import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {redact} from '@ledgerscout/chain-data';
import {createDeepSeekRequest,loadRuntimeConfig,type RequestModel} from '@ledgerscout/agent-runtime';
import {loadEquityConfig,type EquityConfig} from '../../equity-data/src/config.js';
import {THEMES,validateUniverse,type DiscoveryDocument,type DiscoveryInput,type DiscoveryJob,type DiscoveryMember,type FrozenCompany,type ThesisInput} from '../../equity-data/src/discovery-types.js';
import {retrieveChunks} from '../../equity-data/src/documents.js';
import {validateOfficialSource} from '../../equity-data/src/official-sources.js';
import {EquityStore} from './equity-store.js';
import {DiscoveryStore} from './discovery-store.js';
import {newDiscoveryJob,runDiscoveryTask,validateCitations,discoveryCode} from './discovery-runtime.js';
import {refreshDiscoverySources} from './discovery-acquisition.js';
import {compareSnapshots,validateThesis} from './discovery-theses.js';

export class DiscoveryHttpError extends Error{constructor(readonly status:number,message:string){super(message);}}
type Options={directory:string;equity:EquityStore;config?:()=>EquityConfig;request?:RequestModel;fetch?:typeof fetch;modelConfig?:typeof loadRuntimeConfig;externalBusy?:()=>boolean};
function fail(status:number,message:string):never{throw new DiscoveryHttpError(status,message);}
const only=(body:Record<string,unknown>,keys:string[])=>{if(Object.keys(body).some(k=>!keys.includes(k)))fail(400,'不支持的发现请求字段');};
const symbols=(value:unknown,max:number):string[]=>{
  if(!Array.isArray(value)||!value.length||value.length>max||value.some(s=>typeof s!=='string'||! /^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,2})?$/.test(s))||new Set(value).size!==value.length)fail(400,`请明确选择1至${max}家公司；每批上限${max}`);
  return value as string[];
};
const signature=(m:DiscoveryMember)=>JSON.stringify({symbol:m.symbol,sources:m.sources.map(({verification,verifiedAt,...s})=>s)});
const projection=(job:DiscoveryJob)=>{const {input,...rest}=job;return rest;};
function latestDocuments(documents:DiscoveryDocument[]):DiscoveryDocument[]{
  const urls=new Set<string>();return documents.filter(d=>{const key=d.symbol+'|'+d.url;if(urls.has(key))return false;urls.add(key);return true;});
}
export function createDiscoveryService(options:Options){
  const store=new DiscoveryStore(options.directory),equity=options.equity;
  const config=options.config??loadEquityConfig,modelConfig=options.modelConfig??loadRuntimeConfig;
  const secrets=()=>{try{const c=config();return[c.fmpKey,c.twelveDataKey??'',c.secUserAgent,modelConfig().key].filter(Boolean);}catch{return[];}};
  const safe=<T>(v:T)=>redact(v,secrets()) as T;
  let active:{job:DiscoveryJob;controller:AbortController;task:Promise<void>}|undefined,accepting=false,closed=false;
  if(!store.universe().version){
    const seedSources:Record<string,{url:string;pathPrefix:string}>={MSFT:{url:'https://www.microsoft.com/en-us/investor/default',pathPrefix:'/en-us/investor/'},CRM:{url:'https://investor.salesforce.com/news/',pathPrefix:'/news/'},NOW:{url:'https://investor.servicenow.com/overview/default.aspx',pathPrefix:'/'}};
    const seed=[['MSFT','workflow','developer'],['GOOGL','workflow','content'],['ADBE','content'],['CRM','workflow'],['NOW','workflow','vertical'],['INTU','vertical'],['DUOL','vertical'],['PLTR','vertical'],['HUBS','workflow'],['PATH','workflow']];
    store.setUniverse(validateUniverse(seed.map(([symbol,...themes])=>({symbol,themes,sources:seedSources[symbol!]?([{id:'investor-news',kind:'index',url:seedSources[symbol!]!.url,allowedHosts:[new URL(seedSources[symbol!]!.url).hostname],pathPrefix:seedSources[symbol!]!.pathPrefix,maxPages:1}]):[]}))),0);
  }
  const configured=()=>{try{const c=config();return{fmp:Boolean(c.fmpKey),sec:Boolean(c.secUserAgent),deepseek:Boolean(options.request||modelConfig().key)};}catch{return{fmp:false,sec:false,deepseek:false};}};
  function canResume(job:DiscoveryJob):boolean{return ['failed','cancelled','interrupted'].includes(job.status)&&!job.resumedBy&&job.counts.modelRequests<15&&job.counts.toolCalls<12&&job.counts.dataHttpRequests<32&&job.counts.elapsedMs+job.reservedMs<300000;}
  function attachCoverage(job:DiscoveryJob){
    const refreshes=store.jobs().filter(j=>j.kind==='refresh');
    for(const member of job.input.members){
      const source=refreshes.find(j=>j.input.members.some(m=>m.symbol===member.symbol&&signature(m)===signature(member)));
      const checks=source?.checks.filter(c=>c.symbol===member.symbol)??[];
      job.checks.push(...structuredClone(checks));
      if(!checks.length)job.gaps.push(`${member.symbol}：当前目录配置尚无可追溯的来源检查记录；缓存正文不代表完整或最新披露。`);
      for(const c of checks)if(['partial','unavailable','not-checked'].includes(c.status))job.gaps.push(`${member.symbol} / ${c.sourceId}：${c.reason??'本轮来源覆盖不完整。'}`);
    }
  }
  function start(job:DiscoveryJob,alreadyStored=false){
    if(active)fail(409,'已有发现任务执行中');
    if(!alreadyStored&&job.kind!=='refresh')attachCoverage(job);
    if(!alreadyStored)store.saveJob(safe(job));
    const controller=new AbortController(),item={job,controller,task:Promise.resolve()};active=item;
    item.task=Promise.resolve().then(async()=>{
      if(job.kind==='refresh')await refreshDiscoverySources({job,store,equity,config:config(),fetch:options.fetch,signal:controller.signal,secrets:secrets(),save:()=>store.saveJob(safe(job))});
      else await runDiscoveryTask({job,documents:async()=>{
        const ids=job.input.companies.flatMap(c=>c.documentIds),out:DiscoveryDocument[]=[];
        for(const id of ids){const doc=await store.document(id);if(!doc)throw Error('DOCUMENT_UNAVAILABLE');out.push(doc);}return out;
      },request:options.request??createDeepSeekRequest(modelConfig()),signal:controller.signal,secrets:secrets(),save:j=>store.saveJob(safe(j)),...(job.kind==='review'?{thesis:store.thesis(job.input.thesisId!,job.input.thesisVersion),onProposal:(p:Parameters<DiscoveryStore['saveProposal']>[0])=>store.saveProposal(safe(p))}:{})});
    }).catch(error=>{
      job.status=controller.signal.aborted?'cancelled':'failed';job.error=discoveryCode(error);job.gaps.push('本轮未完成，现有证据和进度已保留。');job.resumable=canResume(job);store.saveJob(safe(job));
    }).finally(()=>{if(active===item)active=undefined;});
  }
  async function freeze(selected:string[]):Promise<FrozenCompany[]>{
    const universe=store.universe(),docs=latestDocuments(await store.documents(selected));
    const out:FrozenCompany[]=[];
    for(const symbol of selected){
      const member=universe.members.find(m=>m.symbol===symbol),snapshot=await equity.company(symbol),snapshotId=equity.companyRef(symbol);
      if(!member||member.verification!=='verified'||!snapshot||!snapshotId||snapshot.security.cik!==member.cik||snapshot.security.kind!=='common-stock')fail(422,`${symbol}：尚无已核验公司缓存，请先更新数据`);
      out.push({symbol,snapshotId,snapshot,documentIds:docs.filter(d=>d.symbol===symbol&&d.cik===snapshot.security.cik).slice(0,12).map(d=>d.id)});
    }return out;
  }
  async function chunksFor(companies:FrozenCompany[]){
    const chunks=new Map<string,DiscoveryDocument['chunks'][number]>();
    for(const company of companies)for(const id of company.documentIds){const doc=await store.document(id);if(!doc||doc.symbol!==company.symbol||doc.cik!==company.snapshot.security.cik)fail(422,'原文证据身份或哈希校验失败');for(const chunk of doc.chunks)chunks.set(chunk.id,chunk);}
    return chunks;
  }
  async function validateInputReferences(input:ThesisInput,companies:FrozenCompany[]){
    const chunks=await chunksFor(companies);
    const support=validateCitations(input.support,chunks),opposing=validateCitations(input.opposing,chunks);if(!support.length||support.length!==input.support.length||opposing.length!==input.opposing.length)fail(400,'观点必须引用本轮有效的原文片段及逐字引文');input.support=support;input.opposing=opposing;
  }
  async function state(){
    const universe=store.universe(),docs=latestDocuments(await store.documents(universe.members.map(m=>m.symbol)));
    const companies=[];const themes=new Set<string>();let verified=0,withEvidence=0;
    for(const m of universe.members){
      const c=await equity.company(m.symbol),valid=m.verification==='verified'&&c?.security.cik===m.cik;
      const available=docs.filter(d=>d.symbol===m.symbol&&d.cik===m.cik);
      const hasAI=available.some(d=>d.chunks.some(ch=>/\b(?:artificial intelligence|generative|copilot|AI)\b/i.test(ch.text)));
      if(valid)verified++;if(valid&&hasAI){withEvidence++;m.themes.forEach(t=>themes.add(t));}
      companies.push({symbol:m.symbol,name:c?.security.name??m.name,themes:m.themes,verification:valid?'verified':'pending',snapshotId:equity.companyRef(m.symbol),fetchedAt:c?.fetchedAt,documents:available.map(({text,sections,chunks,...metadata})=>metadata)});
    }
    const jobs=store.jobs().map(j=>({...projection(j),resumable:canResume(j)}));
    const lightThesis=(t:ReturnType<DiscoveryStore['thesis']>)=>t?{...t,companies:t.companies.map(({snapshot,...c})=>c)}:undefined;
    return safe({themes:THEMES,universe,companies,coverage:{catalog:universe.members.length,verified,withEvidence,themesReady:themes.size,prepared:verified>=5&&withEvidence>=3&&themes.size>=2},configured:configured(),busy:Boolean(active)||accepting||Boolean(options.externalBusy?.()),activeJob:active?projection(active.job):undefined,jobs,theses:store.theses().map(lightThesis),proposals:store.proposals().map(p=>({...p,companies:p.companies.map(({snapshot,...c})=>c)}))});
  }
  async function route(method:string,path:string,body:Record<string,unknown>,params:URLSearchParams):Promise<{status:number;value:unknown}>{
    if(closed)fail(503,'发现研究服务正在关闭');
    if(method==='GET'&&path==='/state')return{status:200,value:await state()};
    const docMatch=/^\/documents\/([a-zA-Z0-9_-]{1,100})$/.exec(path);
    if(method==='GET'&&docMatch){
      const doc=await store.document(docMatch[1]!);if(!doc)fail(404,'本机未保存此原文');
      const offset=params.get('offset')??'0',query=params.get('query')??'';if(!/^\d{1,6}$/.test(offset)||query.length>1000)fail(400,'无效正文查询或分页');
      const {text,sections,chunks,...metadata}=doc;
      return{status:200,value:safe({document:metadata,...retrieveChunks(doc,query,{offset:Number(offset),limit:3})})};
    }
    const thesisMatch=/^\/theses\/([a-zA-Z0-9_-]{1,100})$/.exec(path);
    if(method==='GET'&&thesisMatch){const latest=store.thesis(thesisMatch[1]!);if(!latest)fail(404,'未找到研究观点');return{status:200,value:safe({versions:Array.from({length:latest.version},(_,i)=>{const t=store.thesis(latest.id,i+1)!;const {companies,...rest}=t;return rest;})})};}
    const jobMatch=/^\/jobs\/([a-zA-Z0-9_-]{1,100})$/.exec(path);
    if(method==='GET'&&jobMatch){const j=store.job(jobMatch[1]!);if(!j)fail(404,'未找到发现任务');return{status:200,value:safe({...projection(j),resumable:canResume(j)})};}
    if(method!=='POST')fail(404,'发现接口不存在');
    if(path==='/cancel'){only(body,['jobId']);const requested=Boolean(active&&active.job.id===body.jobId);if(requested)active!.controller.abort();return{status:200,value:{requested}};}
    if(active||options.externalBusy?.())fail(409,'已有研究或更新执行中');
    if(path==='/universe'){
      only(body,['members','expectedVersion']);if(!Number.isSafeInteger(body.expectedVersion))fail(400,'缺少目录版本');
      const members=validateUniverse(body.members),previous=store.universe();
      for(const m of members){const old=previous.members.find(x=>x.symbol===m.symbol);if(old){m.verification=old.verification;m.cik=old.cik;m.website=old.website;if(old.verification==='verified')m.name=old.name;for(const source of m.sources){const trusted=old.sources.find(s=>s.id===source.id);if(trusted&&signature({...m,sources:[source]})===signature({...old,sources:[trusted]}))Object.assign(source,trusted);}}for(const s of m.sources)validateOfficialSource(s);}
      return{status:200,value:safe(store.setUniverse(members,Number(body.expectedVersion)))};
    }
    if(path==='/refresh'){
      only(body,['symbols']);const selected=symbols(body.symbols,5),u=store.universe();
      if(selected.some(s=>!u.members.some(m=>m.symbol===s)))fail(400,'更新公司必须来自发现目录');
      const c=configured();if(!c.fmp||!c.sec)fail(503,'请先配置FMP_API_KEY和SEC_USER_AGENT');
      const input:DiscoveryInput={universeVersion:u.version,members:u.members.filter(m=>selected.includes(m.symbol)),companies:[],question:'更新AI应用研究资料'};
      const job=newDiscoveryJob('refresh',input);start(job);return{status:202,value:{jobId:job.id}};
    }
    if(path==='/scan'){
      only(body,['symbols','question']);const selected=symbols(body.symbols,10),u=store.universe();
      if(!configured().deepseek)fail(503,'请先配置DeepSeek');
      const overview=await state();if(!overview.coverage.prepared)fail(422,'资料准备尚未达标：需5家已核验公司、3家AI正文证据，至少覆盖2类主题');
      if(body.question!==undefined&&(typeof body.question!=='string'||body.question.length>4000))fail(400,'研究问题最多4000字符');
      const companies=await freeze(selected);const job=newDiscoveryJob('scan',{universeVersion:u.version,members:u.members.filter(m=>selected.includes(m.symbol)),companies,question:typeof body.question==='string'?body.question:'发现未来12–24个月值得验证的AI应用商业机会'});
      start(job);return{status:202,value:{jobId:job.id}};
    }
    if(path==='/handoff'){
      only(body,['jobId','opportunityId','symbol']);const job=typeof body.jobId==='string'?store.job(body.jobId):undefined,opp=job?.opportunities.find(o=>o.id===body.opportunityId);
      if(!job||!opp||typeof body.symbol!=='string'||!opp.candidates.some(c=>c.symbol===body.symbol))fail(400,'候选公司必须来自已保存的主题机会');
      return{status:200,value:safe({symbol:body.symbol,question:`围绕AI应用主题「${opp.title}」研究${body.symbol}：${opp.mechanism}。重点验证：${opp.checks.join('；')}。说明支持、反对与数据缺口，区分公司整体经营与AI业务贡献。`,discoveryContext:{jobId:job.id,opportunityId:opp.id,symbol:body.symbol}})};
    }
    if(path==='/theses'){
      only(body,['input','expectedVersion']);const input=validateThesis(body.input),source=store.job(input.sourceJobId);
      const opp=source?.opportunities.find(o=>o.id===input.opportunityId);
      if(!source||source.kind!=='scan'||!opp||opp.theme!==input.theme||input.symbols.some(s=>!opp.candidates.some(c=>c.symbol===s)))fail(400,'观点需绑定本轮机会与候选公司');
      const companies=source.input.companies.filter(c=>input.symbols.includes(c.symbol));await validateInputReferences(input,companies);
      const requiredGaps=[...new Set([...source.gaps,...opp.gaps])];
      if(requiredGaps.some(g=>!input.gaps.includes(g))&&!input.gapResolutionReason)fail(400,'解除本轮证据缺口需要填写判断理由');
      return{status:200,value:safe(store.confirmThesis(input,Number(body.expectedVersion),companies))};
    }
    if(path==='/review'){
      only(body,['thesisId','version']);const t=typeof body.thesisId==='string'?store.thesis(body.thesisId,body.version===undefined?undefined:Number(body.version)):undefined;if(!t)fail(404,'未找到待复核观点');
      if(store.thesis(t.id)?.version!==t.version)fail(409,'请对最新已确认观点进行复核');
      const companies=await freeze(t.symbols);for(const c of companies)c.documentIds=[...new Set([...c.documentIds,...(t.companies.find(old=>old.symbol===c.symbol)?.documentIds??[])])];const changed=compareSnapshots(t.companies,companies).some(c=>['restatement','new-period','missing','not-comparable'].includes(c.kind)&&JSON.stringify(c.previous)!==JSON.stringify(c.next));
      const oldDocs=new Set(t.companies.flatMap(c=>c.documentIds));const newDocs=companies.some(c=>c.documentIds.some(id=>!oldDocs.has(id)));
      if(!changed&&!newDocs)return{status:200,value:{unchanged:true,message:'当前缓存无新证据；未调用模型。请先显式更新资料。'}};
      if(!configured().deepseek)fail(503,'请先配置DeepSeek');const u=store.universe();
      const job=newDiscoveryJob('review',{universeVersion:u.version,members:u.members.filter(m=>t.symbols.includes(m.symbol)),companies,previousCompanies:t.companies,question:t.statement.slice(0,4000),thesisId:t.id,thesisVersion:t.version});start(job);return{status:202,value:{jobId:job.id}};
    }
    const proposalMatch=/^\/proposals\/([a-zA-Z0-9_-]{1,100})$/.exec(path);
    if(proposalMatch){
      only(body,['decision','expectedVersion','edited']);if(!['accept','reject'].includes(String(body.decision)))fail(400,'请明确接受或拒绝复核建议');const p=store.proposal(proposalMatch[1]!);if(!p)fail(404,'未找到复核建议');
      const edited=body.edited===undefined?undefined:validateThesis(body.edited);
      if(body.decision==='accept'){const draft=edited??p.draft;if(draft.theme!==p.draft.theme||draft.sourceJobId!==p.draft.sourceJobId||draft.symbols.some(s=>!p.companies.some(c=>c.symbol===s)))fail(400,'复核不能改变原研究目标或来源');await validateInputReferences(draft,p.companies);}
      return{status:200,value:safe({thesis:store.resolveProposal(p.id,body.decision as 'accept'|'reject',edited,Number(body.expectedVersion)),decision:body.decision})};
    }
    if(path==='/resume'){
      only(body,['jobId']);const parent=typeof body.jobId==='string'?store.job(body.jobId):undefined;if(!parent||!canResume(parent))fail(409,'该任务不可恢复或原预算已用尽');
      for(const c of parent.input.companies){const p=await equity.readEvidence(c.snapshotId);if(!isDeepStrictEqual(p.data,c.snapshot))fail(409,'原证券快照已改变');}await chunksFor(parent.input.companies);
      const child=structuredClone(parent);child.id=`j_${randomUUID()}`;child.resumeOf=parent.id;delete child.resumedBy;child.createdAt=new Date().toISOString();child.status='loading';child.counts.elapsedMs+=child.reservedMs;child.reservedMs=0;child.error=undefined;child.resumable=false;
      parent.resumable=true;store.saveJob(parent);store.claimResume(parent.id,child);start(child,true);return{status:202,value:{jobId:child.id}};
    }
    fail(404,'发现接口不存在');
  }
  async function guarded(method:string,path:string,body:Record<string,unknown>,params:URLSearchParams){
    const protectedRequest=method==='POST'&&path!=='/cancel';
    if(protectedRequest&&accepting)fail(409,'已有发现操作正在准备');
    if(protectedRequest)accepting=true;
    try{return await route(method,path,body,params);}catch(error){
      if(error instanceof DiscoveryHttpError)throw error;
      const message=error instanceof Error?error.message:'';
      if(/stale|already|version|consum/i.test(message))fail(409,'目录或观点版本已改变，或该操作已经处理，请重新读取本机状态');
      if(/Invalid|Unsupported|Duplicate|maximum|source|scope|gap|evidence|identity|frozen/i.test(message))fail(400,'输入或原始证据未通过校验，请核对范围、引用和数据缺口');
      fail(500,'发现记录读取或保存未完成，请保留本机原始资料');
    }finally{if(protectedRequest)accepting=false;}
  }
  return{route:guarded,get busy(){return Boolean(active)||accepting;},get activeJob(){return active?.job;},wait:async()=>{await active?.task;},close:async()=>{closed=true;active?.controller.abort();await active?.task;store.close();},
    context:async(value:unknown,symbol:string)=>{
      const v=value as {jobId?:string;opportunityId?:string;symbol?:string};if(!v||v.symbol!==symbol||typeof v.jobId!=='string')fail(400,'主题背景与股票不匹配');
      const j=store.job(v.jobId),o=j?.opportunities.find(x=>x.id===v.opportunityId);if(!j||!o||!o.candidates.some(c=>c.symbol===symbol))fail(400,'主题背景未经授权');
      const company=j.input.companies.find(c=>c.symbol===symbol);if(!company)fail(400,'缺少主题原始公司快照');
      const docs=[];for(const id of company.documentIds){const d=await store.document(id);if(d)docs.push(d);}
      return{jobId:j.id,opportunityId:o.id,company,documents:docs,summary:{title:o.title,mechanism:o.mechanism,checks:o.checks,gaps:[...j.gaps,...o.gaps]}};
    }};
}

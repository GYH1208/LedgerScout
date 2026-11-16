import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {redact} from '@ledgerscout/chain-data';
import {parseDocument} from 'htmlparser2';
import {EquityTransport} from '../../equity-data/src/transport.js';
import {EquityProvider,normalizeFilings} from '../../equity-data/src/provider.js';
import {DailyQuota} from '../../equity-data/src/quota.js';
import {normalizeFinancials} from '../../equity-data/src/financials.js';
import {deriveMetrics} from '../../equity-data/src/metrics.js';
import {buildDocument} from '../../equity-data/src/documents.js';
import {validateOfficialSource,discoverOfficialLinks,readOfficialPage} from '../../equity-data/src/official-sources.js';
import type {DiscoveryJob,DiscoveryMember,OfficialSource,DiscoveryDocument,SourceCheck} from '../../equity-data/src/discovery-types.js';
import type {CompanySnapshot,SourceRef,Filing} from '../../equity-data/src/types.js';
import type {EquityConfig} from '../../equity-data/src/config.js';
import type {DiscoveryStore} from './discovery-store.js';
import type {EquityStore} from './equity-store.js';
import {DiscoveryBudget,discoveryCode} from './discovery-runtime.js';

export type DiscoveryAcquisitionOptions={job:DiscoveryJob;store:DiscoveryStore;equity:EquityStore;config:EquityConfig;fetch?:typeof fetch;signal?:AbortSignal;secrets?:string[];save:()=>void|Promise<void>};
const fresh=(date:string,age:number)=>Number.isFinite(Date.parse(date))&&Date.now()-Date.parse(date)>=0&&Date.now()-Date.parse(date)<age;
const sourceConfig=(s:OfficialSource)=>JSON.stringify([s.id,s.kind,s.url,s.allowedHosts,s.pathPrefix,s.maxPages??1]);
const code=(e:unknown)=>{const message=e instanceof Error?e.message.replace(/^OFFICIAL_/,''):'';return discoveryCode(Error(message));};
const stops=(e:unknown)=>/^(?:CANCELLED|HTTP_BUDGET|STAGE_DEADLINE|QUOTA_[A-Z_]+|RATE_LIMIT|RECORD_FAILED)$/.test(e instanceof Error?e.message.replace(/^OFFICIAL_/,''):'');
type HtmlNode=ReturnType<typeof parseDocument>['children'][number];
function anchors(html:string,base:string):{url:string;label:string}[]{
 const result:{url:string;label:string}[]=[],pending:HtmlNode[]=parseDocument(html).children.slice().reverse();
 while(pending.length){const n=pending.pop()!;if(!('name'in n)||!('children'in n))continue;if(['script','style','noscript','template'].includes(n.name))continue;
  if(n.name==='a'&&n.attribs.href){let label='';const text=[...n.children];while(text.length){const t=text.pop()!;if(t.type==='text')label=t.data+label;else if('children'in t)for(const c of t.children)text.push(c);}try{result.push({url:new URL(n.attribs.href,base).href.split('#')[0]!,label});}catch{}}
  for(let i=n.children.length-1;i>=0;i--)pending.push(n.children[i]!);
 }return result;
}
function publication(html:string):string|undefined{
 const pending:HtmlNode[]=[...parseDocument(html).children];
 while(pending.length){const n=pending.pop()!;if(!('name'in n)||!('children'in n))continue;const a=n.attribs;
  const raw=n.name==='time'?a.datetime:n.name==='meta'&&/^(?:article:published_time|datePublished|pubdate|date)$/i.test(a.property??a.name??'')?a.content:undefined;
  if(raw){const day=raw.slice(0,10);if(/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day&&day<=new Date().toISOString().slice(0,10))return day;}
  for(const c of n.children)pending.push(c);
 }return;
}

/** Explicit bounded acquisition only. No model calls, pool edits, implicit continuation or URL guessing. */
export async function refreshDiscoverySources(options:DiscoveryAcquisitionOptions):Promise<void>{
 const {job,store,equity,config}=options;
 const safe=<T>(value:T)=>redact(value,[config.fmpKey,config.twelveDataKey??'',config.secUserAgent,...(options.secrets??[])].filter(Boolean)) as T;
 const budget=new DiscoveryBudget(job,options.save,options.signal);
 const updated=new Map<string,DiscoveryMember>();
 let quota:DailyQuota|undefined,transport:EquityTransport|undefined,activeSymbol='',refs:SourceRef[]=[],fatal:unknown;
 const rawFilings=new Map<string,SourceRef>();
 const hook=async()=>{try{await budget.http(Math.max(15000,config.timeoutMs));}catch(e){fatal=e;throw e;}};
 const assertActive=()=>{if(fatal)throw fatal;budget.check();};
 const add=(symbol:string,sourceId:string,url:string,status:SourceCheck['status'],documentIds:string[]=[],reason?:string)=>{
  const check:SourceCheck={symbol,sourceId,url,status,documentIds,checkedAt:new Date().toISOString(),...(reason?{reason}:{})};
  const old=job.checks.findIndex(c=>c.symbol===symbol&&c.sourceId===sourceId);if(old>=0)job.checks[old]=check;else job.checks.push(check);
 };
 const officialRead=async(source:OfficialSource,url:string)=>{
  assertActive();try{return await readOfficialPage(source,url,{fetch:options.fetch,signal:budget.signal,beforeRequest:hook});}catch(e){assertActive();throw e;}finally{if(!budget.signal.aborted)await budget.settleHttp();}
 };
 async function recordOfficial(symbol:string,source:string,url:string,html:string,fetchedAt:string){
  return equity.evidence(symbol,source,safe({url,body:html,fetchedAt}));
 }
 async function ingest(member:DiscoveryMember,url:string,html:string,raw:SourceRef,previous:DiscoveryDocument[],extra:Partial<Pick<DiscoveryDocument,'form'|'accession'|'publishedAt'>>={}){
  assertActive();
  const document=buildDocument({id:`d_${randomUUID()}`,symbol:member.symbol,cik:member.cik!,sourceKind:extra.accession?'sec':'issuer',url,html:safe(html),...extra,fetchedAt:new Date().toISOString()});
  if(!document.text.trim()||!document.chunks.length)throw Error('NO_EXTRACTABLE_TEXT');
  const old=previous.find(d=>d.url===url&&d.hash===document.hash&&d.cik===member.cik);
  // Canonical text hashes alone cannot certify changes outside the indexed bound.
  if(old&&old.rawEvidenceId){const original=await equity.readEvidence(old.rawEvidenceId);const originalBody=original.data.body;if(typeof originalBody==='string'&&createHash('sha256').update(originalBody).digest('hex')===createHash('sha256').update(safe(html)).digest('hex'))return{document:old,unchanged:true};}
  document.rawEvidenceId=raw.id;await store.saveDocument(document);previous.unshift(document);return{document,unchanged:false};
 }
 try{
  if(job.kind!=='refresh'||job.input.members.length>5||!job.input.members.length||job.input.members.some(m=>!job.symbols.includes(m.symbol)))throw Error('INVALID_REFRESH_SCOPE');
  assertActive();quota=new DailyQuota(join(config.outputDirectory,'equity-quota.sqlite'),config.dailyLimit);
  transport=new EquityTransport(config,{fetch:options.fetch,signal:budget.signal,quota,beforeRequest:hook,record:async value=>{
   const r=value as {provider?:string;endpoint?:string;symbol?:string;source?:string;body?:unknown};
   const symbol=r.symbol??activeSymbol,ref=await equity.evidence(symbol,`${r.provider??'provider'}:${r.endpoint??'response'}`,safe(value));refs.push(ref);
   if(r.provider==='fmp'&&r.endpoint==='profile'&&r.symbol&&r.body)equity.setProfileRef(r.symbol,ref);
   if(r.provider==='sec'&&r.endpoint==='filing'&&r.source&&typeof r.body==='string')rawFilings.set(`${symbol}|${r.source}`,ref);
   if(!budget.signal.aborted)await budget.settleHttp();
  }});
  const provider=new EquityProvider(transport,{profileCache:{get:async symbol=>{const ref=equity.profileRef(symbol);if(!ref||!fresh(ref.fetchedAt,7*86400000))return;const proof=await equity.readEvidence(ref.id);if(proof.symbol!==symbol)return;refs.push(ref);return proof.data.body;}}});
  for(const frozen of job.input.members){
   if(job.completed.includes(frozen.symbol))continue;
   assertActive();activeSymbol=frozen.symbol;refs=[];
   try{
    let snapshot=await equity.company(frozen.symbol),filings:Filing[];
    const profileRef=equity.profileRef(frozen.symbol);
    if(snapshot&&fresh(snapshot.fetchedAt,86400000)&&profileRef&&fresh(profileRef.fetchedAt,7*86400000)){
     if(snapshot.security.kind!=='common-stock'||snapshot.security.country!=='US'||snapshot.security.currency!=='USD')throw Error('INVALID_SECURITY_IDENTITY');
     const current=await transport.request('sec',`submissions/CIK${snapshot.security.cik}.json`,frozen.symbol);assertActive();filings=normalizeFilings(current,snapshot.security);
    }else{
     const raw=await provider.getCompany(frozen.symbol);assertActive();
     const financials=normalizeFinancials(raw.companyFacts,raw.security.industry);
     if(!raw.security.industry?.trim()){financials.industryExclusion='unclassified';financials.warnings.push('证券行业分类尚未核验，不提供普通公司比率比较。');}
     snapshot=safe({security:raw.security,...(raw.prices?{prices:raw.prices}:{}),financials,metrics:deriveMetrics(raw.security,financials,raw.prices,refs.map(r=>r.id)),filings:raw.filings.slice(0,30),sourceRefs:[...refs],fetchedAt:new Date().toISOString(),warnings:raw.warnings});
     await equity.saveCompany(snapshot);filings=raw.filings;
    }
    if(frozen.cik&&frozen.cik.padStart(10,'0')!==snapshot.security.cik)throw Error('INVALID_SECURITY_IDENTITY');
    const member:DiscoveryMember={...structuredClone(frozen),cik:snapshot.security.cik,name:snapshot.security.name,verification:'verified'};updated.set(member.symbol,member);
    const currentProfileRef=equity.profileRef(member.symbol),proof=currentProfileRef?await equity.readEvidence(currentProfileRef.id):undefined;
    const profile=Array.isArray(proof?.data.body)?proof!.data.body[0]:undefined;
    let website:URL|undefined;
    if(profile?.symbol===member.symbol&&String(profile.cik).padStart(10,'0')===member.cik&&typeof profile.website==='string')try{const parsed=new URL(profile.website);if(['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password&&!parsed.port)website=parsed;}catch{}
    if(website)member.website=website.href;
    const previous=await store.documents([member.symbol]);let bodies=0,indexPages=0;
    const sorted=[...filings].sort((a,b)=>b.filed.localeCompare(a.filed));
    const annual=sorted.find(f=>/^10-K/.test(f.form)),quarter=sorted.find(f=>/^10-Q/.test(f.form));
    const latestEightK=sorted.find(f=>/^8-K/.test(f.form));
    const reportCandidates=[annual,quarter].filter((f):f is Filing=>Boolean(f)).sort((a,b)=>b.filed.localeCompare(a.filed));
    // The newest periodic disclosure gets the first body; preserve the issuer/8-K reservation.
    const selected=reportCandidates.slice(0,!member.sources.length&&!latestEightK?2:1);
    const omitted=sorted.filter(f=>/^10-[KQ]/.test(f.form)&&!selected.some(s=>s.url===f.url&&s.accession===f.accession)&&!previous.some(d=>d.url===f.url&&d.cik===member.cik&&d.accession===f.accession));
    const secDocuments:string[]=[],secFailures:string[]=[];let allUnchanged=true,secPartial=omitted.length>0;
    for(const filing of selected){
     assertActive();
     const old=previous.find(d=>d.url===filing.url&&d.cik===member.cik&&d.accession===filing.accession);
     if(old){secDocuments.push(old.id);secPartial||=old.warnings.some(w=>/truncat|limit/i.test(w));continue;}
     if(bodies>=2){secPartial=true;break;}
     bodies++;
     try{
      const html=await provider.getFiling(filing);assertActive();
      const raw=rawFilings.get(`${member.symbol}|${filing.url}`);if(!raw)throw Error('RECORD_FAILED');
      const obtained=await ingest(member,filing.url,html,raw,previous,{form:filing.form,accession:filing.accession,publishedAt:filing.filed});
      secDocuments.push(obtained.document.id);allUnchanged&&=obtained.unchanged;secPartial||=obtained.document.warnings.some(w=>/truncat|limit/i.test(w));
     }catch(e){assertActive();if(stops(e))throw e;secPartial=true;allUnchanged=false;secFailures.push(`${filing.form}:${code(e)}`);}
    }
    add(member.symbol,'sec-filings',`https://data.sec.gov/submissions/CIK${member.cik}.json`,!selected.length?'unavailable':secPartial?'partial':allUnchanged?'unchanged':'checked',secDocuments,!selected.length?'当前SEC索引没有可验证的10-K/10-Q正文。':`已检查当前SEC索引；仅覆盖所列年度/季度正文，不代表全部披露均已阅读。${omitted.length?`当前索引另有${omitted.length}份未缓存年度/季度正文，本轮为有界读取及官网/8-K材料保留额度而未检查：${omitted.slice(0,10).map(f=>`${f.form} ${f.filed} ${f.accession}`).join('；')}${omitted.length>10?'；其余未逐项列出':''}。`:''}${secFailures.length?`未取得的正文：${secFailures.join('；')}。`:''}`);
    if(latestEightK){
     add(member.symbol,'sec-8k',latestEightK.url,'not-checked',[],'本轮尚未读取最新8-K的实际附件目录及正文。');
     if(member.sources.length)add(member.symbol,'sec-8k',latestEightK.url,'not-checked',[],'本轮为已登记官网来源保留正文额度；最新8-K及其附件未检查。');
     else if(bodies>=2||job.counts.dataHttpRequests>30)add(member.symbol,'sec-8k',latestEightK.url,'not-checked',[],'正文上限或剩余HTTP预算不足以核验目录并读取正文；未猜测附件URL。');
     else try{
      assertActive();let attachment:string|undefined,limited=false;
      try{
       const listing=await transport.filingIndex(latestEightK.url) as {directory?:{item?:{name?:unknown}[]}};assertActive();
       attachment=listing.directory?.item?.map(item=>item?.name).filter((name):name is string=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.(?:htm|html|txt)$/i.test(name)&&!name.includes('..')&&name!==latestEightK.primaryDocument&&/ex(?:hibit)?[-_]?99|99[._-]?1|earnings|release/i.test(name)).sort((a,b)=>Number(/99[._-]?1/i.test(b))-Number(/99[._-]?1/i.test(a))||a.localeCompare(b))[0];
       limited=!attachment;
      }catch(e){assertActive();if(stops(e))throw e;limited=true;}
      const filing=attachment?{...latestEightK,primaryDocument:attachment,url:`${latestEightK.url.slice(0,latestEightK.url.lastIndexOf('/')+1)}${attachment}`}:latestEightK;
      const old=previous.find(d=>d.url===filing.url&&d.cik===member.cik&&d.accession===filing.accession);
      let document:DiscoveryDocument,unchanged=Boolean(old);
      if(old)document=old;
      else{bodies++;const html=await provider.getFiling(filing);assertActive();const raw=rawFilings.get(`${member.symbol}|${filing.url}`);if(!raw)throw Error('RECORD_FAILED');const obtained=await ingest(member,filing.url,html,raw,previous,{form:filing.form,accession:filing.accession,publishedAt:filing.filed});document=obtained.document;unchanged=obtained.unchanged;}
      add(member.symbol,'sec-8k',latestEightK.url,limited||document.warnings.some(w=>/truncat|limit/i.test(w))?'partial':unchanged?'unchanged':'checked',[document.id],limited?'仅取得已验证8-K主文档；实际附件目录未知或未发现可识别的业绩附件，附件覆盖不完整。':'由该8-K已核验的实际附件目录读取所列业绩材料；未穷尽其他8-K或附件。');
     }catch(e){assertActive();add(member.symbol,'sec-8k',latestEightK.url,'unavailable',[],`最新8-K材料未完整取得：${code(e)}。`);if(stops(e))throw e;}
    }
    let homepageLinks:{url:string;label:string}[]|undefined;
    for(const source of member.sources){
     assertActive();
     if(bodies>=2){add(member.symbol,source.id,source.url,'not-checked',[],'已达到每公司两份新正文上限。');continue;}
     try{
      validateOfficialSource(source);let owned=false;
      const owner=website?.hostname.replace(/^www\./,'');const sourceHost=new URL(source.url).hostname;
      if(owner&&(sourceHost===owner||sourceHost.endsWith(`.${owner}`)))owned=true;
      else if(website?.protocol==='https:'){
       if(homepageLinks===undefined){const homepage:OfficialSource={id:'ownership',kind:'document',url:website.href,allowedHosts:[website.hostname],pathPrefix:website.pathname,verification:'verified'};const page=await officialRead(homepage,homepage.url);await recordOfficial(member.symbol,'issuer:ownership',page.url,page.html,page.fetchedAt);homepageLinks=anchors(page.html,page.url);}
       owned=homepageLinks.some(a=>{try{return /\binvestor\s+(?:relations?|cent(?:er|re))\b|^\s*investors?\s*$|\bfinancial\s+(?:results|disclosures?|reports?)\b|投资者关系|投资者中心|财务披露|财务报告|财报/i.test(a.label)&&new URL(a.url).protocol==='https:'&&new URL(a.url).hostname===sourceHost;}catch{return false;}});
      }
      if(!owned){source.verification='pending';delete source.verifiedAt;add(member.symbol,source.id,source.url,'unavailable',[],'来源归属未由已核验公司官网域名或其实际链接证明；本轮未请求该来源。');continue;}
      source.verification='verified';source.verifiedAt=new Date().toISOString();
      const urls:string[]=[];let limited=false;
      if(source.kind==='index'){
       if(indexPages){add(member.symbol,source.id,source.url,'not-checked',[],'每公司最多读取一个已登记索引及其一页后续分页。');continue;}
       const first=await officialRead(source,source.url);indexPages++;await recordOfficial(member.symbol,'issuer:index',first.url,first.html,first.fetchedAt);
       const discovered=discoverOfficialLinks(first.html,source,first.url);let links=[...discovered.documents],labels=anchors(first.html,first.url);
       if(discovered.nextPage&&indexPages<Math.min(2,source.maxPages??1)){const next=await officialRead(source,discovered.nextPage);indexPages++;await recordOfficial(member.symbol,'issuer:index',next.url,next.html,next.fetchedAt);links.push(...discoverOfficialLinks(next.html,source,next.url).documents);labels.push(...anchors(next.html,next.url));}
       const relevance=(url:string)=>{const parsed=new URL(url);return /earnings|results|financial|product|artificial|intelligence|generative|copilot|\bai\b/i.test(`${parsed.pathname.slice(source.pathPrefix.length)} ${parsed.search} ${labels.find(a=>a.url===url)?.label??''}`)?1:0;};
       const linkDate=(url:string)=>(`${labels.find(a=>a.url===url)?.label??''} ${url}`.match(/\b20\d{2}-\d{2}-\d{2}\b/)??[''])[0]!;
       links=[...new Set(links)].sort((a,b)=>relevance(b)-relevance(a)||linkDate(b).localeCompare(linkDate(a))||Number(previous.some(d=>d.url===a))-Number(previous.some(d=>d.url===b)));
       urls.push(...links.slice(0,2-bodies));limited=!links.length||links.length>urls.length;
      }else urls.push(source.url);
      const ids:string[]=[];let unchanged=urls.length>0,truncated=false;
      for(const url of urls){assertActive();bodies++;const page=await officialRead(source.kind==='index'?{...source,kind:'index'}:source,url);const raw=await recordOfficial(member.symbol,'issuer:document',url,page.html,page.fetchedAt);const obtained=await ingest(member,url,page.html,raw,previous,{publishedAt:publication(page.html)});ids.push(obtained.document.id);unchanged&&=obtained.unchanged;truncated||=obtained.document.warnings.some(w=>/truncat|limit/i.test(w));}
      add(member.symbol,source.id,source.url,limited||truncated?'partial':unchanged?'unchanged':'checked',ids,!urls.length?'索引未解析出可读取的HTML正文链接；动态内容或范围限制使覆盖未知，不能据此判断无新资料。':limited?'索引已检查；本轮仅选取有界正文，其余实际链接未读取。':urls.some(url=>!previous.find(d=>d.url===url)?.publishedAt)?'正文发布日期未知，不能声称为最新资料。':undefined);
     }catch(e){assertActive();add(member.symbol,source.id,source.url,'unavailable',[],`来源未完成读取：${code(e)}。`);if(stops(e))throw e;}
    }
    job.completed.push(member.symbol);job.remaining=job.symbols.filter(s=>!job.completed.includes(s));await budget.save();
   }catch(e){assertActive();if(stops(e))throw e;job.errors.push({symbol:frozen.symbol,code:code(e)});add(frozen.symbol,'sec-filings',`https://data.sec.gov/submissions/CIK${frozen.cik??'unknown'}.json`,'unavailable',[],`本公司更新未完整完成：${code(e)}。`);await budget.save();}
  }
  assertActive();job.status=job.errors.length||job.remaining.length||job.checks.some(c=>['partial','unavailable','not-checked'].includes(c.status))?'partial':'completed';
 }catch(e){
  const stopped=fatal??e;job.status=options.signal?.aborted?'cancelled':/BUDGET|DEADLINE/.test(stopped instanceof Error?stopped.message:'')?'exhausted':'failed';job.error=code(stopped);
 }finally{
  for(const member of job.input.members)if(!job.completed.includes(member.symbol)){
   if(!job.checks.some(c=>c.symbol===member.symbol&&c.sourceId==='sec-filings'))add(member.symbol,'sec-filings',`https://data.sec.gov/submissions/CIK${member.cik??'unknown'}.json`,'not-checked',[],'本轮在读取完成前停止；不代表没有新披露。');
   for(const source of member.sources)if(!job.checks.some(c=>c.symbol===member.symbol&&c.sourceId===source.id))add(member.symbol,source.id,source.url,'not-checked',[],'本轮未完成该来源检查。');
  }
  try{
   const current=store.universe(),members=current.members.map(existing=>{
    const original=job.input.members.find(m=>m.symbol===existing.symbol),next=updated.get(existing.symbol);if(!original||!next||existing.cik&&existing.cik!==original.cik&&existing.cik!==next.cik)return existing;
    return{...existing,cik:next.cik,name:next.name,website:next.website,verification:next.verification,sources:existing.sources.map(s=>{const old=original.sources.find(o=>o.id===s.id),verified=next.sources.find(o=>o.id===s.id);if(!old||!verified||sourceConfig(s)!==sourceConfig(old))return s;const merged={...s,verification:verified.verification};delete merged.verifiedAt;if(verified.verifiedAt)merged.verifiedAt=verified.verifiedAt;return merged;})};
   });
   if(JSON.stringify(members)!==JSON.stringify(current.members))store.setUniverse(members,current.version);
  }catch{job.gaps.push('目录核验状态未能合并；已保存的正文和原目录版本保持可追溯。');if(job.status==='completed')job.status='partial';}
  job.resumable=['cancelled','failed','partial'].includes(job.status)&&job.remaining.length>0&&job.counts.dataHttpRequests<32&&job.counts.elapsedMs<300000;job.reservedMs=0;
  budget.close();transport?.close();quota?.close();await budget.save();
 }
}

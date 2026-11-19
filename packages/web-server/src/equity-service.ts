import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from '@ledgerscout/chain-data';
import { loadRuntimeConfig,createDeepSeekRequest,type RequestModel } from '@ledgerscout/agent-runtime';
import { loadEquityConfig,type EquityConfig } from '../../equity-data/src/config.js';
import { DailyQuota } from '../../equity-data/src/quota.js';
import { TwelveDataQuota } from '../../equity-data/src/twelve-quota.js';
import { currentNewYorkDate,TwelveDataProvider,TWELVE_PRICE_SOURCE,TWELVE_STOCK_PRICE_SOURCE } from '../../equity-data/src/twelve-data.js';
import { EquityDataError,EquityTransport,safeEquityCode } from '../../equity-data/src/transport.js';
import { EquityProvider } from '../../equity-data/src/provider.js';
import { normalizeFinancials } from '../../equity-data/src/financials.js';
import { deriveMetrics,derivePriceReturns,buildMarketSnapshot } from '../../equity-data/src/metrics.js';
import { screenCompanies,validateFilters } from '../../equity-data/src/screening.js';
import { MARKET_SYMBOLS,type CompanySnapshot,type PriceSeries,type SourceRef,type Filing } from '../../equity-data/src/types.js';
import { EquityStore,validSymbol,type EquityJob,type EquityCheckpoint } from './equity-store.js';
import { runEquityResearch } from './equity-runtime.js';
import { createDiscoveryService,DiscoveryHttpError } from './discovery-service.js';
import { retrieveChunks } from '../../equity-data/src/documents.js';

export class EquityHttpError extends Error{constructor(readonly status:number,message:string){super(message);}}
export type EquityServiceOptions={directory:string;config?:()=>EquityConfig;request?:RequestModel;fetch?:typeof fetch;modelConfig?:typeof loadRuntimeConfig};
type RouteResult={status:number;value:unknown};
function fail(status:number,message:string):never{throw new EquityHttpError(status,message);}
const only=(body:Record<string,unknown>,keys:string[])=>{if(Object.keys(body).some(k=>!keys.includes(k)))fail(400,'不支持的请求字段');};
const fresh=(date:string,age:number)=>Number.isFinite(Date.parse(date))&&Date.now()-Date.parse(date)>=0&&Date.now()-Date.parse(date)<age;
const verifiedStockPrice=(prices:PriceSeries|undefined,symbol:string)=>prices?.source===TWELVE_STOCK_PRICE_SOURCE&&prices.symbol===symbol&&prices.adjustment==='split-adjusted'&&prices.bars.length>0;
const stockPriceWarning='twelve-data-prices:';

export function createEquityService(options:EquityServiceOptions){
  const store=new EquityStore(options.directory);
  let quota:DailyQuota|undefined;
  let twelveQuota:TwelveDataQuota|undefined;
  let active:{id:string;controller:AbortController;task:Promise<void>;job:EquityJob|Record<string,unknown>}|undefined;
  let closed=false;
  let accepting=false;
  const config=options.config??loadEquityConfig;
  const modelConfig=options.modelConfig??loadRuntimeConfig;
  const configured=()=>{try{const c=config();return {twelveData:Boolean(c.twelveDataKey),fmp:Boolean(c.fmpKey),sec:Boolean(c.secUserAgent),deepseek:Boolean(options.request||modelConfig().key)};}catch{return{twelveData:false,fmp:false,sec:false,deepseek:false};}};
  const secrets=()=>{try{const c=config();return[c.fmpKey,c.twelveDataKey??'',c.secUserAgent,modelConfig().key].filter(Boolean);}catch{return[];}};
  const safe=<T>(value:T)=>redact(value,secrets()) as T;
  const getQuota=()=>quota??=new DailyQuota(join(config().outputDirectory,'equity-quota.sqlite'),config().dailyLimit);
  const getTwelveQuota=()=>twelveQuota??=new TwelveDataQuota(join(config().outputDirectory,'twelve-data-quota.sqlite'),config().twelveDataDailyLimit??600);
  const discovery=createDiscoveryService({...options,equity:store,externalBusy:()=>Boolean(active)||accepting});
  const lastRefresh=store.refreshJob();
  if(lastRefresh?.status==='loading')store.setRefreshJob({...lastRefresh,status:'interrupted',error:'更新已中断；已完成的缓存保留，选择剩余股票后再次更新。'});

  function start(id:string,job:EquityJob|Record<string,unknown>,work:(signal:AbortSignal)=>Promise<void>){
    if(active||discovery.busy)fail(409,'已有研究或更新正在执行');
    const controller=new AbortController();
    const running={id,controller,task:Promise.resolve(),job};active=running;
    running.task=Promise.resolve().then(()=>work(controller.signal)).catch(()=>{
      // Work functions normally persist detailed safe failures themselves.
      if('researchDomain' in job){const result=job as EquityJob;result.status=controller.signal.aborted?'cancelled':'failed';result.error='运行未完成，已保存的证据保留。';store.finish(safe(result));}
      else store.setRefreshJob({...job,status:controller.signal.aborted?'cancelled':'failed',error:'更新未完成，已保存的缓存保留。'});
    }).finally(()=>{if(active===running)active=undefined;});
  }
  function transport(signal:AbortSignal,job:EquityJob|Record<string,unknown>,refs:SourceRef[],symbol:string){
    const c=config();let http=0;
    const began=performance.now(),previous='researchDomain' in job?(job as EquityJob).counts.elapsedMs:0;
    return new EquityTransport(c,{...('kind' in job&&job.kind==='market'?{}:{quota:getQuota()}),...(c.twelveDataKey?{twelveQuota:getTwelveQuota()}:{}),fetch:options.fetch,signal,
      beforeRequest:async()=>{
        signal.throwIfAborted();
        if('researchDomain' in job){const j=job as EquityJob;if(j.counts.dataHttpRequests>=32||previous+performance.now()-began>=300_000)throw Error('HTTP_BUDGET');j.counts.dataHttpRequests++;j.counts.elapsedMs=Math.ceil(previous+performance.now()-began);store.finish(safe(j));}
        else{http++;job.httpAttempts=http;store.setRefreshJob(safe(job));}
      },
      record:async record=>{
        const r=record as {provider?:string;endpoint?:string;fetchedAt?:string;symbol?:string;body?:unknown};
        const ref=await store.evidence(symbol,`${r.provider??'provider'}:${r.endpoint??'response'}`,safe(record));refs.push(ref);
        if(r.provider==='fmp'&&r.endpoint==='profile'&&r.symbol&&r.body)store.setProfileRef(r.symbol,ref);
      },
    });
  }
  function provider(signal:AbortSignal,job:EquityJob|Record<string,unknown>,refs:SourceRef[],symbol:string){
    return new EquityProvider(transport(signal,job,refs,symbol),{profileCache:{get:async ticker=>{const ref=store.profileRef(ticker);if(!ref||!fresh(ref.fetchedAt,7*86_400_000))return;const proof=await store.readEvidence(ref.id);refs.push(ref);return proof.data.body;}}});
  }
  async function obtainCompany(symbol:string,source:EquityProvider,refs:SourceRef[]):Promise<{snapshot:CompanySnapshot;id:string}>{
    const raw=await source.getCompany(symbol);
    if(raw.security.kind!=='common-stock')fail(422,'本版只支持已核验的美国上市普通股');
    const financials=normalizeFinancials(raw.companyFacts,raw.security.industry);
    if(!raw.security.industry?.trim()){
      financials.industryExclusion='unclassified';
      financials.warnings.push('证券行业分类尚未核验，不提供普通公司比率比较。');
    }
    const stocksUnavailable=raw.warnings.some(w=>w.startsWith(stockPriceWarning));
    const old=stocksUnavailable?await store.company(symbol):undefined;
    const cached=old&&old.security.cik===raw.security.cik&&old.security.exchange===raw.security.exchange&&verifiedStockPrice(old.prices,symbol)?old:undefined;
    const prices=raw.prices??cached?.prices;
    const retained=cached?.sourceRefs.filter(ref=>ref.source==='twelve-data:stock_time_series').at(-1);
    const sourceRefs=retained?[...refs,retained]:[...refs];
    const snapshot:CompanySnapshot=safe({security:raw.security,...(prices?{prices}:{}),financials,
      metrics:deriveMetrics(raw.security,financials,prices,sourceRefs.map(r=>r.id)),filings:raw.filings.slice(0,30),sourceRefs,fetchedAt:new Date().toISOString(),warnings:cached?[...raw.warnings,'保留上一份拆股复权日线，请核对实际行情日期。']:raw.warnings});
    const id=await store.saveCompany(safe(snapshot));return{snapshot,id};
  }
  async function refreshCachedStockPrices(snapshot:CompanySnapshot,source:EquityProvider,refs:SourceRef[]){
    const prices=await source.getStockPrices(snapshot.security);
    const sourceRefs=[...snapshot.sourceRefs.filter(ref=>ref.source!=='twelve-data:stock_time_series'),...refs];
    const returns=derivePriceReturns(prices,refs.map(ref=>ref.id));
    const pe=deriveMetrics(snapshot.security,snapshot.financials,prices,sourceRefs.map(ref=>ref.id)).pe!;
    const warnings=snapshot.warnings.filter(w=>!w.startsWith(stockPriceWarning)&&!w.startsWith('prices:')&&w!=='保留上一份拆股复权日线，请核对实际行情日期。');
    await store.saveCompany(safe({...snapshot,prices,metrics:{...snapshot.metrics,...returns,pe},sourceRefs,warnings}));
  }
  async function readyToResume(sessionId:string,runId:string){
    const source=store.run(sessionId,runId),cp=store.loadCheckpoint(runId);
    if(!source||!['cancelled','failed','interrupted'].includes(source.status)||!cp||cp.sessionId!==sessionId||cp.symbol!==source.symbol)return;
    if(cp.counts.modelRequests>=15||cp.counts.toolCalls>=12||cp.counts.dataHttpRequests>=32||cp.counts.elapsedMs+cp.reservedMs>=300_000)return;
    if(!cp.queryIds.length)return;
    try{
      for(const id of cp.queryIds){const q=await store.readEvidence(id);if(!source.queries.some(v=>v.queryId===id)||q.symbol!==source.symbol&& !source.queries.some(v=>v.queryId===id&&v.source==='peer_snapshot'))return;}
      const first=await store.readEvidence(cp.queryIds[0]!);const snapshot=first.data as CompanySnapshot;
      if(first.source!=='SEC / FMP normalized snapshot'||snapshot.security.symbol!==source.symbol)return;
      for(const ref of snapshot.sourceRefs){const raw=await store.readEvidence(ref.id);if(!raw)return;}
      return{source,cp,snapshot};
    }catch{return;}
  }
  async function runResearch(job:EquityJob,refresh:boolean,signal:AbortSignal,recovery?:{cp:EquityCheckpoint;snapshot:CompanySnapshot}){
    const refs:SourceRef[]=[];const api=provider(signal,job,refs,job.symbol);const startTime=performance.now(),initialElapsed=job.counts.elapsedMs;
    let runtimeStarted=false;
    try{
      let snapshot:CompanySnapshot|undefined=recovery?.snapshot,id=recovery?.cp.queryIds[0],historical:EquityJob|undefined;
      const themeContext=job.discoveryContext&&!recovery?await discovery.context(job.discoveryContext,job.symbol):undefined;
      if(themeContext){snapshot=themeContext.company.snapshot;id=themeContext.company.snapshotId;}
      if(!snapshot&&!refresh){
        const session=store.session(job.sessionId)!;
        const requested=job.question.match(/q_[A-Za-z0-9_-]+/g)??[];
        const matching=session.turns.filter(turn=>turn.id!==job.id&&requested.some(id=>turn.queries.some(q=>q.queryId===id)));
        const snapshots=new Set(matching.flatMap(turn=>turn.queries.filter(q=>q.source==='company_snapshot').map(q=>q.queryId)));
        if(snapshots.size>1)fail(400,'问题引用多个不同时点，请每次选择一个历史快照');
        const previous=requested.length?matching[0]:[...session.turns].reverse().find(turn=>turn.id!==job.id&&turn.queries.some(q=>q.source==='company_snapshot'));
        historical=previous;
        id=previous?.queries.find(q=>q.source==='company_snapshot')?.queryId??job.screenContext?.snapshotId??store.companyRef(job.symbol);
        if(id){const proof=await store.readEvidence(id);if(proof.symbol!==job.symbol)fail(400,'快照与研究股票不匹配');snapshot=proof.data;}
      }
      if(!snapshot){const loaded=await obtainCompany(job.symbol,api,refs);snapshot=loaded.snapshot;id=loaded.id;}
      if(snapshot.security.symbol!==job.symbol||snapshot.security.kind!=='common-stock')fail(422,'证券身份未通过核验');
      if(!id)throw Error('Snapshot missing');
      if(!recovery)job.queries=historical?structuredClone(historical.queries):[{queryId:id,symbol:job.symbol,source:'company_snapshot',fetchedAt:snapshot.fetchedAt,data:{security:snapshot.security,metrics:snapshot.metrics}}];
      if(themeContext){
        const ref=await store.evidence(job.symbol,'AI application theme context',safe(themeContext.summary));
        job.queries.push({queryId:ref.id,symbol:job.symbol,source:'AI application theme context',fetchedAt:ref.fetchedAt,data:themeContext.summary});
        for(const d of themeContext.documents){
          const text=retrieveChunks(d,job.question,{limit:3}).chunks.map(c=>c.text).join('\n');
          const proof=await store.evidence(job.symbol,d.sourceKind==='sec'?'SEC disclosure':'Issuer disclosure',safe({accession:d.accession??d.id,text,url:d.url,filed:d.publishedAt,sourceDocumentId:d.id}));
          job.queries.push({queryId:proof.id,symbol:job.symbol,source:d.sourceKind==='sec'?'SEC disclosure':'Issuer disclosure',fetchedAt:proof.fetchedAt,data:{accession:d.accession??d.id,filed:d.publishedAt}});
        }
      }
      if(recovery)job.queries=recovery.cp.queryIds.map(queryId=>recoverySourceQuery(queryId));
      let peers:CompanySnapshot[]=[];
      if(recovery||historical){for(const q of job.queries.filter(q=>q.source==='peer_snapshot'))peers.push((await store.readEvidence(q.queryId)).data);}
      else {
        const cached=await store.companies();
        peers=cached.filter(s=>s.security.symbol!==job.symbol&&s.security.kind==='common-stock'&&Boolean(snapshot!.security.sector)&&s.security.sector===snapshot!.security.sector).slice(0,3);
        for(const peer of peers){const pid=store.companyRef(peer.security.symbol);if(pid)job.queries.push({queryId:pid,symbol:peer.security.symbol,source:'peer_snapshot',fetchedAt:peer.fetchedAt,data:{security:peer.security,metrics:peer.metrics}});}
      }
      const allowedFilings=new Set(snapshot.filings.map(f=>f.accession));
      const readDisclosure=async(filing:Filing,toolSignal:AbortSignal)=>{
        toolSignal.throwIfAborted();
        if(!allowedFilings.has(filing.accession))throw Error('FILING_NOT_AUTHORIZED');
        const existing=job.queries.find(q=>q.source==='SEC disclosure'&&(q.data as {accession?:string})?.accession===filing.accession);
        if(existing){const proof=await store.readEvidence(existing.queryId);return {queryId:existing.queryId,text:String(proof.data.text)};}
        // A fresh transport must re-verify the exact original filing link through
        // the same CIK's current SEC submissions before it is allowed to fetch it.
        const transport=new EquityTransport(config(),{quota:getQuota(),fetch:options.fetch,signal:toolSignal,beforeRequest:async()=>{toolSignal.throwIfAborted();if(job.counts.dataHttpRequests>=32)throw Error('HTTP_BUDGET');job.counts.dataHttpRequests++;store.finish(safe(job));}});
        const current=await transport.request('sec',`submissions/CIK${snapshot!.security.cik}.json`) as {filings?:{recent?:{accessionNumber?:string[];primaryDocument?:string[]}}};
        toolSignal.throwIfAborted();
        const index=current.filings?.recent?.accessionNumber?.indexOf(filing.accession)??-1;
        if(index<0||current.filings?.recent?.primaryDocument?.[index]!==filing.primaryDocument)throw Error('FILING_NO_LONGER_VERIFIABLE');
        const html=await new EquityProvider(transport).getFiling(filing);
        toolSignal.throwIfAborted();
        const {buildDocument}=await import('../../equity-data/src/documents.js');
        const document=buildDocument({id:`d_${randomUUID()}`,symbol:job.symbol,cik:snapshot!.security.cik,sourceKind:'sec',url:filing.url,form:filing.form,accession:filing.accession,publishedAt:filing.filed,html});
        const text=retrieveChunks(document,job.question,{limit:3}).chunks.map(c=>c.text).join('\n');
        const proof=await store.evidence(job.symbol,'SEC disclosure',safe({accession:filing.accession,url:filing.url,filed:filing.filed,text,truncated:text.length>=30_000}));
        job.queries.push({queryId:proof.id,symbol:job.symbol,source:'SEC disclosure',fetchedAt:proof.fetchedAt,data:{accession:filing.accession,filed:filing.filed}});store.finish(safe(job));
        return{queryId:proof.id,text};
      };
      function recoverySourceQuery(queryId:string){const original=store.run(job.sessionId,job.resumeOf!)!.queries.find(q=>q.queryId===queryId);if(!original)throw Error('Recovered query missing');return original;}
      job.counts.elapsedMs=initialElapsed+Math.ceil(performance.now()-startTime);
      const request=options.request??createDeepSeekRequest(modelConfig());
      runtimeStarted=true;
      const result=await runEquityResearch({job,snapshot,peers,request,signal,checkpoint:recovery?.cp,readDisclosure,readSavedDisclosure:async queryId=>{if(!job.queries.some(q=>q.queryId===queryId&&['SEC disclosure','Issuer disclosure'].includes(q.source)))throw Error('UNAUTHORIZED_EVIDENCE');const q=await store.readEvidence(queryId);return{queryId,text:String(q.data.text),source:q.source};},secrets:secrets(),saveCheckpoint:async cp=>{store.checkpoint(cp);store.finish(safe(job));}});
      store.finish(safe(result));
    }catch(error){
      if(runtimeStarted)throw error;
      job.status=signal.aborted?'cancelled':'failed';job.error=`无法取得并核验证券数据：${safeEquityCode(error)}。已保存的历史证据保留。`;
      job.counts.elapsedMs=initialElapsed+Math.ceil(performance.now()-startTime);job.resumable=false;store.finish(safe(job));
    }
  }

  async function route(method:string,path:string,body:Record<string,unknown>,params:URLSearchParams):Promise<RouteResult>{
    if(closed)fail(503,'研究服务正在关闭');
    if(path.startsWith('/discovery/')){try{return await discovery.route(method,path.slice('/discovery'.length),body,params);}catch(error){if(error instanceof DiscoveryHttpError)throw new EquityHttpError(error.status,error.message);throw error;}}
    if(method==='GET'&&path==='/state'){
      const c=configured(),sessions=store.sessions();
      for(const s of sessions)for(const j of s.turns)j.resumable=Boolean(await readyToResume(s.id,j.runId));
      const companies=await store.companies();
      let used=0,marketUsed=0,quotaError='';try{used=getQuota().usage();marketUsed=getTwelveQuota().usage();}catch{quotaError='行情额度记录无法读取；已停止供应商更新。';}
      return{status:200,value:safe({configured:c,capabilities:{market:c.twelveData,research:c.deepseek&&(c.fmp&&c.sec||companies.length>0),secReports:c.sec},busy:Boolean(active)||discovery.busy,pool:store.pool(),market:store.marketSeries().length&&store.marketSeries().every(s=>s.source===TWELVE_PRICE_SOURCE)?store.market():null,companies,sessions,activeJob:active?.job??discovery.activeJob??store.refreshJob(),quota:{used,limit:config().dailyLimit},marketQuota:{used:marketUsed,limit:config().twelveDataDailyLimit??600,provider:'twelve-data'},coverage:store.coverage(),...(quotaError?{error:quotaError}:{})})};
    }
    const evidence=/^\/evidence\/(j_[A-Za-z0-9_-]+)\/(q_[A-Za-z0-9_-]+)$/.exec(path);
    if(method==='GET'&&evidence){
      const job=store.job(evidence[1]!);if(!job||!job.queries.some(q=>q.queryId===evidence[2]))fail(404,'本轮未引用此证据');
      const raw=params.get('offset')??'0';if(!/^\d{1,6}$/.test(raw))fail(400,'无效证据分页');
      const proof=await store.readEvidence(evidence[2]!);const offset=Number(raw);
      const company=proof.data as CompanySnapshot;
      const rows=proof.source==='SEC / FMP normalized snapshot'?[...company.financials.annual,...company.financials.quarterly]:Array.isArray(proof.data)?proof.data:[proof.data];
      return{status:200,value:safe({query:{queryId:proof.queryId,symbol:proof.symbol,source:proof.source,fetchedAt:proof.fetchedAt},data:proof.source==='SEC / FMP normalized snapshot'?{security:company.security,metrics:company.metrics,filings:company.filings,rows:rows.slice(offset,offset+10),sourceRefs:company.sourceRefs}:rows.slice(offset,offset+10),offset,total:rows.length,nextOffset:offset+10<rows.length?offset+10:null})};
    }
    if(method!=='POST')fail(404,'美股接口不存在');
    if(path==='/cancel'){
      only(body,['jobId']);if(discovery.activeJob?.id===body.jobId)return discovery.route('POST','/cancel',body,new URLSearchParams());if(typeof body.jobId!=='string')fail(400,'缺少运行ID');const requested=active?.id===body.jobId;
      if(requested)active!.controller.abort(Error('User cancelled'));return{status:200,value:{requested}};
    }
    if(path==='/pool'){
      only(body,['symbols']);if(active||discovery.busy)fail(409,'请等待本轮结束后修改股票池');
      if(!Array.isArray(body.symbols)||body.symbols.some(s=>!validSymbol(s)))fail(400,'请输入有效的股票代码');
      try{return{status:200,value:store.setPool(body.symbols as string[])};}catch{fail(400,'股票池最多10只，代码不可重复');}
    }
    if(path==='/screen'){
      only(body,['filters','sortBy','descending']);
      try{
        const companies=await store.companies(),filters=validateFilters(body.filters);
        if(body.sortBy!==undefined&&typeof body.sortBy!=='string'||body.descending!==undefined&&typeof body.descending!=='boolean')fail(400,'无效排序条件');
        const benchmark=store.marketSeries().find(series=>series.symbol==='SPY'&&series.source===TWELVE_PRICE_SOURCE);
        const result=screenCompanies(companies,filters,{sortBy:body.sortBy as string|undefined,descending:body.descending as boolean|undefined,benchmark});
        const missing=store.pool().symbols.filter(s=>!companies.some(c=>c.security.symbol===s));
        result.total=store.pool().symbols.length;result.missing+=missing.length;result.excluded.push(...missing.map(symbol=>({symbol,reason:'尚未取得并核验本机数据'})));
        for(const match of result.matches)match.snapshotId=store.companyRef(match.symbol);
        return{status:200,value:safe(result)};
      }catch(error){if(error instanceof EquityHttpError)throw error;fail(400,'筛选条件不支持；请选择已支持字段和数值条件');}
    }
    if(active||discovery.busy)fail(409,'已有研究或更新正在执行');
    if(path==='/refresh'){
      only(body,['kind','symbols']);const c=configured();
      if(body.kind!=='market'&&body.kind!=='stocks')fail(400,'无效更新类型');
      if(body.kind==='market'&&!c.twelveData)fail(503,'请先在本地 .env 配置 TWELVE_DATA_API_KEY');
      if(body.kind==='stocks'&&!c.fmp)fail(503,'请先在本地 .env 配置 FMP_API_KEY');
      if(body.kind==='market'&&body.symbols!==undefined)fail(400,'市场代理由设计固定，请单独更新股票池');
      const symbols=body.kind==='market'?[...MARKET_SYMBOLS]:body.symbols;
      if(!Array.isArray(symbols)||!symbols.length||symbols.some(s=>!validSymbol(s))||new Set(symbols).size!==symbols.length)fail(400,'请选择有效且不重复的股票代码');
      if(body.kind==='stocks'&&(!c.sec||symbols.length>5||symbols.some(s=>!store.pool().symbols.includes(String(s)))))fail(400,'股票更新需 SEC_USER_AGENT，且每批最多5只池内股票');
      const job:Record<string,unknown>={id:`j_${randomUUID()}`,status:'loading',kind:body.kind,symbols,completed:[],remaining:symbols,errors:[],httpAttempts:0,createdAt:new Date().toISOString()};store.setRefreshJob(job);
      start(String(job.id),job,async signal=>{
        const refs:SourceRef[]=[],wire=transport(signal,job,refs,String(body.kind)),marketApi=new TwelveDataProvider(wire),api=new EquityProvider(wire,{profileCache:{get:async ticker=>{const ref=store.profileRef(ticker);if(!ref||!fresh(ref.fetchedAt,7*86_400_000))return;refs.push(ref);return (await store.readEvidence(ref.id)).data.body;}}}),completed:string[]=[],errors:{symbol:string;code:string}[]=[],series=new Map(store.marketSeries().filter(s=>s.source===TWELVE_PRICE_SOURCE).map(s=>[s.symbol,s]));
        for(const symbol of symbols as string[]){
          if(signal.aborted)break;
          try{
            if(body.kind==='market'){const existing=series.get(symbol);if(!existing||!fresh(existing.fetchedAt,86_400_000))series.set(symbol,await marketApi.getMarket(symbol));}
            else{
              const existing=await store.company(symbol);
              refs.length=0;
              if(!existing||!fresh(existing.fetchedAt,86_400_000)){
                const {snapshot}=await obtainCompany(symbol,api,refs);
                const priceFailure=snapshot.warnings.find(w=>w.startsWith(stockPriceWarning));
                if(priceFailure)throw new EquityDataError(priceFailure.slice(stockPriceWarning.length));
              }else if(c.twelveData){
                const prices=existing.prices;
                const reusable=verifiedStockPrice(prices,symbol)&&fresh(prices!.fetchedAt,86_400_000)&&currentNewYorkDate(prices!.fetchedAt)===currentNewYorkDate();
                if(!reusable)await refreshCachedStockPrices(existing,api,refs);
              }
            }
            completed.push(symbol);
          }catch(error){const code=safeEquityCode(error);errors.push({symbol,code});if(['RATE_LIMIT','QUOTA_EXHAUSTED','QUOTA_STORAGE','HTTP_BUDGET','STAGE_DEADLINE'].includes(code))break;}
          job.completed=[...completed];job.remaining=(symbols as string[]).filter(s=>!completed.includes(s));job.errors=[...errors];store.setRefreshJob(safe(job));
        }
        if(body.kind==='market'){
          store.setMarketSeries([...series.values()]);const market=buildMarketSnapshot([...series.values()]);
          if(errors.length)market.warnings.push('本次部分更新失败，旧快照仍保留；请核对数据日期。');store.setMarket(market);
        }
        const companies=await store.companies();store.setCoverage({verifiedMarket:store.market()?.coverage??0,verifiedStocks:companies.filter(c=>c.security.kind==='common-stock'&&Boolean(c.prices?.bars.length)).length});
        Object.assign(job,{status:signal.aborted?'cancelled':errors.length||completed.length!==symbols.length?'partial':'completed',completed,remaining:(symbols as string[]).filter(s=>!completed.includes(s)),errors,...(errors.length?{error:'部分数据未取得；已完成进度已保存，剩余部分需显式更新。'}:{})});store.setRefreshJob(safe(job));
      });return{status:202,value:{jobId:job.id}};
    }
    if(path==='/research'){
      only(body,['symbol','question','sessionId','screenContext','refresh','discoveryContext']);
      if(!validSymbol(body.symbol)||typeof body.question!=='string'||!body.question.trim()||body.question.length>4000||body.refresh!==undefined&&typeof body.refresh!=='boolean'||body.sessionId!==undefined&&typeof body.sessionId!=='string')fail(400,'请提供准确的股票代码和1–4000字符的研究问题');
      const symbol=body.symbol as string,question=String(safe(body.question));
      if(body.discoveryContext){if(body.sessionId||body.refresh)fail(400,'主题研究请使用独立的新会话及已保存快照');await discovery.context(body.discoveryContext,symbol);}
      if(body.sessionId){const session=store.session(String(body.sessionId));if(!session)fail(404,'未找到美股会话');if(session.symbol!==symbol)fail(400,'会话股票固定，请新建研究');}
      const c=configured();if(!c.deepseek)fail(503,'请先在本地 .env 配置 DeepSeek');
      const cached=await store.company(symbol);if((body.refresh||!cached)&&(!c.fmp||!c.sec))fail(503,'首次或刷新研究需配置 FMP_API_KEY 和 SEC_USER_AGENT');
      let screenContext:EquityJob['screenContext'];
      if(body.screenContext!==undefined){const v=body.screenContext as Record<string,unknown>;if(!v||typeof v!=='object'||Array.isArray(v))fail(400,'无效筛选背景');only(v,['filters','snapshotId']);
        try{screenContext={filters:validateFilters(v.filters),...(typeof v.snapshotId==='string'?{snapshotId:v.snapshotId}:{})};if(screenContext.snapshotId){const p=await store.readEvidence(screenContext.snapshotId);if(p.symbol!==symbol||p.source!=='SEC / FMP normalized snapshot')fail(400,'筛选快照与股票不匹配');}}catch{fail(400,'无效筛选背景或快照引用');}}
      const requested=question.match(/q_[A-Za-z0-9_-]+/g)??[];
      if(requested.length){const session=body.sessionId?store.session(String(body.sessionId)):undefined;const allowed=new Set(session?.turns.flatMap(t=>t.queries.map(q=>q.queryId))??[]);if(body.refresh||requested.some(q=>!allowed.has(q)))fail(400,'历史证据必须来自本会话；刷新不能与旧证据ID混用');}
      const job=store.accept(symbol,question,body.sessionId as string|undefined,screenContext);if(body.discoveryContext){job.discoveryContext=body.discoveryContext as EquityJob['discoveryContext'];store.finish(job);}start(job.id,job,signal=>runResearch(job,body.refresh===true,signal));return{status:202,value:{jobId:job.id,sessionId:job.sessionId}};
    }
    if(path==='/resume'){
      only(body,['sessionId','runId']);if(typeof body.sessionId!=='string'||typeof body.runId!=='string')fail(400,'缺少源会话或运行ID');
      const recovered=await readyToResume(String(body.sessionId),String(body.runId));if(!recovered)fail(409,'源运行不可恢复、已恢复、预算耗尽或证据校验失败');
      if(!configured().deepseek)fail(503,'请配置 DeepSeek 后恢复');
      const job=store.accept(recovered.source.symbol,recovered.source.question,recovered.source.sessionId,recovered.source.screenContext);
      job.resumeOf=recovered.source.runId;job.counts={...recovered.cp.counts};job.tokenUsage={...recovered.cp.tokenUsage};job.queries=[...recovered.source.queries];
      store.activateResume(recovered.source.runId,job,recovered.cp);start(job.id,job,signal=>runResearch(job,false,signal,{cp:recovered.cp,snapshot:recovered.snapshot}));return{status:202,value:{jobId:job.id,sessionId:job.sessionId}};
    }
    fail(404,'美股接口不存在');
  }
  async function guardedRoute(method:string,path:string,body:Record<string,unknown>,params:URLSearchParams){
    if(method!=='POST'||!['/research','/refresh','/resume'].includes(path))return route(method,path,body,params);
    if(accepting||active||discovery.busy)fail(409,'已有研究或更新正在准备或执行');
    accepting=true;try{return await route(method,path,body,params);}finally{accepting=false;}
  }
  return {route:guardedRoute,get busy(){return Boolean(active)||accepting;},wait:async()=>{await active?.task;await discovery.wait();},close:async()=>{closed=true;active?.controller.abort();await active?.task;await discovery.close();quota?.close();twelveQuota?.close();store.close();}};
}

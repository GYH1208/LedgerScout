import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEquityService } from '../src/equity-service.js';
import type { EquityConfig } from '../../equity-data/src/config.js';

const config=(dir:string):EquityConfig=>({fmpKey:'',secUserAgent:'',timeoutMs:1000,maxRetries:0,dailyLimit:200,outputDirectory:dir});
test('missing configuration and browsing cached views do not issue model or supplier requests',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'equity-service-'));let calls=0;
  const service=createEquityService({directory:dir,config:()=>config(dir),fetch:async()=>{calls++;throw Error('must not fetch');},request:async()=>{calls++;return{content:''};}});
  try {
    const state=await service.route('GET','/state',{},new URLSearchParams());
    assert.equal((state.value as any).configured.fmp,false);assert.equal((state.value as any).configured.sec,false);
    assert.equal((state.value as any).market,null);
    await assert.rejects(service.route('POST','/refresh',{kind:'market'},new URLSearchParams()),/TWELVE_DATA/);
    const screen=await service.route('POST','/screen',{filters:[]},new URLSearchParams());
    assert.equal((screen.value as any).total,0);assert.equal(calls,0);
  } finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('market refresh uses Twelve Data without FMP or SEC, replaces old-provider cache and reuses verified fresh series',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'equity-td-'));const {EquityStore}=await import('../src/equity-store.js');
  const {MARKET_SYMBOLS}=await import('../../equity-data/src/types.js');const seed=new EquityStore(dir);
  seed.setMarketSeries(MARKET_SYMBOLS.map(symbol=>({symbol,bars:[{date:'2026-11-13',close:1}],adjustment:'split-adjusted' as const,source:symbol==='SPY'?'fmp:historical-price-eod/light':'twelve-data:time_series:adjust=splits',fetchedAt:new Date().toISOString()})));seed.close();
  let calls=0;
  const service=createEquityService({directory:dir,config:()=>({...config(dir),twelveDataKey:'test-td-key'}),fetch:async input=>{
    calls++;assert.equal(new URL(String(input)).hostname,'api.twelvedata.com');
    return Response.json({meta:{symbol:'SPY',interval:'1day',currency:'USD',exchange_timezone:'America/New_York',mic_code:'ARCX',type:'ETF'},status:'ok',values:[{datetime:'2026-11-13',close:'100'}]});
  }});
  try{
    await service.route('POST','/refresh',{kind:'market'},new URLSearchParams());await service.wait();
    let state=(await service.route('GET','/state',{},new URLSearchParams())).value as any;
    assert.equal(state.configured.fmp,false);assert.equal(state.configured.twelveData,true);assert.equal(state.capabilities.market,true);
    assert.equal(state.market.coverage,13);assert.equal(state.market.rows[0].price,100);assert.equal(state.activeJob.status,'completed');
    assert.equal(state.marketQuota.used,1);assert.equal(state.quota.used,0);assert.equal(calls,1);
    await service.route('POST','/refresh',{kind:'market'},new URLSearchParams());await service.wait();
    state=(await service.route('GET','/state',{},new URLSearchParams())).value as any;assert.equal(calls,1);assert.equal(state.activeJob.httpAttempts,0);
  }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('web and CLI use the configured shared supplier quota directory',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'equity-quotapath-')),quotaDir=join(dir,'shared');
  const {TwelveDataQuota}=await import('../../equity-data/src/twelve-quota.js');
  const reserve=new TwelveDataQuota(join(quotaDir,'twelve-data-quota.sqlite'));reserve.reserve();reserve.close();
  const service=createEquityService({directory:join(dir,'web'),config:()=>({...config(quotaDir),twelveDataKey:'test-key'})});
  try{const state=(await service.route('GET','/state',{},new URLSearchParams())).value as any;assert.equal(state.marketQuota.used,1);}
  finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('stock refresh upgrades a fresh legacy snapshot and its screen using Twelve Data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'equity-td-stock-'));
  const {EquityStore}=await import('../src/equity-store.js');
  const {previousNewYorkDate}=await import('../../equity-data/src/twelve-data.js');
  const seed=new EquityStore(dir);
  const now=new Date().toISOString(),last=previousNewYorkDate(now);
  const security={symbol:'CRM',name:'Salesforce',cik:'0001108524',exchange:'NYSE',currency:'USD',country:'US',kind:'common-stock' as const,industry:'Software'};
  const financials={annual:[],quarterly:[],warnings:[]};
  seed.setPool(['CRM']);
  const oldId=await seed.saveCompany({security,financials,prices:{symbol:'CRM',adjustment:'unknown',source:'fmp:historical-price-eod/light',fetchedAt:now,bars:[{date:last,close:99}]},metrics:{},filings:[],sourceRefs:[],warnings:[],fetchedAt:now});
  seed.close();
  const days=Array.from({length:65},(_,i)=>new Date(Date.parse(last)-(64-i)*86_400_000).toISOString().slice(0,10));
  let calls=0,researchContext='';
  const service=createEquityService({directory:dir,config:()=>({...config(dir),fmpKey:'stock-fmp-key',secUserAgent:'test@ledgerscout.invalid',twelveDataKey:'stock-td-key'}),request:async request=>{
    researchContext=request.messages.map(message=>message.content).join('\n');
    return {content:'{}'};
  },fetch:async(input,init)=>{
    calls++;const url=new URL(String(input));
    assert.equal(url.hostname,'api.twelvedata.com');
    assert.equal(url.searchParams.get('type'),'Common Stock');
    assert.equal(url.searchParams.get('symbol'),'CRM');
    assert.equal(url.searchParams.get('adjust'),'splits');
    assert.equal(Date.parse(url.searchParams.get('end_date')!)-Date.parse(last),86_400_000);
    assert.equal(new Headers(init?.headers).get('Authorization'),'apikey stock-td-key');
    return Response.json({meta:{symbol:'CRM',interval:'1day',currency:'USD',exchange_timezone:'America/New_York',mic_code:'XNYS',type:'Common Stock'},status:'ok',values:days.map((datetime,i)=>({datetime,close:String(100+i)}))});
  }});
  try{
    await service.route('POST','/refresh',{kind:'stocks',symbols:['CRM']},new URLSearchParams());await service.wait();
    const state=(await service.route('GET','/state',{},new URLSearchParams())).value as any;
    assert.equal(calls,1);assert.equal(state.activeJob.status,'completed');assert.equal(state.marketQuota.used,1);assert.equal(state.quota.used,0);
    assert.equal(state.companies[0].prices.adjustment,'split-adjusted');
    assert.equal(state.companies[0].fetchedAt,now);
    assert.deepEqual(state.companies[0].financials,financials);
    assert.equal(state.companies[0].metrics.pe.value,null);
    assert.ok(state.companies[0].sourceRefs.some((ref:any)=>ref.source.startsWith('twelve-data:')));
    assert.ok(!JSON.stringify(state).includes('stock-td-key'));
    const screen=(await service.route('POST','/screen',{filters:[{field:'return63d',op:'gt',value:0}]},new URLSearchParams())).value as any;
    assert.deepEqual(screen.matches.map((match:any)=>match.symbol),['CRM']);
    assert.notEqual(screen.matches[0].snapshotId,oldId);
    await service.route('POST','/research',{symbol:'CRM',question:'近 63 个交易日表现如何？'},new URLSearchParams());await service.wait();
    assert.match(researchContext,/"return63d":\{"value":[0-9.]+/);
    assert.equal(calls,1);
  }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('explicit stock refresh saves source-backed snapshots and history follow-up reuses evidence without HTTP',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'equity-live-offline-'));let calls=0;
  const cfg={...config(dir),fmpKey:'offline-fmp-secret',secUserAgent:'LedgerScout testing contact@ledgerscout.invalid'};
  const service=createEquityService({directory:dir,config:()=>cfg,request:async r=>{
    const id=r.messages.map(m=>m.content).join('\n').match(/q_[A-Za-z0-9_-]+/)?.[0];
    return {content:JSON.stringify({analysis:'以本轮披露财务为依据的解释。',sourceRefs:[id]}),usage:{inputTokens:10,outputTokens:5,totalTokens:15}};
  },fetch:async input=>{
    calls++;const url=new URL(String(input));
    if(url.pathname.endsWith('/profile'))return Response.json([{symbol:'AAPL',companyName:'Apple',currency:'USD',country:'US',cik:'320193',exchange:'NASDAQ',isEtf:false,isFund:false,isAdr:false,isActivelyTrading:true,sector:'Technology',industry:'Consumer Electronics'}]);
    if(url.pathname.endsWith('company_tickers_exchange.json'))return Response.json({fields:['cik','name','ticker','exchange'],data:[[320193,'Apple','AAPL','Nasdaq']]});
    if(url.pathname.startsWith('/submissions/'))return Response.json({cik:'320193',tickers:['AAPL'],exchanges:['Nasdaq'],filings:{recent:{accessionNumber:[],form:[],filingDate:[],primaryDocument:[]}}});
    if(url.pathname.includes('companyfacts'))return Response.json({cik:320193,facts:{'us-gaap':{Revenues:{units:{USD:[{start:'2025-01-01',end:'2025-12-31',val:100,accn:'0000320193-26-000001',form:'10-K',filed:'2026-01-31',fy:2025,fp:'FY'}]}}}}});
    if(url.pathname.endsWith('/light'))return Response.json([{symbol:'AAPL',date:'2026-11-13',price:100,volume:200}]);
    throw Error('Unexpected URL');
  }});
  try {
    await service.route('POST','/pool',{symbols:['AAPL']},new URLSearchParams());
    const refresh=await service.route('POST','/refresh',{kind:'stocks',symbols:['AAPL']},new URLSearchParams());assert.equal(refresh.status,202);await service.wait();
    const state=(await service.route('GET','/state',{},new URLSearchParams())).value as any;
    assert.equal(state.companies.length,1);assert.equal(state.companies[0].security.cik,'0000320193');assert.equal(calls,5);
    const first=(await service.route('POST','/research',{symbol:'AAPL',question:'说明收入口径'},new URLSearchParams())).value as any;await service.wait();
    const after=(await service.route('GET','/state',{},new URLSearchParams())).value as any;
    const turn=after.sessions[0].turns[0];assert.ok(turn.answer.facts.some((f:string)=>f.includes('100')));assert.equal(turn.tokenUsage.totalTokens,15);
    await service.route('POST','/research',{symbol:'AAPL',sessionId:first.sessionId,question:'解释之前的财务'},new URLSearchParams());await service.wait();
    assert.equal(calls,5);
    const proof=await service.route('GET',`/evidence/${turn.id}/${turn.queries[0].queryId}`,{},new URLSearchParams());assert.equal(proof.status,200);
    await assert.rejects(service.route('GET',`/evidence/${turn.id}/q_foreign`,{},new URLSearchParams()),/引用|证据/);
    await assert.rejects(service.route('POST','/research',{symbol:'MSFT',sessionId:first.sessionId,question:'研究'},new URLSearchParams()),/固定|symbol/);
    const {EquityStore}=await import('../src/equity-store.js');const aging=new EquityStore(dir);
    const old=(await aging.company('AAPL'))!;old.fetchedAt=new Date(Date.now()-2*86_400_000).toISOString();await aging.saveCompany(old);aging.close();
    await service.route('POST','/refresh',{kind:'stocks',symbols:['AAPL']},new URLSearchParams());await service.wait();
    assert.equal(calls,9); // 3 SEC calls + price; seven-day profile cache avoids another FMP attempt.
    const renewed=(await service.route('GET','/state',{},new URLSearchParams())).value as any;assert.equal(renewed.quota.used,3);
  } finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('pool replacement does not authorize unrelated evidence and fixed snapshots survive cache refresh',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'equity-history-'));
  const service=createEquityService({directory:dir,config:()=>config(dir),request:async r=>({content:JSON.stringify({analysis:'历史解释',sourceRefs:[r.messages.map(m=>m.content).join('\n').match(/q_[A-Za-z0-9_-]+/)?.[0]]})})});
  try{
    // Use the actual persistence interface; no supplier or model implementation is mocked.
    const {EquityStore}=await import('../src/equity-store.js');const seed=new EquityStore(dir);
    const make=(revenue:number)=>({security:{symbol:'AAPL',name:'Apple',cik:'0000320193',exchange:'NASDAQ',currency:'USD',country:'US',kind:'common-stock' as const},financials:{annual:[],quarterly:[],warnings:[]},metrics:{revenue:{value:revenue,unit:'USD',definition:'revenue',period:'2025',sourceRefs:[]}},filings:[],sourceRefs:[],fetchedAt:new Date().toISOString(),warnings:[]});
    await seed.saveCompany(make(100));seed.close();
    const first=(await service.route('POST','/research',{symbol:'AAPL',question:'收入'},new URLSearchParams())).value as any;await service.wait();
    const source=(await service.route('GET','/state',{},new URLSearchParams())).value as any;const oldId=source.sessions[0].turns[0].queries[0].queryId;
    const updater=new EquityStore(dir);await updater.saveCompany(make(200));updater.close();
    await service.route('POST','/research',{symbol:'AAPL',sessionId:first.sessionId,question:`解释 ${oldId}`},new URLSearchParams());await service.wait();
    const next=(await service.route('GET','/state',{},new URLSearchParams())).value as any;const turn=next.sessions[0].turns.at(-1);
    assert.equal(turn.queries[0].queryId,oldId);assert.ok(turn.answer.facts.some((f:string)=>f.includes('100 USD')));
    await assert.rejects(service.route('POST','/research',{symbol:'AAPL',sessionId:first.sessionId,question:'读取 q_foreign'},new URLSearchParams()),/历史证据/);
  }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('simultaneous research admission rejects one request without leaving a loading history item',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'equity-admission-'));
  const {EquityStore}=await import('../src/equity-store.js');const seed=new EquityStore(dir);
  await seed.saveCompany({security:{symbol:'AAPL',name:'Apple',cik:'0000320193',exchange:'NASDAQ',currency:'USD',country:'US',kind:'common-stock'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{},filings:[],sourceRefs:[],fetchedAt:new Date().toISOString(),warnings:[]});seed.close();
  const service=createEquityService({directory:dir,config:()=>config(dir),request:async()=>({content:'{}'})});
  try{
    const result=await Promise.allSettled([1,2].map(()=>service.route('POST','/research',{symbol:'AAPL',question:'研究'},new URLSearchParams())));
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1);await service.wait();
    const state=(await service.route('GET','/state',{},new URLSearchParams())).value as any;
    assert.equal(state.sessions.flatMap((s:any)=>s.turns).length,1);
    assert.equal(state.sessions.flatMap((s:any)=>s.turns).filter((j:any)=>j.status==='loading').length,0);
  }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('cancel/restart/resume freezes peer authorization and counts, and consumed parents cannot resume twice',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'equity-resume-'));const {EquityStore}=await import('../src/equity-store.js');
  const seed=new EquityStore(dir);const make=(symbol:string)=>({security:{symbol,name:symbol,cik:'0000320193',exchange:'NASDAQ',currency:'USD',country:'US',kind:'common-stock' as const,sector:'Technology'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{},filings:[],sourceRefs:[],fetchedAt:new Date().toISOString(),warnings:[]});
  await seed.saveCompany(make('AAPL'));await seed.saveCompany(make('MSFT'));await seed.saveCompany(make('NVDA'));seed.setPool(['AAPL','MSFT']);seed.close();
  let entered:()=>void=()=>{};const started=new Promise<void>(r=>entered=r);
  let service=createEquityService({directory:dir,config:()=>config(dir),request:async r=>{entered();await new Promise((_resolve,reject)=>r.signal!.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));return{content:''};}});
  try{
    const accepted=(await service.route('POST','/research',{symbol:'AAPL',question:'比较同行'},new URLSearchParams())).value as any;await started;
    await service.route('POST','/cancel',{jobId:accepted.jobId},new URLSearchParams());await service.wait();
    let state=(await service.route('GET','/state',{},new URLSearchParams())).value as any;const parent=state.sessions[0].turns[0];
    assert.equal(parent.status,'cancelled');assert.equal(parent.resumable,true);assert.equal(parent.counts.modelRequests,1);
    await service.close();
    const update=new EquityStore(dir);update.setPool(['AAPL','NVDA']);update.close();
    let peerSymbols:string[]=[];
    service=createEquityService({directory:dir,config:()=>config(dir),request:async r=>{
      const tool=[...r.messages].reverse().find(m=>m.role==='tool');
      if(tool){peerSymbols=JSON.parse(tool.content).peers.map((p:any)=>p.security.symbol);return{content:'{}'};}
      return{content:'',toolCalls:[{id:'peer',name:'compare_pool_peers',arguments:{}}]};
    }});
    await service.route('POST','/resume',{sessionId:parent.sessionId,runId:parent.runId},new URLSearchParams());await service.wait();
    assert.deepEqual(peerSymbols,['MSFT']);state=(await service.route('GET','/state',{},new URLSearchParams())).value as any;
    const resumed=state.sessions[0].turns.at(-1);assert.equal(resumed.counts.modelRequests,3);assert.equal(resumed.counts.dataHttpRequests,0);
    assert.deepEqual(resumed.queries.map((q:any)=>q.symbol),['AAPL','MSFT']);
    await assert.rejects(service.route('POST','/resume',{sessionId:parent.sessionId,runId:parent.runId},new URLSearchParams()),/不可恢复|已恢复/);
  }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDiscoveryService} from '../src/discovery-service.js';
import {EquityStore} from '../src/equity-store.js';
import {DiscoveryStore} from '../src/discovery-store.js';
import {buildDocument} from '../../equity-data/src/documents.js';
import type {CompanySnapshot} from '../../equity-data/src/types.js';
test('discovery browsing/catalog edits are offline, batch limits are explicit and research pool stays separate',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'discovery-http-'));const equity=new EquityStore(dir);let calls=0;
  const service=createDiscoveryService({directory:dir,equity,config:()=>({fmpKey:'',secUserAgent:'',timeoutMs:1000,maxRetries:0,dailyLimit:200,outputDirectory:dir}),fetch:async()=>{calls++;throw Error('no network');}});
  const route=(method:string,path:string,body:any={})=>service.route(method,path,body,new URLSearchParams());
  try{
    const first=(await route('GET','/state')).value as any;assert.equal(first.coverage.verified,0);assert.equal(calls,0);
    const members=[{symbol:'MSFT',themes:['workflow'],sources:[]}];
    await route('POST','/universe',{expectedVersion:first.universe.version,members});
    assert.deepEqual(equity.pool().symbols,[]);assert.equal(calls,0);
    await assert.rejects(route('POST','/refresh',{symbols:['A','B','C','D','E','F']}),/5|batch|批/);
    await assert.rejects(route('POST','/scan',{symbols:['MSFT']}),/数据|缓存|configured|配置|证据/);
  }finally{await service.close();equity.close();await rm(dir,{recursive:true,force:true});}
});

test('cached theme to company to confirmed thesis and changed-evidence review preserves old versions',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'discovery-flow-')),equity=new EquityStore(dir),seed=new DiscoveryStore(dir);let models=0;
  const symbols=['AAA','BBB','CCC','DDD','EEE'];
  const make=(symbol:string,n=10):CompanySnapshot=>({security:{symbol,name:symbol,cik:'0000789019',currency:'USD',country:'US',exchange:'NASDAQ',kind:'common-stock'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{revenue:{value:n,unit:'USD',definition:'Revenue',period:'2026-09-30',sourceRefs:[]}},filings:[],sourceRefs:[],fetchedAt:new Date().toISOString(),warnings:[]});
  const quote='Artificial intelligence applications generated revenue of 12 million.';
  const document=(symbol:string,suffix='',value=12)=>buildDocument({id:`d_${symbol}${suffix}`,symbol,cik:'0000789019',sourceKind:'sec',url:`https://www.sec.gov/Archives/edgar/data/789019/${symbol}.htm`,publishedAt:'2026-10-30',html:`<h1>Item 1. Business</h1><p>${quote.replace('12',String(value))} Customers are evaluating adoption. Competitive risks remain. ${'Operations continue with reporting limitations. '.repeat(8)}</p>`});
  for(const s of symbols){await equity.saveCompany(make(s));await seed.saveDocument(document(s));}
  seed.setUniverse(symbols.map((symbol,i)=>({symbol,cik:'0000789019',themes:i<3?['workflow']:['developer'],verification:'verified',sources:[]})),0);
  const refresh:any={id:'j_coverage',kind:'refresh',createdAt:new Date().toISOString(),status:'partial',symbols:['AAA'],completed:['AAA'],remaining:[],errors:[],counts:{modelRequests:0,toolCalls:0,dataHttpRequests:2,elapsedMs:100},tokenUsage:{inputTokens:0,outputTokens:0,totalTokens:0,unknownRequests:0},input:{universeVersion:1,members:seed.universe().members.filter(m=>m.symbol==='AAA'),companies:[],question:'更新资料'},extractions:[],opportunities:[],checks:[{symbol:'AAA',sourceId:'sec-8k',url:'https://www.sec.gov/Archives/edgar/data/789019/AAA.htm',status:'not-checked',documentIds:[],checkedAt:new Date().toISOString(),reason:'附件未完整检查'}],gaps:[],reservedMs:0};seed.saveJob(refresh);
  const citation={chunkId:'d_AAA:c0',quote};const claim={text:quote,kind:'issuer-claim',scope:'ai-product',citations:[citation]};
  const service=createDiscoveryService({directory:dir,equity,config:()=>({fmpKey:'',secUserAgent:'',timeoutMs:1000,maxRetries:0,dailyLimit:200,outputDirectory:dir}),request:async request=>{
    models++;const content=request.messages.map(m=>m.content).join('');
    if(content.includes('对已确认观点提出复核'))return{content:JSON.stringify({impact:'mixed',explanation:'新增披露需继续验证',citations:[{chunkId:'d_AAA_new:c0',quote:quote.replace('12','13')}],gaps:['新报告仍需独立验证']})};
    if(content.includes('返回{claims'))return{content:JSON.stringify({claims:[claim],opposing:[],gaps:['公司自述尚需验证']})};
    return{content:JSON.stringify({opportunities:[{theme:'workflow',title:'应用采用',mechanism:'采用转化为收入仍待验证',whyNow:'新披露提供线索',stage:'revenue',support:[claim],opposing:[],gaps:['公司自述尚需验证'],candidates:[{symbol:'AAA',role:'应用方',exposure:'ai-product'}],checks:['下期披露'],invalidation:'采用未兑现',nextCheck:'2027-02-01'}]})};
  }});
  const route=(method:string,path:string,body:any={})=>service.route(method,path,body,new URLSearchParams());
  try{
    assert.equal(((await route('GET','/state')).value as any).coverage.prepared,true);
    const current=(await route('GET','/state')).value as any;
    await route('POST','/universe',{expectedVersion:current.universe.version,members:current.universe.members.map((m:any)=>({symbol:m.symbol,themes:m.symbol==='AAA'?['developer']:m.themes,sources:[]}))});
    const edited=(await route('GET','/state')).value as any;assert.deepEqual(edited.universe.members.find((m:any)=>m.symbol==='AAA').themes,['developer']);assert.equal(edited.coverage.verified,5);
    const accepted=(await route('POST','/scan',{symbols:['AAA']})).value as any;await service.wait();
    const job=(await route('GET',`/jobs/${accepted.jobId}`)).value as any;assert.equal(job.opportunities.length,1);assert.equal(job.counts.dataHttpRequests,0);assert.ok(job.gaps.some((g:string)=>g.includes('附件未完整检查')));assert.equal(job.checks[0].status,'not-checked');
    const handoff=(await route('POST','/handoff',{jobId:job.id,opportunityId:job.opportunities[0].id,symbol:'AAA'})).value as any;
    assert.equal(handoff.discoveryContext.symbol,'AAA');const context=await service.context(handoff.discoveryContext,'AAA');assert.equal(context.company.snapshot.metrics.revenue!.value,10);
    const o=job.opportunities[0];
    const input={title:o.title,statement:o.mechanism,theme:o.theme,symbols:['AAA'],sourceJobId:job.id,opportunityId:o.id,support:[citation],opposing:[],gaps:[...job.gaps,...o.gaps],conditions:[],invalidation:o.invalidation,nextCheck:o.nextCheck,horizonMonths:24};
    const first=(await route('POST','/theses',{input,expectedVersion:0})).value as any;assert.equal(first.version,1);
    const before=models;assert.equal(((await route('POST','/review',{thesisId:first.id})).value as any).unchanged,true);assert.equal(models,before);
    await equity.saveCompany(make('AAA',11));await seed.saveDocument({...document('AAA','_new',13),fetchedAt:new Date(Date.now()+1000).toISOString()});
    const review=(await route('POST','/review',{thesisId:first.id})).value as any;await service.wait();
    const state=(await route('GET','/state')).value as any,p=state.proposals.find((p:any)=>p.jobId===review.jobId);assert.ok(p);assert.ok(p.changes.some((c:any)=>c.field==='revenue'&&c.kind==='restatement'));
    const second=(await route('POST',`/proposals/${p.id}`,{decision:'accept',expectedVersion:1})).value as any;assert.equal(second.thesis.version,2);
    const repeated=(await route('POST',`/proposals/${p.id}`,{decision:'accept',expectedVersion:1})).value as any;assert.equal(repeated.thesis.version,2);
    const history=(await route('GET',`/theses/${first.id}`)).value as any;assert.deepEqual(history.versions.map((v:any)=>v.version),[1,2]);assert.deepEqual(equity.pool().symbols,[]);
  }finally{await service.close();seed.close();equity.close();await rm(dir,{recursive:true,force:true});}
});

test('cancelled discovery resumes frozen company inputs after restart and catalog edits without resetting counts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'discovery-resume-')),equity=new EquityStore(dir),seed=new DiscoveryStore(dir);
  const list=['AAA','BBB','CCC','DDD','EEE'];
  for(const symbol of list){
    await equity.saveCompany({security:{symbol,name:symbol,cik:'0000789019',currency:'USD',country:'US',exchange:'NASDAQ',kind:'common-stock'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{},filings:[],sourceRefs:[],fetchedAt:new Date().toISOString(),warnings:[]});
    await seed.saveDocument(buildDocument({id:`d_${symbol}`,symbol,cik:'0000789019',sourceKind:'sec',url:`https://www.sec.gov/Archives/edgar/data/789019/${symbol}.htm`,html:'<h1>Item 1. Business</h1><p>Artificial intelligence applications support customer workflows. '+('Reported operations require further verification. '.repeat(8))+'</p>'}));
  }
  seed.setUniverse(list.map((symbol,i)=>({symbol,cik:'0000789019',themes:i<3?['workflow']:['developer'],sources:[],verification:'verified'})),0);seed.close();
  const cfg=()=>({fmpKey:'',secUserAgent:'',timeoutMs:1000,maxRetries:0,dailyLimit:200,outputDirectory:dir});
  let entered:()=>void=()=>{};const started=new Promise<void>(r=>entered=r);
  let service=createDiscoveryService({directory:dir,equity,config:cfg,request:async r=>{entered();await new Promise<void>((_resolve,reject)=>r.signal!.addEventListener('abort',()=>reject(Error('cancel')),{once:true}));return{content:''};}});
  try{
    const accepted=(await service.route('POST','/scan',{symbols:['AAA']},new URLSearchParams())).value as any;await started;
    await assert.rejects(service.route('POST','/scan',{symbols:['BBB']},new URLSearchParams()),/执行|准备/);
    await service.route('POST','/cancel',{jobId:accepted.jobId},new URLSearchParams());await service.wait();
    const cancelled=(await service.route('GET',`/jobs/${accepted.jobId}`,{},new URLSearchParams())).value as any;assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.resumable,true);assert.equal(cancelled.counts.modelRequests,1);
    await service.close();const edit=new DiscoveryStore(dir);edit.setUniverse([{symbol:'ZZZ',themes:['content'],verification:'pending',sources:[]}],edit.universe().version);edit.close();
    let calls=0;
    service=createDiscoveryService({directory:dir,equity,config:cfg,request:async r=>{calls++;assert.ok(JSON.stringify(r.messages).includes('AAA'));assert.equal(JSON.stringify(r.messages).includes('ZZZ'),false);return{content:calls===1?JSON.stringify({claims:[{text:'Applications support workflows.',kind:'issuer-claim',scope:'company',citations:[{chunkId:'d_AAA:c0',quote:'Artificial intelligence applications support customer workflows.'}]}],gaps:['仍需验证']}):'{"opportunities":[]}'};}});
    const resumed=(await service.route('POST','/resume',{jobId:accepted.jobId},new URLSearchParams())).value as any;await service.wait();
    const final=(await service.route('GET',`/jobs/${resumed.jobId}`,{},new URLSearchParams())).value as any;assert.notEqual(final.status,'failed');assert.equal(final.counts.modelRequests,3);assert.equal(final.counts.dataHttpRequests,0);assert.ok(final.counts.elapsedMs>=35000);
    await assert.rejects(service.route('POST','/resume',{jobId:accepted.jobId},new URLSearchParams()),/不可恢复/);
  }finally{await service.close();equity.close();await rm(dir,{recursive:true,force:true});}
});

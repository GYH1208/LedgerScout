import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEquityService} from '../src/equity-service.js';
import {EquityStore,type EquitySession} from '../src/equity-store.js';
import {DiscoveryStore} from '../src/discovery-store.js';
import {buildDocument} from '../../equity-data/src/documents.js';
import type {CompanySnapshot} from '../../equity-data/src/types.js';
import type {DiscoveryJob} from '../../equity-data/src/discovery-types.js';
import type {RequestModel} from '../../agent-runtime/src/types.js';

const date='2026-10-30T00:00:00.000Z';
const secText='Artificial intelligence workflow revenue reached 12 million, according to the SEC disclosure.';
const issuerText='Artificial intelligence workflow adoption remains a company claim requiring independent verification.';
const snapshot=(revenue:number):CompanySnapshot=>({
  security:{symbol:'AAA',name:'Application Company',cik:'0000789019',exchange:'NASDAQ',currency:'USD',country:'US',kind:'common-stock'},
  financials:{annual:[],quarterly:[],warnings:[]},
  metrics:{revenue:{value:revenue,unit:'USD',definition:'Company total revenue, not AI revenue',period:'2026-09-30',sourceRefs:[]}},
  filings:[],sourceRefs:[],fetchedAt:date,warnings:[],
});

async function fixture(request:RequestModel){
  const dir=await mkdtemp(join(tmpdir(),'discovery-handoff-'));
  const equity=new EquityStore(dir),discovery=new DiscoveryStore(dir);
  let originalId:string;
  try{
    const original=snapshot(100);originalId=await equity.saveCompany(original);
    for(const [sourceKind,text] of [['sec',secText],['issuer',issuerText]] as const){
      await discovery.saveDocument(buildDocument({id:`d_${sourceKind}`,symbol:'AAA',cik:'0000789019',sourceKind,
        url:sourceKind==='sec'?'https://www.sec.gov/Archives/edgar/data/789019/aaa.htm':'https://www.example.com/investors/aaa.html',
        fetchedAt:date,publishedAt:'2026-10-30',html:`<h1>Item 1. Business</h1><p>${text}</p>`}));
    }
    const member={symbol:'AAA',cik:'0000789019',themes:['workflow'] as const,sources:[],verification:'verified' as const};
    const job:DiscoveryJob={id:'j_saved_scan',kind:'scan',createdAt:date,status:'completed',symbols:['AAA'],completed:['AAA'],remaining:[],errors:[],
      counts:{modelRequests:2,toolCalls:2,dataHttpRequests:0,elapsedMs:100},tokenUsage:{inputTokens:10,outputTokens:10,totalTokens:20,unknownRequests:0},
      input:{universeVersion:1,members:[{...member,themes:['workflow']}],companies:[{symbol:'AAA',snapshotId:originalId,snapshot:original,documentIds:['d_sec','d_issuer']}],question:'Find AI workflow opportunities'},
      extractions:[],checks:[],gaps:['AI contribution is not independently verified'],reservedMs:0,
      opportunities:[{id:'o_workflow',theme:'workflow',title:'Workflow adoption',mechanism:'Adoption may contribute to revenue',whyNow:'New disclosure',stage:'revenue',
        support:[{text:secText,kind:'issuer-claim',scope:'ai-product',citations:[{chunkId:'d_sec:c0',quote:secText}]}],opposing:[],gaps:['Attribution remains unknown'],
        candidates:[{symbol:'AAA',role:'Application vendor',exposure:'ai-product'}],checks:['Verify adoption in next disclosure'],invalidation:'Adoption does not convert to revenue',nextCheck:'2027-02-01'}]};
    discovery.setUniverse([{...member,themes:['workflow']}],0);discovery.saveJob(job);
    // Replacing the current cache must not replace the snapshot frozen into the scan.
    await equity.saveCompany(snapshot(900));
  }finally{discovery.close();equity.close();}
  let http=0;
  const service=createEquityService({directory:dir,
    config:()=>({fmpKey:'',secUserAgent:'',timeoutMs:1000,maxRetries:0,dailyLimit:200,outputDirectory:dir}),
    modelConfig:()=>{throw Error('Offline test must not load model configuration or .env');},request,
    fetch:async()=>{http++;throw Error('Offline handoff must never use HTTP');},
  });
  const route=(method:string,path:string,body:Record<string,unknown>={})=>service.route(method,path,body,new URLSearchParams());
  return{service,route,originalId,http:()=>http,close:async()=>{await service.close();await rm(dir,{recursive:true,force:true});}};
}

type Handoff={symbol:string;question:string;discoveryContext:{jobId:string;opportunityId:string;symbol:string}};
const invalid=(error:unknown)=>Boolean(error&&typeof error==='object'&&'status' in error&&error.status===400);

test('discovery handoff feeds frozen company facts and both saved disclosure kinds through the real Pi tool loop without HTTP',{timeout:30_000},async()=>{
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  let requests=0;
  const f=await fixture(async request=>{
    requests++;
    const user=request.messages.find(message=>message.role==='user')!.content;
    assert.match(user,/"revenue":\{"value":100,/);
    assert.doesNotMatch(user,/"value":900/);
    assert.match(user,/Attribution remains unknown/);
    const index=JSON.parse(user.match(/证据索引：([^\n]+)/)![1]!) as {queryId:string;source:string}[];
    const disclosures=index.filter(query=>['SEC disclosure','Issuer disclosure'].includes(query.source));
    assert.deepEqual(disclosures.map(query=>query.source),['SEC disclosure','Issuer disclosure']);
    const results=request.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content));
    if(!results.length){
      if(requests===1){entered();await gate;}
      assert.ok(request.tools.some(tool=>tool.name==='read_saved_disclosure'));
      return{content:'',toolCalls:disclosures.map((query,i)=>({id:`saved_${i}`,name:'read_saved_disclosure',arguments:{queryId:query.queryId}})),usage:{inputTokens:10,outputTokens:5,totalTokens:15}};
    }
    assert.deepEqual(results.map(result=>result.queryId),disclosures.map(query=>query.queryId));
    assert.match(results[0].text,/workflow revenue reached 12 million/);
    assert.match(results[1].text,/adoption remains a company claim/);
    assert.deepEqual(results.map(result=>result.source),['SEC disclosure','Issuer disclosure']);
    return{content:JSON.stringify({analysis:`公司披露需继续验证 [${disclosures[0]!.queryId}] [${disclosures[1]!.queryId}]`,sourceRefs:disclosures.map(query=>query.queryId)}),usage:{inputTokens:10,outputTokens:5,totalTokens:15}};
  });
  try{
    const handoff=(await f.route('POST','/discovery/handoff',{jobId:'j_saved_scan',opportunityId:'o_workflow',symbol:'AAA'})).value as Handoff;
    const accepted=await f.route('POST','/research',handoff);
    assert.equal(accepted.status,202);
    const {sessionId}=accepted.value as {sessionId:string};
    await started;
    await assert.rejects(f.route('POST','/discovery/handoff',{jobId:'j_saved_scan',opportunityId:'o_workflow',symbol:'AAA'}),error=>Boolean(error&&typeof error==='object'&&'status' in error&&error.status===409));
    release();await f.service.wait();
    let state=(await f.route('GET','/state')).value as {sessions:EquitySession[];busy:boolean};
    assert.equal(state.sessions.length,1);assert.equal(state.sessions[0]!.id,sessionId);assert.equal(state.sessions[0]!.symbol,'AAA');
    const first=state.sessions[0]!.turns[0]!;
    assert.equal(first.queries[0]!.queryId,f.originalId);
    assert.match(first.answer!.facts.join('\n'),/revenue：100 USD/);
    assert.ok(first.answer!.analysis.includes('公司披露需继续验证'));
    assert.equal(first.counts.modelRequests,2);assert.equal(first.counts.toolCalls,2);assert.equal(first.counts.dataHttpRequests,0);
    assert.equal(first.tokenUsage.totalTokens,30);assert.equal(first.tokenUsage.unknownRequests,0);assert.equal(state.busy,false);
    for(const query of first.queries.filter(query=>query.source.endsWith('disclosure'))){
      const evidence=await f.route('GET',`/evidence/${first.id}/${query.queryId}`);
      assert.equal(evidence.status,200);assert.ok(first.answer!.sourceRefs.includes(query.queryId));
    }
    await assert.rejects(f.route('POST','/research',{symbol:'BBB',sessionId,question:'Switch company'}),invalid);
    // Ordinary follow-up omits discoveryContext and still reads the session's frozen evidence.
    await f.route('POST','/research',{symbol:'AAA',sessionId,question:'Explain the saved evidence again'});await f.service.wait();
    state=(await f.route('GET','/state')).value as typeof state;
    assert.equal(state.sessions.length,1);assert.equal(state.sessions[0]!.turns.length,2);
    const followup=state.sessions[0]!.turns[1]!;
    assert.equal(followup.queries[0]!.queryId,f.originalId);assert.equal(followup.discoveryContext,undefined);
    assert.match(followup.answer!.analysis,/公司披露需继续验证/);
    assert.equal(requests,4);assert.equal(f.http(),0);
  }finally{release();await f.close();}
});

test('tampered discovery contexts and refresh or existing-session combinations are rejected before saving a research turn',async()=>{
  let models=0;
  const f=await fixture(async()=>{models++;return{content:'{}'};});
  try{
    const handoff=(await f.route('POST','/discovery/handoff',{jobId:'j_saved_scan',opportunityId:'o_workflow',symbol:'AAA'})).value as Handoff;
    for(const change of [{jobId:'j_foreign'},{opportunityId:'o_foreign'},{symbol:'BBB'}]){
      await assert.rejects(f.route('POST','/research',{...handoff,discoveryContext:{...handoff.discoveryContext,...change}}),invalid);
    }
    await assert.rejects(f.route('POST','/discovery/handoff',{jobId:'j_saved_scan',opportunityId:'o_workflow',symbol:'BBB'}),invalid);
    await assert.rejects(f.route('POST','/research',{...handoff,refresh:true}),invalid);
    await assert.rejects(f.route('POST','/research',{...handoff,sessionId:'s_existing'}),invalid);
    const state=(await f.route('GET','/state')).value as {sessions:EquitySession[];busy:boolean};
    assert.deepEqual(state.sessions,[]);assert.equal(state.busy,false);assert.equal(models,0);assert.equal(f.http(),0);
  }finally{await f.close();}
});

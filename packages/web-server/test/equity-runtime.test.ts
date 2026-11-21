import test from 'node:test';
import assert from 'node:assert/strict';
import { runEquityResearch } from '../src/equity-runtime.js';
import type { CompanySnapshot } from '../../equity-data/src/types.js';
import type { EquityCheckpoint, EquityJob } from '../src/equity-store.js';

const snapshot:CompanySnapshot={security:{symbol:'AAPL',name:'Apple',cik:'0000320193',exchange:'NASDAQ',currency:'USD',country:'US',kind:'common-stock'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{netMargin:{value:20,unit:'%',definition:'net income / revenue',period:'2025',sourceRefs:['q_snapshot']}},filings:[],sourceRefs:[],fetchedAt:'2026-11-16T00:00:00Z',warnings:[]};
const job=():EquityJob=>({id:'j_test',sessionId:'s_equity',runId:'r_equity',researchDomain:'us-equity',symbol:'AAPL',question:'研究利润率',createdAt:'2026-11-16T00:00:00Z',status:'loading',counts:{modelRequests:0,toolCalls:0,dataHttpRequests:0,elapsedMs:0},tokenUsage:{inputTokens:0,outputTokens:0,totalTokens:0,unknownRequests:0},queries:[{queryId:'q_snapshot',symbol:'AAPL',source:'company_snapshot',fetchedAt:snapshot.fetchedAt,data:{}}]});

test('equity Pi runtime authorizes a single symbol and renders deterministic facts with actual token counts',async()=>{
  let saved:EquityCheckpoint|undefined;
  const result=await runEquityResearch({job:job(),snapshot,peers:[],saveCheckpoint:async cp=>{saved=structuredClone(cp);},request:async r=>{
    assert.ok(r.messages.some(m=>m.content.includes('AAPL')));
    assert.ok(r.tools.every(t=>!t.name.includes('eth')));
    return {content:JSON.stringify({analysis:'已取得财务口径，尚需披露原文判断业务风险。',sourceRefs:['q_snapshot']}),usage:{inputTokens:20,outputTokens:10,totalTokens:30}};
  }});
  assert.equal(result.status,'partial'); // no SEC financial facts in this deliberately incomplete fixture
  assert.ok(result.answer!.facts.some(f=>f.includes('20')&&f.includes('2025')));
  assert.equal(result.tokenUsage.totalTokens,30);
  assert.equal(result.counts.modelRequests,1);
  assert.equal(saved!.closed,true);
});

test('repeated identical evidence reads cannot spend the entire tool budget without progress',async()=>{
  const result=await runEquityResearch({job:job(),snapshot,peers:[],saveCheckpoint:async()=>{},request:async r=>{
    if(r.finalOnly)return {content:JSON.stringify({analysis:'依据已取得数据',sourceRefs:['q_snapshot']})};
    return {content:'',toolCalls:[{id:`call${r.messages.length}`,name:'read_company_metrics',arguments:{symbol:'AAPL'}}]};
  }});
  assert.ok(result.counts.toolCalls<=4);
  assert.ok(result.counts.modelRequests<15);
  assert.ok(result.answer!.dataGaps.some(g=>/重复|进展/.test(g)));
});

test('cancelled model work leaves a frozen resumable checkpoint with reserved request time',async()=>{
  const controller=new AbortController();let saved:EquityCheckpoint|undefined;
  const result=await runEquityResearch({job:job(),snapshot,peers:[],signal:controller.signal,saveCheckpoint:async cp=>{saved=structuredClone(cp);},request:async()=>{controller.abort();throw Error('cancel');}});
  assert.equal(result.status,'cancelled');assert.equal(result.resumable,true);
  assert.equal(saved!.symbol,'AAPL');assert.deepEqual(saved!.queryIds,['q_snapshot']);
  assert.equal(saved!.counts.modelRequests,1);assert.equal(saved!.closed,false);
});

test('provider-echoed secrets never enter model messages, and foreign inline citations are rejected',async()=>{
  const secret='private-fmp-echo';let outbound='';
  const value=structuredClone(snapshot);value.security.name=`Apple ${secret}`;
  const result=await runEquityResearch({job:job(),snapshot:value,peers:[],secrets:[secret],saveCheckpoint:async()=>{},request:async r=>{
    outbound=JSON.stringify(r);return{content:JSON.stringify({analysis:'虚构业务风险 [q_foreign]',sourceRefs:['q_snapshot']})};
  }});
  assert.equal(outbound.includes(secret),false);assert.equal(result.answer!.analysis,'');
  assert.ok(result.answer!.dataGaps.some(g=>/引用/.test(g)));
});

test('disclosure work receives the runtime deadline signal and stops after time exhaustion',async()=>{
  const value=structuredClone(snapshot);value.filings=[{accession:'0000320193-26-000001',form:'10-K',filed:'2026-11-13',primaryDocument:'aapl.htm',url:'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl.htm'}];
  const source=job();const cp:EquityCheckpoint={version:1,researchDomain:'us-equity',symbol:'AAPL',sessionId:source.sessionId,runId:'r_parent',question:source.question,counts:{...source.counts,elapsedMs:299_800},tokenUsage:source.tokenUsage,queryIds:['q_snapshot'],messages:[{role:'system',content:'Read disclosure'},{role:'user',content:'AAPL'}],refresh:false,reservedMs:0,closed:false};
  let received:AbortSignal|undefined;
  const result=await runEquityResearch({job:source,snapshot:value,checkpoint:cp,peers:[],saveCheckpoint:async()=>{},request:async()=>({content:'',toolCalls:[{id:'disclosure',name:'read_sec_disclosure',arguments:{accession:value.filings[0]!.accession}}]}),readDisclosure:async(_filing,signal)=>{
    received=signal;await new Promise<void>(resolve=>setTimeout(resolve,300));
    assert.ok(signal?.aborted);return{queryId:'q_disclosure',text:'late'};
  }});
  assert.equal(result.status,'exhausted');assert.ok(received?.aborted);
});

test('a complete disclosure-backed research round can complete without formula notices becoming gaps',async()=>{
  const value=structuredClone(snapshot);
  value.prices={symbol:'AAPL',bars:[{date:'2026-11-13',close:100}],adjustment:'split-adjusted',source:'verified-test-source',fetchedAt:value.fetchedAt};
  value.financials.annual=[{metric:'revenue',value:100,unit:'USD',start:'2025-01-01',end:'2025-12-31',filed:'2026-01-31',accession:'0000320193-26-000001',form:'10-K'}];
  const source=job();source.queries.push({queryId:'q_disclosure',symbol:'AAPL',source:'SEC disclosure',fetchedAt:value.fetchedAt,data:{}});
  const result=await runEquityResearch({job:source,snapshot:value,peers:[],saveCheckpoint:async()=>{},request:async()=>({content:JSON.stringify({analysis:'依据已读取的披露说明 [q_disclosure]。',sourceRefs:['q_disclosure']})})});
  assert.equal(result.status,'completed');assert.deepEqual(result.answer!.dataGaps,[]);
});

test('a multi-tool disclosure round fits conservative context limits while preserving complete call/result pairs',async()=>{
  const value=structuredClone(snapshot),source=job();let requests=0;
  value.security.name='Apple Inc.';value.metrics={};
  for(const key of ['revenue','netIncome','netMargin','revenueGrowth','operatingCashFlow','freeCashFlow','pe','priceReturn21'])value.metrics[key]={value:100,unit:'USD',period:'2025-10-01/2026-09-30',definition:'A detailed definition of the matching period and currency. '.repeat(4),reason:'A limitation of the available evidence. '.repeat(3),sourceRefs:['q_snapshot']};
  value.financials.annual=Array.from({length:24},()=>({metric:'revenue',value:100,unit:'USD',start:'2025-10-01',end:'2026-09-30',filed:'2026-10-30',accession:'0000320193-26-000001',form:'10-K'}));
  value.filings=[{accession:'0000320193-26-000001',form:'10-K',filed:'2026-10-30',primaryDocument:'aapl.htm',url:'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl.htm'}];
  const result=await runEquityResearch({job:source,snapshot:value,peers:[],saveCheckpoint:async()=>{},readDisclosure:async()=>{
    source.queries.push({queryId:'q_disclosure',symbol:'AAPL',source:'SEC disclosure',fetchedAt:value.fetchedAt,data:{}});
    return{queryId:'q_disclosure',text:'Business disclosure text with reported risks and revenue. '.repeat(200)};
  },request:async r=>{
    requests++;
    if(requests===1)return{content:'',toolCalls:[{id:'metrics',name:'read_company_metrics',arguments:{}},{id:'financial',name:'read_financial_periods',arguments:{period:'annual'}},{id:'disclosure',name:'read_sec_disclosure',arguments:{accession:value.filings[0]!.accession}}]};
    const assistant=r.messages.find(m=>m.toolCalls?.length);assert.equal(assistant?.toolCalls?.length,3);
    assert.equal(r.finalOnly,true);assert.equal(r.tools.length,0);
    assert.deepEqual(r.messages.filter(m=>m.role==='tool').map(m=>m.callId),['metrics','financial','disclosure']);
    assert.ok(r.messages.some(m=>m.content.includes('q_disclosure')));
    return{content:JSON.stringify({analysis:'根据披露片段 [q_disclosure]，说明证据覆盖限制。',sourceRefs:['q_disclosure']})};
  }});
  assert.equal(requests,2);assert.notEqual(result.status,'failed');assert.ok(result.answer!.analysis.includes('q_disclosure'));
  assert.ok(result.answer!.dataGaps.some(g=>/输入预算|截断/.test(g)));
});

test('resumed compacted evidence keeps its input-truncation limitation',async()=>{
  const source=job();source.queries.push({queryId:'q_disclosure',symbol:'AAPL',source:'SEC disclosure',fetchedAt:snapshot.fetchedAt,data:{}});
  const cp:EquityCheckpoint={version:1,researchDomain:'us-equity',symbol:'AAPL',sessionId:source.sessionId,runId:'r_parent',question:source.question,counts:source.counts,tokenUsage:source.tokenUsage,queryIds:source.queries.map(q=>q.queryId),messages:[{role:'system',content:'Return JSON'},{role:'user',content:'AAPL'},{role:'assistant',content:'',toolCalls:[{id:'d',name:'read_sec_disclosure',arguments:{}}]},{role:'tool',callId:'d',name:'read_sec_disclosure',content:JSON.stringify({queryId:'q_disclosure',truncated:true,note:'输入预算限制；仅为原始证据的部分片段，完整来源仍保存在本机。'})}],refresh:false,reservedMs:0,closed:false};
  const result=await runEquityResearch({job:source,snapshot,peers:[],checkpoint:cp,saveCheckpoint:async()=>{},request:async()=>({content:JSON.stringify({analysis:'有限片段 [q_disclosure]',sourceRefs:['q_disclosure']})})});
  assert.ok(result.answer!.dataGaps.some(g=>g.includes('输入预算')));
});

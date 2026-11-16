import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runDiscoveryTask,newDiscoveryJob} from '../src/discovery-runtime.js';
import type {DiscoveryDocument,DiscoveryInput} from '../../equity-data/src/discovery-types.js';
const text='Artificial intelligence applications generated revenue of 12 million. Adoption is early and competitive risks remain.';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const doc:DiscoveryDocument={id:'d_test',symbol:'MSFT',cik:'0000789019',sourceKind:'sec',url:'https://www.sec.gov/Archives/edgar/data/789019/a/report.htm',title:'Business',fetchedAt:'2026-11-16T00:00:00Z',publishedAt:'2026-10-30',hash:hash(text),text,sections:[{id:'business',title:'Business',kind:'business',start:0,end:text.length,confidence:'heading'}],chunks:[{id:'d_test:c0',documentId:'d_test',symbol:'MSFT',cik:'0000789019',sectionId:'business',kind:'business',start:0,end:text.length,text,hash:hash(text)}],warnings:[]};
const input=():DiscoveryInput=>({universeVersion:1,members:[{symbol:'MSFT',themes:['workflow'],sources:[],verification:'verified'}],companies:[{symbol:'MSFT',snapshotId:'q_snapshot',documentIds:['d_test'],snapshot:{security:{symbol:'MSFT',name:'Microsoft',cik:'0000789019',currency:'USD',country:'US',exchange:'NASDAQ',kind:'common-stock'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{},filings:[],sourceRefs:[],fetchedAt:doc.fetchedAt,warnings:[]}}],question:'AI应用商业化'});
const citation={chunkId:'d_test:c0',quote:'Artificial intelligence applications generated revenue of 12 million.'};
const claim={text:'AI applications reported revenue of 12 million.',kind:'issuer-claim',scope:'ai-product',citations:[citation]};
const opportunity={theme:'workflow',title:'应用采用',mechanism:'付费采用可能形成收入',whyNow:'本轮公司披露提供采用线索',stage:'revenue',support:[claim],opposing:[],gaps:['尚无独立客户验证'],candidates:[{symbol:'MSFT',role:'应用提供方',exposure:'ai-product'}],checks:['后续报告期付费采用'],invalidation:'商业化进度未得到后续披露支持',nextCheck:'2027-02-01'};
test('staged Pi discovery uses original chunks, bounded isolated company inputs and no HTTP',async()=>{
  const job=newDiscoveryJob('scan',input());let models=0;
  const result=await runDiscoveryTask({job,documents:async()=>[doc],save:async()=>{},request:async r=>{
    models++;assert.equal(r.tools.length,0);assert.ok(JSON.stringify(r.messages).includes('d_test:c0'));
    return{content:JSON.stringify(models===1?{claims:[claim],opposing:[],gaps:['尚无独立客户验证']}:{opportunities:[opportunity]}),usage:{inputTokens:10,outputTokens:5,totalTokens:15}};
  }});
  assert.equal(models,2);assert.equal(result.opportunities.length,1);assert.equal(result.counts.dataHttpRequests,0);assert.equal(result.counts.toolCalls,1);assert.equal(result.tokenUsage.totalTokens,30);
  assert.equal(result.opportunities[0]!.support[0]!.kind,'issuer-claim');
});
test('fabricated quotes, foreign symbols and numeric AI attribution cannot certify an opportunity',async()=>{
  const job=newDiscoveryJob('scan',input());let n=0;
  const result=await runDiscoveryTask({job,documents:async()=>[doc],save:async()=>{},request:async()=>{
    n++;return{content:JSON.stringify(n===1?{claims:[{...claim,citations:[{chunkId:'d_other:c0',quote:text}]}],gaps:[]}:{opportunities:[{...opportunity,candidates:[{symbol:'EVIL',role:'x',exposure:'ai-product'}],support:[{...claim,text:'AI revenue was 999 million.'}]}]})};
  }});
  assert.equal(result.opportunities.length,0);assert.ok(result.gaps.length);
});
test('cancelled extraction reserves its model time and explicit continuation reuses completed companies',async()=>{
  const ctl=new AbortController(),job=newDiscoveryJob('scan',input());
  const first=await runDiscoveryTask({job,documents:async()=>[doc],save:async()=>{},signal:ctl.signal,request:async()=>{ctl.abort();throw Error('cancel');}});
  assert.equal(first.status,'cancelled');assert.equal(first.counts.modelRequests,1);assert.equal(first.reservedMs,35000);assert.equal(first.tokenUsage.unknownRequests,1);
});

test('ten-company extraction stays within the input budget using at most two bounded aggregation contexts',async()=>{
  const value=input();value.companies=[];value.members=[];const documents:DiscoveryDocument[]=[];
  for(let i=0;i<10;i++){
    const symbol=`A${i}`,id=`d_${symbol}`,company=structuredClone(input().companies[0]!);company.symbol=symbol;company.snapshot.security.symbol=symbol;company.snapshotId=`q_${symbol}`;company.documentIds=[id];value.companies.push(company);value.members.push({symbol,themes:['workflow'],verification:'verified',sources:[]});
    const d=structuredClone(doc);d.id=id;d.symbol=symbol;d.chunks[0]!.id=`${id}:c0`;d.chunks[0]!.documentId=id;d.chunks[0]!.symbol=symbol;documents.push(d);
  }
  let calls=0;
  const result=await runDiscoveryTask({job:newDiscoveryJob('scan',value),documents:async()=>documents,save:async()=>{},request:async r=>{
    calls++;const content=r.messages.map(m=>m.content).join('');
    if(content.includes('返回{claims')){const id=content.match(/d_A\d:c0/)![0];const c={...claim,text:'披露提供应用商业化线索，但仍需要更多客户采用和财务验证。'.repeat(12),citations:[{chunkId:id,quote:citation.quote}]};return{content:JSON.stringify({claims:[c,c,c],opposing:[c],gaps:['尚需验证']})};}
    return{content:'{"opportunities":[]}'};
  }});
  assert.equal(result.completed.length,10);assert.equal(calls,12);assert.notEqual(result.status,'failed');assert.equal(result.counts.toolCalls,10);
});


test('candidate AI exposure cannot exceed validated company extraction scope',async()=>{
  let calls=0;const unknown={...claim,scope:'unknown'};
  const result=await runDiscoveryTask({job:newDiscoveryJob('scan',input()),documents:async()=>[doc],save:()=>{},request:async()=>({content:JSON.stringify(++calls===1?{claims:[unknown],gaps:[]}:{opportunities:[opportunity]})})});
  assert.equal(result.opportunities[0]!.candidates[0]!.exposure,'unknown');
});

test('review prioritizes new evidence without AI keywords over old AI excerpts and drafts a cited update',async()=>{
  const old=Array.from({length:5},(_,i)=>{const d=structuredClone(doc);d.id='d_old'+i;d.chunks[0]!.id=d.id+':c0';d.chunks[0]!.documentId=d.id;return d;});
  const fresh=structuredClone(doc);fresh.id='d_fresh';fresh.text='Customers terminated paid workflow subscriptions as costs exceeded the benefits.';fresh.chunks=[{...doc.chunks[0]!,id:'d_fresh:c0',documentId:'d_fresh',text:fresh.text,end:fresh.text.length}];
  const value=input();value.companies[0]!.documentIds=[...old.map(d=>d.id),fresh.id];
  const thesis:any={id:'t_test',version:1,confirmed:true,title:'采用',statement:'AI workflow applications gain paid adoption.',theme:'workflow',symbols:['MSFT'],sourceJobId:'j_old',support:[{chunkId:'d_old0:c0',quote:citation.quote}],opposing:[],gaps:['须验证续费'],conditions:[],invalidation:'客户停止续费',nextCheck:'2027-02-01',horizonMonths:24,createdAt:doc.fetchedAt,companies:[{...value.companies[0]!,documentIds:old.map(d=>d.id)}]};
  let proposal:any;
  await runDiscoveryTask({job:newDiscoveryJob('review',value),thesis,documents:async()=>[...old,fresh],save:()=>{},onProposal:p=>{proposal=p;},request:async r=>{
    assert.ok(JSON.stringify(r.messages).includes(fresh.text));
    assert.ok(JSON.stringify(r.messages).includes('客户停止续费'));
    return {content:JSON.stringify({impact:'weakened',explanation:'付费客户停止续费，削弱采用判断。',revisedStatement:'当前付费采用证据减弱，须重新验证续费。',citations:[{chunkId:'d_fresh:c0',quote:fresh.text}]})};
  }});
  assert.equal(proposal.impact,'weakened');assert.notEqual(proposal.draft.statement,thesis.statement);assert.ok(proposal.draft.opposing.some((c:any)=>c.chunkId==='d_fresh:c0'));assert.ok(proposal.draft.gaps.includes('须验证续费'));
});


test('company totals adjacent to AI marketing cannot become quantitative AI revenue evidence',async()=>{
  const d=structuredClone(doc);d.text='Company revenue was 12 million. We launched an AI product; no AI product revenue is disclosed.';d.chunks[0]!.text=d.text;
  const unsupported={text:'AI product revenue was 12 million.',kind:'issuer-claim',scope:'ai-product',citations:[{chunkId:d.chunks[0]!.id,quote:d.text}]};
  let calls=0;const result=await runDiscoveryTask({job:newDiscoveryJob('scan',input()),documents:async()=>[d],save:()=>{},request:async()=>({content:JSON.stringify(++calls===1?{claims:[unsupported],gaps:[]}:{opportunities:[{...opportunity,support:[unsupported]}]})})});
  assert.equal(result.opportunities.length,0);assert.ok(result.gaps.some(g=>g.includes('AI')));
});


test('cancelled aggregation preserves completed groups and the two-request synthesis cap on resume',async()=>{
  const value=input();value.companies=[];value.members=[];const documents:DiscoveryDocument[]=[];
  for(let i=0;i<6;i++){const symbol='A'+i,id='d_'+symbol,c=structuredClone(input().companies[0]!);c.symbol=symbol;c.snapshot.security.symbol=symbol;c.documentIds=[id];value.companies.push(c);value.members.push({symbol,themes:['workflow'],verification:'verified',sources:[]});const d=structuredClone(doc);d.id=id;d.symbol=symbol;Object.assign(d.chunks[0]!,{id:id+':c0',documentId:id,symbol});documents.push(d);}
  const ctl=new AbortController();let models=0,aggregations=0;
  const request:any=async(r:any)=>{models++;const content=JSON.stringify(r.messages);if(content.includes('返回{claims')){const id=content.match(/d_A[0-9]:c0/)![0];return{content:JSON.stringify({claims:[{...claim,citations:[{chunkId:id,quote:citation.quote}]}],gaps:[]})};}aggregations++;if(aggregations===2){ctl.abort();throw Error('cancelled');}return{content:JSON.stringify({opportunities:[{...opportunity,candidates:[{symbol:'A0',role:'应用',exposure:'ai-product'}],support:[{...claim,citations:[{chunkId:'d_A0:c0',quote:citation.quote}]}]}]})};};
  const first=await runDiscoveryTask({job:newDiscoveryJob('scan',value),documents:async()=>documents,save:()=>{},signal:ctl.signal,request});assert.equal(first.opportunities.length,1);
  const resumed=structuredClone(first);resumed.status='loading';resumed.counts.elapsedMs+=resumed.reservedMs;resumed.reservedMs=0;
  const result=await runDiscoveryTask({job:resumed,documents:async()=>documents,save:()=>{},request});
  assert.equal(aggregations,2);assert.equal(result.opportunities.length,1);assert.equal(models,8);assert.ok(result.gaps.some(g=>g.includes('汇总')));
});


test('opportunity check dates cannot silently be in the past relative to the frozen scan date',async()=>{
 const value=input(),job=newDiscoveryJob('scan',value);job.createdAt='2026-11-16T00:00:00Z';let calls=0;
 const result=await runDiscoveryTask({job,documents:async()=>[doc],save:()=>{},request:async()=>({content:JSON.stringify(++calls===1?{claims:[claim],gaps:[]}:{opportunities:[{...opportunity,nextCheck:'2026-03-31'}]})})});
 assert.ok(result.opportunities[0]!.nextCheck>'2026-11-16');assert.ok(result.opportunities[0]!.gaps.some(g=>g.includes('检查日期')));
});


test('aggregation can select immutable extraction claim IDs without rewriting original quotes',async()=>{
 let calls=0;const result=await runDiscoveryTask({job:newDiscoveryJob('scan',input()),documents:async()=>[doc],save:()=>{},request:async r=>{calls++;if(calls===1)return{content:JSON.stringify({claims:[claim],gaps:[]})};assert.ok(JSON.stringify(r.messages).includes('MSFT:s0'));return{content:JSON.stringify({opportunities:[{...opportunity,support:undefined,supportRefs:['MSFT:s0'],opposingRefs:[]}]})};}});
 assert.equal(result.opportunities.length,1);assert.deepEqual(result.opportunities[0]!.support[0]!.citations,[citation]);
});


test('same-sentence company totals and an AI launch are not direct AI revenue attribution',async()=>{
 const d=structuredClone(doc);d.text='Company revenue was 12 million, and we launched a new AI product.';d.chunks[0]!.text=d.text;const unsupported={...claim,text:'AI product revenue was 12 million.',citations:[{chunkId:d.chunks[0]!.id,quote:d.text}]};let calls=0;
 const r=await runDiscoveryTask({job:newDiscoveryJob('scan',input()),documents:async()=>[d],save:()=>{},request:async()=>({content:JSON.stringify(++calls===1?{claims:[unsupported],gaps:[]}:{opportunities:[{...opportunity,support:[unsupported]}]})})});assert.equal(r.opportunities.length,0);
});

test('review wording cannot attach invented financial numbers to a valid new quote',async()=>{
 const value=input(),old=structuredClone(doc),fresh=structuredClone(doc);fresh.id='d_new';fresh.text='AI product revenue was 13 million.';Object.assign(fresh.chunks[0]!,{id:'d_new:c0',documentId:'d_new',text:fresh.text});value.companies[0]!.documentIds=[old.id,fresh.id];
 const thesis:any={id:'t_numbers',version:1,confirmed:true,title:'采用',statement:'AI付费采用须验证',theme:'workflow',symbols:['MSFT'],sourceJobId:'j_old',support:[citation],opposing:[],gaps:[],conditions:[],invalidation:'停止采用',nextCheck:'2027-02-01',horizonMonths:24,createdAt:doc.fetchedAt,companies:[{...value.companies[0]!,documentIds:[old.id]}]};let proposal:any;
 await runDiscoveryTask({job:newDiscoveryJob('review',value),thesis,documents:async()=>[old,fresh],save:()=>{},onProposal:p=>{proposal=p;},request:async()=>({content:JSON.stringify({impact:'strengthened',explanation:'AI product revenue is 999 million.',revisedStatement:'AI product revenue is 999 million.',citations:[{chunkId:'d_new:c0',quote:fresh.text}]})})});
 assert.equal(proposal.impact,'insufficient');assert.equal(proposal.draft.statement,thesis.statement);assert.ok(!proposal.explanation.includes('999'));
});

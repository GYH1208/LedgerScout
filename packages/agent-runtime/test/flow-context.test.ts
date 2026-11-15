import test from 'node:test';
import assert from 'node:assert/strict';
import { compactFlowContext } from '../src/flow-context.js';
import { fitContextAsync } from '../src/context.js';
import { toolDefinitions } from '../src/tools.js';
import type {ChatMessage} from '../src/types.js';

test('many completed flow read batches fit without orphaning the latest tool calls',async()=>{
 const messages:ChatMessage[]=[{role:'system',content:'s'.repeat(2600)},{role:'user',content:'u'.repeat(1300)}];
 for(let batch=0;batch<6;batch++){
   const calls=Array.from({length:2},(_,i)=>({id:`call-${batch}-${i}`,name:'read_query_evidence',arguments:{queryId:'q_example-source',collection:i?'flow_assets':'flow_counterparties',offset:batch*2,limit:2}}));
   messages.push({role:'assistant',content:'',toolCalls:calls});
   for(const call of calls)messages.push({role:'tool',name:call.name,callId:call.id,content:JSON.stringify({queryId:'q_example-source',collection:call.arguments.collection,offset:batch*2,totalAvailable:30,hasMore:true,records:[{address:'0x'+'1'.repeat(40),description:'x'.repeat(180)}]})});
 }
 const compacted=compactFlowContext(messages);
 const fitted=await fitContextAsync(compacted,24000,{tools:toolDefinitions,maxTokens:10000});
 assert(fitted.measurement.tokens<=10000);
 assert(compacted.some(m=>m.role==='assistant'&&m.content.includes('q_example-source')));
 assert.equal(compacted.filter(m=>m.role==='tool').length,2);
 const last=compacted.find(m=>m.toolCalls?.some(c=>c.id==='call-5-0'))!;assert.equal(last.toolCalls!.length,2);
 assert.deepEqual(compacted.filter(m=>m.role==='tool').map(m=>m.callId),['call-5-0','call-5-1']);
});
test('mixed tools, incomplete batches and error results remain available',()=>{
 const messages:ChatMessage[]=[{role:'user',content:'question'},
 {role:'assistant',content:'',toolCalls:[{id:'mixed',name:'get_eth_balance',arguments:{}},{id:'read',name:'read_query_evidence',arguments:{}}]},
 {role:'tool',name:'get_eth_balance',callId:'mixed',content:'{}'},
 {role:'tool',name:'read_query_evidence',callId:'read',content:JSON.stringify({queryId:'q_old'})},
 {role:'assistant',content:'',toolCalls:[{id:'bad',name:'read_query_evidence',arguments:{}}]},
 {role:'tool',name:'read_query_evidence',callId:'bad',content:'INVALID_ARGUMENT'},
 {role:'assistant',content:'',toolCalls:[{id:'incomplete',name:'read_query_evidence',arguments:{}},{id:'missing',name:'read_query_evidence',arguments:{}}]},
 {role:'tool',name:'read_query_evidence',callId:'incomplete',content:JSON.stringify({queryId:'q_old'})},
 {role:'assistant',content:'',toolCalls:[{id:'last',name:'read_query_evidence',arguments:{}}]},
 {role:'tool',name:'read_query_evidence',callId:'last',content:JSON.stringify({queryId:'q_last',records:[1]})}];
 const compacted=compactFlowContext(messages);
 for(const id of ['mixed','bad','incomplete','last'])assert(compacted.some(m=>m.toolCalls?.some(c=>c.id===id)),id);
 assert(compacted.some(m=>m.content==='INVALID_ARGUMENT'));
 assert.equal(compacted.at(-1)?.content,messages.at(-1)?.content);
});

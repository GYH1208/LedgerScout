import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/discovery-api.js';

test('discovery selection normalizes symbols and enforces explicit bounded batches', () => {
  assert.equal(typeof api.parseDiscoverySymbols, 'function');
  assert.deepEqual(api.parseDiscoverySymbols('aapl，MSFT aapl BRK.B'), ['AAPL', 'MSFT', 'BRK.B']);
  assert.deepEqual(api.parseDiscoverySymbols(''), []);
  assert.throws(() => api.parseDiscoverySymbols('A/B'), /代码/);
  assert.throws(() => api.parseDiscoverySymbols(Array.from({length:31}, (_,i) => `A${i}`).join(' ')), /30/);
  assert.throws(() => api.selectedDiscoverySymbols([], 5), /选择/);
  assert.throws(() => api.selectedDiscoverySymbols(['A','B','C','D','E','F'], 5), /5/);
  assert.deepEqual(api.selectedDiscoverySymbols(['a', 'A'], 10), ['A']);
});

test('catalog payload never carries server-owned identity or verification and derives source host', () => {
  assert.equal(typeof api.universePayload, 'function');
  const value = api.universePayload(4, [{symbol:'AAPL',name:'Typed name',cik:'untrusted',website:'https://bad.example',verification:'verified',themes:['workflow'],sources:[{id:'s',kind:'index',url:'https://ir.example.com/releases',allowedHosts:['bad.example'],pathPrefix:'/',maxPages:2,verification:'verified',verifiedAt:'now'}]}]);
  assert.deepEqual(value,{expectedVersion:4,members:[{symbol:'AAPL',name:'Typed name',themes:['workflow'],sources:[{id:'s',kind:'index',url:'https://ir.example.com/releases',allowedHosts:['ir.example.com'],pathPrefix:'/',maxPages:2}]}]});
});

test('opportunity drafts preserve quotes and unknowns without claiming user confirmation', () => {
  assert.equal(typeof api.draftThesis, 'function');
  const citation={chunkId:'doc:c2',quote:'Actual source'};
  const draft=api.draftThesis({id:'job'}, {id:'o',theme:'workflow',title:'Study',mechanism:'Hypothesis',support:[{citations:[citation]}],opposing:[],gaps:['Unknown AI revenue'],candidates:[{symbol:'AAPL'}],checks:['Check adoption'],invalidation:'No adoption',nextCheck:'Next filing'});
  assert.equal(draft.sourceJobId,'job');assert.equal(draft.opportunityId,'o');
  assert.deepEqual(draft.support,[citation]);assert.deepEqual(draft.gaps,['Unknown AI revenue']);
  assert.equal(draft.conditions[0].kind,'manual');assert.equal(draft.horizonMonths,24);
  assert.equal(draft.confirmed,undefined);
  assert.throws(() => api.thesisPayload(draft,false,0), /确认/);
  assert.deepEqual(api.thesisPayload(draft,true,0),{input:draft,expectedVersion:0});
  assert.throws(() => api.thesisPayload({...draft,conditions:[{id:'x',kind:'metric',field:'arbitrarySql',op:'gt',value:1,period:'2026'}]},true,0), /指标/);
  assert.throws(() => api.thesisPayload({...draft,conditions:[{id:'x',kind:'metric',field:'revenueGrowth',op:'gt',value:NaN,period:'2026'}]},true,0), /指标/);
});

test('citation document id strips only the terminal chunk locator',()=>{
  assert.equal(typeof api.citationDocumentId,'function');
  assert.equal(api.citationDocumentId('sec:document:abc:c27'),'sec:document:abc');
  assert.equal(api.citationDocumentId('bad'),null);
});

test('local reads are GET; mutations use JSON client header and preserve version decisions',async()=>{
  assert.equal(typeof api.createDiscoveryApi,'function');
  const calls=[];const client=api.createDiscoveryApi(async(path,options)=>{calls.push({path,...options});return new Response(JSON.stringify({ok:true}));});
  await client.state();await client.document('d/a','AI & revenue',20);await client.thesis('t/a');
  assert.equal(calls[0].path,'/api/equity/discovery/state');assert.equal(calls[0].method,undefined);
  assert.equal(calls[1].path,'/api/equity/discovery/documents/d%2Fa?query=AI%20%26%20revenue&offset=20');
  assert.equal(calls[2].path,'/api/equity/discovery/theses/t%2Fa');
  await client.proposal('p/a',{decision:'accept',expectedVersion:3});
  assert.equal(calls[3].path,'/api/equity/discovery/proposals/p%2Fa');assert.equal(calls[3].method,'POST');
  assert.equal(calls[3].headers['x-ledgerscout-client'],'web');assert.deepEqual(JSON.parse(calls[3].body),{decision:'accept',expectedVersion:3});
  for(const method of ['refresh','scan','handoff','review']) await client[method]({symbols:['A']});
  await client.cancel('j');await client.resume('j');
  assert.deepEqual(JSON.parse(calls.at(-1).body),{jobId:'j'});
});

test('service errors never invent discovery results; polling stops on terminal jobs',async()=>{
  assert.equal(typeof api.createDiscoveryApi,'function');
  await assert.rejects(api.createDiscoveryApi(async()=>new Response('<html>')).state(),/服务/);
  await assert.rejects(api.createDiscoveryApi(async()=>new Response('{"error":"版本冲突"}',{status:409})).state(),/版本冲突/);
  assert.equal(api.isDiscoveryRunning({busy:false,activeJob:{status:'partial'}}),false);
  assert.equal(api.isDiscoveryRunning({activeJob:{status:'loading'}}),true);
});

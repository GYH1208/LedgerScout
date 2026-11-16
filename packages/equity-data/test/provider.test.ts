import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrices, normalizeSecurity, normalizeFilings, EquityProvider } from '../src/provider.js';
import { EquityTransport } from '../src/transport.js';
import { loadEquityConfig } from '../src/config.js';
import { DailyQuota } from '../src/quota.js';
const profile = [{symbol:'AAPL',companyName:'Apple Inc.',cik:'0000320193',exchange:'NASDAQ',currency:'USD',country:'US',isEtf:false,isFund:false,isAdr:false,isActivelyTrading:true}];
const tickers = {fields:['cik','name','ticker','exchange'],data:[[320193,'Apple Inc.','AAPL','Nasdaq']]};

test('ownership XML and unsupported recent filing forms do not reject a company financial report',()=>{
  const security=normalizeSecurity(profile,tickers,'AAPL');
  const filings=normalizeFilings({cik:320193,tickers:['AAPL'],exchanges:['Nasdaq'],filings:{recent:{accessionNumber:['0000320193-26-000001','0000320193-26-000002'],form:['4','10-K'],filingDate:['2026-11-13','2026-11-12'],primaryDocument:['xslF345X05/ownership.xml','aapl-20260930.htm']}}},security);
  assert.equal(filings.length,1);assert.equal(filings[0]!.form,'10-K');
});
test('prices sort dates, accept documented price field and never guess adjustment', () => {
  const result = normalizePrices([{symbol:'AAPL',date:'2026-11-13',price:12},{symbol:'AAPL',date:'2026-11-12',close:10}], 'AAPL');
  assert.deepEqual(result.bars.map(x=>x.close), [10,12]); assert.equal(result.adjustment,'unknown');
  assert.throws(()=>normalizePrices([{date:'2026-02-30',price:10}], 'AAPL'));
  assert.throws(()=>normalizePrices([{symbol:'MSFT',date:'2026-11-13',price:10}], 'AAPL'));
  assert.throws(()=>normalizePrices([{date:'2026-11-13',price:0}], 'AAPL'));
});
test('prices reject future observations and more than 5000 daily observations',()=>{
  assert.throws(()=>normalizePrices([{date:'2026-11-17',price:1}],'AAPL','2026-11-16T12:00:00Z'),/FUTURE/);
  assert.throws(()=>normalizePrices(Array.from({length:5001},()=>({date:'2026-11-13',price:1})),'AAPL'),/PRICE_DATA/);
});
test('security requires matching SEC identity and complete common share flags', () => {
  assert.equal(normalizeSecurity(profile,tickers,'AAPL').kind,'common-stock');
  for(const change of [{isAdr:true},{isEtf:true},{isFund:true},{country:'CN'},{currency:'EUR'},{exchange:'NYSE'},{isAdr:undefined}]) {
    assert.throws(()=>normalizeSecurity([{...profile[0],...change}],tickers,'AAPL'));
  }
  assert.throws(()=>normalizeSecurity(profile,{...tickers,data:[[123,'Apple','AAPL','Nasdaq']]},'AAPL'));
});
test('filings verify company and safe accession document paths', () => {
  const security = normalizeSecurity(profile,tickers,'AAPL');
  const submissions = {cik:'320193',tickers:['AAPL'],exchanges:['Nasdaq'],filings:{recent:{accessionNumber:['0000320193-26-000001'],form:['10-K'],filingDate:['2026-10-30'],primaryDocument:['aapl-20260926.htm']}}};
  assert.equal(normalizeFilings(submissions,security)[0]?.url, 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-20260926.htm');
  assert.throws(()=>normalizeFilings({...submissions,cik:123},security));
  assert.throws(()=>normalizeFilings({...submissions,filings:{recent:{...submissions.filings.recent,primaryDocument:['../evil.htm']}}},security));
});
test('company facts remain available when optional prices lack permission within five calls', async () => {
  let calls=0; const q=new DailyQuota(':memory:',20);
  const transport = new EquityTransport({...loadEquityConfig({FMP_API_KEY:'key',SEC_USER_AGENT:'Tool person@real-domain.org'},[]),maxRetries:0}, {quota:q,fetch:async url=>{
    calls++; const u=String(url);
    if(u.includes('/profile?'))return Response.json(profile);
    if(u.includes('/light?'))return new Response('{}',{status:403});
    if(u.includes('tickers_exchange'))return Response.json(tickers);
    if(u.includes('/submissions/'))return Response.json({cik:320193,tickers:['AAPL'],exchanges:['Nasdaq'],filings:{recent:{accessionNumber:[],form:[],filingDate:[],primaryDocument:[]}}});
    return Response.json({cik:320193,facts:{'us-gaap':{}}});
  }});
  const company=await new EquityProvider(transport).getCompany('AAPL');
  assert.equal(company.prices,undefined); assert.equal(company.security.symbol,'AAPL'); assert.equal(calls,5);
  assert.ok(company.warnings.includes('prices:PERMISSION_DENIED')); q.close();
});
test('provider reuses verified ticker mapping between company operations',async()=>{
  let tickerCalls=0;const q=new DailyQuota(':memory:',20);
  const t=new EquityTransport({...loadEquityConfig({FMP_API_KEY:'key',SEC_USER_AGENT:'Tool person@real-domain.org'},[]),maxRetries:0},{quota:q,fetch:async url=>{
    const u=String(url);
    if(u.includes('/profile?'))return Response.json(profile);
    if(u.includes('/light?'))return Response.json([{symbol:'AAPL',date:'2026-11-13',price:1}]);
    if(u.includes('tickers_exchange')){tickerCalls++;return Response.json(tickers);}
    if(u.includes('/submissions/'))return Response.json({cik:320193,tickers:['AAPL'],exchanges:['Nasdaq'],filings:{recent:{accessionNumber:[],form:[],filingDate:[],primaryDocument:[]}}});
    return Response.json({cik:320193,facts:{'us-gaap':{}}});
  }});
  const p=new EquityProvider(t);await p.getCompany('AAPL');await p.getCompany('AAPL');
  assert.equal(tickerCalls,1);q.close();
});

test('a transient SEC retry uses the shared 32-attempt stage budget instead of failing at five company attempts',async()=>{
  const q=new DailyQuota(':memory:',20);let factsCalls=0;
  const t=new EquityTransport({...loadEquityConfig({FMP_API_KEY:'key',SEC_USER_AGENT:'Tool person@real-domain.org'},[]),maxRetries:1},{quota:q,fetch:async url=>{
    const u=String(url);
    if(u.includes('/profile?'))return Response.json(profile);
    if(u.includes('/light?'))return Response.json([{symbol:'AAPL',date:'2026-11-13',price:1}]);
    if(u.includes('tickers_exchange'))return Response.json(tickers);
    if(u.includes('/submissions/'))return Response.json({cik:320193,tickers:['AAPL'],exchanges:['Nasdaq'],filings:{recent:{accessionNumber:[],form:[],filingDate:[],primaryDocument:[]}}});
    factsCalls++;return factsCalls===1?new Response('{}',{status:503}):Response.json({cik:320193,facts:{'us-gaap':{}}});
  }});
  try{const company=await new EquityProvider(t).getCompany('AAPL');assert.equal(company.prices?.bars.length,1);assert.equal(t.requestCount,6);assert.equal(q.usage(),2);}finally{q.close();}
});

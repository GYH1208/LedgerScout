import test from 'node:test';
import assert from 'node:assert/strict';
import { EquityTransport } from '../src/transport.js';
import { DailyQuota } from '../src/quota.js';
import { loadEquityConfig } from '../src/config.js';
const config = () => loadEquityConfig({ FMP_API_KEY: 'secret-key', SEC_USER_AGENT: 'LedgerScout research@real-domain.org', MAX_RETRIES: '1' }, []);

test('FMP payment-required responses identify unavailable plan permissions without retrying',async()=>{
  const q=new DailyQuota(':memory:',10);const records:any[]=[];let calls=0;
  const t=new EquityTransport(config(),{quota:q,record:async r=>{records.push(r);},fetch:async()=>{calls++;return new Response('Premium Query Parameter: symbol is not available under your current subscription',{status:402});}});
  try{
    await assert.rejects(t.request('fmp','historical-price-eod/light','QQQ'),/PERMISSION_DENIED/);
    assert.equal(calls,1);assert.equal(q.usage(),1);assert.equal(records[0].status,402);
  }finally{q.close();}
});

test('transport fixed hosts, redaction including keys, and quota on retries', async () => {
  const q = new DailyQuota(':memory:', 10); const records: unknown[] = []; let n = 0;
  const t = new EquityTransport(config(), { quota:q, record: async r => { records.push(r); }, fetch: async (url, init) => {
    assert.equal(new URL(String(url)).hostname, 'financialmodelingprep.com');
    assert.equal(init?.redirect, 'error');
    n++; return new Response(n === 1 ? '{}' : '{"secret-key":"secret-key","symbol":"AAPL"}', {status:n === 1 ? 503 : 200});
  }});
  await t.request('fmp', 'profile', 'AAPL'); assert.equal(q.usage(), 2);
  assert.equal(JSON.stringify(records).includes('secret-key'), false);
  await assert.rejects(t.request('fmp', 'https://evil.test', 'AAPL'), /ENDPOINT/);
  await assert.rejects(t.request('fmp', 'profile', '../AAPL'), /SYMBOL/);
  q.close();
});
test('transport stops entire stage on rate limit even in a successful payload', async () => {
  let calls = 0; const q = new DailyQuota(':memory:', 20);
  const t = new EquityTransport(config(), {quota:q,fetch:async () => { calls++; return Response.json({'Error Message':'Limit Reach . Please upgrade your plan'}); }});
  await assert.rejects(t.request('fmp','profile','AAPL'), /RATE_LIMIT/);
  await assert.rejects(t.request('fmp','profile','MSFT'), /RATE_LIMIT/);
  assert.equal(calls, 1); q.close();
});
test('transport enforces response limits, cancellation and 32 attempts', async () => {
  const q = new DailyQuota(':memory:', 200);
  const t = new EquityTransport({...config(),maxRetries:0}, {quota:q, fetch:async () => new Response('x', {headers:{'content-length':'2097153'}})});
  await assert.rejects(t.request('fmp','profile','AAPL'), /RESPONSE_SIZE/);
  const budget = new EquityTransport({...config(),maxRetries:0}, {quota:q,fetch:async()=>Response.json([])});
  for(let i=0;i<32;i++) await budget.request('fmp','profile','AAPL');
  await assert.rejects(budget.request('fmp','profile','AAPL'), /HTTP_BUDGET/);
  const controller = new AbortController(); controller.abort();
  const cancelled = new EquityTransport(config(), {quota:q,signal:controller.signal, fetch:async()=>Response.json([])});
  await assert.rejects(cancelled.request('fmp','profile','AAPL'), /CANCELLED/); q.close();
});
test('SEC allows only canonical endpoints and verified filing paths', async () => {
  const seen:string[] = [];
  const t = new EquityTransport(config(), {fetch:async url => {seen.push(String(url));return Response.json({});}});
  await t.request('sec','tickers');
  assert.equal(seen[0], 'https://www.sec.gov/files/company_tickers_exchange.json');
  await assert.rejects(t.filing('https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/../../evil.htm'), /FILING/);
  await assert.rejects(t.filing('https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl.htm'), /FILING_NOT_VERIFIED/);
});
test('deadline prevents delayed budget hooks from sending a request after return', async () => {
  let calls=0;
  const q=new DailyQuota(':memory:',20);
  const t=new EquityTransport({...config(),timeoutMs:5,maxRetries:0},{quota:q,beforeRequest:async()=>{await new Promise(resolve=>setTimeout(resolve,30));},fetch:async()=>{calls++;return Response.json([]);}});
  await assert.rejects(t.request('fmp','profile','AAPL'),/REQUEST_TIMEOUT/);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(calls,0);assert.equal(q.usage(),0);q.close();
});
test('artifact recording failure never repeats a successful provider call', async () => {
  let calls=0;const q=new DailyQuota(':memory:',20);
  const t=new EquityTransport(config(),{quota:q,fetch:async()=>{calls++;return Response.json([]);},record:async()=>{throw new Error('secret-key');}});
  await assert.rejects(t.request('fmp','profile','AAPL'),/RECORD_FAILED/);
  assert.equal(calls,1);q.close();
});
test('SEC verified filings are only issued after matching submissions metadata', async () => {
  const t=new EquityTransport(config(),{fetch:async url=>String(url).includes('submissions')?Response.json({cik:320193,filings:{recent:{accessionNumber:['0000320193-26-000001'],primaryDocument:['aapl.htm']}}}):new Response('<html>filing</html>')});
  await t.request('sec','submissions/CIK0000320193.json');
  assert.equal(await t.filing('https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl.htm'),'<html>filing</html>');
});
test('shared SEC dispatch pacing survives slow beforeRequest hooks across instances',async()=>{
  const times:number[]=[];
  const fetcher=async()=>{times.push(Date.now());return Response.json({});};
  const a=new EquityTransport(config(),{beforeRequest:async()=>{await new Promise(resolve=>setTimeout(resolve,800));},fetch:fetcher});
  const b=new EquityTransport(config(),{fetch:fetcher});
  await Promise.all([a.request('sec','tickers'),b.request('sec','tickers')]);
  assert.ok(Math.abs(times[1]!-times[0]!)>=450,`dispatch interval ${Math.abs(times[1]!-times[0]!)}`);
});
test('budget hook failure is safe and never retried',async()=>{
  let hooks=0;
  const t=new EquityTransport(config(),{beforeRequest:()=>{hooks++;throw new Error('secret-key');},fetch:async()=>{throw new Error('must not fetch');}});
  await assert.rejects(t.request('fmp','profile','AAPL'),/REQUEST_REJECTED/);
  assert.equal(hooks,1);
});

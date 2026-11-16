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

test('SEC exhibit retrieval requires an accession index authorized by that CIK primary filing',async()=>{
 const primary='https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm',directory='/Archives/edgar/data/1/000000000126000001',seen:string[]=[],records:any[]=[];let hooks=0;
 const t=new EquityTransport({...config(),maxRetries:0},{beforeRequest:()=>{hooks++;},record:async r=>{records.push(r);},fetch:async url=>{
  const u=String(url);seen.push(u);if(u.includes('submissions'))return Response.json({cik:1,filings:{recent:{accessionNumber:['0000000001-26-000001'],primaryDocument:['report.htm']}}});
  if(u.endsWith('index.json'))return Response.json({directory:{name:directory,item:[{name:'actual-ex99_1.htm'},{name:'../../other.htm'},{name:'%2e%2e.htm'},{name:'nested/release.htm'},{name:'image.pdf'},{name:'index.json'}]}});
  return new Response('<p>Actual earnings release exhibit</p>');
 }});
 await assert.rejects(t.filingIndex(primary),/FILING.*VERIFIED/);assert.equal(seen.length,0);
 await t.request('sec','submissions/CIK0000000001.json');
 await assert.rejects(t.filing(`${primary.slice(0,primary.lastIndexOf('/')+1)}actual-ex99_1.htm`),/FILING_NOT_VERIFIED/);
 await assert.rejects(t.filingIndex(primary.replace('000000000126000001','000000000126000002')),/FILING.*VERIFIED/);
 await t.filingIndex(primary);
 assert.equal(await t.filing(`${primary.slice(0,primary.lastIndexOf('/')+1)}actual-ex99_1.htm`),'<p>Actual earnings release exhibit</p>');
 await assert.rejects(t.filingIndex(`${primary.slice(0,primary.lastIndexOf('/')+1)}actual-ex99_1.htm`),/FILING.*VERIFIED/);
 for(const filename of ['other.htm','%2e%2e.htm','nested/release.htm','image.pdf'])await assert.rejects(t.filing(`${primary.slice(0,primary.lastIndexOf('/')+1)}${filename}`),/FILING/);
 assert.deepEqual(seen,['https://data.sec.gov/submissions/CIK0000000001.json',`https://www.sec.gov${directory}/index.json`,`https://www.sec.gov${directory}/actual-ex99_1.htm`]);assert.equal(hooks,3);assert.equal(records[1].endpoint,'filing-index');assert.equal(t.requestCount,3);
});

test('SEC index response cannot authorize files from another accession or an unmatched CIK',async()=>{
 const primary='https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm';let calls=0;
 const t=new EquityTransport({...config(),maxRetries:0},{fetch:async url=>{calls++;return Response.json(String(url).includes('submissions')?{cik:1,filings:{recent:{accessionNumber:['0000000001-26-000001'],primaryDocument:['report.htm']}}}:{directory:{name:'/Archives/edgar/data/1/000000000126000002',item:[{name:'earnings.htm'}]}});}});
 await t.request('sec','submissions/CIK0000000002.json');await assert.rejects(t.filingIndex(primary),/FILING.*VERIFIED/);assert.equal(calls,1);
 await t.request('sec','submissions/CIK0000000001.json');await assert.rejects(t.filingIndex(primary),/INVALID_FILING_INDEX/);
 await assert.rejects(t.filing(primary.replace('report.htm','earnings.htm')),/FILING_NOT_VERIFIED/);assert.equal(calls,3);
});

test('verified SEC filing bodies allow16MiB while ordinary provider responses retain2MiB limits',async()=>{
 const primary='https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm',large='<html><p>'+('disclosure '.repeat(200000))+'</p></html>';let filingCalls=0;
 const t=new EquityTransport({...config(),maxRetries:0},{fetch:async url=>{
  const u=String(url);if(u.includes('submissions'))return Response.json({cik:1,filings:{recent:{accessionNumber:['0000000001-26-000001'],primaryDocument:['report.htm']}}});
  if(u===primary){filingCalls++;return filingCalls===1?new Response(large):new Response('too large',{headers:{'content-length':'16777217'}});}
  return new Response('provider response',{headers:{'content-length':'2097153'}});
 }});
 await t.request('sec','submissions/CIK0000000001.json');assert.equal((await t.filing(primary)).length,large.length);await assert.rejects(t.filing(primary),/RESPONSE_SIZE/);await assert.rejects(t.request('fmp','profile','AAPL'),/RESPONSE_SIZE/);assert.equal(filingCalls,2);
});

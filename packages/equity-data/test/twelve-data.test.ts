import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TwelveDataQuota } from '../src/twelve-quota.js';
import { normalizeTwelvePrices, normalizeTwelveStockPrices, currentNewYorkDate, previousNewYorkDate } from '../src/twelve-data.js';
import { EquityTransport } from '../src/transport.js';
import { loadEquityConfig } from '../src/config.js';

const payload=()=>({meta:{symbol:'QQQ',interval:'1day',currency:'USD',exchange_timezone:'America/New_York',exchange:'NASDAQ',mic_code:'XNAS',type:'ETF'},values:[{datetime:'2026-11-13',close:'600.25',volume:'12000'},{datetime:'2026-11-12',close:'590.5',volume:'11000'}],status:'ok'});
test('Twelve Data ETF prices require matching US identity, finite strings and completed daily dates',()=>{
  const p=normalizeTwelvePrices(payload(),'QQQ','2026-11-16T06:00:00Z');
  assert.equal(p.adjustment,'split-adjusted');assert.equal(p.source,'twelve-data:time_series:adjust=splits');
  assert.deepEqual(p.bars.map(b=>b.close),[590.5,600.25]);
  assert.equal(normalizeTwelvePrices({...payload(),meta:{...payload().meta,mic_code:'XNMS'}},'QQQ','2026-11-16T06:00:00Z').bars.length,2);
  for(const change of [{symbol:'SPY'},{currency:'CAD'},{type:'Common Stock'},{exchange_timezone:'Europe/London'},{interval:'1min'},{mic_code:'XTSE'}]){
    assert.throws(()=>normalizeTwelvePrices({...payload(),meta:{...payload().meta,...change}},'QQQ','2026-11-16T06:00:00Z'));
  }
  for(const close of ['', 'Infinity', '-1','12oops'])assert.throws(()=>normalizeTwelvePrices({...payload(),values:[{datetime:'2026-11-13',close}]},'QQQ','2026-11-16T06:00:00Z'));
  assert.throws(()=>normalizeTwelvePrices({...payload(),values:[{datetime:'2026-11-16',close:'1'}]},'QQQ','2026-11-16T22:00:00Z'),/INCOMPLETE_PRICE_DATE/);
  assert.equal(previousNewYorkDate('2026-11-16T02:00:00Z'),'2026-11-14');
});
test('Twelve Data stock prices must match verified listing and exclude the current New York date',()=>{
  const asOf='2026-11-17T07:00:00Z';
  const security={symbol:'CRM',cik:'0001108524',kind:'common-stock' as const,exchange:'NYSE',name:'Salesforce',currency:'USD',country:'US'};
  const body={...payload(),meta:{...payload().meta,symbol:'CRM',exchange:'NYSE',mic_code:'XNYS',type:'Common Stock'},values:[{datetime:'2026-11-16',close:'175.25'}]};
  assert.equal(normalizeTwelveStockPrices(body,security,asOf).bars[0]!.close,175.25);
  for(const changes of [{symbol:'NOW'},{type:'ETF'},{mic_code:'XNGS'},{currency:'CAD'}]){
    assert.throws(()=>normalizeTwelveStockPrices({...body,meta:{...body.meta,...changes}},security,asOf),/STOCK_PRICE_IDENTITY_MISMATCH/);
  }
  assert.throws(()=>normalizeTwelveStockPrices({...body,values:[{datetime:currentNewYorkDate(asOf),close:'175.25'}]},security,asOf),/INCOMPLETE_PRICE_DATE/);
});
test('Twelve Data reservations persist across instances, space dispatches and reset by UTC day',()=>{
  const dir=mkdtempSync(join(tmpdir(),'td-quota-')),path=join(dir,'quota.sqlite');
  const a=new TwelveDataQuota(path,2),b=new TwelveDataQuota(path,2);const now=Date.parse('2026-11-16T12:00:00Z');
  try{
    assert.equal(a.reserve(now),0);assert.equal(b.reserve(now+1),7999);assert.equal(a.usage(new Date(now)),1);
    assert.equal(b.reserve(now+8000),0);assert.equal(a.usage(new Date(now)),2);
    assert.throws(()=>a.reserve(now+16000),/QUOTA_EXHAUSTED/);
    assert.equal(b.reserve(Date.parse('2026-11-17T00:00:00Z')),0);
    assert.equal(b.usage(new Date('2026-11-17T00:00:00Z')),1);
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('Twelve Data uses header auth, fixed ETF-only requests and redacted recorded parameters',async()=>{
  const q=new TwelveDataQuota(':memory:',10);const records:any[]=[];let calls=0;
  const c=loadEquityConfig({TWELVE_DATA_API_KEY:'private-td-key',MAX_RETRIES:'0'},[]);
  const t=new EquityTransport(c,{twelveQuota:q,record:async r=>{records.push(r);},fetch:async(input,init)=>{
    calls++;const u=new URL(String(input));assert.equal(u.hostname,'api.twelvedata.com');assert.equal(u.pathname,'/time_series');
    assert.equal(u.searchParams.get('adjust'),'splits');assert.equal(u.searchParams.get('interval'),'1day');assert.equal(u.searchParams.get('type'),'ETF');
    assert.equal(u.searchParams.has('apikey'),false);assert.equal(new Headers(init?.headers).get('Authorization'),'apikey private-td-key');
    return Response.json({...payload(),echo:'private-td-key'});
  }});
  try{
    await t.request('twelve-data','time_series','QQQ');assert.equal(calls,1);assert.equal(q.usage(),1);
    assert.equal(records[0].parameters.adjust,'splits');assert.equal(JSON.stringify(records).includes('private-td-key'),false);
    await assert.rejects(t.request('twelve-data','time_series','AAPL'),/MARKET_SYMBOL/);
    await assert.rejects(t.request('twelve-data','quote','SPY'),/ENDPOINT/);
  }finally{q.close();}
});
test('Twelve Data embedded rate limit stops the stage without retry or FMP fallback',async()=>{
  const q=new TwelveDataQuota(':memory:',10);let calls=0;
  const t=new EquityTransport(loadEquityConfig({TWELVE_DATA_API_KEY:'td-secret'},[]),{twelveQuota:q,fetch:async()=>{calls++;return Response.json({status:'error',code:429,message:'You have run out of API credits'});}});
  try{await assert.rejects(t.request('twelve-data','time_series','SPY'),/RATE_LIMIT/);await assert.rejects(t.request('twelve-data','time_series','QQQ'),/RATE_LIMIT/);assert.equal(calls,1);}finally{q.close();}
});
test('cancelling a paced Twelve Data request dispatches no late HTTP and consumes no extra quota',async()=>{
  const q=new TwelveDataQuota(':memory:',10);q.reserve();const controller=new AbortController();let calls=0;
  const t=new EquityTransport(loadEquityConfig({TWELVE_DATA_API_KEY:'td-secret'},[]),{twelveQuota:q,signal:controller.signal,fetch:async()=>{calls++;return Response.json(payload());}});
  const result=t.request('twelve-data','time_series','SPY');setTimeout(()=>controller.abort(),15);
  try{await assert.rejects(result,/CANCELLED/);assert.equal(calls,0);assert.equal(q.usage(),1);}finally{q.close();}
});

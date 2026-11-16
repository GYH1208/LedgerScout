import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketSnapshot, deriveMetrics } from '../src/metrics.js';
import type { FinancialPoint, Financials, PriceSeries, Security } from '../src/types.js';
const security: Security = { symbol:'ACME', name:'Acme', cik:'1', exchange:'NYSE', currency:'USD',country:'US',kind:'common-stock' };
const p = (metric:string,value:number,start:string,end:string,unit='USD'):FinancialPoint => ({ metric,value,start,end,unit,filed:'2025-02-01',accession:'a',form:'10-K' });
const financials = (annual:FinancialPoint[],quarterly:FinancialPoint[]=[]):Financials => ({annual,quarterly,warnings:[]});
const prices = (symbol='ACME', adjustment:PriceSeries['adjustment']='split-adjusted'):PriceSeries => ({symbol,adjustment,source:'fixture',fetchedAt:'2025-04-01T00:00:00Z', bars:[{date:'2025-03-27',close:100},{date:'2025-03-28',close:110},{date:'2025-03-31',close:121}]});

test('derives matching-period margin and free cash flow with source references', () => {
 const result = deriveMetrics(security, financials([p('revenue',200,'2024-01-01','2024-12-31'),p('netIncome',20,'2024-01-01','2024-12-31'),p('operatingCashFlow',50,'2024-01-01','2024-12-31'),p('capex',15,'2024-01-01','2024-12-31')]),prices(),['sec:1']);
 assert.equal(result.netMargin?.value,10); assert.equal(result.freeCashFlow?.value,35);
 assert.match(result.freeCashFlow!.definition,/operating cash flow.*capital expenditures/i);
 assert.ok(result.netMargin?.sourceRefs.includes('sec:1')); assert.equal(result.return1d?.value,10);
});

test('does not compare currencies or different-length fiscal periods', () => {
 const result = deriveMetrics(security, financials([p('revenue',200,'2024-01-01','2024-12-31'),p('revenue',100,'2023-07-01','2023-12-31'),p('netIncome',20,'2024-01-01','2024-12-31','EUR')]));
 assert.equal(result.revenueGrowthYoY?.value,null); assert.equal(result.netMargin?.value,null);
});

test('TTM needs four consecutive coherent quarters and does not infer an EPS share basis', () => {
 const quarters = [['2024-01-01','2024-03-31'],['2024-04-01','2024-06-30'],['2024-07-01','2024-09-30'],['2024-10-01','2024-12-31']];
 const q = quarters.map(([s,e])=>p('revenue',25,s!,e!));
 assert.equal(deriveMetrics(security,financials([],q)).revenueTtm?.value,100);
 assert.equal(deriveMetrics(security,financials([],q.slice(1))).revenueTtm?.value,null);
 const broken = q.map(x=>({...x})); broken[2]!.start='2024-07-02';
 assert.equal(deriveMetrics(security,financials([],broken)).revenueTtm?.value,null);
 assert.equal(deriveMetrics(security,financials([p('dilutedEps',-1,'2024-01-01','2024-12-31','USD/shares')]),prices()).pe?.value,null);
});

test('special industries do not receive general company ratios', () => {
 const result=deriveMetrics({...security,industry:'Insurance - Life'}, {...financials([p('revenue',200,'2024-01-01','2024-12-31'),p('netIncome',20,'2024-01-01','2024-12-31')]),industryExclusion:'insurance'});
 assert.equal(result.netMargin?.value,null); assert.match(result.netMargin!.reason!,/insurance/i);
});

test('market aligns dates across available proxies, computes price returns and relative SPY percentage points', () => {
 const spy=prices('SPY'); const qqq=prices('QQQ'); qqq.bars[2]!.close=132;
 qqq.bars.push({date:'2025-04-01',close:140});
 const result=buildMarketSnapshot([spy,qqq]);
 assert.equal(result.commonDate,'2025-03-31'); assert.equal(result.coverage,2); assert.equal(result.total,13);
 assert.equal(result.rows.find(r=>r.symbol==='QQQ')?.returns['1d'],20);
 assert.equal(result.rows.find(r=>r.symbol==='QQQ')?.relativeToSpy['1d'],10);
 assert.equal(result.rows.find(r=>r.symbol==='XLE')?.price,null);
});

test('unknown/unadjusted series expose prices but do not enter return comparisons', () => {
 const result=buildMarketSnapshot([prices('SPY'),prices('QQQ','unknown'),prices('XLE','unadjusted')]);
 assert.equal(result.rows.find(r=>r.symbol==='QQQ')?.returns['1d'],null);
 assert.equal(result.rows.find(r=>r.symbol==='XLE')?.returns['1d'],null);
 assert.equal(result.rows.find(r=>r.symbol==='SPY')?.returns['5d'],null);
});

test('TTM will not relabel a foreign-currency total as USD', () => {
 const quarters=[['2024-01-01','2024-03-31'],['2024-04-01','2024-06-30'],['2024-07-01','2024-09-30'],['2024-10-01','2024-12-31']];
 const result=deriveMetrics(security,financials([],quarters.map(([s,e])=>p('revenue',25,s!,e!,'EUR'))));
 assert.equal(result.revenueTtm?.value,null);
});

test('positive same-length prior-year revenue calculates growth and its UI alias', () => {
 const result=deriveMetrics(security,financials([p('revenue',120,'2024-01-01','2024-12-31'),p('revenue',100,'2023-01-01','2023-12-31')]));
 assert.equal(result.revenueGrowth?.value,20);assert.equal(result.revenueGrowthYoY?.value,20);
});

test('a missing interior proxy date cannot turn a one-session comparison into two SPY sessions', () => {
 const spy=prices('SPY'),qqq=prices('QQQ');qqq.bars.splice(1,1);
 const result=buildMarketSnapshot([spy,qqq]);
 assert.equal(result.rows.find(row=>row.symbol==='SPY')?.returns['1d'],10);
 assert.equal(result.rows.find(row=>row.symbol==='QQQ')?.returns['1d'],null);
});

test('conflicting duplicate dates are unusable and missing SPY prevents relative-return claims', () => {
 const qqq=prices('QQQ');qqq.bars.push({date:'2025-03-31',close:200});
 const result=buildMarketSnapshot([qqq]);
 assert.equal(result.commonDate,'2025-03-28');
 assert.equal(result.rows.find(row=>row.symbol==='QQQ')?.relativeToSpy['1d'],null);
});

test('all return horizons use trading-session offsets and expose the twenty-one-session UI metric', () => {
 const series:PriceSeries={...prices('SPY'),bars:Array.from({length:64},(_,i)=>({date:new Date(Date.UTC(2024,0,1+i)).toISOString().slice(0,10),close:150}))};
 series.bars[0]!.close=50;series.bars[42]!.close=100;series.bars[58]!.close=125;series.bars[62]!.close=160;series.bars[63]!.close=200;
 const row=buildMarketSnapshot([series]).rows.find(r=>r.symbol==='SPY')!;
 assert.deepEqual(row.returns,{'1d':25,'5d':60,'21d':100,'63d':300});
 const own={...series,symbol:'ACME'};assert.equal(deriveMetrics(security,financials([]),own).priceReturn21?.value,100);
});

test('zero revenue and negative capex cannot produce finite-looking financial ratios', () => {
 const result=deriveMetrics(security,financials([p('revenue',0,'2024-01-01','2024-12-31'),p('netIncome',10,'2024-01-01','2024-12-31'),p('operatingCashFlow',50,'2024-01-01','2024-12-31'),p('capex',-5,'2024-01-01','2024-12-31')]));
 assert.equal(result.netMargin?.value,null);assert.equal(result.freeCashFlow?.value,null);
});

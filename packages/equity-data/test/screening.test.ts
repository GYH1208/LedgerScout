import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenCompanies, validateFilters } from '../src/screening.js';
import type { CompanySnapshot, MetricValue } from '../src/types.js';
const metric=(value:number|null):MetricValue=>({value,unit:'percent',definition:'fixture',period:'2024-01-01/2024-12-31',sourceRefs:['sec:1']});
const company=(symbol:string,value:number|null,fetchedAt='2025-04-01T00:00:00Z'):CompanySnapshot=>({security:{symbol,name:symbol,cik:'1',exchange:'NYSE',currency:'USD',country:'US',kind:'common-stock'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{netMargin:metric(value)},filings:[],sourceRefs:[],fetchedAt,warnings:[]});

test('validates allow-listed finite filters and rejects injected or unsupported fields', () => {
 assert.deepEqual(validateFilters([{field:'netMargin',op:'gt',value:0}]),[{field:'netMargin',op:'gt',value:0}]);
 for(const input of [null,{},[{field:'__proto__',op:'gt',value:0}],[{field:'madeUp',op:'gt',value:0}],[{field:'pe',op:'eq',value:1}],[{field:'pe',op:'gt',value:NaN}],[{field:'pe',op:'gt',value:1,code:'x'}]]) assert.throws(()=>validateFilters(input));
});

test('AND filters exclude missing and stale values without treating them as zero, echo conditions exactly', () => {
 const filters=validateFilters([{field:'netMargin',op:'gte',value:0},{field:'netMargin',op:'lt',value:20}]);
 const result=screenCompanies([company('ZERO',0),company('NULL',null),company('OLD',5,'2025-01-01T00:00:00Z'),company('HIGH',30)],filters,{now:'2025-04-01T12:00:00Z'});
 assert.deepEqual(result.filters,filters); assert.deepEqual(result.matches.map(m=>m.symbol),['ZERO']); assert.equal(result.total,4); assert.equal(result.missing,2);
 assert.equal(result.excluded.length,2);
});

test('sort excludes companies missing sort values and breaks ties by symbol deterministically', () => {
 const result=screenCompanies([company('Z',5),company('A',5),company('NULL',null),company('B',10)],[],{now:'2025-04-01T12:00:00Z',sortBy:'netMargin',descending:true});
 assert.deepEqual(result.matches.map(x=>x.symbol),['B','A','Z']);assert.equal(result.missing,1);
 assert.throws(()=>screenCompanies([],[],{sortBy:'constructor'}));
});

test('invalid timestamps and unsupported securities cannot pass the ordinary stock screen', () => {
 const etf=company('ETF',10);etf.security.kind='etf';
 const result=screenCompanies([company('BAD',5,'invalid'),etf],[],{now:'2025-04-01T12:00:00Z'});
 assert.equal(result.matches.length,0);assert.equal(result.excluded.length,2);
});

test('price filters reject stale price cache even when financial snapshot was refreshed', () => {
 const c=company('OLDPRICE',5);c.metrics.priceReturn21=metric(10);c.prices={symbol:'OLDPRICE',adjustment:'split-adjusted',source:'prices',fetchedAt:'2025-01-01T00:00:00Z',bars:[]};
 const result=screenCompanies([c],[{field:'priceReturn21',op:'gt',value:0}],{now:'2025-04-01T12:00:00Z'});
 assert.equal(result.matches.length,0);assert.equal(result.missing,1);
});

test('stock price comparisons use the same session edges and do not fill a missing close',()=>{
 const a=company('A',1),b=company('B',1),c=company('C',1);
 for(const [entry,bars] of [
  [a,[['2025-03-27',100],['2025-03-28',110],['2025-03-31',121]]],
  [b,[['2025-03-27',50],['2025-03-28',55]]],
  [c,[['2025-03-26',20],['2025-03-28',30]]],
 ] as [CompanySnapshot,[string,number][]][]){
  entry.prices={symbol:entry.security.symbol,adjustment:'split-adjusted',source:'twelve-data:stock_time_series:adjust=splits',fetchedAt:'2025-04-01T00:00:00Z',bars:bars.map(([date,close])=>({date,close}))};
 }
 const result=screenCompanies([a,b,c],[],{sortBy:'return1d',now:'2025-04-01T12:00:00Z'});
 assert.deepEqual(result.matches.map(m=>[m.symbol,m.metrics.return1d!.period,m.metrics.return1d!.value]),[['A','2025-03-27/2025-03-28',10],['B','2025-03-27/2025-03-28',10]]);
 assert.deepEqual(result.excluded.map(m=>m.symbol),['C']);
});

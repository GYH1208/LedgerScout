import type {CompanySnapshot,PriceSeries,ScreenFilter,ScreenResult} from './types.js';
import {commonStockSessions,derivePriceReturns} from './metrics.js';
export const SCREEN_FIELDS = ['revenue','netIncome','operatingCashFlow','capex','freeCashFlow','cash','assets','liabilities','dilutedEps','revenueGrowth','revenueGrowthYoY','netMargin','revenueTtm','netIncomeTtm','operatingCashFlowTtm','capexTtm','freeCashFlowTtm','pe','priceReturn21','return1d','return5d','return21d','return63d'] as const;
const allowed = new Set<string>(SCREEN_FIELDS);
export function validateFilters(value:unknown):ScreenFilter[]{
  if(!Array.isArray(value)||value.length>20)throw new Error('Filters must be an array of at most 20 supported conditions.');
  return value.map(entry=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).some(key=>!['field','op','value'].includes(key))
      ||!allowed.has(entry.field)||!['gt','gte','lt','lte'].includes(entry.op)||typeof entry.value!=='number'||!Number.isFinite(entry.value))throw new Error('Unsupported screen filter.');
    return {field:entry.field,op:entry.op,value:entry.value};
  });
}
export function screenCompanies(companies:CompanySnapshot[],filters:ScreenFilter[],options:{sortBy?:string;descending?:boolean;now?:string;maxAgeMs?:number;benchmark?:PriceSeries}={}):ScreenResult{
  const conditions=validateFilters(filters);
  if(options.sortBy&&!allowed.has(options.sortBy))throw new Error('Unsupported sort field.');
  const now=options.now??new Date().toISOString(),timestamp=Date.parse(now),maxAge=options.maxAgeMs??86_400_000;
  if(!Number.isFinite(timestamp)||!Number.isFinite(maxAge)||maxAge<0)throw new Error('Invalid screen freshness options.');
  const fields=[...new Set([...conditions.map(f=>f.field),...(options.sortBy?[options.sortBy]:[])])];
  const usesPrices=fields.some(field=>field==='priceReturn21'||/^return\d+d$/.test(field));
  const fresh=(date:string)=>{const age=timestamp-Date.parse(date);return Number.isFinite(age)&&age>=0&&age<=maxAge;};
  const supported=(company:CompanySnapshot)=>company.security.kind==='common-stock'&&company.security.currency==='USD'&&company.security.country==='US';
  const priceEligible=(company:CompanySnapshot)=>company.prices?.symbol===company.security.symbol&&company.prices.adjustment==='split-adjusted'&&company.prices.bars.length>0&&fresh(company.prices.fetchedAt);
  const sessions=usesPrices?commonStockSessions(companies.filter(c=>supported(c)&&fresh(c.fetchedAt)&&priceEligible(c)).map(c=>c.prices!),options.benchmark):undefined;
  const result:ScreenResult={filters:conditions,total:companies.length,matches:[],excluded:[],missing:0,asOf:now};
  for(const company of companies){
    const symbol=company.security.symbol;
    let reason:string|undefined;
    if(!supported(company))reason='Unsupported security for USD US common-stock comparison.';
    else if(!fresh(company.fetchedAt))reason='Snapshot is stale or has an invalid acquisition timestamp.';
    else if(usesPrices&&!priceEligible(company))reason='Verified split-adjusted stock price cache is missing or stale.';
    const metrics=usesPrices&&!reason?{...company.metrics,...derivePriceReturns(company.prices,company.sourceRefs.map(ref=>ref.id),sessions)}:company.metrics;
    if(!reason)for(const field of fields){const metric=Object.hasOwn(metrics,field)?metrics[field]:undefined;if(metric?.value==null||!Number.isFinite(metric.value)){reason=`${field}: ${metric?.reason??'metric unavailable'}`;break;}}
    if(reason){result.excluded.push({symbol,reason});result.missing++;continue;}
    if(conditions.every(filter=>{const value=metrics[filter.field]!.value!;switch(filter.op){case'gt':return value>filter.value;case'gte':return value>=filter.value;case'lt':return value<filter.value;case'lte':return value<=filter.value;}}))result.matches.push({symbol,name:company.security.name,metrics});
  }
  result.matches.sort((a,b)=>options.sortBy?(a.metrics[options.sortBy]!.value!-b.metrics[options.sortBy]!.value!)*(options.descending?-1:1)||a.symbol.localeCompare(b.symbol):a.symbol.localeCompare(b.symbol));
  result.excluded.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  return result;
}

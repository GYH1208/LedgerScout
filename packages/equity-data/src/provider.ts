import type { Filing, PriceBar, PriceSeries, Security } from './types.js';
import { EquityDataError, EquityTransport, equitySymbol, safeEquityCode } from './transport.js';

type Row=Record<string,unknown>;
function row(value:unknown):Row {if(!value||typeof value!=='object'||Array.isArray(value))throw new EquityDataError('INVALID_DATA');return value as Row;}
function day(value:unknown):string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new EquityDataError('INVALID_DATE');return value;
}
function cik(value:unknown):string {const s=String(value);if(!/^\d{1,10}$/.test(s)||Number(s)===0)throw new EquityDataError('INVALID_CIK');return s.padStart(10,'0');}
function exchange(value:unknown):string {
  const map:Record<string,string>={NASDAQ:'NASDAQ',NASDAQGS:'NASDAQ',NASDAQGM:'NASDAQ',NASDAQCM:'NASDAQ',NYSE:'NYSE',AMEX:'AMEX','NYSE AMERICAN':'AMEX'};
  const result=typeof value==='string'?map[value.toUpperCase()]:undefined;
  if(!result)throw new EquityDataError('UNSUPPORTED_EXCHANGE');return result;
}
export function normalizePrices(body:unknown,symbol:string,fetchedAt=new Date().toISOString()):PriceSeries {
  const s=equitySymbol(symbol),items=Array.isArray(body)?body:row(body).historical;
  if(!Number.isFinite(Date.parse(fetchedAt)))throw new EquityDataError('INVALID_FETCHED_AT');
  if(!Array.isArray(items)||items.length===0||items.length>5000)throw new EquityDataError('PRICE_DATA_UNAVAILABLE');
  const bars=new Map<string,PriceBar>();
  for(const item of items) {
    const r=row(item);if(r.symbol!==undefined&&r.symbol!==s)throw new EquityDataError('PRICE_SYMBOL_MISMATCH');
    const date=day(r.date),close=r.close??r.price;
    if(date>new Date(fetchedAt).toISOString().slice(0,10))throw new EquityDataError('FUTURE_PRICE_DATE');
    if(typeof close!=='number'||!Number.isFinite(close)||close<=0)throw new EquityDataError('INVALID_PRICE');
    if(r.volume!==undefined&&(typeof r.volume!=='number'||!Number.isFinite(r.volume)||r.volume<0))throw new EquityDataError('INVALID_VOLUME');
    const bar:PriceBar={date,close,...(r.volume!==undefined?{volume:r.volume as number}:{})};
    if(bars.has(date)&&JSON.stringify(bars.get(date))!==JSON.stringify(bar))throw new EquityDataError('PRICE_DATE_CONFLICT');
    bars.set(date,bar);
  }
  return {symbol:s,bars:[...bars.values()].sort((a,b)=>a.date.localeCompare(b.date)),adjustment:'unknown',source:'fmp:historical-price-eod/light',fetchedAt};
}
export function normalizeSecurity(profile:unknown,tickers:unknown,symbol:string):Security {
  const s=equitySymbol(symbol);
  if(!Array.isArray(profile)||profile.length!==1)throw new EquityDataError('SECURITY_IDENTITY_UNAVAILABLE');
  const p=row(profile[0]);
  if(p.symbol!==s||typeof p.companyName!=='string'||!p.companyName.trim())throw new EquityDataError('SECURITY_IDENTITY_MISMATCH');
  if(p.currency!=='USD'||p.country!=='US'||p.isEtf!==false||p.isFund!==false||p.isAdr!==false||p.isActivelyTrading!==true||/\b(preferred|preference|warrants?|rights|units|depositary)\b/i.test(p.companyName))throw new EquityDataError('UNSUPPORTED_SECURITY');
  const securityCik=cik(p.cik),securityExchange=exchange(p.exchange??p.exchangeShortName);
  const t=row(tickers);if(!Array.isArray(t.fields)||!Array.isArray(t.data))throw new EquityDataError('INVALID_SEC_TICKERS');
  const fields=t.fields as unknown[];
  for(const key of ['cik','ticker','exchange'])if(!fields.includes(key))throw new EquityDataError('INVALID_SEC_TICKERS');
  const matches=t.data.filter((r):r is unknown[]=>Array.isArray(r)&&r[fields.indexOf('ticker')]===s);
  if(matches.length!==1||cik(matches[0]![fields.indexOf('cik')])!==securityCik||exchange(matches[0]![fields.indexOf('exchange')])!==securityExchange)throw new EquityDataError('SECURITY_IDENTITY_MISMATCH');
  return {symbol:s,name:p.companyName,cik:securityCik,exchange:securityExchange,currency:'USD',country:'US',kind:'common-stock',...(typeof p.sector==='string'?{sector:p.sector}:{}),...(typeof p.industry==='string'?{industry:p.industry}:{})};
}
export function normalizeFilings(submissions:unknown,security:Security):Filing[] {
  const b=row(submissions);
  if(cik(b.cik)!==security.cik||!Array.isArray(b.tickers)||!b.tickers.includes(security.symbol)||!Array.isArray(b.exchanges)||!b.exchanges.some(x=>{try{return exchange(x)===security.exchange;}catch{return false;}}))throw new EquityDataError('SUBMISSIONS_IDENTITY_MISMATCH');
  const recent=row(row(b.filings).recent);
  const columns=['accessionNumber','form','filingDate','primaryDocument'];
  if(columns.some(k=>!Array.isArray(recent[k])))throw new EquityDataError('INVALID_FILINGS');
  const accessions=recent.accessionNumber as unknown[];
  if(accessions.length>10000||columns.some(k=>(recent[k] as unknown[]).length!==accessions.length))throw new EquityDataError('INVALID_FILINGS');
  return accessions.slice(0,1000).flatMap((accession,i)=>{
    const primaryDocument=(recent.primaryDocument as unknown[])[i],form=(recent.form as unknown[])[i];
    if(typeof form!=='string'||!['10-K','10-K/A','10-Q','10-Q/A','8-K','8-K/A'].includes(form))return [];
    if(typeof accession!=='string'||!/^\d{10}-\d{2}-\d{6}$/.test(accession)||typeof primaryDocument!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.(?:htm|html|txt)$/i.test(primaryDocument)||primaryDocument.includes('..')||typeof form!=='string'||!/^[A-Z0-9 /-]{1,30}$/.test(form))throw new EquityDataError('INVALID_FILING');
    return [{accession,form,filed:day((recent.filingDate as unknown[])[i]),primaryDocument,url:`https://www.sec.gov/Archives/edgar/data/${Number(security.cik)}/${accession.replaceAll('-','')}/${primaryDocument}`}];
  });
}
export class EquityProvider {
  private tickers?:unknown;
  constructor(private readonly transport:EquityTransport,private readonly options:{profileCache?:{get:(symbol:string)=>Promise<unknown|undefined>}}={}) {}
  async getMarket(symbol:string):Promise<PriceSeries> {const s=equitySymbol(symbol);return normalizePrices(await this.transport.request('fmp','historical-price-eod/light',s),s);}
  async getCompany(symbol:string):Promise<{security:Security;prices?:PriceSeries;companyFacts:unknown;filings:Filing[];warnings:string[]}> {
    const s=equitySymbol(symbol);
    const profile=await this.options.profileCache?.get(s)??await this.transport.request('fmp','profile',s);
    const tickers=this.tickers??await this.transport.request('sec','tickers',s);
    const security=normalizeSecurity(profile,tickers,s);
    this.tickers=tickers;
    const submissions=await this.transport.request('sec',`submissions/CIK${security.cik}.json`,s);
    const filings=normalizeFilings(submissions,security);
    const companyFacts=await this.transport.request('sec',`api/xbrl/companyfacts/CIK${security.cik}.json`,s);
    if(cik(row(companyFacts).cik)!==security.cik||!row(companyFacts).facts)throw new EquityDataError('COMPANYFACTS_IDENTITY_MISMATCH');
    let prices:PriceSeries|undefined;const warnings:string[]=[];
    try{prices=await this.getMarket(s);}catch(error){
      const code=safeEquityCode(error);
      if(['CANCELLED','STAGE_DEADLINE','RATE_LIMIT','QUOTA_EXHAUSTED','QUOTA_STORAGE','RECORD_FAILED','HTTP_BUDGET'].includes(code))throw error;
      warnings.push(`prices:${code}`);
    }
    return {security,prices,companyFacts,filings,warnings};
  }
  async getFiling(filing:Filing):Promise<string> {return this.transport.filing(filing.url);}
}

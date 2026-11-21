import { normalizePrices } from './provider.js';
import { EquityTransport,EquityDataError,equitySymbol } from './transport.js';
import { MARKET_SYMBOLS,type PriceSeries,type Security } from './types.js';

export const TWELVE_PRICE_SOURCE='twelve-data:time_series:adjust=splits';
export const TWELVE_STOCK_PRICE_SOURCE='twelve-data:stock_time_series:adjust=splits';
const stockMics:Record<string,readonly string[]>={NASDAQ:['XNAS','XNGS','XNMS','XNCM'],NYSE:['XNYS'],AMEX:['XASE']};
export function currentNewYorkDate(now=new Date().toISOString()):string{
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const part=(name:string)=>parts.find(p=>p.type===name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function previousNewYorkDate(now=new Date().toISOString()):string{
  return new Date(Date.parse(currentNewYorkDate(now))-86_400_000).toISOString().slice(0,10);
}
/** Called only for our fixed time_series request with explicit adjust=splits. */
export function normalizeTwelvePrices(body:unknown,symbol:string,fetchedAt=new Date().toISOString()):PriceSeries{
  const s=equitySymbol(symbol);
  if(!(MARKET_SYMBOLS as readonly string[]).includes(s))throw new EquityDataError('INVALID_MARKET_SYMBOL');
  return normalizeDailySeries(body,s,fetchedAt,'ETF',['XNAS','XNMS','XNGS','XNCM','XNYS','ARCX','XASE','BATS'],TWELVE_PRICE_SOURCE);
}
export function normalizeTwelveStockPrices(body:unknown,security:Security,fetchedAt=new Date().toISOString()):PriceSeries{
  if(security.kind!=='common-stock'||security.country!=='US'||security.currency!=='USD'||!Object.hasOwn(stockMics,security.exchange))throw new EquityDataError('INVALID_STOCK_SECURITY');
  return normalizeDailySeries(body,security.symbol,fetchedAt,'Common Stock',stockMics[security.exchange]!,TWELVE_STOCK_PRICE_SOURCE);
}
function normalizeDailySeries(body:unknown,symbol:string,fetchedAt:string,type:'ETF'|'Common Stock',mics:readonly string[],source:string):PriceSeries{
  const b=body as {status?:string;meta?:Record<string,unknown>;values?:Record<string,unknown>[]};const m=b?.meta;
  if(b?.status!=='ok'||!m||m.symbol!==symbol||m.interval!=='1day'||m.currency!=='USD'||m.type!==type||m.exchange_timezone!=='America/New_York'||!mics.includes(String(m.mic_code)))throw new EquityDataError(type==='ETF'?'MARKET_IDENTITY_MISMATCH':'STOCK_PRICE_IDENTITY_MISMATCH');
  if(!Array.isArray(b.values)||!b.values.length||b.values.length>128)throw new EquityDataError('PRICE_DATA_UNAVAILABLE');
  const decimal=(v:unknown,code:string)=>{
    if(typeof v!=='string'||!/^\d+(?:\.\d+)?$/.test(v)||!Number.isFinite(Number(v)))throw new EquityDataError(code);return Number(v);
  };
  const last=previousNewYorkDate(fetchedAt);
  const series=normalizePrices(b.values.map(v=>{
    if(!v||typeof v.datetime!=='string'||v.datetime>last)throw new EquityDataError('INCOMPLETE_PRICE_DATE');
    return {date:v.datetime,close:decimal(v.close,'INVALID_PRICE'),...(v.volume!==undefined?{volume:decimal(v.volume,'INVALID_VOLUME')}:{})};
  }),symbol,fetchedAt);
  return {...series,adjustment:'split-adjusted',source};
}
export class TwelveDataProvider{
  constructor(private readonly transport:EquityTransport){}
  async getMarket(symbol:string):Promise<PriceSeries>{return normalizeTwelvePrices(await this.transport.request('twelve-data','time_series',symbol),symbol);}
}

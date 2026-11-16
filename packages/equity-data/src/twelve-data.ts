import { normalizePrices } from './provider.js';
import { EquityTransport,EquityDataError,equitySymbol } from './transport.js';
import { MARKET_SYMBOLS,type PriceSeries } from './types.js';

export const TWELVE_PRICE_SOURCE='twelve-data:time_series:adjust=splits';
export function previousNewYorkDate(now=new Date().toISOString()):string{
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const part=(name:string)=>parts.find(p=>p.type===name)!.value;
  return new Date(Date.parse(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`)-86_400_000).toISOString().slice(0,10);
}
/** Called only for our fixed time_series request with explicit adjust=splits. */
export function normalizeTwelvePrices(body:unknown,symbol:string,fetchedAt=new Date().toISOString()):PriceSeries{
  const s=equitySymbol(symbol);
  if(!(MARKET_SYMBOLS as readonly string[]).includes(s))throw new EquityDataError('INVALID_MARKET_SYMBOL');
  const b=body as {status?:string;meta?:Record<string,unknown>;values?:Record<string,unknown>[]};const m=b?.meta;
  if(b?.status!=='ok'||!m||m.symbol!==s||m.interval!=='1day'||m.currency!=='USD'||m.type!=='ETF'||m.exchange_timezone!=='America/New_York'||!['XNAS','XNMS','XNGS','XNCM','XNYS','ARCX','XASE','BATS'].includes(String(m.mic_code)))throw new EquityDataError('MARKET_IDENTITY_MISMATCH');
  if(!Array.isArray(b.values)||!b.values.length||b.values.length>128)throw new EquityDataError('PRICE_DATA_UNAVAILABLE');
  const decimal=(v:unknown,code:string)=>{
    if(typeof v!=='string'||!/^\d+(?:\.\d+)?$/.test(v)||!Number.isFinite(Number(v)))throw new EquityDataError(code);return Number(v);
  };
  const last=previousNewYorkDate(fetchedAt);
  const series=normalizePrices(b.values.map(v=>{
    if(typeof v.datetime!=='string'||v.datetime>last)throw new EquityDataError('INCOMPLETE_PRICE_DATE');
    return {date:v.datetime,close:decimal(v.close,'INVALID_PRICE'),...(v.volume!==undefined?{volume:decimal(v.volume,'INVALID_VOLUME')}:{})};
  }),s,fetchedAt);
  return {...series,adjustment:'split-adjusted',source:TWELVE_PRICE_SOURCE};
}
export class TwelveDataProvider{
  constructor(private readonly transport:EquityTransport){}
  async getMarket(symbol:string):Promise<PriceSeries>{return normalizeTwelvePrices(await this.transport.request('twelve-data','time_series',symbol),symbol);}
}

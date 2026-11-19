import { MARKET_SYMBOLS } from './types.js';
import { EquityDataError, equitySymbol, safeEquityCode } from './transport.js';
import { normalizePrices } from './provider.js';
import { normalizeTwelvePrices } from './twelve-data.js';

export type Capability = {endpoint:string;symbol:string;status:'available'|'unavailable';fields:string[];historyLength:number;adjustment:'unknown'|'split-adjusted';asOf?:string;code?:string;identityVerified?:boolean};
export function parseCapabilityArgs(args:string[]):{config:boolean;stage?:'market'|'stocks';symbols:string[]} {
  if(args.length===1&&args[0]==='--config')return {config:true,symbols:[]};
  const options=new Map<string,string>();
  for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];if(!k||!['--stage','--symbols'].includes(k)||!v||options.has(k))throw new EquityDataError('CAPABILITY_ARGUMENTS');options.set(k,v);}
  const stage=options.get('--stage');if(stage!=='market'&&stage!=='stocks')throw new EquityDataError('CAPABILITY_STAGE_REQUIRED');
  const raw=options.get('--symbols');if(!raw&&stage==='stocks')throw new EquityDataError('CAPABILITY_SYMBOLS_REQUIRED');
  const symbols=raw?raw.split(',').map(equitySymbol):[...MARKET_SYMBOLS];
  if(!symbols.length||symbols.length>(stage==='stocks'?5:13)||new Set(symbols).size!==symbols.length)throw new EquityDataError('CAPABILITY_SYMBOL_LIMIT');
  if(stage==='market'&&symbols.some(s=>!(MARKET_SYMBOLS as readonly string[]).includes(s)))throw new EquityDataError('CAPABILITY_MARKET_SYMBOL');
  if(stage==='stocks'&&symbols.some(s=>(MARKET_SYMBOLS as readonly string[]).includes(s)))throw new EquityDataError('CAPABILITY_STOCK_SYMBOL');
  return {config:false,stage,symbols};
}
export function inspectCapability(endpoint:string,symbol:string,body:unknown,error?:unknown):Capability {
  const result:Capability={endpoint,symbol:equitySymbol(symbol),status:'unavailable',fields:[],historyLength:0,adjustment:'unknown'};
  if(error){result.code=safeEquityCode(error);return result;}
  try {
    const rows=Array.isArray(body)?body:body&&typeof body==='object'&&(body as {historical?:unknown}).historical;
    const sample=Array.isArray(rows)?rows[0]:body;
    result.fields=sample&&typeof sample==='object'?Object.keys(sample).sort():[];
    if(endpoint==='time_series'){
      const prices=normalizeTwelvePrices(body,symbol);result.historyLength=prices.bars.length;result.asOf=prices.bars.at(-1)!.date;result.adjustment=prices.adjustment as 'split-adjusted';result.fields=['meta','values','status'];result.identityVerified=true;
    } else if(endpoint==='historical-price-eod/light') {
      const prices=normalizePrices(body,symbol);result.historyLength=prices.bars.length;result.asOf=prices.bars.at(-1)!.date;
    } else if(endpoint==='profile') {
      if(!Array.isArray(body)||body.length!==1||!result.fields.includes('symbol')||body[0].symbol!==symbol)throw new EquityDataError('INVALID_PROFILE');
    } else if(endpoint==='tickers') {
      const t=body as {fields?:unknown[];data?:unknown[]};if(!Array.isArray(t.fields)||!Array.isArray(t.data))throw new EquityDataError('INVALID_SEC_TICKERS');result.fields=t.fields.filter((x):x is string=>typeof x==='string');result.historyLength=t.data.length;
    } else if(endpoint.startsWith('submissions/')) {
      const t=body as {filings?:{recent?:{accessionNumber?:unknown[]}}};if(!Array.isArray(t.filings?.recent?.accessionNumber))throw new EquityDataError('INVALID_FILINGS');result.historyLength=t.filings.recent.accessionNumber.length;
    } else if(endpoint.startsWith('api/xbrl/companyfacts/')) {
      const t=body as {facts?:unknown};if(!t.facts||typeof t.facts!=='object')throw new EquityDataError('INVALID_COMPANYFACTS');
    } else throw new EquityDataError('INVALID_ENDPOINT');
    result.status='available';return result;
  } catch(caught){result.code=safeEquityCode(caught);return result;}
}
export function assessCoverage(rows:Capability[]) {
  const prices=rows.filter(r=>['historical-price-eod/light','time_series','stock_time_series'].includes(r.endpoint)&&r.status==='available'&&r.historyLength>=1);
  const marketCovered=new Set(prices.filter(r=>(MARKET_SYMBOLS as readonly string[]).includes(r.symbol)).map(r=>r.symbol)).size;
  const stockCovered=new Set(prices.filter(r=>r.identityVerified&&!(MARKET_SYMBOLS as readonly string[]).includes(r.symbol)).map(r=>r.symbol)).size;
  // A single stage never proves common trading-date, identity and adjustment coverage.
  return {complete:false,marketCovered,marketRequired:13,stockCovered,stockRequired:5,reason:'Actual minimum coverage, common dates, security identity and adjustment semantics require review; unknown adjustment does not authorize return rankings.'};
}

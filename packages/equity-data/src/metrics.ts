import { MARKET_SYMBOLS, type FinancialPoint, type Financials, type MarketSnapshot, type MetricValue, type Metrics, type PriceBar, type PriceSeries, type Security } from './types.js';
import { specialIndustry, validDate } from './financials.js';

const DAY = 86_400_000;
const horizons = [1, 5, 21, 63] as const;
const monetary = ['revenue', 'netIncome', 'operatingCashFlow', 'capex', 'cash', 'assets', 'liabilities', 'dilutedEps'] as const;
const period = (p: FinancialPoint) => `${p.start ? `${p.start}/` : ''}${p.end}`;
const length = (p: FinancialPoint) => p.start ? (Date.parse(p.end) - Date.parse(p.start)) / DAY + 1 : 0;
const concept = (p: FinancialPoint) => p.derivedFrom?.[0]?.split('|')[0];
const coherent = (a:FinancialPoint,b:FinancialPoint) => a.unit === b.unit && a.start === b.start && a.end === b.end;
const round = (n:number) => Math.round(n * 1e10) / 1e10;

function cleanBars(series: PriceSeries): PriceBar[] {
  const dates = new Map<string, PriceBar>();
  const conflicts = new Set<string>();
  for (const bar of series.bars) {
    if (!validDate(bar.date) || !Number.isFinite(bar.close) || bar.close <= 0) continue;
    if (dates.has(bar.date) && dates.get(bar.date)!.close !== bar.close) conflicts.add(bar.date);
    dates.set(bar.date,bar);
  }
  return [...dates.values()].filter(bar => !conflicts.has(bar.date)).sort((a,b)=>a.date.localeCompare(b.date));
}

function trailingQuarterSum(financials:Financials, metric:string): {value:number; points:FinancialPoint[]} | undefined {
  const points = financials.quarterly.filter(p=>p.metric===metric && p.start && Number.isFinite(p.value)).sort((a,b)=>b.end.localeCompare(a.end)).slice(0,4).reverse();
  if (points.length!==4) return undefined;
  for (const [index,p] of points.entries()) {
    if (length(p)<70 || length(p)>110 || p.unit!=='USD' || p.unit!==points[0]!.unit || concept(p)!==concept(points[0]!)) return undefined;
    if (index && Date.parse(p.start!) - Date.parse(points[index-1]!.end)! !== DAY) return undefined;
  }
  const duration = (Date.parse(points[3]!.end) - Date.parse(points[0]!.start!))/DAY + 1;
  if (duration<350 || duration>380) return undefined;
  return {value:points.reduce((sum,p)=>sum+p.value,0),points};
}

export function deriveMetrics(security:Security,financials:Financials,prices?:PriceSeries,sourceRefs:string[]=[]):Metrics {
  const result:Metrics = {};
  const ref = (points:FinancialPoint[]) => [...new Set([...sourceRefs,...points.flatMap(p=>p.derivedFrom ?? [`sec:${p.accession}`])])];
  const set = (key:string,value:number|null,unit:string,definition:string,reportPeriod:string,points:FinancialPoint[]=[],reason?:string) => {
    result[key] = {value:value!==null && Number.isFinite(value)?value:null,unit,definition,period:reportPeriod,sourceRefs:ref(points),...(reason?{reason}: {})};
  };
  const latest = (metric:string) => [...financials.annual.filter(p=>p.metric===metric),...financials.quarterly.filter(p=>p.metric===metric)]
    .filter(p=>Number.isFinite(p.value)).sort((a,b)=>b.end.localeCompare(a.end) || length(b)-length(a))[0];
  for (const metric of monetary) {
    const p = latest(metric);
    set(metric,p?.value ?? null,p?.unit ?? (metric==='dilutedEps'?'USD/shares':'USD'),`Latest reported ${metric}; annual period preferred when end dates coincide.`,p?period(p):'unavailable',p?[p]:[],p?undefined:'Supported financial fact unavailable.');
  }
  const exclusion = financials.industryExclusion ?? specialIndustry(security.industry);
  const unsupported = security.kind !== 'common-stock' || security.currency !== 'USD' || security.country !== 'US';
  const ratioReason = exclusion ? `General-company ratios excluded for ${exclusion} reporting.` : unsupported ? 'Only USD US common stocks support these financial comparisons.' : undefined;
  const revenue=latest('revenue'), net=latest('netIncome'), ocf=latest('operatingCashFlow'), capex=latest('capex');
  const marginOk = revenue && net && coherent(revenue,net) && revenue.unit===security.currency && revenue.value>0;
  set('netMargin',!ratioReason&&marginOk?round(net.value/revenue.value*100):null,'percent','Net income / revenue × 100 for the same period and currency.',revenue?period(revenue):'unavailable',[revenue,net].filter((p):p is FinancialPoint=>!!p),ratioReason ?? (!marginOk?'Matching-period positive revenue and net income unavailable.':undefined));
  const freeOk=ocf&&capex&&coherent(ocf,capex)&&ocf.unit===security.currency&&capex.value>=0;
  set('freeCashFlow',!ratioReason&&freeOk?ocf.value-capex.value:null,'USD','Free cash flow = operating cash flow minus cash capital expenditures (payments to acquire property, plant and equipment).',ocf?period(ocf):'unavailable',[ocf,capex].filter((p):p is FinancialPoint=>!!p),ratioReason ?? (!freeOk?'Matching-period cash flow and nonnegative capital expenditures unavailable.':undefined));
  const prior = revenue?.start ? [...financials.annual,...financials.quarterly].filter(p=>p.metric==='revenue' && p.start && p.end<revenue.end && p.unit===revenue.unit && concept(p)===concept(revenue)
    && Math.abs(length(p)-length(revenue))<=7 && Math.abs((Date.parse(revenue.end)-Date.parse(p.end))/DAY-365)<=8)
    .sort((a,b)=>b.end.localeCompare(a.end))[0] : undefined;
  const growthOk=revenue&&prior&&prior.value>0&&revenue.unit===security.currency;
  set('revenueGrowthYoY',!ratioReason&&growthOk?round((revenue.value/prior.value-1)*100):null,'percent','Revenue change from a comparable prior-year period of the same currency, concept and fiscal length.',revenue?period(revenue):'unavailable',[revenue,prior].filter((p):p is FinancialPoint=>!!p),ratioReason ?? (!growthOk?'Comparable prior-year positive revenue unavailable.':undefined));
  result.revenueGrowth = {...result.revenueGrowthYoY!};
  for (const metric of ['revenue','netIncome','operatingCashFlow','capex']) {
    const ttm = trailingQuarterSum(financials,metric);
    set(`${metric}Ttm`,!ratioReason&&ttm?ttm.value:null,'USD',`Sum of four continuous single-quarter ${metric} facts with consistent units and concept.`,ttm?`${ttm.points[0]!.start}/${ttm.points[3]!.end}`:'unavailable',ttm?.points,ratioReason ?? (!ttm?'Four continuous coherent quarters unavailable.':undefined));
  }
  const ttmOcf=trailingQuarterSum(financials,'operatingCashFlow'),ttmCapex=trailingQuarterSum(financials,'capex');
  const ttmFreeOk=ttmOcf&&ttmCapex&&ttmOcf.points.every((p,i)=>coherent(p,ttmCapex.points[i]!)&&ttmCapex.points[i]!.value>=0);
  set('freeCashFlowTtm',!ratioReason&&ttmFreeOk?ttmOcf.value-ttmCapex.value:null,'USD','TTM operating cash flow minus TTM capital expenditures on matching quarters.',ttmFreeOk?`${ttmOcf.points[0]!.start}/${ttmOcf.points[3]!.end}`:'unavailable',[...(ttmOcf?.points??[]),...(ttmCapex?.points??[])],ratioReason ?? (!ttmFreeOk?'Matching four-quarter cash flows unavailable.':undefined));
  // Company Facts EPS alone does not establish compatibility with the current price after splits.
  const bars=prices&&prices.symbol===security.symbol?cleanBars(prices):[];
  const last=bars.at(-1);
  const eps=latest('dilutedEps');
  set('pe',null,'multiple','Price / diluted EPS, requiring a verified compatible split/share basis and positive earnings.',`price:${last?.date??'unavailable'}; report:${eps?period(eps):'unavailable'}`,eps?[eps]:[],ratioReason ?? (eps&&eps.value<=0?'P/E unavailable for nonpositive earnings.':'Compatible diluted EPS share/split basis has not been verified.'));
  for (const horizon of horizons) {
    const first=bars.at(-1-horizon);
    const valid=prices?.adjustment==='split-adjusted'&&first&&last;
    const key=`return${horizon}d`;
    set(key,valid?round((last.close/first.close-1)*100):null,'percent',`${horizon}-trading-session split-adjusted price return; excludes dividends.`,valid?`${first.date}/${last.date}`:last?.date??'unavailable',[],valid?undefined:'Verified split-adjusted price history or required trading sessions unavailable.');
    result[key]!.sourceRefs=prices?[...new Set([...sourceRefs,prices.source])]:[...sourceRefs];
  }
  result.priceReturn21={...result.return21d!};
  return result;
}

export function buildMarketSnapshot(series:PriceSeries[]):MarketSnapshot {
  const warnings=['ETF proxies: SPY/QQQ and S&P 500 sector ETF samples. Returns are price returns, exclude dividends, and are not total returns.'];
  const bySymbol=new Map<string,{series:PriceSeries;bars:PriceBar[]}>();
  for(const item of series) {
    if (!(MARKET_SYMBOLS as readonly string[]).includes(item.symbol)) continue;
    const previous=bySymbol.get(item.symbol);
    if(!previous||item.fetchedAt>previous.series.fetchedAt) bySymbol.set(item.symbol,{series:item,bars:cleanBars(item)});
  }
  const available=[...bySymbol.values()].filter(v=>v.bars.length);
  const commonDates=available.length?available[0]!.bars.map(b=>b.date).filter(date=>available.every(v=>v.bars.some(b=>b.date===date))).sort():[];
  const commonDate=commonDates.at(-1)??null;
  // SPY supplies the trading-session calendar. An absent peer observation cannot lengthen a return horizon.
  const calendar=(bySymbol.get('SPY')?.bars??available[0]?.bars??[]).map(b=>b.date).filter(date=>commonDate!==null&&date<=commonDate);
  if(!commonDate)warnings.push('No common comparable trading date available.');
  const rows=MARKET_SYMBOLS.map(symbol=>{
    const item=bySymbol.get(symbol),last=item?.bars.find(b=>b.date===commonDate);
    const returns:Record<string,number|null>={},relativeToSpy:Record<string,number|null>={};
    for(const horizon of horizons) {
      const firstDate=calendar.at(-1-horizon),first=item?.bars.find(b=>b.date===firstDate);
      returns[`${horizon}d`]=item?.series.adjustment==='split-adjusted'&&last&&first?round((last.close/first.close-1)*100):null;
      relativeToSpy[`${horizon}d`]=null;
    }
    const reason=!item||!item.bars.length?'Price history missing.':!commonDate?'No common trading date.':item.series.adjustment!=='split-adjusted'?'Verified split adjustment unavailable; returns not compared.':undefined;
    return {symbol,label:`${symbol} ETF proxy${symbol==='SPY'||symbol==='QQQ'?'':' (S&P 500 sector sample)'}`,asOf:last?.date??null,price:last?.close??null,returns,relativeToSpy,...(reason?{reason}: {})};
  });
  const spy=rows.find(row=>row.symbol==='SPY');
  for(const row of rows)for(const horizon of horizons){const key=`${horizon}d`,own=row.returns[key],benchmark=spy?.returns[key];row.relativeToSpy[key]=own!=null&&benchmark!=null?round(own-benchmark):null;}
  const fetchedAt=[...bySymbol.values()].map(v=>v.series.fetchedAt).filter(date=>Number.isFinite(Date.parse(date))).sort().at(-1)??'';
  if(available.length<MARKET_SYMBOLS.length)warnings.push(`Price coverage ${available.length}/${MARKET_SYMBOLS.length} ETF proxies.`);
  return {fetchedAt,commonDate,rows,coverage:rows.filter(r=>r.price!==null).length,total:MARKET_SYMBOLS.length,warnings};
}

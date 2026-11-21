import {THEMES,type ThesisInput,type ThesisCondition,type FrozenCompany,type MetricChange,type ConditionResult,type EvidenceCitation} from '../../equity-data/src/discovery-types.js';

/** Same deterministic metric names emitted by deriveMetrics; never an expression language. */
const supportedFields=new Set(['revenue','netIncome','operatingCashFlow','capex','cash','assets','liabilities','dilutedEps','netMargin','freeCashFlow','revenueGrowthYoY','revenueGrowth','revenueTtm','netIncomeTtm','operatingCashFlowTtm','capexTtm','freeCashFlowTtm','pe','return1d','return5d','return21d','return63d','priceReturn21']);
const symbol=(v:unknown):v is string=>typeof v==='string'&&/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,2})?$/.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
function plain(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).some(k=>!keys.includes(k)))throw Error('Unsupported thesis field');
  return value as Record<string,unknown>;
}
function text(v:unknown,max:number,label:string):string{if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))throw Error(`Invalid ${label}`);return v;}
function identity(v:unknown,label:string):string{const s=text(v,100,label);if(!/^[a-zA-Z0-9_-]+$/.test(s))throw Error(`Invalid ${label}`);return s;}
function strings(value:unknown,max:number,len:number,label:string):string[]{if(!Array.isArray(value)||value.length>max)throw Error(`Invalid ${label}`);return value.map(v=>text(v,len,label));}
function citations(value:unknown):EvidenceCitation[]{
  if(!Array.isArray(value)||value.length>50)throw Error('Invalid citations');
  return value.map(v=>{const c=plain(v,['chunkId','quote']);const chunkId=text(c.chunkId,160,'chunk identity');if(!/^[A-Za-z0-9_-]+(?::c[0-9]+)?$/.test(chunkId))throw Error('Invalid chunk identity');return{chunkId,quote:text(c.quote,4000,'citation quote')};});
}
function condition(value:unknown):ThesisCondition{
  const c=plain(value,['id','kind','description','symbol','field','op','value','period']);
  if(c.kind!=='metric'&&c.kind!=='manual')throw Error('Invalid condition kind');
  const result:ThesisCondition={id:identity(c.id,'condition identity'),kind:c.kind,description:text(c.description,1000,'condition description')};
  if(c.kind==='manual'){
    if(['symbol','field','op','value','period'].some(key=>c[key]!==undefined))throw Error('Manual conditions cannot execute metric checks');
    return result;
  }
  if(typeof c.field!=='string'||!supportedFields.has(c.field)||!['gt','gte','lt','lte'].includes(String(c.op))||typeof c.value!=='number'||!Number.isFinite(c.value))throw Error('Invalid metric condition');
  if(c.symbol!==undefined&&!symbol(c.symbol))throw Error('Invalid condition symbol');
  return{...result,...(c.symbol!==undefined?{symbol:c.symbol as string}:{}),field:c.field,op:c.op as ThesisCondition['op'],value:c.value,period:text(c.period,160,'condition period')};
}

export function validateThesis(input:unknown):ThesisInput{
  const v=plain(input,['id','title','statement','theme','symbols','sourceJobId','opportunityId','support','opposing','gaps','conditions','invalidation','nextCheck','horizonMonths','gapResolutionReason']);
  if(!THEMES.some(t=>t.id===v.theme))throw Error('Invalid thesis theme');
  if(!Array.isArray(v.symbols)||v.symbols.length<1||v.symbols.length>10||v.symbols.some(s=>!symbol(s))||new Set(v.symbols).size!==v.symbols.length)throw Error('Invalid thesis symbols');
  if(!Array.isArray(v.conditions)||v.conditions.length>20)throw Error('Invalid conditions');
  const conditions=v.conditions.map(condition);
  if(new Set(conditions.map(c=>c.id)).size!==conditions.length)throw Error('Duplicate condition identity');
  for(const c of conditions){const target=(c as ThesisCondition&{symbol?:string}).symbol;if(target&&!v.symbols.includes(target))throw Error('Condition symbol outside thesis');}
  if(!date(v.nextCheck))throw Error('Invalid next check date');
  if(v.horizonMonths!==12&&v.horizonMonths!==24)throw Error('Invalid horizon months');
  return{...(v.id!==undefined?{id:identity(v.id,'thesis identity')}:{}),title:text(v.title,200,'thesis title'),statement:text(v.statement,8000,'thesis statement'),theme:v.theme as ThesisInput['theme'],symbols:[...v.symbols] as string[],sourceJobId:identity(v.sourceJobId,'source job identity'),...(v.opportunityId!==undefined?{opportunityId:identity(v.opportunityId,'opportunity identity')}:{}),support:citations(v.support),opposing:citations(v.opposing),gaps:strings(v.gaps,50,1000,'gaps'),conditions,invalidation:text(v.invalidation,4000,'invalidation'),nextCheck:v.nextCheck,horizonMonths:v.horizonMonths,...(v.gapResolutionReason!==undefined?{gapResolutionReason:text(v.gapResolutionReason,2000,'gap resolution reason')}:{})};
}

export function compareSnapshots(previous:FrozenCompany[],next:FrozenCompany[]):MetricChange[]{
  const before=new Map(previous.map(c=>[c.symbol,c])),after=new Map(next.map(c=>[c.symbol,c]));
  const changes:MetricChange[]=[];
  for(const symbol of [...new Set([...before.keys(),...after.keys()])].sort()){
    const a=before.get(symbol)?.snapshot.metrics??{},b=after.get(symbol)?.snapshot.metrics??{};
    for(const field of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
      const p=a[field]??null,n=b[field]??null;
      let kind:MetricChange['kind'];
      if(!p||!n||p.value===null||n.value===null||!Number.isFinite(p.value)||!Number.isFinite(n.value))kind='missing';
      else if(p.unit!==n.unit||p.definition!==n.definition)kind='not-comparable';
      else if(p.period!==n.period)kind='new-period';
      else kind=p.value===n.value?'unchanged':'restatement';
      const rawDelta=(kind==='restatement'||kind==='unchanged')?n!.value!-p!.value!:null;
      changes.push({symbol,field,kind,previous:p,next:n,delta:rawDelta!==null&&Number.isFinite(rawDelta)?rawDelta:null});
    }
  }
  return changes;
}

export function evaluateConditions(conditions:ThesisCondition[],companies:FrozenCompany[]):ConditionResult[]{
  return conditions.map(raw=>{
    let c:ThesisCondition;try{c=condition(raw);}catch{return{id:raw.id,status:'unknown',reason:'Invalid or unsupported condition.'};}
    if(c.kind==='manual')return{id:c.id,status:'manual',reason:'Requires explicit human assessment.'};
    const target=(c as ThesisCondition&{symbol?:string}).symbol;
    const candidates=target?companies.filter(company=>company.symbol===target):companies;
    if(candidates.length!==1)return{id:c.id,status:'unknown',reason:'One authorized company must be selected.'};
    const metric=candidates[0]!.snapshot.metrics[c.field!];
    if(!metric||metric.value===null||!Number.isFinite(metric.value))return{id:c.id,status:'unknown',reason:'Requested metric is unavailable.'};
    if(metric.period!==c.period)return{id:c.id,status:'unknown',reason:'Requested reporting period is unavailable.'};
    const met=c.op==='gt'?metric.value>c.value!:c.op==='gte'?metric.value>=c.value!:c.op==='lt'?metric.value<c.value!:metric.value<=c.value!;
    return{id:c.id,status:met?'met':'not-met',reason:'Compared supported metric for the exact requested period.'};
  });
}

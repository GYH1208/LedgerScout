import type {CompanySnapshot,MetricValue} from './types.js';

export const THEMES=[{id:'workflow',label:'企业工作流'},{id:'developer',label:'软件开发'},{id:'content',label:'内容创作'},{id:'vertical',label:'垂直行业应用'}] as const;
export type ThemeKey=typeof THEMES[number]['id'];
export type OfficialSource={id:string;kind:'document'|'index'|'pdf';url:string;allowedHosts:string[];pathPrefix:string;maxPages?:1|2;verification:'pending'|'verified';verifiedAt?:string};
export type DiscoveryMember={symbol:string;name?:string;cik?:string;website?:string;themes:ThemeKey[];sources:OfficialSource[];verification:'pending'|'verified'};
export type DiscoveryUniverse={version:number;createdAt:string;members:DiscoveryMember[]};
export type SectionKind='business'|'mda'|'risk'|'financial'|'other';
export type DocumentSection={id:string;title:string;kind:SectionKind;start:number;end:number;confidence:'heading'|'fallback'};
export type EvidenceChunk={id:string;documentId:string;symbol:string;cik:string;sectionId:string;kind:SectionKind;text:string;start:number;end:number;hash:string};
export type DiscoveryDocument={id:string;symbol:string;cik:string;sourceKind:'sec'|'issuer'|'alpha-vantage';rawEvidenceId?:string;url:string;title:string;form?:string;accession?:string;period?:string;publishedAt?:string;fetchedAt:string;hash:string;text:string;sections:DocumentSection[];chunks:EvidenceChunk[];warnings:string[]};
export type EvidenceCitation={chunkId:string;quote:string};
export type ResearchClaim={text:string;kind:'issuer-claim'|'analysis';scope:'company'|'segment'|'ai-product'|'unknown';citations:EvidenceCitation[]};
export type CompanyExtraction={symbol:string;themes:ThemeKey[];claims:ResearchClaim[];opposing:ResearchClaim[];gaps:string[]};
export type Opportunity={id:string;theme:ThemeKey;title:string;mechanism:string;whyNow:string;stage:'trial'|'adoption'|'revenue'|'profit';support:ResearchClaim[];opposing:ResearchClaim[];gaps:string[];candidates:{symbol:string;role:string;exposure:'company'|'segment'|'ai-product'|'unknown'}[];checks:string[];invalidation:string;nextCheck:string};
export type DiscoveryCounts={modelRequests:number;toolCalls:number;dataHttpRequests:number;elapsedMs:number};
export type DiscoveryUsage={inputTokens:number;outputTokens:number;totalTokens:number;unknownRequests:number};
export type SourceCheck={symbol:string;sourceId:string;url:string;status:'checked'|'unchanged'|'partial'|'unavailable'|'not-checked';documentIds:string[];reason?:string;checkedAt:string};
export type FrozenCompany={symbol:string;snapshotId:string;snapshot:CompanySnapshot;documentIds:string[]};
export type DiscoveryInput={universeVersion:number;members:DiscoveryMember[];companies:FrozenCompany[];question:string;thesisId?:string;thesisVersion?:number;previousCompanies?:FrozenCompany[]};
export type DiscoveryJob={id:string;kind:'refresh'|'scan'|'review';createdAt:string;status:'loading'|'completed'|'partial'|'failed'|'cancelled'|'interrupted'|'exhausted';symbols:string[];completed:string[];remaining:string[];errors:{symbol:string;code:string}[];counts:DiscoveryCounts;tokenUsage:DiscoveryUsage;input:DiscoveryInput;extractions:CompanyExtraction[];opportunities:Opportunity[];checks:SourceCheck[];gaps:string[];reservedMs:number;aggregationRequests?:number;aggregationCompleted?:number;resumeOf?:string;resumedBy?:string;proposalId?:string;error?:string;resumable?:boolean};
export type ThesisCondition={id:string;kind:'metric'|'manual';description:string;symbol?:string;field?:string;op?:'gt'|'gte'|'lt'|'lte';value?:number;period?:string};
export type ThesisInput={id?:string;title:string;statement:string;theme:ThemeKey;symbols:string[];sourceJobId:string;opportunityId?:string;support:EvidenceCitation[];opposing:EvidenceCitation[];gaps:string[];conditions:ThesisCondition[];invalidation:string;nextCheck:string;horizonMonths:12|24;gapResolutionReason?:string};
export type ThesisVersion=ThesisInput&{id:string;version:number;createdAt:string;confirmed:true;companies:FrozenCompany[]};
export type MetricChange={symbol:string;field:string;kind:'new-period'|'restatement'|'missing'|'unchanged'|'not-comparable';previous:MetricValue|null;next:MetricValue|null;delta:number|null};
export type ConditionResult={id:string;status:'met'|'not-met'|'unknown'|'manual';reason:string};
export type ReviewProposal={id:string;jobId:string;thesisId:string;thesisVersion:number;createdAt:string;status:'pending'|'accepted'|'rejected';impact:'strengthened'|'weakened'|'mixed'|'unchanged'|'insufficient';explanation:string;citations:EvidenceCitation[];changes:MetricChange[];conditionResults:ConditionResult[];draft:ThesisInput;companies:FrozenCompany[];newDocumentIds:string[];resolvedThesisVersion?:number};

/** Browser edits cannot grant source or security verification. */
export function validateUniverse(value:unknown):DiscoveryMember[]{
  if(!Array.isArray(value)||value.length>30)throw Error('Discovery catalog maximum is30');
  const symbols=new Set<string>();
  return value.map(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['symbol','name','themes','sources'].includes(k)))throw Error('Unsupported catalog field');
    const r=raw as Record<string,unknown>;
    if(typeof r.symbol!=='string'||! /^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,2})?$/.test(r.symbol))throw Error('Invalid symbol');
    if(symbols.has(r.symbol))throw Error('Duplicate catalog symbol');symbols.add(r.symbol);
    if(!Array.isArray(r.themes)||r.themes.length<1||r.themes.length>4||new Set(r.themes).size!==r.themes.length||r.themes.some(t=>!THEMES.some(x=>x.id===t)))throw Error('Invalid theme');
    if(r.name!==undefined&&(typeof r.name!=='string'||r.name.length>200))throw Error('Invalid company name');
    if(!Array.isArray(r.sources)||r.sources.length>5)throw Error('Invalid sources');
    const ids=new Set<string>();
    const sources=r.sources.map((s:any):OfficialSource=>{
      if(!s||typeof s!=='object'||Object.keys(s).some(k=>!['id','kind','url','allowedHosts','pathPrefix','maxPages'].includes(k)))throw Error('Unsupported source field');
      if(typeof s.id!=='string'||! /^[a-zA-Z0-9_-]{1,60}$/.test(s.id)||ids.has(s.id))throw Error('Invalid source ID');ids.add(s.id);
      let url:URL;try{url=new URL(s.url);}catch{throw Error('Invalid source URL');}
      const host=url.hostname;
      if(url.protocol!=='https:'||url.username||url.password||url.port||!host.includes('.')||/^[\d.]+$/.test(host)||host.includes(':')||/\.(?:local|localhost|internal|test|invalid)$/.test(host)||url.hash)throw Error('Invalid source URL');
      if(!['document','index','pdf'].includes(s.kind)||!Array.isArray(s.allowedHosts)||s.allowedHosts.length!==1||s.allowedHosts[0]!==host||typeof s.pathPrefix!=='string'||!s.pathPrefix.startsWith('/')||s.pathPrefix.includes('..')||!url.pathname.startsWith(s.pathPrefix)||s.maxPages!==undefined&&![1,2].includes(s.maxPages))throw Error('Invalid source scope');
      return{id:s.id,kind:s.kind,url:url.href,allowedHosts:[host],pathPrefix:s.pathPrefix,maxPages:s.kind==='index'?(s.maxPages??1):1,verification:'pending'};
    });
    return{symbol:r.symbol,...(r.name?{name:r.name as string}:{}),themes:r.themes as ThemeKey[],sources,verification:'pending'};
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DiscoveryStore} from '../src/discovery-store.js';
import {EquityStore} from '../src/equity-store.js';
import {newDiscoveryJob} from '../src/discovery-runtime.js';
import {refreshDiscoverySources} from '../src/discovery-acquisition.js';
import type {DiscoveryMember,OfficialSource} from '../../equity-data/src/discovery-types.js';
import type {EquityConfig} from '../../equity-data/src/config.js';
import type {CompanySnapshot} from '../../equity-data/src/types.js';
import {buildDocument} from '../../equity-data/src/documents.js';

const profile=(symbol:string)=>[{symbol,companyName:symbol,cik:'1',currency:'USD',country:'US',isEtf:false,isFund:false,isAdr:false,isActivelyTrading:true,exchange:'NASDAQ',website:'https://www.issuer.example.com',industry:'Software'}];
const snapshot=(symbol:string):CompanySnapshot=>({security:{symbol,name:symbol,cik:'0000000001',currency:'USD',country:'US',kind:'common-stock',exchange:'NASDAQ',industry:'Software'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{},filings:[],sourceRefs:[],fetchedAt:new Date().toISOString(),warnings:[]});
const secUrl='https://www.sec.gov/Archives/edgar/data/1/000000000126000001/annual.htm';
const submission=(symbol:string)=>({cik:1,tickers:[symbol],exchanges:['NASDAQ'],filings:{recent:{accessionNumber:['0000000001-26-000001'],form:['10-K'],filingDate:['2026-11-15'],primaryDocument:['annual.htm']}}});
const withEightK=(symbol:string)=>({cik:1,tickers:[symbol],exchanges:['NASDAQ'],filings:{recent:{accessionNumber:['0000000001-26-000002','0000000001-26-000001'],form:['8-K','10-K'],filingDate:['2026-11-16','2026-11-15'],primaryDocument:['current.htm','annual.htm']}}});
const withQuarter=(symbol:string,eightK=true)=>({cik:1,tickers:[symbol],exchanges:['NASDAQ'],filings:{recent:{accessionNumber:[...(eightK?['0000000001-26-000002']:[]),'0000000001-26-000003','0000000001-26-000001'],form:[...(eightK?['8-K']:[]),'10-Q','10-K'],filingDate:[...(eightK?['2026-11-16']:[]),'2026-11-16','2026-11-15'],primaryDocument:[...(eightK?['current.htm']:[]),'quarter.htm','annual.htm']}}});
const quarterUrl='https://www.sec.gov/Archives/edgar/data/1/000000000126000003/quarter.htm';
const body=`<nav>Item 1. Business</nav><p>${'Cover registration information. '.repeat(1200)}</p><h2>Item 1. Business</h2><p>${'Our AI workflow product has paying enterprise customers. '.repeat(10)}</p>`;
const official=(host='investor.issuer.example.com'):OfficialSource=>({id:'products',kind:'document',url:`https://${host}/products/ai`,allowedHosts:[host],pathPrefix:'/products/',verification:'pending'});
async function fixture(fn:(v:{store:DiscoveryStore;equity:EquityStore;config:EquityConfig;members:DiscoveryMember[]})=>Promise<void>,sources:OfficialSource[]=[],symbols=['AAA']){
 const dir=await mkdtemp(join(tmpdir(),'discovery-acquire-'));const store=new DiscoveryStore(dir),equity=new EquityStore(dir);
 const config:EquityConfig={fmpKey:'offline-secret',secUserAgent:'LedgerScout research@offline.org',timeoutMs:5000,maxRetries:0,dailyLimit:200,outputDirectory:dir};
 const members:DiscoveryMember[]=symbols.map(symbol=>({symbol,themes:['workflow'],verification:'pending',sources:structuredClone(sources)}));store.setUniverse(members,0);
 try{for(const symbol of symbols){await equity.saveCompany(snapshot(symbol));const ref=await equity.evidence(symbol,'fmp:profile',{body:profile(symbol)});equity.setProfileRef(symbol,ref);}await fn({store,equity,config,members});}
 finally{store.close();equity.close();await rm(dir,{recursive:true,force:true});}
}

test('fresh company/profile caches still check current submissions and retain SEC body beyond TOC and 30k',()=>fixture(async({store,equity,config,members})=>{
 const seen:string[]=[];const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async url=>{seen.push(String(url));if(String(url).includes('submissions'))return Response.json(submission('AAA'));if(String(url)===secUrl)return new Response(body);throw Error('Unexpected network endpoint');}});
 assert.deepEqual(seen,['https://data.sec.gov/submissions/CIK0000000001.json',secUrl]);assert.equal(job.counts.dataHttpRequests,2);assert.equal(job.status,'completed');assert.deepEqual(job.completed,['AAA']);
 const docs=await store.documents(['AAA']);assert.equal(docs.length,1);assert.ok(docs[0]!.sections.find(s=>s.kind==='business')!.start>30000);assert.ok(docs[0]!.rawEvidenceId);assert.equal((await equity.readEvidence(docs[0]!.rawEvidenceId!)).data.body,body);
 assert.equal(store.universe().members[0]!.verification,'verified');assert.equal(store.universe().members[0]!.cik,'0000000001');
}));

test('fresh SEC index permits immutable same-URL filing reuse but never implies all issuer sources checked',()=>fixture(async({store,equity,config,members})=>{
 const run=async()=>{const job=newDiscoveryJob('refresh',{universeVersion:store.universe().version,members:store.universe().members,companies:[],question:''});store.saveJob(job);const seen:string[]=[];await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async url=>{seen.push(String(url));return String(url).includes('submissions')?Response.json(submission('AAA')):new Response(body);}});return{job,seen};};
 const first=await run(),oldId=(await store.documents(['AAA']))[0]!.id;const second=await run();
 assert.equal(first.seen.length,2);assert.equal(second.seen.length,1);assert.equal(second.job.checks.find(c=>c.sourceId==='sec-filings')!.status,'unchanged');assert.deepEqual(second.job.checks.find(c=>c.sourceId==='sec-filings')!.documentIds,[oldId]);assert.equal((await store.documents(['AAA'])).length,1);
}));

test('unproved cross-domain ownership stays pending and never fetches the registered source',()=>fixture(async({store,equity,config,members})=>{
 const seen:string[]=[];const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async url=>{seen.push(String(url));if(String(url).includes('submissions'))return Response.json(submission('AAA'));if(String(url)===secUrl)return new Response(body);if(String(url)==='https://www.issuer.example.com/')return new Response('<a href="https://other.example.com">Unrelated</a>',{headers:{'content-type':'text/html'}});throw Error('Unowned source must not dispatch');}});
 assert.ok(!seen.some(url=>url.includes('hostile.example.com')));assert.equal(store.universe().members[0]!.sources[0]!.verification,'pending');assert.equal(store.universe().members[0]!.sources[0]!.verifiedAt,undefined);assert.equal(job.checks.find(c=>c.sourceId==='products')!.status,'unavailable');assert.equal(job.status,'partial');
},[{...official('hostile.example.com'),verification:'verified',verifiedAt:'2026-11-01T00:00:00.000Z'}]));

test('a cached annual cannot hide a newer quarter when the second body is reserved for an actual8-K exhibit',()=>fixture(async({store,equity,config,members})=>{
 const first=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});
 await refreshDiscoverySources({job:first,store,equity,config,save:()=>store.saveJob(first),fetch:async value=>String(value).includes('submissions')?Response.json(submission('AAA')):new Response(body)});
 const annual=(await store.documents(['AAA']))[0]!;
 const seen:string[]=[],directory='/Archives/edgar/data/1/000000000126000002',exhibit=`https://www.sec.gov${directory}/earnings-ex99_1.htm`;
 const job=newDiscoveryJob('refresh',{universeVersion:store.universe().version,members:store.universe().members,companies:[],question:''});
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{
  const url=String(value);seen.push(url);if(url.includes('submissions'))return Response.json(withQuarter('AAA'));
  if(url===quarterUrl)return new Response('<h1>Quarterly AI adoption</h1><p>New paid AI workflow customers disclosed this quarter.</p>');
  if(url.endsWith('index.json'))return Response.json({directory:{name:directory,item:[{name:'current.htm'},{name:'earnings-ex99_1.htm'}]}});
  if(url===exhibit)return new Response('<p>Current quarterly earnings exhibit.</p>');throw Error('Unexpected filing request');
 }});
 const docs=await store.documents(['AAA']);assert.ok(docs.some(d=>d.url===quarterUrl));assert.ok(docs.some(d=>d.id===annual.id));assert.equal(docs.length,3);
 assert.deepEqual(seen,['https://data.sec.gov/submissions/CIK0000000001.json',quarterUrl,`https://www.sec.gov${directory}/index.json`,exhibit]);
 const check=job.checks.find(c=>c.sourceId==='sec-filings')!;assert.equal(check.status,'checked');assert.ok(check.documentIds.includes(docs.find(d=>d.url===quarterUrl)!.id));
}));

test('a newly visible annual omitted for an8-K exhibit is a partial coverage gap even when the selected quarter is cached',()=>fixture(async({store,equity,config,members})=>{
 const quarter=buildDocument({id:'d_quarter',symbol:'AAA',cik:'0000000001',sourceKind:'sec',url:quarterUrl,html:'<p>Previously obtained quarterly disclosure.</p>',form:'10-Q',accession:'0000000001-26-000003',publishedAt:'2026-11-16'});await store.saveDocument(quarter);
 const directory='/Archives/edgar/data/1/000000000126000002',exhibit=`https://www.sec.gov${directory}/earnings-ex99_1.htm`,seen:string[]=[];
 const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{
  const url=String(value);seen.push(url);if(url.includes('submissions'))return Response.json(withQuarter('AAA'));
  if(url.endsWith('index.json'))return Response.json({directory:{name:directory,item:[{name:'current.htm'},{name:'earnings-ex99_1.htm'}]}});
  if(url===exhibit||url===secUrl)return new Response('<p>Newly obtained disclosure.</p>');throw Error('Unexpected filing request');
 }});
 const check=job.checks.find(c=>c.sourceId==='sec-filings')!;assert.equal(check.status,'partial');assert.match(check.reason!,/10-K/);assert.match(check.reason!,/2026-11-15/);assert.match(check.reason!,/0000000001-26-000001/);
 assert.deepEqual(check.documentIds,['d_quarter']);assert.ok(!seen.includes(secUrl));assert.equal(job.status,'partial');
}));

test('newest quarter keeps the registered issuer reservation and explains an unread annual',()=>fixture(async({store,equity,config,members})=>{
 const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''}),seen:string[]=[];
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{const url=String(value);seen.push(url);if(url.includes('submissions'))return Response.json(withQuarter('AAA',false));if(url===quarterUrl||url===secUrl)return new Response(body);return new Response('<p>Issuer product disclosure.</p>',{headers:{'content-type':'text/html'}});}});
 const docs=await store.documents(['AAA']);assert.ok(docs.some(d=>d.url===quarterUrl));assert.ok(docs.some(d=>d.sourceKind==='issuer'));assert.equal(docs.length,2);assert.ok(!seen.includes(secUrl));
 const check=job.checks.find(c=>c.sourceId==='sec-filings')!;assert.equal(check.status,'partial');assert.match(check.reason!,/10-K/);assert.equal(job.checks.find(c=>c.sourceId==='products')!.status,'checked');
},[official()]));

test('a generic external partner homepage link cannot verify a registered issuer source',()=>fixture(async({store,equity,config,members})=>{
 const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''}),seen:string[]=[];
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{const url=String(value);seen.push(url);if(url.includes('submissions'))return Response.json(submission('AAA'));if(url===secUrl)return new Response(body);return new Response(url==='https://www.issuer.example.com/'?'<a href="https://partner.example.com/products/ai">External technology partner</a>':'<p>Partner product claims.</p>',{headers:{'content-type':'text/html'}});}});
 assert.ok(!seen.some(url=>url.includes('partner.example.com')));assert.equal(store.universe().members[0]!.sources[0]!.verification,'pending');assert.equal(job.checks.find(c=>c.sourceId==='products')!.status,'unavailable');
},[official('partner.example.com')]));

test('an actual homepage investor-relations link can verify a third-party IR source',()=>fixture(async({store,equity,config,members})=>{
 const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{const url=String(value);if(url.includes('submissions'))return Response.json(submission('AAA'));if(url===secUrl)return new Response(body);return new Response(url==='https://www.issuer.example.com/'?'<a href="https://investors.external.example.com/">Investor Relations</a>':'<p>Issuer investor disclosure.</p>',{headers:{'content-type':'text/html'}});}});
 assert.equal(store.universe().members[0]!.sources[0]!.verification,'verified');assert.equal(job.checks.find(c=>c.sourceId==='products')!.status,'checked');assert.ok((await store.documents(['AAA'])).some(d=>d.url==='https://investors.external.example.com/products/ai'));
},[official('investors.external.example.com')]));

test('one shared HTTP budget stops before request33 and explicitly preserves unchecked sources',()=>fixture(async({store,equity,config,members})=>{
 const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});job.counts.dataHttpRequests=31;store.saveJob(job);let calls=0;
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async()=>{calls++;return Response.json(submission('AAA'));}});
 assert.equal(calls,1);assert.equal(job.counts.dataHttpRequests,32);assert.equal(job.status,'exhausted');assert.deepEqual(job.remaining,['AAA']);assert.ok(job.checks.some(c=>c.sourceId==='products'&&c.status==='not-checked'));
},[official()]));

test('cancellation after a completed member preserves progress and never starts the remaining company',()=>fixture(async({store,equity,config,members})=>{
 const controller=new AbortController();const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);let calls=0;
 await refreshDiscoverySources({job,store,equity,config,signal:controller.signal,save:()=>{store.saveJob(job);if(job.completed.includes('AAA'))controller.abort();},fetch:async url=>{calls++;return String(url).includes('submissions')?Response.json(submission('AAA')):new Response(body);}});
 assert.equal(job.status,'cancelled');assert.deepEqual(job.completed,['AAA']);assert.deepEqual(job.remaining,['BBB']);assert.equal(calls,2);assert.ok(job.checks.some(c=>c.symbol==='BBB'&&c.status==='not-checked'));
},[],['AAA','BBB']));

test('a proved issuer index follows at most its actual next page and selects one new relevant body',()=>fixture(async({store,equity,config,members})=>{
 const seen:string[]=[];const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async url=>{
  const u=String(url);seen.push(u);if(u.includes('submissions'))return Response.json(submission('AAA'));if(u===secUrl)return new Response(body);
  const html=u.endsWith('?page=2')?'<a href="/products/ai-results-2026-11-15.html">2026-11-15 AI earnings</a><a rel="next" href="?page=3">Next</a>':u.endsWith('/products/')?'<a href="old.html">Archives</a><a rel="next" href="?page=2">Next</a>':'<time datetime="2026-11-15"></time><h1>AI Results</h1><p>AI product paid adoption expanded.</p>';
  return new Response(html,{headers:{'content-type':'text/html'}});
 }});
 assert.equal(seen.length,5);assert.ok(seen.some(u=>u.endsWith('ai-results-2026-11-15.html')));assert.ok(!seen.some(u=>u.endsWith('old.html')||u.endsWith('?page=3')));
 assert.equal(job.checks.find(c=>c.sourceId==='products')!.status,'partial');assert.equal(store.universe().members[0]!.sources[0]!.verification,'verified');
 const docs=await store.documents(['AAA']);assert.equal(docs.length,2);assert.equal(docs.find(d=>d.sourceKind==='issuer')!.publishedAt,'2026-11-15');
},[{...official(),kind:'index',url:'https://investor.issuer.example.com/products/',maxPages:2}]));

test('issuer rate limits stop the batch before any later registered source dispatch',()=>fixture(async({store,equity,config,members})=>{
 const seen:string[]=[];const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async url=>{const u=String(url);seen.push(u);if(u.includes('submissions'))return Response.json(submission('AAA'));if(u===secUrl)return new Response(body);return new Response('limited',{status:429});}});
 assert.equal(job.status,'failed');assert.equal(job.error,'RATE_LIMIT');assert.equal(seen.length,3);assert.equal(job.checks.find(c=>c.sourceId==='products')!.status,'unavailable');assert.equal(job.checks.find(c=>c.sourceId==='later')!.status,'not-checked');
},[official(),{...official(),id:'later',url:'https://investor.issuer.example.com/products/later'}]));

test('index relevance takes precedence over an unseen unrelated archive link',()=>fixture(async({store,equity,config,members})=>{
 const issuerBody='<h1>AI product</h1><p>Paid workflow product adoption.</p>',url='https://investor.issuer.example.com/products/ai.html';
 const raw=await equity.evidence('AAA','issuer:document',{url,body:issuerBody});const existing=buildDocument({id:'d_existing',symbol:'AAA',cik:'0000000001',sourceKind:'issuer',url,html:issuerBody});existing.rawEvidenceId=raw.id;await store.saveDocument(existing);
 const seen:string[]=[];const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{const u=String(value);seen.push(u);if(u.includes('submissions'))return Response.json(submission('AAA'));if(u===secUrl)return new Response(body);return new Response(u.endsWith('/products/')?'<a href="ai.html">AI product results</a><a href="unrelated.html">Archive contact directory</a>':issuerBody,{headers:{'content-type':'text/html'}});}});
 assert.ok(seen.includes(url));assert.ok(!seen.some(u=>u.endsWith('unrelated.html')));
},[{...official(),kind:'index',url:'https://investor.issuer.example.com/products/'}]));

test('latest SEC8-K earnings exhibit is obtained only through its verified actual accession directory',()=>fixture(async({store,equity,config,members})=>{
 const seen:string[]=[],directory='/Archives/edgar/data/1/000000000126000002',exhibitUrl=`https://www.sec.gov${directory}/issuer-ex99_1.htm`;
 const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{const u=String(value);seen.push(u);if(u.includes('submissions'))return Response.json(withEightK('AAA'));if(u===secUrl)return new Response(body);if(u.endsWith('index.json'))return Response.json({directory:{name:directory,item:[{name:'current.htm'},{name:'issuer-ex99_1.htm'},{name:'../invented-ex99.htm'}]}});if(u===exhibitUrl)return new Response('<h1>Quarterly earnings</h1><p>Our AI workflow product generated $12 million in disclosed revenue.</p>');throw Error('Only actual verified SEC files may dispatch');}});
 assert.deepEqual(seen,['https://data.sec.gov/submissions/CIK0000000001.json',secUrl,`https://www.sec.gov${directory}/index.json`,exhibitUrl]);assert.equal(job.counts.dataHttpRequests,4);
 const docs=await store.documents(['AAA']),exhibit=docs.find(d=>d.url===exhibitUrl)!;assert.equal(docs.length,2);assert.equal(exhibit.sourceKind,'sec');assert.equal(exhibit.form,'8-K');assert.equal(exhibit.accession,'0000000001-26-000002');assert.equal(exhibit.publishedAt,'2026-11-16');assert.ok(exhibit.rawEvidenceId);assert.ok(exhibit.chunks.some(c=>c.text.includes('$12 million')));assert.equal((await equity.readEvidence(exhibit.rawEvidenceId!)).data.body.includes('$12 million'),true);assert.deepEqual(job.checks.find(c=>c.sourceId==='sec-8k')!.documentIds,[exhibit.id]);assert.equal(job.checks.find(c=>c.sourceId==='sec-8k')!.status,'checked');
}));

test('unparseable SEC8-K directory falls back to its verified primary and remains explicitly partial',()=>fixture(async({store,equity,config,members})=>{
 const seen:string[]=[],primary='https://www.sec.gov/Archives/edgar/data/1/000000000126000002/current.htm';const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{const u=String(value);seen.push(u);if(u.includes('submissions'))return Response.json(withEightK('AAA'));if(u===secUrl)return new Response(body);if(u.endsWith('index.json'))return Response.json({directory:{name:'/Archives/edgar/data/1/wrong',item:[{name:'guessed-ex99.htm'}]}});if(u===primary)return new Response('<p>8-K primary reports results; exhibit coverage is unavailable.</p>');throw Error('Never guess an exhibit filename');}});
 assert.ok(seen.includes(primary));assert.ok(!seen.some(u=>u.endsWith('guessed-ex99.htm')));assert.equal((await store.documents(['AAA'])).length,2);assert.equal(job.checks.find(c=>c.sourceId==='sec-8k')!.status,'partial');assert.equal(job.status,'partial');
}));

test('SEC8-K remains explicitly unchecked when index-plus-body requests exceed the shared HTTP budget',()=>fixture(async({store,equity,config,members})=>{
 const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});job.counts.dataHttpRequests=30;store.saveJob(job);const seen:string[]=[];
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{const u=String(value);seen.push(u);return u.includes('submissions')?Response.json(withEightK('AAA')):new Response(body);}});
 assert.equal(seen.length,2);assert.equal(job.counts.dataHttpRequests,32);assert.equal(job.checks.find(c=>c.sourceId==='sec-8k')!.status,'not-checked');assert.equal(job.status,'partial');assert.equal((await store.documents(['AAA'])).length,1);
}));

test('registered issuer source reserves the second body and leaves SEC8-K coverage explicitly incomplete',()=>fixture(async({store,equity,config,members})=>{
 const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);const seen:string[]=[];
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{const u=String(value);seen.push(u);if(u.includes('submissions'))return Response.json(withEightK('AAA'));if(u===secUrl)return new Response(body);return new Response('<p>Issuer AI product adoption is a company disclosure.</p>',{headers:{'content-type':'text/html'}});}});
 assert.equal(seen.length,3);assert.ok(!seen.some(u=>u.endsWith('index.json')));assert.equal(job.checks.find(c=>c.sourceId==='sec-8k')!.status,'not-checked');assert.equal((await store.documents(['AAA'])).length,2);assert.equal(job.status,'partial');
},[official()]));

test('oversized annual body remains a truthful partial source and a small verified8-K exhibit still completes',()=>fixture(async({store,equity,config,members})=>{
 const seen:string[]=[],directory='/Archives/edgar/data/1/000000000126000002',exhibitUrl=`https://www.sec.gov${directory}/earnings-ex99_1.htm`;
 const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{const u=String(value);seen.push(u);if(u.includes('submissions'))return Response.json(withEightK('AAA'));if(u===secUrl)return new Response('annual exceeds SEC limit',{headers:{'content-length':'16777217'}});if(u.endsWith('index.json'))return Response.json({directory:{name:directory,item:[{name:'current.htm'},{name:'earnings-ex99_1.htm'}]}});if(u===exhibitUrl)return new Response('<p>AI workflow paid adoption expanded this quarter.</p>');throw Error('Only verified bodies may be attempted');}});
 assert.deepEqual(seen,['https://data.sec.gov/submissions/CIK0000000001.json',secUrl,`https://www.sec.gov${directory}/index.json`,exhibitUrl]);assert.equal(job.status,'partial');assert.deepEqual(job.completed,['AAA']);assert.deepEqual(job.remaining,[]);
 const annual=job.checks.find(c=>c.sourceId==='sec-filings')!;assert.equal(annual.status,'partial');assert.match(annual.reason!,/RESPONSE_SIZE/);assert.equal(annual.documentIds.length,0);assert.equal(job.checks.find(c=>c.sourceId==='sec-8k')!.status,'checked');const docs=await store.documents(['AAA']);assert.equal(docs.length,1);assert.equal(docs[0]!.url,exhibitUrl);assert.equal(store.universe().members[0]!.cik,'0000000001');
}));


test('a registered one-page limit never follows next and opaque dynamic indexes stay partial',()=>fixture(async({store,equity,config,members})=>{
 const seen:string[]=[];const job=newDiscoveryJob('refresh',{universeVersion:1,members,companies:[],question:''});store.saveJob(job);
 await refreshDiscoverySources({job,store,equity,config,save:()=>store.saveJob(job),fetch:async value=>{const url=String(value);seen.push(url);if(url.includes('submissions'))return Response.json(submission('AAA'));if(url===secUrl)return new Response(body);return new Response('<main>Investor news loads dynamically.</main><a rel="next" href="?page=2">Next</a>',{headers:{'content-type':'text/html'}});}});
 assert.ok(!seen.some(url=>url.endsWith('?page=2')));assert.equal(job.checks.find(c=>c.sourceId==='products')!.status,'partial');
},[{...official(),kind:'index',url:'https://investor.issuer.example.com/products/',maxPages:1}]));

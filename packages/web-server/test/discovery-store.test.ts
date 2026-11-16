import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {DiscoveryDocument,DiscoveryJob,DiscoveryMember,FrozenCompany,ReviewProposal,ThesisInput} from '../../equity-data/src/discovery-types.js';
import {DiscoveryStore} from '../src/discovery-store.js';
import {buildDocument,retrieveChunks} from '../../equity-data/src/documents.js';
import {runDiscoveryTask} from '../src/discovery-runtime.js';

const member:DiscoveryMember={symbol:'MSFT',themes:['workflow'],sources:[],verification:'pending'};
const thesis=():ThesisInput=>({title:'Workflow',statement:'Paid usage improves cash flow.',theme:'workflow',symbols:['MSFT'],sourceJobId:'dj_source',support:[],opposing:[],gaps:['AI revenue unknown'],conditions:[],invalidation:'Adoption stalls',nextCheck:'2027-02-28',horizonMonths:12});
const job=(id='dj_one'):DiscoveryJob=>({id,kind:'scan',createdAt:'2026-11-16T00:00:00.000Z',status:'loading',symbols:['MSFT'],completed:[],remaining:['MSFT'],errors:[],counts:{modelRequests:0,toolCalls:0,dataHttpRequests:0,elapsedMs:0},tokenUsage:{inputTokens:0,outputTokens:0,totalTokens:0,unknownRequests:0},input:{universeVersion:1,members:[member],companies:[],question:'Which workflow?'},extractions:[],opportunities:[],checks:[],gaps:[],reservedMs:0,resumable:true});
const doc=(id='d_one',text='AI paid usage',fetchedAt='2026-11-16T00:00:00.000Z'):DiscoveryDocument=>({id,symbol:'MSFT',cik:'0000789019',sourceKind:'issuer',url:'https://www.microsoft.com/product',title:'Product',publishedAt:'2026-11-01',fetchedAt,hash:createHash('sha256').update(text).digest('hex'),text,sections:[],chunks:[],warnings:[]});
async function fixture(fn:(store:DiscoveryStore,dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'discovery-store-'));const store=new DiscoveryStore(dir);try{await fn(store,dir);}finally{store.close();await rm(dir,{recursive:true,force:true});}}

test('catalog history enforces limits and optimistic versions without touching equity files',()=>fixture(async(store,dir)=>{
  await writeFile(join(dir,'equity.sqlite'),'legacy bytes');
  assert.equal(store.universe().version,0);
  store.setUniverse([member],0);store.setUniverse([],1);
  assert.equal(store.universeVersion(1)!.members[0]!.symbol,'MSFT');
  assert.throws(()=>store.setUniverse([],1),/version|stale/i);
  assert.throws(()=>store.setUniverse([member,member],2),/duplicate/i);
  assert.throws(()=>store.setUniverse(Array(31).fill(member),2),/30/);
  assert.equal(await readFile(join(dir,'equity.sqlite'),'utf8'),'legacy bytes');
}));

test('documents preserve immutable versions and reject invalid IDs, tamper and wrong text hashes',()=>fixture(async(store,dir)=>{
  await store.saveDocument(doc());await store.saveDocument(doc('d_new','New adoption','2026-11-17T00:00:00.000Z'));
  assert.deepEqual((await store.documents(['MSFT'])).map(d=>d.id),['d_new','d_one']);
  assert.equal((await store.document('d_one'))!.publishedAt,'2026-11-01');
  await assert.rejects(store.saveDocument(doc('d_one','Overwrite')),/immutable|exist/i);
  await assert.rejects(store.saveDocument({...doc('d_bad'),hash:'bad'}),/hash/i);
  await assert.rejects(store.document('../../.env'),/identity|invalid/i);
  await writeFile(join(dir,'discovery','documents','d_one.json'),'{}');
  await assert.rejects(store.document('d_one'),/hash|integrity/i);
}));

test('jobs freeze input and source identity and atomic resume has one consumer',()=>fixture(async(store)=>{
  const parent={...job(),status:'partial' as const};store.saveJob(parent);
  assert.throws(()=>store.saveJob({...parent,input:{...parent.input,question:'Changed authorization'}}),/frozen|identity/i);
  const child={...parent,id:'dj_child',status:'loading' as const,resumeOf:parent.id};store.claimResume(parent.id,child);
  assert.equal(store.job(parent.id)!.resumedBy,'dj_child');
  assert.throws(()=>store.claimResume(parent.id,{...child,id:'dj_second'}),/consum|resume/i);
  assert.equal(store.job('dj_second'),undefined);
}));

test('restart interrupts loading jobs without replay and detects persisted job tamper',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'discovery-restart-'));let store=new DiscoveryStore(dir);
  try{store.saveJob(job());store.close();store=new DiscoveryStore(dir);assert.equal(store.job('dj_one')!.status,'interrupted');assert.equal(store.job('dj_one')!.counts.modelRequests,0);
    const db=new DatabaseSync(join(dir,'discovery.sqlite'));db.prepare('UPDATE discovery_jobs SET body=? WHERE id=?').run('{}','dj_one');db.close();assert.throws(()=>store.job('dj_one'),/hash|integrity/i);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('confirmed thesis versions preserve history and gaps require evidence or explicit reason',()=>fixture(async(store)=>{
  const first=store.confirmThesis(thesis(),0,[]);assert.match(first.id,/^t_/);assert.equal(first.confirmed,true);
  assert.throws(()=>store.confirmThesis({...thesis(),id:first.id},0,[]),/version|stale/i);
  assert.throws(()=>store.confirmThesis({...thesis(),id:first.id,gaps:[]},1,[]),/gap/i);
  const second=store.confirmThesis({...thesis(),id:first.id,gaps:[],gapResolutionReason:'Manually assessed insufficient relevance'},1,[]);
  assert.equal(second.version,2);assert.deepEqual(store.thesis(first.id,1)!.gaps,['AI revenue unknown']);assert.equal(store.theses().length,1);
  assert.throws(()=>store.confirmThesis({...thesis(),title:'x'.repeat(201)},0,[]));
}));

test('proposal rejection, acceptance and stale decisions cannot overwrite confirmed history',()=>fixture(async(store)=>{
  const initial=store.confirmThesis(thesis(),0,[]);
  const proposal=(id:string):ReviewProposal=>({id,jobId:'dj_review',thesisId:initial.id,thesisVersion:1,createdAt:'2026-11-16T00:00:00.000Z',status:'pending',impact:'mixed',explanation:'Mixed evidence',citations:[],changes:[],conditionResults:[],draft:{...thesis(),id:initial.id,statement:'Revised'},companies:[],newDocumentIds:[]});
  store.saveProposal(proposal('p_reject'));assert.equal(store.resolveProposal('p_reject','reject',undefined,1),undefined);assert.equal(store.proposal('p_reject')!.status,'rejected');assert.throws(()=>store.resolveProposal('p_reject','accept',undefined,1),/resolved|consum/i);
  store.saveProposal(proposal('p_accept'));store.saveProposal(proposal('p_stale'));
  const result=store.resolveProposal('p_accept','accept',undefined,1)!;assert.equal(result.version,2);assert.equal(store.thesis(initial.id,1)!.statement,thesis().statement);
  assert.equal(store.resolveProposal('p_accept','accept',undefined,1)!.version,2);
  assert.throws(()=>store.resolveProposal('p_stale','accept',undefined,1),/stale|version/i);assert.equal(store.proposal('p_stale')!.status,'pending');
}));

test('proposal decisions are idempotent and preserve their original resolved version after later revisions',()=>fixture(async(store)=>{
  const initial=store.confirmThesis(thesis(),0,[]);
  const proposal=(id:string):ReviewProposal=>({id,jobId:'dj_review',thesisId:initial.id,thesisVersion:1,createdAt:'2026-11-16T00:00:00.000Z',status:'pending',impact:'mixed',explanation:'Mixed evidence',citations:[],changes:[],conditionResults:[],draft:{...thesis(),id:initial.id,statement:'Second'},companies:[],newDocumentIds:[]});
  store.saveProposal(proposal('p_no'));store.resolveProposal('p_no','reject',undefined,1);assert.equal(store.resolveProposal('p_no','reject',undefined,1),undefined);
  store.saveProposal(proposal('p_yes'));store.resolveProposal('p_yes','accept',undefined,1);
  store.confirmThesis({...thesis(),id:initial.id,statement:'Third'},2,[]);
  assert.equal(store.resolveProposal('p_yes','accept',undefined,1)!.statement,'Second');assert.equal(store.proposal('p_yes')!.resolvedThesisVersion,2);
  assert.throws(()=>store.resolveProposal('p_yes','reject',undefined,1),/resolved|decision/i);
}));

test('confirmed gap removal can cite new registered evidence and edited acceptance keeps the draft immutable',()=>fixture(async(store)=>{
  const document=doc('d_evidence');document.sections=[{id:'s0',title:'Product',kind:'other',start:0,end:document.text.length,confidence:'fallback'}];
  document.chunks=[{id:'d_evidence:c0',documentId:document.id,symbol:document.symbol,cik:document.cik,sectionId:'s0',kind:'other',text:document.text,start:0,end:document.text.length,hash:document.hash}];
  await store.saveDocument(document);
  const company:FrozenCompany={symbol:'MSFT',snapshotId:'q_new',documentIds:[document.id],snapshot:{security:{symbol:'MSFT',name:'Microsoft',cik:document.cik,exchange:'NASDAQ',currency:'USD',country:'US',kind:'common-stock'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{},filings:[],sourceRefs:[],fetchedAt:document.fetchedAt,warnings:[]}};
  const first=store.confirmThesis(thesis(),0,[]);
  const draft={...thesis(),id:first.id,gaps:[],support:[{chunkId:'d_evidence:c0',quote:document.text}]};
  store.saveProposal({id:'p_evidence',jobId:'dj_review',thesisId:first.id,thesisVersion:1,createdAt:document.fetchedAt,status:'pending',impact:'strengthened',explanation:'New original disclosure',citations:draft.support,changes:[],conditionResults:[],draft,companies:[company],newDocumentIds:[document.id]});
  const next=store.resolveProposal('p_evidence','accept',{...draft,statement:'User edited'},1)!;
  assert.equal(next.statement,'User edited');assert.deepEqual(next.gaps,[]);assert.equal(store.proposal('p_evidence')!.draft.statement,thesis().statement);
  assert.equal(store.proposals()[0]!.status,'accepted');
}));

test('terminal jobs require a new explicit resume and budget counters cannot be reset',()=>fixture(async(store)=>{
  const parent={...job(),status:'partial' as const,counts:{modelRequests:2,toolCalls:3,dataHttpRequests:4,elapsedMs:100},reservedMs:50};store.saveJob(parent);
  assert.throws(()=>store.saveJob({...parent,status:'loading'}),/terminal|resume|status/i);
  assert.throws(()=>store.claimResume(parent.id,{...parent,id:'dj_reset',resumeOf:parent.id,status:'loading',counts:job().counts}),/budget/i);
  assert.equal(store.job('dj_reset'),undefined);
}));

test('constructor preserves existing legacy databases byte for byte',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'discovery-legacy-'));let store:DiscoveryStore|undefined;
  try{
    for(const filename of ['equity.sqlite','sessions.sqlite']){const db=new DatabaseSync(join(dir,filename));db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('untouched')");db.close();}
    const equity=await readFile(join(dir,'equity.sqlite')),sessions=await readFile(join(dir,'sessions.sqlite'));
    store=new DiscoveryStore(dir);store.setUniverse([member],0);
    assert.deepEqual(await readFile(join(dir,'equity.sqlite')),equity);assert.deepEqual(await readFile(join(dir,'sessions.sqlite')),sessions);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('job lists stay bounded while complete immutable history remains addressable',()=>fixture(async(store)=>{
  for(let index=0;index<25;index++)store.saveJob({...job(`dj_${index}`),status:'completed'});
  assert.equal(store.jobs().length,20);assert.equal(store.jobs()[0]!.id,'dj_24');assert.equal(store.job('dj_0')!.id,'dj_0');
}));

test('invalid calendar timestamps cannot be normalized into another disclosure or job date',()=>fixture(async(store)=>{
  assert.throws(()=>store.saveJob({...job(),createdAt:'2026-02-30T00:00:00.000Z'}),/date|identity/i);
  await assert.rejects(store.saveDocument({...doc(),fetchedAt:'2026-02-30T00:00:00.000Z'}),/date|identity/i);
  await assert.rejects(store.saveDocument({...doc(),publishedAt:'2026-02-30'}),/date/i);
}));

test('model reservations settle without resetting cumulative requests and resume carries elapsed reservations',()=>fixture(async(store)=>{
  const running={...job(),counts:{...job().counts,modelRequests:1,elapsedMs:100},tokenUsage:{...job().tokenUsage,unknownRequests:1},reservedMs:35000};store.saveJob(running);
  const settled={...running,tokenUsage:{inputTokens:20,outputTokens:10,totalTokens:30,unknownRequests:0},reservedMs:0};
  store.saveJob(settled);assert.equal(store.job(running.id)!.reservedMs,0);
  const parent={...settled,status:'interrupted' as const,reservedMs:35000};store.saveJob(parent);
  const child={...parent,id:'dj_time',resumeOf:parent.id,status:'loading' as const,counts:{...parent.counts,elapsedMs:35100},reservedMs:0};store.claimResume(parent.id,child);
  assert.equal(store.job(child.id)!.counts.elapsedMs,35100);
}));

test('parsed document chunks survive storage with exact text and stable citation locations',()=>fixture(async(store)=>{
  const parsed=buildDocument({id:'d_parsed',symbol:'MSFT',cik:'0000789019',sourceKind:'issuer',url:'https://www.microsoft.com/product',publishedAt:'2026-11-01',html:'<article><h1>AI product</h1><p>Customers pay for AI workflow assistance and commercial adoption remains a research question.</p></article>'});
  await store.saveDocument(parsed);const persisted=(await store.document(parsed.id))!;
  const selected=retrieveChunks(persisted,'workflow').chunks[0]!;
  assert.equal(selected.id,'d_parsed:c0');assert.equal(persisted.text.slice(selected.start,selected.end),selected.text);
  const input={...thesis(),support:[{chunkId:selected.id,quote:selected.text}]};assert.equal(store.confirmThesis(input,0,[]).support[0]!.chunkId,'d_parsed:c0');
}));

test('saveDocument freezes caller input before asynchronous file operations',()=>fixture(async(store)=>{
  const input=doc('d_frozen'),saving=store.saveDocument(input);input.symbol='GOOG';input.title='Changed by caller';await saving;
  const result=(await store.document('d_frozen'))!;assert.equal(result.symbol,'MSFT');assert.equal(result.title,'Product');
}));

test('real offline Pi runs settle persisted model reservations and cancelled work resumes with cumulative counters',()=>fixture(async(store)=>{
  const parsed=buildDocument({id:'d_runtime',symbol:'MSFT',cik:'0000789019',sourceKind:'issuer',url:'https://www.microsoft.com/product',html:'<p>Paid adoption of AI workflow applications remains an early company claim.</p>'});await store.saveDocument(parsed);
  const company:FrozenCompany={symbol:'MSFT',snapshotId:'q_runtime',documentIds:[parsed.id],snapshot:{security:{symbol:'MSFT',name:'Microsoft',cik:parsed.cik,exchange:'NASDAQ',currency:'USD',country:'US',kind:'common-stock'},financials:{annual:[],quarterly:[],warnings:[]},metrics:{},filings:[],sourceRefs:[],fetchedAt:parsed.fetchedAt,warnings:[]}};
  const base=job('dj_runtime');base.input.companies=[company];store.saveJob(base);
  const claim={text:'Company describes AI workflow adoption.',kind:'issuer-claim',scope:'ai-product',citations:[{chunkId:parsed.chunks[0]!.id,quote:parsed.text}]};
  let request=0;const reply=async()=>({content:JSON.stringify(++request%2?{claims:[claim],opposing:[],gaps:[]}:{opportunities:[]}),usage:{inputTokens:10,outputTokens:5,totalTokens:15}});
  const success=await runDiscoveryTask({job:base,documents:symbols=>store.documents(symbols),save:current=>store.saveJob(current),request:reply});
  assert.equal(success.status,'completed');assert.equal(store.job(base.id)!.tokenUsage.totalTokens,30);assert.equal(store.job(base.id)!.reservedMs,0);assert.equal(store.job(base.id)!.tokenUsage.unknownRequests,0);
  const controller=new AbortController(),cancelledJob={...job('dj_cancelled'),input:base.input};store.saveJob(cancelledJob);
  const cancelled=await runDiscoveryTask({job:cancelledJob,documents:symbols=>store.documents(symbols),save:current=>store.saveJob(current),signal:controller.signal,request:async()=>{controller.abort();throw Error('cancelled');}});
  assert.equal(store.job(cancelled.id)!.status,'cancelled');assert.equal(cancelled.reservedMs,35000);
  const child={...cancelled,id:'dj_resumed',resumeOf:cancelled.id,status:'loading' as const,counts:{...cancelled.counts,elapsedMs:cancelled.counts.elapsedMs+cancelled.reservedMs},reservedMs:0};store.claimResume(cancelled.id,child);request=0;
  const resumed=await runDiscoveryTask({job:child,documents:symbols=>store.documents(symbols),save:current=>store.saveJob(current),request:reply});
  assert.equal(resumed.counts.modelRequests,3);assert.equal(resumed.tokenUsage.unknownRequests,1);assert.ok(resumed.counts.elapsedMs>=35000);assert.equal(store.job(cancelled.id)!.resumedBy,child.id);
}));

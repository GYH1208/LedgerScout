import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
import {lstat,readFile,realpath,writeFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validateUniverse,type DiscoveryMember,type DiscoveryUniverse,type DiscoveryDocument,type DiscoveryJob,type FrozenCompany,type ThesisInput,type ThesisVersion,type ReviewProposal} from '../../equity-data/src/discovery-types.js';
import {validateThesis,compareSnapshots} from './discovery-theses.js';

const hash=(body:string)=>createHash('sha256').update(body).digest('hex');
const identity=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const locationIdentity=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_:-]{1,160}$/.test(v);
const symbol=(v:unknown):v is string=>typeof v==='string'&&/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,2})?$/.test(v);
const calendarDate=(v:string):boolean=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v)&&calendarDate(v.slice(0,10))&&Number.isFinite(Date.parse(v));
const canonical=(value:unknown):string=>{
  if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return`{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
function body(value:unknown):string{const result=JSON.stringify(value);if(!result||Buffer.byteLength(result)>64_000_000)throw Error('Discovery state too large');return result;}
function version(value:number){if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid expected version');}
function validateCompanies(companies:FrozenCompany[],symbols?:string[]){
  if(!Array.isArray(companies)||companies.length>10||new Set(companies.map(c=>c.symbol)).size!==companies.length)throw Error('Invalid frozen companies');
  for(const c of companies)if(!symbol(c.symbol)||!identity(c.snapshotId)||!c.snapshot||c.snapshot.security?.symbol!==c.symbol||symbols&&!symbols.includes(c.symbol)||!Array.isArray(c.documentIds)||c.documentIds.length>1000||c.documentIds.some(d=>!identity(d)))throw Error('Invalid frozen company identity');
}
function validateMembers(members:DiscoveryMember[]){
  if(!Array.isArray(members))throw Error('Invalid catalog');
  validateUniverse(members.map(m=>({symbol:m.symbol,...(m.name!==undefined?{name:m.name}:{}),themes:m.themes,sources:m.sources.map(s=>({id:s.id,kind:s.kind,url:s.url,allowedHosts:s.allowedHosts,pathPrefix:s.pathPrefix,...(s.maxPages!==undefined?{maxPages:s.maxPages}:{})}))})));
  for(const m of members){
    if(!['pending','verified'].includes(m.verification)||m.cik!==undefined&&!/^\d{1,10}$/.test(m.cik)||m.sources.some(s=>!['pending','verified'].includes(s.verification)||s.verifiedAt!==undefined&&!date(s.verifiedAt)))throw Error('Invalid catalog verification');
    if(m.verification==='verified'&&!m.cik)throw Error('Verified catalog security requires CIK');
  }
}

/** Independent discovery state. Constructors recover metadata only and never contact providers. */
export class DiscoveryStore {
  private readonly db:DatabaseSync;
  private readonly documentDirectory:string;
  constructor(readonly base:string){
    mkdirSync(base,{recursive:true,mode:0o700});
    this.documentDirectory=join(base,'discovery','documents');mkdirSync(this.documentDirectory,{recursive:true,mode:0o700});
    const path=join(base,'discovery.sqlite'),existed=existsSync(path);this.db=new DatabaseSync(path);
    try{
      this.db.exec('PRAGMA busy_timeout=2500; PRAGMA foreign_keys=ON');
      const schema=this.db.prepare('PRAGMA user_version').get()!.user_version;
      if(schema!==0&&schema!==1)throw Error('Unsupported discovery database schema');
      if(schema===0){
        if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get())throw Error('Unknown discovery database schema');
        if(existed)this.db.exec(`VACUUM INTO '${join(base,`discovery-before-v1-${randomUUID()}.sqlite`).replaceAll("'","''")}'`);
        this.transaction(()=>this.db.exec(`
          CREATE TABLE discovery_universes(version INTEGER PRIMARY KEY,body TEXT NOT NULL,hash TEXT NOT NULL);
          CREATE TABLE discovery_documents(id TEXT PRIMARY KEY,symbol TEXT NOT NULL,cik TEXT NOT NULL,source_kind TEXT NOT NULL,url TEXT NOT NULL,text_hash TEXT NOT NULL,file_hash TEXT NOT NULL,fetched_at TEXT NOT NULL,chunk_ids TEXT NOT NULL);
          CREATE TABLE discovery_jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL,resumed_by TEXT);
          CREATE TABLE discovery_theses(id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(id,version));
          CREATE TABLE discovery_proposals(id TEXT PRIMARY KEY,body TEXT NOT NULL,hash TEXT NOT NULL);
          PRAGMA user_version=1;
        `));
      }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      this.transaction(()=>{
        for(const row of this.db.prepare('SELECT * FROM discovery_jobs').all()){
          const job=this.read<DiscoveryJob>(row);
          if(job.id!==row.id)throw Error('Discovery job identity mismatch');
          if(job.status==='loading')this.writeJob({...job,status:'interrupted',error:'Service restarted; explicit resume is required.'});
        }
      });
    }catch(error){this.db.close();throw error;}
  }
  private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private read<T>(row:Record<string,unknown>):T{const serialized=String(row.body);if(hash(serialized)!==row.hash)throw Error('Discovery state hash integrity failure');return JSON.parse(serialized) as T;}
  universe():DiscoveryUniverse{const row=this.db.prepare('SELECT * FROM discovery_universes ORDER BY version DESC LIMIT 1').get();return row?this.read(row):{version:0,createdAt:'',members:[]};}
  universeVersion(v:number):DiscoveryUniverse|undefined{version(v);if(v===0)return{version:0,createdAt:'',members:[]};const row=this.db.prepare('SELECT * FROM discovery_universes WHERE version=?').get(v);return row?this.read(row):undefined;}
  setUniverse(members:DiscoveryMember[],expectedVersion:number):DiscoveryUniverse{
    version(expectedVersion);validateMembers(members);
    return this.transaction(()=>{if(this.universe().version!==expectedVersion)throw Error('Stale catalog version');const value:DiscoveryUniverse={version:expectedVersion+1,createdAt:new Date().toISOString(),members:JSON.parse(body(members))};const serialized=body(value);this.db.prepare('INSERT INTO discovery_universes VALUES(?,?,?)').run(value.version,serialized,hash(serialized));return value;});
  }
  private async safeDocumentDirectory(){
    for(const path of [join(this.base,'discovery'),this.documentDirectory])if((await lstat(path)).isSymbolicLink())throw Error('Unsafe document directory');
    const rel=relative(await realpath(this.base),await realpath(this.documentDirectory));if(rel.startsWith('..')||isAbsolute(rel))throw Error('Document directory outside storage root');
  }
  private validateDocument(doc:DiscoveryDocument){
    if(!identity(doc.id)||!symbol(doc.symbol)||!/^\d{1,10}$/.test(doc.cik)||!['sec','issuer'].includes(doc.sourceKind)||!date(doc.fetchedAt)||typeof doc.text!=='string'||Buffer.byteLength(doc.text)>16_000_000||hash(doc.text)!==doc.hash)throw Error('Invalid document identity or text hash');
    if(doc.publishedAt!==undefined&&(typeof doc.publishedAt!=='string'||!calendarDate(doc.publishedAt)&&!date(doc.publishedAt)))throw Error('Invalid disclosure publication date');
    const url=new URL(doc.url);if(url.protocol!=='https:'||url.username||url.password)throw Error('Invalid document source URL');
    if(!Array.isArray(doc.sections)||!Array.isArray(doc.chunks)||!Array.isArray(doc.warnings)||doc.sections.length>2000||doc.chunks.length>20000)throw Error('Invalid document index');
    const sections=new Set<string>();
    for(const section of doc.sections){if(!locationIdentity(section.id)||sections.has(section.id)||!Number.isInteger(section.start)||!Number.isInteger(section.end)||section.start<0||section.end<=section.start||section.end>doc.text.length)throw Error('Invalid document section');sections.add(section.id);}
    const chunks=new Set<string>();
    for(const chunk of doc.chunks){if(!locationIdentity(chunk.id)||chunks.has(chunk.id)||chunk.documentId!==doc.id||chunk.symbol!==doc.symbol||chunk.cik!==doc.cik||!sections.has(chunk.sectionId)||!Number.isInteger(chunk.start)||!Number.isInteger(chunk.end)||chunk.start<0||chunk.end<=chunk.start||chunk.end>doc.text.length||chunk.text!==doc.text.slice(chunk.start,chunk.end)||hash(chunk.text)!==chunk.hash)throw Error('Document chunk identity or hash mismatch');chunks.add(chunk.id);}
  }
  async saveDocument(doc:DiscoveryDocument):Promise<void>{
    doc=JSON.parse(body(doc)) as DiscoveryDocument;
    this.validateDocument(doc);if(this.db.prepare('SELECT id FROM discovery_documents WHERE id=?').get(doc.id))throw Error('Document identity is immutable');
    await this.safeDocumentDirectory();const serialized=body(doc);
    await writeFile(join(this.documentDirectory,`${doc.id}.json`),serialized,{flag:'wx',mode:0o600});
    this.db.prepare('INSERT INTO discovery_documents VALUES(?,?,?,?,?,?,?,?,?)').run(doc.id,doc.symbol,doc.cik,doc.sourceKind,doc.url,doc.hash,hash(serialized),doc.fetchedAt,JSON.stringify(doc.chunks.map(c=>c.id)));
  }
  async document(id:string):Promise<DiscoveryDocument|undefined>{
    if(!identity(id))throw Error('Invalid document identity');const row=this.db.prepare('SELECT * FROM discovery_documents WHERE id=?').get(id);if(!row)return;
    await this.safeDocumentDirectory();const path=join(this.documentDirectory,`${id}.json`),stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64_000_000)throw Error('Unsafe document file');
    const rel=relative(await realpath(this.documentDirectory),await realpath(path));if(rel.startsWith('..')||isAbsolute(rel))throw Error('Unsafe document path');
    const serialized=await readFile(path,'utf8');if(hash(serialized)!==row.file_hash)throw Error('Document hash integrity failure');
    const doc=JSON.parse(serialized) as DiscoveryDocument;this.validateDocument(doc);
    if(doc.id!==id||doc.symbol!==row.symbol||doc.cik!==row.cik||doc.sourceKind!==row.source_kind||doc.url!==row.url||doc.hash!==row.text_hash||doc.fetchedAt!==row.fetched_at)throw Error('Document source identity mismatch');return doc;
  }
  async documents(symbols:string[]):Promise<DiscoveryDocument[]>{
    if(!Array.isArray(symbols)||symbols.length>30||symbols.some(s=>!symbol(s)))throw Error('Invalid document symbols');
    const selected=new Set(symbols),rows=this.db.prepare('SELECT id,symbol FROM discovery_documents ORDER BY fetched_at DESC,rowid DESC').all();
    const docs:DiscoveryDocument[]=[];for(const row of rows)if(selected.has(String(row.symbol)))docs.push((await this.document(String(row.id)))!);return docs;
  }
  job(id:string):DiscoveryJob|undefined{if(!identity(id))return;const row=this.db.prepare('SELECT * FROM discovery_jobs WHERE id=?').get(id);if(!row)return;const job=this.read<DiscoveryJob>(row);if(job.id!==id||job.resumedBy!==(row.resumed_by??undefined))throw Error('Discovery job identity mismatch');return job;}
  jobs():DiscoveryJob[]{return this.db.prepare('SELECT id FROM discovery_jobs ORDER BY created_at DESC,rowid DESC LIMIT 20').all().map(row=>this.job(String(row.id))!);}
  private writeJob(job:DiscoveryJob){
    if(!identity(job.id)||!['refresh','scan','review'].includes(job.kind)||!['loading','completed','partial','failed','cancelled','interrupted','exhausted'].includes(job.status)||!date(job.createdAt)||!Array.isArray(job.symbols)||job.symbols.length>(job.kind==='refresh'?5:10)||job.symbols.some(s=>!symbol(s))||new Set(job.symbols).size!==job.symbols.length)throw Error('Invalid discovery job identity');
    for(const list of [job.completed,job.remaining])if(!Array.isArray(list)||new Set(list).size!==list.length||list.some(s=>!job.symbols.includes(s)))throw Error('Invalid discovery progress');
    if(!job.input||!Number.isSafeInteger(job.input.universeVersion)||job.input.universeVersion<0||typeof job.input.question!=='string'||job.input.question.length>4000)throw Error('Invalid frozen input');
    validateMembers(job.input.members);validateCompanies(job.input.companies,job.symbols);if(job.input.previousCompanies)validateCompanies(job.input.previousCompanies,job.symbols);
    if(job.symbols.some(s=>!job.input.members.some(m=>m.symbol===s)))throw Error('Job symbol outside frozen catalog');
    for(const ledger of [job.counts,job.tokenUsage])if(!ledger||Object.values(ledger).some(v=>!Number.isSafeInteger(v)||v<0))throw Error('Invalid job budget counters');
    if(!Number.isSafeInteger(job.reservedMs)||job.reservedMs<0)throw Error('Invalid job reserved time');
    const prior=this.job(job.id);
    if(prior){
      if(prior.status!=='loading'&&job.status==='loading')throw Error('Terminal job requires explicit resume');
      for(const key of ['kind','createdAt','symbols','input','resumeOf','resumedBy'] as const)if(canonical(job[key])!==canonical(prior[key]))throw Error('Job frozen input or source identity changed');
      for(const key of Object.keys(prior.counts) as (keyof DiscoveryJob['counts'])[])if(job.counts[key]<prior.counts[key])throw Error('Job budget cannot decrease');
      for(const key of ['inputTokens','outputTokens','totalTokens'] as const)if(job.tokenUsage[key]<prior.tokenUsage[key])throw Error('Job usage cannot decrease');
    }
    const serialized=body(job);this.db.prepare('INSERT INTO discovery_jobs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,hash=excluded.hash').run(job.id,serialized,hash(serialized),job.createdAt,job.resumedBy??null);
  }
  saveJob(job:DiscoveryJob):void{this.transaction(()=>this.writeJob(job));}
  claimResume(parentId:string,child:DiscoveryJob):void{
    this.transaction(()=>{
      const parent=this.job(parentId);if(!parent||!parent.resumable||!['partial','failed','cancelled','interrupted','exhausted'].includes(parent.status)||parent.resumedBy)throw Error('Resume unavailable or already consumed');
      if(child.id===parent.id||this.job(child.id)||child.resumeOf!==parent.id||child.status!=='loading'||child.resumedBy||canonical(child.input)!==canonical(parent.input)||canonical(child.symbols)!==canonical(parent.symbols)||child.kind!==parent.kind)throw Error('Resume frozen identity mismatch');
      for(const key of Object.keys(parent.counts) as (keyof DiscoveryJob['counts'])[])if(child.counts[key]<parent.counts[key])throw Error('Resume cannot reset budget');
      for(const key of Object.keys(parent.tokenUsage) as (keyof DiscoveryJob['tokenUsage'])[])if(child.tokenUsage[key]<parent.tokenUsage[key])throw Error('Resume cannot reset usage');
      if(child.counts.elapsedMs+child.reservedMs<parent.counts.elapsedMs+parent.reservedMs)throw Error('Resume cannot reset time');
      this.writeJob(child);const consumed={...parent,resumedBy:child.id},serialized=body(consumed);
      const result=this.db.prepare('UPDATE discovery_jobs SET body=?,hash=?,resumed_by=? WHERE id=? AND resumed_by IS NULL').run(serialized,hash(serialized),child.id,parent.id);if(result.changes!==1)throw Error('Resume already consumed');
    });
  }
  thesis(id:string,v?:number):ThesisVersion|undefined{
    if(!identity(id))return;if(v!==undefined){version(v);if(v===0)return;}
    const row=v===undefined?this.db.prepare('SELECT * FROM discovery_theses WHERE id=? ORDER BY version DESC LIMIT 1').get(id):this.db.prepare('SELECT * FROM discovery_theses WHERE id=? AND version=?').get(id,v);
    if(!row)return;const result=this.read<ThesisVersion>(row);if(result.id!==id||result.version!==row.version)throw Error('Thesis identity mismatch');return result;
  }
  theses():ThesisVersion[]{return this.db.prepare('SELECT id,MAX(version) AS version FROM discovery_theses GROUP BY id ORDER BY MAX(rowid) DESC').all().map(row=>this.thesis(String(row.id),Number(row.version))!);}
  private newEvidence(previous:ThesisVersion,input:ThesisInput,companies:FrozenCompany[]):boolean{
    if(compareSnapshots(previous.companies,companies).some(change=>['new-period','restatement'].includes(change.kind)))return true;
    const oldDocs=new Set(previous.companies.flatMap(c=>c.documentIds)),citations=new Set([...input.support,...input.opposing].map(c=>c.chunkId));
    return companies.some(c=>c.documentIds.some(id=>{
      if(oldDocs.has(id))return false;const row=this.db.prepare('SELECT symbol,chunk_ids FROM discovery_documents WHERE id=?').get(id);return row?.symbol===c.symbol&&(JSON.parse(String(row.chunk_ids)) as string[]).some(chunk=>citations.has(chunk));
    }));
  }
  private writeThesis(raw:ThesisInput,expectedVersion:number,companies:FrozenCompany[]):ThesisVersion{
    version(expectedVersion);const input=validateThesis(raw);validateCompanies(companies,input.symbols);
    const previous=input.id?this.thesis(input.id):undefined;
    if(input.id&&!previous)throw Error('Unknown thesis identity');if((previous?.version??0)!==expectedVersion)throw Error('Stale thesis version');
    if(previous&&previous.gaps.some(gap=>!input.gaps.includes(gap))&&!input.gapResolutionReason&&!this.newEvidence(previous,input,companies))throw Error('Clearing gaps requires new evidence or a gap resolution reason');
    const result:ThesisVersion={...input,id:previous?.id??`t_${randomUUID()}`,version:expectedVersion+1,createdAt:new Date().toISOString(),confirmed:true,companies:JSON.parse(body(companies))},serialized=body(result);
    this.db.prepare('INSERT INTO discovery_theses VALUES(?,?,?,?)').run(result.id,result.version,serialized,hash(serialized));return result;
  }
  confirmThesis(input:ThesisInput,expectedVersion:number,companies:FrozenCompany[]):ThesisVersion{return this.transaction(()=>this.writeThesis(input,expectedVersion,companies));}
  saveProposal(proposal:ReviewProposal):void{
    if(!identity(proposal.id)||!identity(proposal.jobId)||proposal.status!=='pending'||!date(proposal.createdAt)||!['strengthened','weakened','mixed','unchanged','insufficient'].includes(proposal.impact))throw Error('Invalid review proposal');
    const draft=validateThesis(proposal.draft);if(draft.id!==undefined&&draft.id!==proposal.thesisId)throw Error('Proposal thesis identity mismatch');validateCompanies(proposal.companies,draft.symbols);
    if(!Array.isArray(proposal.newDocumentIds)||proposal.newDocumentIds.some(id=>!identity(id)))throw Error('Invalid proposal documents');
    this.transaction(()=>{if(this.proposal(proposal.id))throw Error('Proposal is immutable');const thesis=this.thesis(proposal.thesisId);if(!thesis||thesis.version!==proposal.thesisVersion)throw Error('Stale proposal thesis version');const serialized=body({...proposal,draft});this.db.prepare('INSERT INTO discovery_proposals VALUES(?,?,?)').run(proposal.id,serialized,hash(serialized));});
  }
  proposal(id:string):ReviewProposal|undefined{if(!identity(id))return;const row=this.db.prepare('SELECT * FROM discovery_proposals WHERE id=?').get(id);if(!row)return;const proposal=this.read<ReviewProposal>(row);if(proposal.id!==id)throw Error('Proposal identity mismatch');return proposal;}
  proposals():ReviewProposal[]{return this.db.prepare('SELECT id FROM discovery_proposals ORDER BY rowid DESC LIMIT 20').all().map(row=>this.proposal(String(row.id))!);}
  resolveProposal(id:string,decision:'accept'|'reject',edited:ThesisInput|undefined,expectedVersion:number):ThesisVersion|undefined{
    version(expectedVersion);if(decision!=='accept'&&decision!=='reject')throw Error('Invalid proposal decision');
    return this.transaction(()=>{const proposal=this.proposal(id);if(!proposal)throw Error('Proposal unavailable');
      if(proposal.thesisVersion!==expectedVersion)throw Error('Stale proposal thesis version');
      if(proposal.status!=='pending'){
        if(proposal.status!==(decision==='accept'?'accepted':'rejected'))throw Error('Proposal already resolved with another decision');
        if(decision==='reject')return;
        const original=proposal.resolvedThesisVersion===undefined?undefined:this.thesis(proposal.thesisId,proposal.resolvedThesisVersion);
        if(!original)throw Error('Resolved thesis version is unavailable');return original;
      }
      if(proposal.thesisVersion!==expectedVersion||this.thesis(proposal.thesisId)?.version!==expectedVersion)throw Error('Stale proposal thesis version');
      let result:ThesisVersion|undefined;
      if(decision==='accept'){if(edited?.id!==undefined&&edited.id!==proposal.thesisId)throw Error('Edited thesis identity mismatch');result=this.writeThesis({...edited??proposal.draft,id:proposal.thesisId},expectedVersion,proposal.companies);}
      const serialized=body({...proposal,status:decision==='accept'?'accepted':'rejected',...(result?{resolvedThesisVersion:result.version}:{})});this.db.prepare('UPDATE discovery_proposals SET body=?,hash=? WHERE id=?').run(serialized,hash(serialized),id);return result;
    });
  }
  close():void{this.db.close();}
}

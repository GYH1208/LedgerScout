import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { CompanySnapshot, MarketSnapshot, PriceSeries, SourceRef, ScreenFilter } from '../../equity-data/src/types.js';

export type EquityCounts = {modelRequests:number;toolCalls:number;dataHttpRequests:number;elapsedMs:number};
export type EquityUsage = {inputTokens:number;outputTokens:number;totalTokens:number;unknownRequests:number};
export type EquityQuery = {queryId:string;symbol:string;source:string;fetchedAt:string;data:unknown};
export type EquityJob = {
  id:string;sessionId:string;runId:string;researchDomain:'us-equity';symbol:string;question:string;
  status:'loading'|'completed'|'partial'|'awaiting_user'|'failed'|'cancelled'|'exhausted'|'interrupted';
  createdAt:string;answer?:{facts:string[];analysis:string;dataGaps:string[];sourceRefs:string[]};
  counts:EquityCounts;tokenUsage:EquityUsage;queries:EquityQuery[];error?:string;resumable?:boolean;
  resumeOf?:string;screenContext?:{filters:ScreenFilter[];snapshotId?:string};
};
export type EquityCheckpoint = {
  version:1;researchDomain:'us-equity';symbol:string;sessionId:string;runId:string;question:string;
  counts:EquityCounts;tokenUsage:EquityUsage;queryIds:string[];messages:import('../../agent-runtime/src/types.js').ChatMessage[];
  refresh:boolean;reservedMs:number;closed:boolean;parentRunId?:string;
};
export type EquitySession = {id:string;researchDomain:'us-equity';symbol:string;title:string;createdAt:string;turns:EquityJob[]};
const identity=(id:string,prefix:string)=>new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,78}$`).test(id);
export const validSymbol=(v:unknown):v is string=>typeof v==='string'&&/^[A-Z][A-Z0-9.-]{0,9}$/.test(v);
const hash=(body:string)=>createHash('sha256').update(body).digest('hex');

/** Domain metadata is independent of legacy Ethereum checkpoints and raw files. */
export class EquityStore {
  private db:DatabaseSync;
  private readonly evidenceDirectory:string;
  constructor(readonly base:string) {
    mkdirSync(base,{recursive:true,mode:0o700});
    this.evidenceDirectory=join(base,'equity','evidence');
    mkdirSync(this.evidenceDirectory,{recursive:true,mode:0o700});
    const path=join(base,'equity.sqlite');
    const existed=existsSync(path);
    this.db=new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=2500; PRAGMA foreign_keys=ON');
      const version=this.db.prepare('PRAGMA user_version').get()!.user_version;
      if(version!==0&&version!==1)throw Error('Unsupported equity database schema');
      if(version===0){
        if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get())throw Error('Unknown equity database schema');
        // VACUUM INTO makes a consistent SQLite backup before changing an existing file.
        if(existed)this.db.exec(`VACUUM INTO '${join(base,`equity-before-v1-${randomUUID()}.sqlite`).replaceAll("'","''")}'`);
        this.transaction(()=>this.db.exec(`
          CREATE TABLE equity_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE equity_sessions(id TEXT PRIMARY KEY,domain TEXT NOT NULL CHECK(domain='us-equity'),symbol TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL);
          CREATE TABLE equity_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES equity_sessions(id),run_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,created_at TEXT NOT NULL);
          CREATE TABLE equity_evidence(id TEXT PRIMARY KEY,symbol TEXT NOT NULL,source TEXT NOT NULL,fetched_at TEXT NOT NULL,hash TEXT NOT NULL);
          CREATE TABLE equity_cache(symbol TEXT PRIMARY KEY,evidence_id TEXT NOT NULL REFERENCES equity_evidence(id));
          CREATE TABLE equity_checkpoints(run_id TEXT PRIMARY KEY,body TEXT NOT NULL,hash TEXT NOT NULL,consumed_by TEXT);
          PRAGMA user_version=1;
        `));
      }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      // Only the owning Web server creates this store. Restart never replays work.
      for(const row of this.db.prepare('SELECT id,body FROM equity_jobs').all()){
        const job=JSON.parse(String(row.body)) as EquityJob;
        if(job.status==='loading'){job.status='interrupted';job.error='运行因服务重启中断；可以校验后显式恢复。';this.finish(job);}
      }
    } catch(error){this.db.close();throw error;}
  }
  private transaction<T>(fn:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private meta<T>(key:string,fallback:T):T {const r=this.db.prepare('SELECT value FROM equity_meta WHERE key=?').get(key);return r?JSON.parse(String(r.value)):fallback;}
  private setMeta(key:string,value:unknown){this.db.prepare('INSERT OR REPLACE INTO equity_meta VALUES(?,?)').run(key,JSON.stringify(value));}
  pool():{symbols:string[];version:number;updatedAt:string}{return this.meta('pool',{symbols:[],version:0,updatedAt:''});}
  setPool(symbols:string[]) {
    if(!Array.isArray(symbols)||symbols.length>10||symbols.some(s=>!validSymbol(s)))throw Error('Pool requires at most 10 valid symbols');
    if(new Set(symbols).size!==symbols.length)throw Error('Duplicate pool symbols');
    return this.transaction(()=>{const pool={symbols:[...symbols],version:this.pool().version+1,updatedAt:new Date().toISOString()};this.setMeta('pool',pool);return pool;});
  }
  market():MarketSnapshot|null{return this.meta('market',null);}
  setMarket(value:MarketSnapshot){this.setMeta('market',value);}
  marketSeries():PriceSeries[]{return this.meta('market-series',[]);}
  setMarketSeries(value:PriceSeries[]){this.setMeta('market-series',value);}
  profileRef(symbol:string):SourceRef|undefined{return this.meta<SourceRef|undefined>(`profile:${symbol}`,undefined);}
  setProfileRef(symbol:string,ref:SourceRef){this.setMeta(`profile:${symbol}`,ref);}
  refreshJob():Record<string,unknown>|null{return this.meta('refresh-job',null);}
  setRefreshJob(value:Record<string,unknown>){this.setMeta('refresh-job',value);}
  setCoverage(value:{verifiedMarket:number;verifiedStocks:number}){this.setMeta('coverage',value);}
  coverage(){return this.meta('coverage',{verifiedMarket:0,verifiedStocks:0});}
  job(id:string):EquityJob|undefined {if(!identity(id,'j'))return;const row=this.db.prepare('SELECT body FROM equity_jobs WHERE id=?').get(id);return row?JSON.parse(String(row.body)):undefined;}
  run(sessionId:string,runId:string):EquityJob|undefined {const row=this.db.prepare('SELECT body FROM equity_jobs WHERE session_id=? AND run_id=?').get(sessionId,runId);return row?JSON.parse(String(row.body)):undefined;}
  session(id:string):EquitySession|undefined {
    const row=this.db.prepare('SELECT * FROM equity_sessions WHERE id=?').get(id);if(!row)return;
    return {id:String(row.id),researchDomain:'us-equity',symbol:String(row.symbol),title:String(row.title),createdAt:String(row.created_at),turns:this.db.prepare('SELECT body FROM equity_jobs WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(id).reverse().map(r=>JSON.parse(String(r.body)))};
  }
  sessions():EquitySession[]{return this.db.prepare('SELECT id FROM equity_sessions ORDER BY created_at DESC,rowid DESC LIMIT 30').all().map(row=>this.session(String(row.id))!);}
  accept(symbol:string,question:string,sessionId?:string,screenContext?:EquityJob['screenContext']):EquityJob {
    if(!validSymbol(symbol))throw Error('Invalid security symbol');
    if(typeof question!=='string'||!question.trim()||question.length>4000)throw Error('Question must have 1–4000 characters');
    return this.transaction(()=>{
      if(sessionId){const s=this.session(sessionId);if(!s)throw Error('Unknown equity session');if(s.symbol!==symbol)throw Error('Session symbol is fixed');}
      const id=sessionId??`s_${randomUUID()}`,now=new Date().toISOString();
      if(!sessionId)this.db.prepare('INSERT INTO equity_sessions VALUES(?,?,?,?,?)').run(id,'us-equity',symbol,`${symbol} · ${question.slice(0,80)}`,now);
      const job:EquityJob={id:`j_${randomUUID()}`,sessionId:id,runId:`r_${randomUUID()}`,researchDomain:'us-equity',symbol,question:question.trim(),status:'loading',createdAt:now,counts:{modelRequests:0,toolCalls:0,dataHttpRequests:0,elapsedMs:0},tokenUsage:{inputTokens:0,outputTokens:0,totalTokens:0,unknownRequests:0},queries:[],...(screenContext?{screenContext}:{} )};
      this.db.prepare('INSERT INTO equity_jobs VALUES(?,?,?,?,?)').run(job.id,id,job.runId,JSON.stringify(job),now);return job;
    });
  }
  finish(job:EquityJob){
    const prior=this.job(job.id);if(!prior||prior.sessionId!==job.sessionId||prior.runId!==job.runId||job.researchDomain!=='us-equity'||job.symbol!==prior.symbol)throw Error('Equity result identity mismatch');
    this.db.prepare('UPDATE equity_jobs SET body=? WHERE id=?').run(JSON.stringify(job),job.id);
  }
  async evidence(symbol:string,source:string,data:unknown):Promise<SourceRef> {
    const id=`q_${randomUUID()}`,fetchedAt=new Date().toISOString();
    const body=JSON.stringify({queryId:id,researchDomain:'us-equity',symbol,source,fetchedAt,data});
    if(Buffer.byteLength(body)>34_000_000)throw Error('Evidence too large');
    await writeFile(join(this.evidenceDirectory,`${id}.json`),body,{flag:'wx',mode:0o600});
    const ref={id,source,fetchedAt,hash:hash(body)};
    this.db.prepare('INSERT INTO equity_evidence VALUES(?,?,?,?,?)').run(id,symbol,source,fetchedAt,ref.hash);return ref;
  }
  async readEvidence(id:string):Promise<{queryId:string;symbol:string;source:string;fetchedAt:string;data:any}> {
    if(!identity(id,'q'))throw Error('Invalid evidence identity');
    const ref=this.db.prepare('SELECT * FROM equity_evidence WHERE id=?').get(id);if(!ref)throw Error('Evidence not registered');
    const path=join(this.evidenceDirectory,`${id}.json`),stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>34_000_000)throw Error('Unsafe evidence file');
    const actual=await realpath(path),root=await realpath(this.base),rel=relative(root,actual);
    if(rel.startsWith('..')||isAbsolute(rel))throw Error('Evidence path outside output root');
    // Reject directory junctions/symlinks even if they resolve to another registered file.
    for(const component of [join(this.base,'equity'),this.evidenceDirectory])if((await lstat(component)).isSymbolicLink())throw Error('Unsafe evidence directory');
    const body=await readFile(path,'utf8');if(hash(body)!==ref.hash)throw Error('Evidence hash changed');
    const value=JSON.parse(body);if(value.queryId!==id||value.researchDomain!=='us-equity'||value.symbol!==ref.symbol)throw Error('Evidence identity mismatch');return value;
  }
  async saveCompany(snapshot:CompanySnapshot):Promise<string>{
    const ref=await this.evidence(snapshot.security.symbol,'SEC / FMP normalized snapshot',snapshot);
    this.db.prepare('INSERT OR REPLACE INTO equity_cache VALUES(?,?)').run(snapshot.security.symbol,ref.id);return ref.id;
  }
  companyRef(symbol:string):string|undefined{return this.db.prepare('SELECT evidence_id FROM equity_cache WHERE symbol=?').get(symbol)?.evidence_id as string|undefined;}
  async company(symbol:string):Promise<CompanySnapshot|undefined>{const id=this.companyRef(symbol);return id?(await this.readEvidence(id)).data:undefined;}
  async companies():Promise<CompanySnapshot[]>{const symbols=this.pool().symbols;const rows=await Promise.all(symbols.map(symbol=>this.company(symbol)));return rows.filter((v):v is CompanySnapshot=>Boolean(v));}
  checkpoint(state:EquityCheckpoint){const body=JSON.stringify(state);this.db.prepare('INSERT INTO equity_checkpoints(run_id,body,hash) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body,hash=excluded.hash').run(state.runId,body,hash(body));}
  loadCheckpoint(runId:string):EquityCheckpoint|undefined {
    const row=this.db.prepare('SELECT * FROM equity_checkpoints WHERE run_id=?').get(runId);if(!row||row.consumed_by)return;
    if(hash(String(row.body))!==row.hash)throw Error('Checkpoint hash changed');
    const cp=JSON.parse(String(row.body)) as EquityCheckpoint;
    if(cp.version!==1||cp.researchDomain!=='us-equity'||cp.runId!==runId||cp.closed)return;
    if(cp.parentRunId&&this.db.prepare('SELECT consumed_by FROM equity_checkpoints WHERE run_id=?').get(cp.parentRunId)?.consumed_by!==runId)return;
    return cp;
  }
  activateResume(source:string,job:EquityJob,state:EquityCheckpoint){
    this.transaction(()=>{
      const result=this.db.prepare('UPDATE equity_checkpoints SET consumed_by=? WHERE run_id=? AND consumed_by IS NULL').run(job.runId,source);
      if(result.changes!==1)throw Error('Checkpoint already consumed');
      this.checkpoint({...state,runId:job.runId,parentRunId:source,closed:false});this.finish(job);
    });
  }
  claimResume(source:string,child:string){this.transaction(()=>{const result=this.db.prepare('UPDATE equity_checkpoints SET consumed_by=? WHERE run_id=? AND consumed_by IS NULL').run(child,source);if(result.changes!==1)throw Error('Checkpoint already consumed');});}
  close(){this.db.close();}
}

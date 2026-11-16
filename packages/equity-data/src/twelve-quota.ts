import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** One time_series symbol costs one credit. Reserve only when dispatch is due. */
export class TwelveDataQuota {
  private db:DatabaseSync;
  constructor(path:string,private readonly limit=600){
    if(!Number.isSafeInteger(limit)||limit<1||limit>800)throw Error('QUOTA_LIMIT');
    try{
      if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
      this.db=new DatabaseSync(path);
      this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS twelve_daily_usage(day TEXT PRIMARY KEY, attempts INTEGER NOT NULL CHECK(attempts>=0)); CREATE TABLE IF NOT EXISTS twelve_dispatch(id INTEGER PRIMARY KEY CHECK(id=1), next_ms INTEGER NOT NULL); INSERT OR IGNORE INTO twelve_dispatch VALUES(1,0)');
    }catch{throw Error('QUOTA_STORAGE');}
  }
  reserve(now=Date.now()):number{
    try{
      const day=new Date(now).toISOString().slice(0,10);
      this.db.exec('BEGIN IMMEDIATE');
      const used=this.usage(new Date(now));if(used>=this.limit)throw Error('QUOTA_EXHAUSTED');
      const next=Number((this.db.prepare('SELECT next_ms FROM twelve_dispatch WHERE id=1').get() as {next_ms:number}).next_ms);
      if(next>now){this.db.exec('COMMIT');return next-now;}
      this.db.prepare('INSERT INTO twelve_daily_usage(day,attempts) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1').run(day);
      // Eight-second spacing keeps attempts below eight in every rolling minute.
      this.db.prepare('UPDATE twelve_dispatch SET next_ms=? WHERE id=1').run(now+8000);
      this.db.exec('COMMIT');return 0;
    }catch(error){
      try{this.db.exec('ROLLBACK');}catch{}
      throw Error(error instanceof Error&&error.message==='QUOTA_EXHAUSTED'?'QUOTA_EXHAUSTED':'QUOTA_STORAGE');
    }
  }
  usage(now=new Date()):number{
    try{return Number((this.db.prepare('SELECT attempts FROM twelve_daily_usage WHERE day=?').get(now.toISOString().slice(0,10)) as {attempts:number}|undefined)?.attempts??0);}
    catch{throw Error('QUOTA_STORAGE');}
  }
  close(){this.db.close();}
}

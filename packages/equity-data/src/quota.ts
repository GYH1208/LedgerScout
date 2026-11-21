import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class DailyQuota {
  private db:DatabaseSync;
  constructor(path:string,private readonly limit=200) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error('QUOTA_LIMIT');
    try {
      if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
      this.db=new DatabaseSync(path);
      this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS fmp_daily_usage(day TEXT PRIMARY KEY, attempts INTEGER NOT NULL CHECK(attempts>=0))');
    } catch {throw new Error('QUOTA_STORAGE');}
  }
  reserve(now=new Date()):void {
    try {
      const day=now.toISOString().slice(0,10);
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('INSERT OR IGNORE INTO fmp_daily_usage(day,attempts) VALUES (?,0)').run(day);
      const result=this.db.prepare('UPDATE fmp_daily_usage SET attempts=attempts+1 WHERE day=? AND attempts<?').run(day,this.limit);
      if(Number(result.changes)!==1)throw new Error('QUOTA_EXHAUSTED');
      this.db.exec('COMMIT');
    } catch(error) {
      try{this.db.exec('ROLLBACK');}catch{}
      throw new Error(error instanceof Error&&error.message==='QUOTA_EXHAUSTED'?'QUOTA_EXHAUSTED':'QUOTA_STORAGE');
    }
  }
  usage(now=new Date()):number {
    try {return Number((this.db.prepare('SELECT attempts FROM fmp_daily_usage WHERE day=?').get(now.toISOString().slice(0,10)) as {attempts:number}|undefined)?.attempts??0);}
    catch {throw new Error('QUOTA_STORAGE');}
  }
  close():void {this.db.close();}
}

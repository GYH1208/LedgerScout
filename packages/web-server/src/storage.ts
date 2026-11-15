import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunResult } from '@ledgerscout/agent-runtime';
import { publicRun, validId, type StoredJob } from './views.js';

type Accept = { sessionId?: string; title: string; question: string; date: string; resumeOf?: string };
type Row = Record<string, unknown>;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };

/** Short synchronous transactions; network and evidence reads stay outside SQLite. */
export class WebStore {
  private db: DatabaseSync;
  private token = randomUUID();
  private closed = false;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2500');
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
      if (version !== 0 && version !== 1) throw Error('Unsupported Web database schema');
      if (version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw Error('Unknown Web database schema');
        this.transaction(() => this.db.exec(`
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL);
          CREATE TABLE jobs (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            session_id TEXT NOT NULL REFERENCES sessions(id), question TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('loading','completed','partial','awaiting_user','failed','cancelled','exhausted','interrupted')),
            run_id TEXT, resume_of TEXT, progress_json TEXT NOT NULL DEFAULT '[]',
            error TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(session_id,run_id));
          CREATE INDEX session_jobs ON jobs(session_id,seq);
          CREATE UNIQUE INDEX one_running_job ON jobs((1)) WHERE status='loading';
          CREATE TABLE evidence_refs (
            job_id TEXT NOT NULL REFERENCES jobs(id), query_id TEXT NOT NULL, source_run_id TEXT NOT NULL,
            PRIMARY KEY(job_id,query_id));
          PRAGMA user_version=1;
        `));
      }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      this.transaction(() => {
        const owner = this.db.prepare("SELECT value FROM meta WHERE key='owner'").get();
        if (owner) {
          const previous = JSON.parse(String(owner.value));
          if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || alive(previous.pid)) throw Error('Web database already has an active owner');
        }
        this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('owner',?)").run(JSON.stringify({ pid: process.pid, token: this.token }));
      });
      chmodSync(path, 0o600);
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private row(row: Row): StoredJob {
    return { id: String(row.id), sessionId: String(row.session_id), question: String(row.question), status: String(row.status),
      ...(row.run_id ? { runId: String(row.run_id) } : {}), ...(row.resume_of ? { resumeOf: String(row.resume_of) } : {}),
      progress: JSON.parse(String(row.progress_json)), ...(row.error ? { error: String(row.error) } : {}),
      ...(row.result_json ? { run: JSON.parse(String(row.result_json)) } : {}) };
  }
  accept(value: Accept) {
    const sessionId = value.sessionId ?? `s_${randomUUID()}`, jobId = `j_${randomUUID()}`;
    if (!validId(sessionId, 's') || value.resumeOf && !validId(value.resumeOf, 'r')) throw Error('Invalid identity');
    return this.transaction(() => {
      if (value.sessionId && !this.hasSession(sessionId)) throw Error('Unknown session');
      if (!value.sessionId) this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sessionId, value.title, value.date);
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO jobs(id,session_id,question,status,resume_of,created_at,updated_at) VALUES(?,?,?,'loading',?,?,?)").run(jobId, sessionId, value.question, value.resumeOf ?? null, now, now);
      return { sessionId, jobId };
    });
  }
  hasSession(id: string) { return Boolean(this.db.prepare('SELECT id FROM sessions WHERE id=?').get(id)); }
  get(id: string) { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); return row ? this.row(row) : undefined; }
  findRun(sessionId: string, runId: string) { const row = this.db.prepare('SELECT * FROM jobs WHERE session_id=? AND run_id=?').get(sessionId, runId); return row ? this.row(row) : undefined; }
  bindRun(id: string, runId: string) {
    if (!validId(runId, 'r')) throw Error('Invalid runtime identity');
    const row = this.get(id); if (!row || row.runId && row.runId !== runId) throw Error('Runtime identity mismatch');
    this.db.prepare('UPDATE jobs SET run_id=?,updated_at=? WHERE id=?').run(runId, new Date().toISOString(), id);
  }
  progress(id: string, entry: { type: string; name?: string }) {
    const job = this.get(id); if (!job) throw Error('Unknown task');
    this.db.prepare('UPDATE jobs SET progress_json=? WHERE id=?').run(JSON.stringify([...job.progress, entry].slice(-12)), id);
  }
  finish(id: string, result: RunResult) {
    const job = this.get(id);
    if (!job || result.sessionId !== job.sessionId || !validId(result.runId, 'r') || job.runId && job.runId !== result.runId || result.queries.some(q => q.sessionId !== job.sessionId || !validId(q.queryId, 'q') || !validId(q.runId, 'r'))) throw Error('Runtime result identity mismatch');
    const projected = publicRun(result), json = JSON.stringify(projected);
    if (Buffer.byteLength(json) > 2_000_000) throw Error('Web result too large');
    this.transaction(() => {
      this.db.prepare('UPDATE jobs SET status=?,run_id=?,error=NULL,result_json=?,updated_at=? WHERE id=?').run(result.status, result.runId, json, new Date().toISOString(), id);
      this.db.prepare('DELETE FROM evidence_refs WHERE job_id=?').run(id);
      const insert = this.db.prepare('INSERT INTO evidence_refs VALUES(?,?,?)');
      for (const q of result.queries) insert.run(id, q.queryId, q.runId);
    });
  }
  interrupt(id: string, error: string) { this.db.prepare("UPDATE jobs SET status='interrupted',error=?,updated_at=? WHERE id=?").run(error, new Date().toISOString(), id); }
  fail(id: string, error: string) { this.db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?").run(error, new Date().toISOString(), id); }
  refs(id: string) { return this.db.prepare('SELECT query_id AS queryId,source_run_id AS sourceRunId FROM evidence_refs WHERE job_id=?').all(id) as { queryId: string; sourceRunId: string }[]; }
  unfinished() { return this.db.prepare("SELECT * FROM jobs WHERE status='loading' ORDER BY seq").all().map(row => this.row(row)); }
  list() {
    const rows = this.db.prepare('SELECT s.*,MAX(j.seq) AS latest FROM sessions s JOIN jobs j ON j.session_id=s.id GROUP BY s.id ORDER BY latest DESC LIMIT 31').all();
    return { hasMoreSessions: rows.length > 30, sessions: rows.slice(0,30).map(row => {
      const jobs = this.db.prepare('SELECT * FROM jobs WHERE session_id=? ORDER BY seq DESC LIMIT 21').all(String(row.id));
      return { id: String(row.id), title: String(row.title), date: String(row.date), hasMoreTurns: jobs.length > 20, turns: jobs.slice(0,20).reverse().map(row => this.row(row)) };
    }) };
  }
  hasImported() { return Boolean(this.db.prepare("SELECT value FROM meta WHERE key='imported'").get()); }
  completeImport(skipped: number) { this.db.prepare("INSERT OR REPLACE INTO meta VALUES('imported',?)").run(String(skipped)); }
  importWarnings() { return Number(this.db.prepare("SELECT value FROM meta WHERE key='imported'").get()?.value ?? 0); }
  importResult(result: RunResult, question: string, date: string) {
    if (this.findRun(result.sessionId, result.runId)) return;
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO sessions VALUES(?,?,?)').run(result.sessionId, question.slice(0,100), date);
      const id = `j_history_${result.runId.slice(2)}`, now = `${date}T00:00:00Z`;
      this.db.prepare("INSERT INTO jobs(id,session_id,question,status,created_at,updated_at) VALUES(?,?,?,'interrupted',?,?)").run(id, result.sessionId, question, now, now);
      // Finish uses its own transaction, so insert projected fields here as one import transaction.
      const json = JSON.stringify(publicRun(result)); if (Buffer.byteLength(json) > 2_000_000) throw Error('Web result too large');
      this.db.prepare('UPDATE jobs SET status=?,run_id=?,result_json=? WHERE id=?').run(result.status, result.runId, json, id);
      for (const q of result.queries) this.db.prepare('INSERT INTO evidence_refs VALUES(?,?,?)').run(id,q.queryId,q.runId);
    });
  }
  close() {
    if (this.closed) return;
    try { this.db.prepare("DELETE FROM meta WHERE key='owner' AND value=?").run(JSON.stringify({ pid: process.pid, token: this.token })); }
    finally { this.db.close(); this.closed = true; }
  }
}

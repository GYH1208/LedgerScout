import { open, lstat, opendir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { CheckpointStore, defaultLimits, type RunResult } from '@ledgerscout/agent-runtime';
import { redact, type QueryResult } from '@ledgerscout/chain-data';
import { WebStore } from './storage.js';
import { validId, type StoredJob } from './views.js';

const unavailable = () => Error('Local evidence unavailable');
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const object = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Reject symlinks at every registered path component and bound actual bytes. */
async function readText(base: string, parts: string[], max: number) {
  const root = await realpath(base); let path = root;
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') throw unavailable();
    path = join(path,part); if ((await lstat(path)).isSymbolicLink()) throw unavailable();
  }
  const resolved = await realpath(path), rel = relative(root,resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) throw unavailable();
  const file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > max) throw unavailable();
    const bytes = Buffer.alloc(Math.min(max+1,stat.size+1)); const {bytesRead} = await file.read(bytes,0,bytes.length,0);
    if (bytesRead > max || bytesRead !== stat.size) throw unavailable();
    return bytes.subarray(0,bytesRead).toString('utf8');
  } finally { await file.close(); }
}
function validQuery(q: any, sessionId: string): q is QueryResult {
  if (!object(q) || q.schemaVersion !== 1 || q.sessionId !== sessionId || !validId(q.runId,'r') || !validId(q.queryId,'q') || !['get_eth_balance','list_asset_transfers','list_normal_transactions'].includes(q.kind) || !['ok','partial','error'].includes(q.status) || q.network !== 'Ethereum Mainnet' || !/^0x[0-9a-fA-F]{40}$/.test(q.address) || typeof q.fetchedAt !== 'string' || !Number.isFinite(Date.parse(q.fetchedAt)) || !object(q.data) || !object(q.range) || !object(q.completeness) || typeof q.completeness.complete !== 'boolean' || typeof q.completeness.stopReason !== 'string' || !Array.isArray(q.evidenceRefs) || !Array.isArray(q.warnings)) return false;
  if (q.status === 'error') return true;
  if (q.kind === 'get_eth_balance') return typeof q.data.wei === 'string' && /^\d+$/.test(q.data.wei) && typeof q.data.eth === 'string' && /^\d+(?:\.\d+)?$/.test(q.data.eth);
  if (q.kind === 'list_asset_transfers') return ['incoming','outgoing'].every(k=>object(q.data[k]) && integer(q.data[k].count) && Array.isArray(q.data[k].transfers) && q.data[k].transfers.every(object));
  return integer(q.data.count) && Array.isArray(q.data.transactions) && q.data.transactions.every(object);
}
function validResult(r: any, sessionId: string, runId: string): r is RunResult {
  return object(r) && r.sessionId === sessionId && r.runId === runId && validId(sessionId,'s') && validId(runId,'r') &&
    ['completed','partial','awaiting_user','failed','cancelled','exhausted'].includes(r.status) && typeof r.answer === 'string' && Array.isArray(r.warnings) &&
    object(r.counts) && ['models','tools','http'].every(k=>integer(r.counts[k])) && object(r.tokenUsage) && r.tokenUsage.source === 'provider' &&
    ['inputTokens','outputTokens','totalTokens','reportedRequests','unknownRequests'].every(k=>integer(r.tokenUsage[k])) &&
    Array.isArray(r.queries) && r.queries.length <= 44 && r.queries.every(q=>validQuery(q,sessionId));
}
export async function loadSummary(base: string, sessionId: string, runId: string) {
  if (!validId(sessionId,'s') || !validId(runId,'r')) throw unavailable();
  const result = JSON.parse(await readText(base,[sessionId,runId,'run-summary.json'],16_000_000));
  if (!validResult(result,sessionId,runId)) throw unavailable();
  return result;
}
export async function loadEvidence(base: string, job: StoredJob, ref: {queryId:string;sourceRunId:string;hash:string}) {
  if (!validId(job.sessionId,'s') || !validId(ref.sourceRunId,'r') || !validId(ref.queryId,'q')) throw unavailable();
  const q = JSON.parse(await readText(base,[job.sessionId,ref.sourceRunId,'queries',ref.queryId,'query.json'],2_000_000));
  if (!validQuery(q,job.sessionId) || q.runId !== ref.sourceRunId || q.queryId !== ref.queryId || createHash('sha256').update(JSON.stringify(q)).digest('hex') !== ref.hash) throw unavailable();
  return q;
}
export async function recovery(base: string, job: StoredJob) {
  if (!job.runId || job.status === 'loading') return undefined;
  try {
    // CheckpointStore validates hashes, dates, ENS proofs and consumed lineage.
    // Check the registered checkpoint path itself before its internal reads.
    await readText(base,[job.sessionId,job.runId,'checkpoint.json'],262144);
    const checked = await CheckpointStore.load(base,job.sessionId,job.runId,defaultLimits);
    for (const ref of checked.state.queryRefs) await readText(base,[job.sessionId,ref.runId,'queries',ref.queryId,'query.json'],2_000_000);
    return { sessionId:job.sessionId,runId:job.runId };
  } catch { return undefined; }
}

export async function initializeHistory(base: string, store: WebStore, secrets: string[]) {
  for (const job of [...store.unfinished(),...store.unhashed()]) {
    let result: RunResult | undefined;
    if (job.runId) { try { result=await loadSummary(base,job.sessionId,job.runId); } catch {} }
    if (result) store.finish(job.id,redact(result,secrets) as RunResult);
    else if (job.status==='loading') store.interrupt(job.id,'本地服务在查询结束前停止。可用检查点经校验后可手动恢复，否则请重新发起查询。');
  }
  if (store.hasImported()) return;
  let skipped=0, processed=0;
  const root=await opendir(base);
  for await (const entry of root) {
    if (!validId(entry.name,'s') || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory=await opendir(join(base,entry.name));
    for await (const run of directory) {
      if (!validId(run.name,'r') || !run.isDirectory() || run.isSymbolicLink()) continue;
      let r:RunResult;
      try {r=await loadSummary(base,entry.name,run.name);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')skipped++;continue;}
      {
        let question='历史运行 '+run.name;
        let timestamp=r.queries[0]?.fetchedAt;
        try {
          const events=await readText(base,[entry.name,run.name,'events.jsonl'],2_000_000);
          for (const line of events.split('\n')) {
            if (!line || Buffer.byteLength(line)>32768) continue;
            const e=JSON.parse(line); if (e.type==='run_started' && e.runId===run.name && typeof e.input==='string' && e.input.trim()) { question=e.input.slice(0,4000);if(typeof e.timestamp==='string'&&Number.isFinite(Date.parse(e.timestamp)))timestamp=e.timestamp;break; }
          }
        } catch {}
        const date=timestamp?new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(timestamp)):new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
        // Storage errors must abort initialization; only malformed source files
        // are skippable. Otherwise a disk failure would permanently lose import.
        store.importResult(redact(r,secrets) as RunResult,String(redact(question,secrets)),date,timestamp?new Date(timestamp).toISOString():undefined);
      }
      if (++processed % 100===0) await new Promise<void>(resolve=>setImmediate(resolve));
    }
  }
  store.completeImport(Math.min(skipped,1_000_000));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebStore } from '../src/storage.js';
import type { RunResult } from '@ledgerscout/agent-runtime';

const accepted = { title: '余额', question: '查询余额', date: '2026-11-15' };
function outcome(sessionId: string, runId = 'r_first'): RunResult {
  return { sessionId, runId, directory: '/private/results', status: 'completed', answer: '1.000000000000000001 ETH', counts: { models: 2, tools: 1, http: 3 }, warnings: [], resumable: false,
    tokenUsage: { source: 'provider', inputTokens: 11, outputTokens: 3, totalTokens: 14, reportedRequests: 2, unknownRequests: 0 },
    queries: [{ schemaVersion: 1, sessionId, runId, queryId: 'q_exact', kind: 'get_eth_balance', toolCallId: 'c', address: '0x'+'1'.repeat(40), network: 'Ethereum Mainnet', range: { blockNumber: 10 }, fetchedAt: '2026-11-15T00:00:00Z', status: 'ok', data: { wei: '1000000000000000001', eth: '1.000000000000000001' }, completeness: { complete: true, stopReason: 'exhausted' }, evidenceRefs: [], warnings: [] }] };
}
async function location() { const dir = await mkdtemp(join(tmpdir(), 'ledger-sqlite-')); return { dir, path: join(dir, 'web.sqlite'), clean: () => rm(dir, { recursive: true, force: true }) }; }

test('reopening retains exact answers and original evidence references without full raw records', async () => {
  const loc = await location(); let store: WebStore | undefined;
  try {
    store = new WebStore(loc.path);
    const first = store.accept(accepted); store.bindRun(first.jobId, 'r_first'); store.finish(first.jobId, outcome(first.sessionId));
    const second = store.accept({ ...accepted, sessionId: first.sessionId, question: '解释旧证据' });
    const historical = outcome(first.sessionId, 'r_followup'); historical.queries[0]!.runId = 'r_first'; store.finish(second.jobId, historical);
    store.close(); store = new WebStore(loc.path);
    const sessions = store.list().sessions;
    assert.equal(sessions.length, 1); assert.equal(sessions[0]!.turns.length, 2);
    assert.equal(store.get(first.jobId)!.run!.queries[0]!.balance!.wei, '1000000000000000001');
    assert.equal(store.get(first.jobId)!.run!.answer, '1.000000000000000001 ETH');
    assert.equal(store.refs(second.jobId)[0]!.sourceRunId, 'r_first');
    const db = new DatabaseSync(loc.path); const row = db.prepare('select result_json from jobs where id = ?').get(first.jobId)!;
    const persisted = JSON.parse(String(row.result_json)); assert.equal(persisted.directory, undefined); assert.equal(persisted.queries[0].data, undefined); db.close();
  } finally { store?.close(); await loc.clean(); }
});

test('failed acceptance rolls back the new session and keeps the existing running task', async () => {
  const loc = await location(); const store = new WebStore(loc.path);
  try { const first = store.accept(accepted); assert.throws(() => store.accept({ ...accepted, title: 'must rollback' })); assert.equal(store.list().sessions.length, 1); assert.equal(store.get(first.jobId)!.status, 'loading'); }
  finally { store.close(); await loc.clean(); }
});

test('active ownership prevents another instance from changing interrupted state', async () => {
  const loc = await location(); const store = new WebStore(loc.path);
  try { const first = store.accept(accepted); assert.throws(() => new WebStore(loc.path), /owner|active|already/i); assert.equal(store.get(first.jobId)!.status, 'loading'); }
  finally { store.close(); await loc.clean(); }
});

test('over 200 jobs remain durable while session views are bounded without deletion', async () => {
  const loc = await location(); let store = new WebStore(loc.path);
  try {
    let sessionId: string | undefined;
    for (let i=0;i<205;i++) { const job = store.accept({ ...accepted, sessionId }); sessionId = job.sessionId; store.finish(job.jobId, outcome(job.sessionId, `r_${i}`)); }
    assert.equal(store.list().sessions[0]!.turns.length, 20); assert.equal(store.list().sessions[0]!.hasMoreTurns, true);
    store.close(); store = new WebStore(loc.path);
    const db = new DatabaseSync(loc.path); assert.equal(db.prepare('select count(*) as n from jobs').get()!.n, 205); db.close();
  } finally { store.close(); await loc.clean(); }
});

test('foreign results cannot replace a durable task or register their evidence', async () => {
  const loc = await location(); const store = new WebStore(loc.path);
  try { const job = store.accept(accepted); assert.throws(() => store.finish(job.jobId, outcome('s_other')), /identity/i); assert.equal(store.get(job.jobId)!.status, 'loading'); assert.deepEqual(store.refs(job.jobId), []); }
  finally { store.close(); await loc.clean(); }
});

test('unknown schema and corrupt databases fail without silently replacing the original file', async () => {
  const loc = await location();
  try {
    const db = new DatabaseSync(loc.path); db.exec('PRAGMA user_version=99'); db.close();
    assert.throws(() => new WebStore(loc.path));
    const check = new DatabaseSync(loc.path); assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 99); check.close();
    const broken = join(loc.dir, 'broken.sqlite'); await writeFile(broken, 'not a database'); assert.throws(() => new WebStore(broken)); assert.equal(await readFile(broken, 'utf8'), 'not a database');
  } finally { await loc.clean(); }
});

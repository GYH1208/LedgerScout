import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '@ledgerscout/chain-data';
import { runAgent } from '../src/runtime.js';
import type { ModelRequest } from '../src/types.js';
const address = '0x' + '1'.repeat(40);
const config = parseConfig({ ALCHEMY_API_KEY: 'offline-key', ETHERSCAN_API_KEY: 'offline-explorer', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' });
const call = (id: string, blockNumber?: number) => ({ id, name: 'get_eth_balance', arguments: { address, ...(blockNumber === undefined ? {} : { blockNumber }) } });
function answer(r: ModelRequest) {
  const ids = [...new Set(r.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content).queryId))];
  return { content: JSON.stringify({ kind: 'answer', queryIds: ids, claims: ids.map(queryId => ({ queryId, field: 'eth' })) }) };
}
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-resume-')); const calls: any[] = [];
  const fetcher = (async (_url, init) => {
    const b = JSON.parse(String(init?.body)); calls.push(b);
    return Response.json({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_chainId' ? '0x1' : b.method === 'eth_blockNumber' ? '0xa' : '0x1' });
  }) as typeof fetch;
  const run = (extra: Record<string, any>) => runAgent({ input: `查询 ${address} 余额`, config, request: async () => ({ content: '' }), outputDirectory: dir, fetch: fetcher, ...extra });
  return { dir, calls, run, close: () => rm(dir, { recursive: true, force: true }) };
}

test('resume replays completed tools, finishes the remaining batch at the same snapshot and keeps cumulative counts', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, request: async () => ({ content: '', toolCalls: [call('a'), call('b', 9)] }),
      onEvent: (e: any) => { if (e.type === 'tool_finished' && e.toolCallId === 'a') ctl.abort(); } });
    assert.equal(first.status, 'cancelled'); assert.equal(h.calls.filter(c => c.method === 'eth_getBalance').length, 1);
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId, request: async (r: ModelRequest) => answer(r) });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.resumeOf, first.runId);
    assert.equal(resumed.counts.models, 2); assert.equal(resumed.counts.tools, 2); assert.equal(resumed.counts.http, 4);
    assert.equal(h.calls.filter(c => c.method === 'eth_chainId').length, 1);
    assert.deepEqual(h.calls.filter(c => c.method === 'eth_getBalance').map(c => c.params[1]), ['0xa', '0x9']);
    assert.equal(resumed.queries.length, 2); assert.match(resumed.answer, /区块 10/); assert.match(resumed.answer, /区块 9/);
    await assert.rejects(h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId }), /resum|恢复/i);
  } finally { await h.close(); }
});

test('resume during a model wait restores paired evidence without another chain query', async () => {
  const h = await harness(); const ctl = new AbortController(); let turn = 0;
  try {
    const first = await h.run({ signal: ctl.signal, request: async () => {
      if (++turn === 1) return { content: '', toolCalls: [call('a')] };
      ctl.abort(); return new Promise(() => {});
    } });
    const before = h.calls.length;
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId, request: async (r: ModelRequest) => answer(r) });
    assert.equal(resumed.status, 'completed'); assert.equal(h.calls.length, before);
    assert.equal(resumed.counts.models, 3); assert.equal(resumed.counts.tools, 1);
    assert.equal(resumed.tokenUsage.unknownRequests, 3);
  } finally { await h.close(); }
});

test('resuming cannot reset the original reduced model budget', async () => {
  const h = await harness(); const ctl = new AbortController(); let turn = 0;
  try {
    const first = await h.run({ signal: ctl.signal, limits: { maxModelRequests: 2 }, request: async () => {
      if (++turn === 1) return { content: '', toolCalls: [call('a')] };
      ctl.abort(); return new Promise(() => {});
    } });
    let requested = false;
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId, request: async () => { requested = true; return { content: '' }; } });
    assert.equal(resumed.status, 'exhausted'); assert.equal(resumed.counts.models, 2); assert.equal(requested, false);
  } finally { await h.close(); }
});

test('finished runs, new input, cross-session and corrupt evidence are rejected before requests', async () => {
  const h = await harness(); let turn = 0;
  try {
    const done = await h.run({ request: async (r: ModelRequest) => ++turn === 1 ? { content: '', toolCalls: [call('a')] } : answer(r) });
    await assert.rejects(h.run({ input: '', sessionId: done.sessionId, resumeRunId: done.runId }), /resum|checkpoint|恢复/i);
    await assert.rejects(h.run({ sessionId: done.sessionId, resumeRunId: done.runId }), /input|问题/i);
    await assert.rejects(h.run({ input: '', resumeRunId: done.runId }), /session/i);
    await assert.rejects(h.run({ input: '', sessionId: 's_other', resumeRunId: done.runId }), /checkpoint|恢复/i);
    const ctl = new AbortController(); turn = 0;
    const first = await h.run({ signal: ctl.signal, request: async () => {
      if (++turn === 1) return { content: '', toolCalls: [call('a')] };
      ctl.abort(); return new Promise(() => {});
    } });
    const q = first.queries[0]!;
    const path = join(first.directory, 'queries', q.queryId, 'query.json');
    const data = JSON.parse(await readFile(path, 'utf8')); data.data.eth = '999'; await writeFile(path, JSON.stringify(data));
    const count = h.calls.length;
    await assert.rejects(h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId }), /evidence|证据|checkpoint/i);
    assert.equal(h.calls.length, count);
  } finally { await h.close(); }
});

test('malformed checkpoint counters cannot disable the cumulative tool budget', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, request: async () => { ctl.abort(); return new Promise(() => {}); } });
    const path = join(first.directory, 'checkpoint.json'); const cp = JSON.parse(await readFile(path, 'utf8'));
    delete cp.counts.tools; await writeFile(path, JSON.stringify(cp));
    await assert.rejects(h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId }), /checkpoint/i);
  } finally { await h.close(); }
});

test('checkpoint write failure stops a model request before any external side effect', async () => {
  const h = await harness(); let called = false;
  try {
    const fs = await import('node:fs');
    const result = await h.run({ onEvent: (e: any) => {
      if (e.type !== 'run_started') return;
      const sid = fs.readdirSync(h.dir)[0]!;
      const rid = fs.readdirSync(join(h.dir, sid)).find(x => x.startsWith('r_'))!;
      fs.mkdirSync(join(h.dir, sid, rid, 'checkpoint.json'));
    }, request: async () => { called = true; return { content: '' }; } });
    assert.equal(result.status, 'failed'); assert.equal(result.resumable, false); assert.equal(called, false); assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('a real process exit retains an in-flight reservation and can resume without replaying data', async () => {
  const h = await harness();
  try {
    const path = join(h.dir, 'crash.mts');
    const runtimeUrl = new URL('../src/runtime.ts', import.meta.url).href;
    const chainUrl = new URL('../../chain-data/src/index.ts', import.meta.url).href;
    await writeFile(path, `import { runAgent } from ${JSON.stringify(runtimeUrl)};
import { parseConfig } from ${JSON.stringify(chainUrl)};
await runAgent({input:'查询 ${address} 余额',outputDirectory:${JSON.stringify(h.dir)},sessionId:'s_crash',
config:parseConfig({ALCHEMY_API_KEY:'offline-key',REQUEST_INTERVAL_MS:'0'}),request:async()=>process.exit(23)});`);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', path], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Crash fixture timed out')); }, 10000);
      child.on('error', reject); child.on('exit', c => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 23);
    const fs = await import('node:fs/promises');
    const rid = (await fs.readdir(join(h.dir, 's_crash'))).find(x => x.startsWith('r_'))!;
    const saved = JSON.parse(await readFile(join(h.dir, 's_crash', rid, 'checkpoint.json'), 'utf8'));
    assert.equal(saved.counts.models, 1); assert.equal(saved.reservedMs, 30000);
    let turn = 0;
    const result = await h.run({ input: '', sessionId: 's_crash', resumeRunId: rid,
      request: async (r: ModelRequest) => ++turn === 1 ? { content: '', toolCalls: [call('a')] } : answer(r) });
    assert.equal(result.status, 'completed'); assert.equal(result.counts.models, 3);
    assert.equal(result.counts.http, 3); assert.ok(result.warnings.some((w: string) => w.includes('恢复')));
  } finally { await h.close(); }
});

test('an orphan recovery child is not active until the parent link commits', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, request: async () => { ctl.abort(); return new Promise(() => {}); } });
    const parent = JSON.parse(await readFile(join(first.directory, 'checkpoint.json'), 'utf8'));
    const fs = await import('node:fs/promises');
    const child = 'r_orphan_child'; const directory = join(h.dir, first.sessionId, child); await fs.mkdir(directory);
    await writeFile(join(directory, 'checkpoint.json'), JSON.stringify({ ...parent, runId: child, lineage: [...parent.lineage, child] }));
    await assert.rejects(h.run({ input: '', sessionId: first.sessionId, resumeRunId: child }), /checkpoint/i);
  } finally { await h.close(); }
});

test('a committed terminal summary prevents recovery even if checkpoint closure was interrupted', async () => {
  const h = await harness(); let turn = 0;
  try {
    const done = await h.run({ request: async (r: ModelRequest) => ++turn === 1 ? { content: '', toolCalls: [call('a')] } : answer(r) });
    const path = join(done.directory, 'checkpoint.json'); const cp = JSON.parse(await readFile(path, 'utf8')); cp.closed = false;
    await writeFile(path, JSON.stringify(cp));
    await assert.rejects(h.run({ input: '', sessionId: done.sessionId, resumeRunId: done.runId }), /checkpoint/i);
  } finally { await h.close(); }
});

test('cancelling an active data request then retrying supersedes its incomplete attempt', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, request: async () => ({ content: '', toolCalls: [call('a')] }), fetch: (async (_url: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body));
      if (b.method === 'eth_getBalance') { ctl.abort(); return new Promise(() => {}); }
      return Response.json({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_chainId' ? '0x1' : '0xa' });
    }) as typeof fetch });
    assert.equal(first.status, 'cancelled'); assert.equal(first.queries[0]?.status, 'error');
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId, request: async (r: ModelRequest) => answer(r) });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.queries.length, 1); assert.equal(resumed.queries[0]?.status, 'ok');
    assert.ok(!resumed.queries.some((q: any) => q.queryId === first.queries[0]!.queryId));
  } finally { await h.close(); }
});

test('a completed query is reusable even when cancellation interrupts its tool-end event', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, limits: { maxToolCalls: 1 }, request: async () => ({ content: '', toolCalls: [call('a')] }),
      onEvent: (e: any) => { if (e.type === 'query_finished') ctl.abort(); } });
    assert.equal(first.queries[0]?.status, 'ok'); const before = h.calls.length;
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId, request: async (r: ModelRequest) => answer(r) });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.counts.tools, 1); assert.equal(h.calls.length, before);
  } finally { await h.close(); }
});

test('large historical sessions are fitted before checkpointing instead of blocking new work', async () => {
  const h = await harness();
  try {
    const first = await h.run({ request: async () => ({ content: '{"kind":"clarification","message":"请给区块"}' }) });
    const path = join(h.dir, first.sessionId, 'session.json'); const data = JSON.parse(await readFile(path, 'utf8'));
    data.turns = Array.from({ length: 20 }, () => ({ user: 'x'.repeat(14000), assistant: 'y'.repeat(14000) }));
    await writeFile(path, JSON.stringify(data));
    const result = await h.run({ sessionId: first.sessionId, request: async () => ({ content: '{"kind":"clarification","message":"请给区块"}' }) });
    assert.equal(result.status, 'awaiting_user'); assert.equal(result.counts.models, 1);
  } finally { await h.close(); }
});

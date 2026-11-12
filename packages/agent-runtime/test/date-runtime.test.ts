import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@ledgerscout/chain-data';
import { runAgent } from '../src/runtime.js';
import type { ModelRequest } from '../src/types.js';
import { SessionStore } from '../src/session.js';
const address = '0x' + '1'.repeat(40); const now = new Date('2026-11-12T01:00:00Z');
const start = Date.parse('2026-11-05T01:00:00Z') / 1000; const end = now.getTime() / 1000;
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-date-runtime-')); const calls: any[] = [];
  const config = parseConfig({ ALCHEMY_API_KEY: 'offline', ETHERSCAN_API_KEY: 'offline', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' });
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)); const body = JSON.parse(String(init?.body ?? '{}')); calls.push({ url, body });
    if (body.method) {
      let value: any = body.method === 'eth_chainId' ? '0x1' : '0x4';
      if (body.method === 'eth_getBlockByNumber') value = { number: body.params[0], timestamp: '0x' +
        ({ 1: start - 1, 2: start, 3: end, 4: end + 1 }[Number(BigInt(body.params[0]))]!).toString(16) };
      if (body.method === 'alchemy_getAssetTransfers') value = { transfers: [] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result: value });
    }
    return Response.json(url.searchParams.get('action') === 'getblocknobytime' ?
      { status: '1', message: 'OK', result: Number(url.searchParams.get('timestamp')) < start ? '1' : '3' } :
      { status: '1', message: 'OK', result: [] });
  }) as typeof fetch;
  const request = async (r: ModelRequest) => {
    const queries = r.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    return !queries.length ? { content: '', toolCalls: [{ id: 'history', name: 'list_normal_transactions', arguments: { address } }] } :
      { content: JSON.stringify({ kind: 'answer', queryIds: queries.map(q => q.queryId), claims: queries.map(q =>
        ({ queryId: q.queryId, field: q.kind === 'list_asset_transfers' ? 'incoming.count' : 'count' })) }) };
  };
  const run = (extra: Partial<Parameters<typeof runAgent>[0]> = {}) => runAgent({ input: `${address} 最近七天普通交易`, config,
    request, fetch: fetcher, outputDirectory: dir, now: () => now, ...extra });
  return { dir, calls, run, close: () => rm(dir, { recursive: true, force: true }) };
}
test('date runtime forces a verified time range and renders it with evidence', async () => {
  const h = await harness();
  try {
    const result = await h.run(); assert.equal(result.status, 'completed');
    assert.equal(result.queries[0]?.range.startBlock, 2); assert.equal(result.queries[0]?.range.endBlock, 3);
    assert.match(result.answer, /2026-11-05/); assert.match(result.answer, /Asia\/Shanghai|北京时间/);
    assert.equal(result.counts.http, 9);
  } finally { await h.close(); }
});
test('invalid dates and date-block conflicts clarify without any model or HTTP request', async () => {
  const h = await harness();
  try {
    for (const input of [`${address} 2026-02-29`, `${address} 最近七天 区块100到200`]) {
      const result = await h.run({ input }); assert.equal(result.status, 'awaiting_user');
      assert.equal(result.counts.models, 0); assert.equal(result.counts.http, 0);
    }
  } finally { await h.close(); }
});
test('date recovery freezes original timestamps and reuses hash-verified mapping evidence', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, onEvent: e => { if (e.type === 'tool_finished') ctl.abort(); } });
    assert.equal(first.status, 'cancelled');
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId, now: () => new Date('2026-12-01T01:00:00Z') });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.queries[0]?.range.timeWindow?.startTimestamp, start);
    assert.equal(resumed.counts.http, first.counts.http);
    assert.equal(h.calls.filter(c => c.url.searchParams.get('action') === 'getblocknobytime').length, 2);
  } finally { await h.close(); }
});
test('malformed checkpoint time windows are rejected before network', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, onEvent: e => { if (e.type === 'tool_finished') ctl.abort(); } });
    const path = join(first.directory, 'checkpoint.json'); const cp = JSON.parse(await readFile(path, 'utf8'));
    cp.timeWindow = { startTimestamp: 'bad' }; await writeFile(path, JSON.stringify(cp));
    const count = h.calls.length;
    await assert.rejects(h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId }), /checkpoint|evidence/i);
    assert.equal(h.calls.length, count);
  } finally { await h.close(); }
});
test('a remaining history tool reuses the original mapping after recovery', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, request: async () => ({ content: '', toolCalls: [
      { id: 'history', name: 'list_normal_transactions', arguments: { address } },
      { id: 'transfers', name: 'list_asset_transfers', arguments: { address } },
    ] }), onEvent: e => { if (e.type === 'tool_finished' && e.name === 'list_normal_transactions') ctl.abort(); } });
    assert.equal(first.status, 'cancelled');
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.queries.length, 2);
    assert.equal(resumed.counts.http, first.counts.http + 2);
    assert.equal(h.calls.filter(c => c.url.searchParams.get('action') === 'getblocknobytime').length, 2);
    assert.equal(resumed.queries[1]?.range.timeWindow?.sourceQueryId, first.queries[0]?.queryId);
  } finally { await h.close(); }
});
test('bounded session history retains time mapping sources with their dependents', async () => {
  const h = await harness();
  try {
    const first = await h.run(); const source = first.queries[0]!;
    const store = new SessionStore(h.dir, first.sessionId, []); await store.open();
    store.data.queries.push({ ...source, queryId: 'q_reuse' });
    for (let i = 0; i < 31; i++) store.data.queries.push({ ...source, queryId: `q_new${i}`, kind: 'get_eth_balance', range: { blockNumber: 4 } });
    await store.save();
    const saved = JSON.parse(await readFile(join(store.directory, 'session.json'), 'utf8'));
    assert.ok(saved.queries.length <= 32); assert.ok(saved.queries.some((q: any) => q.queryId === 'q_new30'));
    assert.ok(saved.queries.some((q: any) => q.queryId === source.queryId));
    assert.ok(saved.queries.some((q: any) => q.queryId === 'q_reuse'));
    for (const q of saved.queries) if (q.range.timeWindow) assert.ok(saved.queries.some((s: any) => s.queryId === q.range.timeWindow.sourceQueryId));
  } finally { await h.close(); }
});
test('historical evidence for a different date cannot satisfy a new date window', async () => {
  const h = await harness();
  try {
    const first = await h.run(); const old = first.queries[0]!;
    const result = await h.run({ sessionId: first.sessionId, input: `用上次证据 ${old.queryId} 回答 ${address} 2026-11-01的交易`,
      request: async () => ({ content: JSON.stringify({ kind: 'answer', queryIds: [old.queryId], claims: [{ queryId: old.queryId, field: 'count' }] }) }) });
    assert.notEqual(result.status, 'completed'); assert.ok(!result.queries.some(q => q.queryId === old.queryId));
  } finally { await h.close(); }
});

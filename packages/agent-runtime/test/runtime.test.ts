import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@ledgerscout/chain-data';
import type { ModelRequest, RequestModel } from '../src/types.js';
const address = '0x' + '1'.repeat(40);
const config = parseConfig({ ALCHEMY_API_KEY: 'offline-chain-key', ETHERSCAN_API_KEY: 'offline-explorer-key', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' });
const toolCall = (name = 'get_eth_balance', args: Record<string, unknown> = { address }) => ({ content: '', toolCalls: [{ id: `call-${Math.random()}`, name, arguments: args }] });
function draft(request: ModelRequest, field = 'eth') {
  const last = request.messages.filter(m => m.role === 'tool').at(-1)!;
  const q = JSON.parse(last.content);
  return { content: JSON.stringify({ kind: 'answer', queryIds: [q.queryId], claims: [{ queryId: q.queryId, field }] }) };
}
async function setup() {
  const { runAgent } = await import('../src/runtime.js');
  const dir = await mkdtemp(join(tmpdir(), 'ledger-runtime-')); const calls: any[] = [];
  const fetcher = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')); calls.push(body);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x1' : body.method === 'eth_blockNumber' ? '0xa' : '0xde0b6b3a7640001' });
  }) as typeof fetch;
  const run = (request: RequestModel, extra: Record<string, any> = {}) => runAgent({ input: `查 ${address} 的 ETH 余额`, config,
    outputDirectory: dir, request, fetch: fetcher, ...extra });
  return { run, dir, calls, close: () => rm(dir, { recursive: true, force: true }) };
}

test('runtime uses real Pi loop and query evidence for exact final facts', async () => {
  const h = await setup(); let turns = 0;
  try {
    const result = await h.run(async r => ++turns === 1 ? toolCall() : draft(r));
    assert.equal(result.status, 'completed'); assert.match(result.answer, /1\.000000000000000001 ETH/);
    assert.match(result.answer, /区块.*10/); assert.match(result.answer, /q_/);
    assert.equal(result.counts.models, 2); assert.equal(result.counts.http, 3);
    const events = (await readFile(join(result.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(events.filter(e => e.type === 'run_finished').length, 1);
    assert.ok(events.some(e => e.type === 'model_response' && e.usage === null));
  } finally { await h.close(); }
});

test('unknown evidence gets one repair then deterministic facts without invented value', async () => {
  const h = await setup(); let turns = 0;
  try {
    const result = await h.run(async () => ++turns === 1 ? toolCall() : { content: JSON.stringify({ kind: 'answer', queryIds: ['unknown'], claims: [], message: '余额是999999 ETH' }) });
    assert.equal(turns, 3); assert.match(result.answer, /1\.000000000000000001/); assert.ok(!result.answer.includes('999999'));
  } finally { await h.close(); }
});

test('repeated successful calls reuse evidence instead of issuing more upstream requests', async () => {
  const h = await setup(); let turns = 0;
  try {
    const result = await h.run(async r => ++turns < 4 ? toolCall() : draft(r));
    assert.equal(result.status, 'completed'); assert.equal(result.counts.tools, 3);
    assert.equal(h.calls.filter(c => c.method === 'eth_getBalance').length, 1);
  } finally { await h.close(); }
});

test('a tool storm is bounded even when every requested name is unknown', async () => {
  const h = await setup();
  try {
    const result = await h.run(async () => ({ content: '', toolCalls: Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: 'send_transaction', arguments: {} })) }), { limits: { maxToolCalls: 3 } });
    assert.equal(result.status, 'exhausted'); assert.equal(result.counts.tools, 3); assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('HTTP request budget blocks the next actual attempt', async () => {
  const h = await setup();
  try {
    const result = await h.run(async () => toolCall(), { limits: { maxHttpRequests: 1 } });
    assert.equal(result.status, 'exhausted'); assert.equal(h.calls.length, 1); assert.equal(result.counts.http, 1);
  } finally { await h.close(); }
});

test('model request budget and uncooperative provider timeout always settle', async () => {
  const h = await setup();
  try {
    const empty = await h.run(async () => ({ content: '' }), { limits: { maxModelRequests: 2 } });
    assert.equal(empty.counts.models, 2); assert.equal(empty.status, 'exhausted');
    const stuck = await h.run(async () => new Promise(() => {}), { limits: { runTimeoutMs: 20, modelTimeoutMs: 100 } });
    assert.equal(stuck.status, 'exhausted');
  } finally { await h.close(); }
});

test('user cancellation records one cancelled terminal state', async () => {
  const h = await setup(); const ctl = new AbortController();
  try {
    const result = await h.run(async () => { ctl.abort(new Error('cancelled')); return new Promise(() => {}); }, { signal: ctl.signal });
    assert.equal(result.status, 'cancelled'); assert.equal(h.calls.length, 0);
    const events = await readFile(join(result.directory, 'events.jsonl'), 'utf8');
    assert.equal(events.split('"type":"run_finished"').length - 1, 1);
  } finally { await h.close(); }
});

test('missing addresses and unsupported date windows are clarified without model or data calls', async () => {
  const h = await setup();
  try {
    for (const input of ['查一下余额', '查 vitalik.eth', `查 ${address} 最近半年的转账`, `查 ${address} 2026-02-29 的转账`]) {
      const r = await h.run(async () => { throw new Error('must not call'); }, { input });
      assert.equal(r.status, 'awaiting_user'); assert.equal(r.counts.models, 0);
    }
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('model cannot query an address that user did not supply', async () => {
  const h = await setup(); let turns = 0;
  try {
    const result = await h.run(async () => ++turns === 1 ? toolCall('get_eth_balance', { address: '0x' + '2'.repeat(40) }) : { content: JSON.stringify({ kind: 'clarification', message: '请提供目标地址' }) });
    assert.equal(h.calls.length, 0); assert.equal(result.status, 'awaiting_user');
  } finally { await h.close(); }
});

test('reopened sessions retain address while new sessions stay empty and path IDs are rejected', async () => {
  const h = await setup(); let turn = 0;
  try {
    const first = await h.run(async r => ++turn === 1 ? toolCall() : draft(r));
    const resumed = await h.run(async () => ({ content: JSON.stringify({ kind: 'clarification', message: '请指定区块范围' }) }), { input: '再查它的交易', sessionId: first.sessionId });
    assert.equal(resumed.counts.models, 1);
    const fresh = await h.run(async () => { throw new Error('must not call'); }, { input: '再查它的交易' });
    assert.equal(fresh.status, 'awaiting_user'); assert.equal(fresh.counts.models, 0);
    await assert.rejects(h.run(async () => ({ content: '' }), { sessionId: '../escape' }), /session/i);
  } finally { await h.close(); }
});

test('storage failure never creates a successful result', async () => {
  const h = await setup();
  try {
    const path = join(h.dir, 'not-a-directory'); await writeFile(path, 'x');
    const r = await h.run(async () => ({ content: '' }), { outputDirectory: path });
    assert.equal(r.status, 'failed'); assert.match(r.error ?? '', /write|storage|persist/i);
  } finally { await h.close(); }
});

test('context overflow fails safely without dropping the current user input', async () => {
  const h = await setup();
  try {
    const r = await h.run(async () => { throw new Error('must not call'); }, { input: `${address} ` + '长'.repeat(20000) });
    assert.equal(r.status, 'failed'); assert.match(r.answer, /上下文|输入/);
  } finally { await h.close(); }
});

test('partial history stays partial regardless of final wording', async () => {
  const h = await setup(); let turns = 0;
  const hash = '0x' + 'a'.repeat(64);
  try {
    const result = await h.run(async r => ++turns === 1 ? toolCall('list_normal_transactions', { address, pageSize: 2, maxRecords: 1 }) : draft(r, 'count'), {
      fetch: (async (_input: unknown, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body ?? '{}'));
        if (b.method) return Response.json({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_chainId' ? '0x1' : '0xa' });
        return Response.json({ status: '1', message: 'OK', result: [0, 1].map(i => ({ hash: i ? '0x'+'b'.repeat(64) : hash,
          blockNumber: '10', timeStamp: '1', from: address, to: address, value: '1', isError: '0' })) });
      }) as typeof fetch,
    });
    assert.equal(result.status, 'partial'); assert.match(result.answer, /部分历史/); assert.equal(result.queries[0]?.data.count, 1);
  } finally { await h.close(); }
});

test('third identical failed query is blocked before another provider request', async () => {
  const h = await setup(); let turns = 0; let calls = 0;
  try {
    const result = await h.run(async () => ++turns <= 3 ? toolCall() : { content: JSON.stringify({ kind: 'clarification', message: '请检查服务权限' }) }, {
      fetch: (async () => { calls++; return new Response('denied', { status: 403 }); }) as typeof fetch,
    });
    assert.equal(calls, 2); assert.equal(result.counts.tools, 3);
    assert.equal(result.queries.length, 2); assert.ok(result.queries.every(q => q.status === 'error'));
  } finally { await h.close(); }
});

test('temporary model retry consumes the same hard request budget', async () => {
  const h = await setup(); let turns = 0;
  try {
    const result = await h.run(async r => {
      turns++;
      if (turns === 1) throw Object.assign(new Error('temporary rate limit'), { retryable: true });
      return turns === 2 ? toolCall() : draft(r);
    }, { limits: { maxModelRequests: 3, retryDelayMs: 1 } });
    assert.equal(result.status, 'completed'); assert.equal(result.counts.models, 3); assert.equal(turns, 3);
  } finally { await h.close(); }
});

test('reopening a session marks orphaned runs interrupted without replay', async () => {
  const h = await setup(); let turns = 0;
  try {
    const first = await h.run(async r => ++turns === 1 ? toolCall() : draft(r));
    const { mkdir } = await import('node:fs/promises');
    const orphan = join(h.dir, first.sessionId, 'r_orphan'); await mkdir(orphan);
    const result = await h.run(async () => ({ content: JSON.stringify({ kind: 'clarification', message: '请给出区块窗口' }) }), { input: '查询交易', sessionId: first.sessionId });
    assert.ok(result.warnings.some(x => x.includes('中断')));
    const marker = JSON.parse(await readFile(join(orphan, 'interrupted.json'), 'utf8'));
    assert.equal(marker.status, 'interrupted'); assert.equal(marker.resumed, false);
    assert.equal(h.calls.length, 3);
  } finally { await h.close(); }
});

test('invalid replacement addresses never fall back to an old session target', async () => {
  const h = await setup(); let turns = 0;
  try {
    const first = await h.run(async r => ++turns === 1 ? toolCall() : draft(r));
    for (const input of ['查 0x123 的余额', '换成 vitalik.eth 查询余额']) {
      const result = await h.run(async () => { throw new Error('must not call'); }, { input, sessionId: first.sessionId });
      assert.equal(result.status, 'awaiting_user'); assert.equal(result.counts.models, 0);
    }
  } finally { await h.close(); }
});

test('cancelling after a first page preserves normalized partial data before finalizing', async () => {
  const h = await setup(); const ctl = new AbortController(); let page = 0;
  const hash = '0x' + 'a'.repeat(64);
  try {
    const result = await h.run(async () => toolCall('list_normal_transactions', { address, pageSize: 1 }), {
      signal: ctl.signal,
      fetch: (async (_input: unknown, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body ?? '{}'));
        if (b.method) return Response.json({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_chainId' ? '0x1' : '0xa' });
        if (++page === 2) { ctl.abort(new Error('cancelled')); return new Promise(() => {}); }
        return Response.json({ status: '1', message: 'OK', result: [{ hash, blockNumber: '10', timeStamp: '1', from: address, to: address, value: '1', isError: '0' }] });
      }) as typeof fetch,
    });
    assert.equal(result.status, 'cancelled'); assert.equal(result.queries[0]?.data.count, 1);
    assert.match(result.answer, /部分历史/);
    const persisted = JSON.parse(await readFile(join(result.directory, 'run-summary.json'), 'utf8'));
    assert.equal(persisted.queries[0].data.count, 1);
  } finally { await h.close(); }
});

test('old evidence cannot complete a changed address or a request for fresh data', async () => {
  const h = await setup(); let turns = 0;
  try {
    const first = await h.run(async r => ++turns === 1 ? toolCall() : draft(r));
    const q = first.queries[0]!;
    for (const input of [`改查 0x${'2'.repeat(40)} 当前余额`, '重新查询当前余额', `查 ${address} 区块20到30的交易`]) {
      const result = await h.run(async () => ({ content: JSON.stringify({ kind: 'answer', queryIds: [q.queryId], claims: [{ queryId: q.queryId, field: 'eth' }] }) }), { sessionId: first.sessionId, input });
      assert.notEqual(result.status, 'completed'); assert.ok(!result.answer.includes('1.000000000000000001 ETH'));
    }
  } finally { await h.close(); }
});

test('explicit historical evidence remains usable without claiming a new chain query', async () => {
  const h = await setup(); let turns = 0;
  try {
    const first = await h.run(async r => ++turns === 1 ? toolCall() : draft(r));
    const q = first.queries[0]!;
    const result = await h.run(async () => ({ content: JSON.stringify({ kind: 'answer', queryIds: [q.queryId], claims: [{ queryId: q.queryId, field: 'eth' }] }) }), { sessionId: first.sessionId, input: `查看上次证据 ${q.queryId} 的余额` });
    assert.equal(result.status, 'completed'); assert.equal(result.counts.http, 0); assert.match(result.answer, /1\.000000000000000001/);
  } finally { await h.close(); }
});

test('summary commit failure leaves one failed terminal and no successful session turn', async () => {
  const h = await setup(); let turns = 0;
  try {
    const fs = await import('node:fs');
    const result = await h.run(async r => ++turns === 1 ? toolCall() : draft(r), {
      onEvent: (e: any) => {
        if (e.type !== 'query_finished') return;
        const session = fs.readdirSync(h.dir)[0]!;
        const run = fs.readdirSync(join(h.dir, session)).find(x => x.startsWith('r_'))!;
        fs.mkdirSync(join(h.dir, session, run, 'run-summary.json'));
      },
    });
    assert.equal(result.status, 'failed');
    const terminal = (await readFile(join(result.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'run_finished');
    assert.equal(terminal.length, 1); assert.equal(terminal[0].status, 'failed');
    let session: any;
    try { session = JSON.parse(await readFile(join(h.dir, result.sessionId, 'session.json'), 'utf8')); }
    catch (e) { assert.equal((e as NodeJS.ErrnoException).code, 'ENOENT'); }
    assert.equal(session?.turns?.length ?? 0, 0);
  } finally { await h.close(); }
});

test('session index write failure also corrects the authoritative run status', async () => {
  const h = await setup(); let turns = 0;
  try {
    const fs = await import('node:fs');
    const result = await h.run(async r => ++turns === 1 ? toolCall() : draft(r), {
      onEvent: (e: any) => {
        if (e.type === 'query_finished') fs.mkdirSync(join(h.dir, fs.readdirSync(h.dir)[0]!, 'session.json'));
      },
    });
    assert.equal(result.status, 'failed');
    const manifest = JSON.parse(await readFile(join(result.directory, 'run-summary.json'), 'utf8'));
    assert.equal(manifest.status, 'failed');
    const terminal = (await readFile(join(result.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'run_finished');
    assert.equal(terminal.length, 1); assert.equal(terminal[0].status, 'failed');
  } finally { await h.close(); }
});

test('provider usage aggregates retries and leaves unreported attempts unknown', async () => {
  const h = await setup(); let turn = 0;
  try {
    const result = await h.run(async r => {
      if (++turn === 1) throw Object.assign(new Error('temporary'), { retryable: true });
      return { ...(turn === 2 ? toolCall() : draft(r)), usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
    }, { limits: { retryDelayMs: 1 } });
    assert.deepEqual(result.tokenUsage, { source: 'provider', inputTokens: 200, outputTokens: 40, totalTokens: 240, reportedRequests: 2, unknownRequests: 1 });
  } finally { await h.close(); }
});

async function seedHistory(h: Awaited<ReturnType<typeof setup>>) {
  const first = await h.run(async () => ({ content: JSON.stringify({ kind: 'clarification', message: '请提供区块' }) }));
  const path = join(h.dir, first.sessionId, 'session.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.turns = Array.from({ length: 6 }, (_, i) => ({ user: `旧问题${i} ` + 'x'.repeat(750), assistant: `旧回答${i} ` + 'y'.repeat(750) }));
  await writeFile(path, JSON.stringify(data));
  return { sessionId: first.sessionId, path };
}

test('large history is summarized once, keeps recent turns, and persists across reopening', async () => {
  const h = await setup(); let turn = 0;
  try {
    const seed = await seedHistory(h);
    const result = await h.run(async r => {
      if (++turn === 1) {
        assert.equal(r.tools.length, 0); assert.equal(r.finalOnly, true);
        assert.ok(r.messages.some(m => m.content.includes('旧问题0')));
        assert.ok(!r.messages.some(m => m.content.includes('旧问题5')));
        return { content: JSON.stringify({ summary: '待继续研究余额变化，区块范围未定。' }), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      }
      assert.ok(r.messages.some(m => m.role === 'assistant' && m.content.includes('区块范围未定')));
      assert.ok(r.messages.some(m => m.content.includes('旧问题5')));
      return { content: JSON.stringify({ kind: 'clarification', message: '请提供区块范围' }) };
    }, { sessionId: seed.sessionId });
    assert.equal(result.status, 'awaiting_user'); assert.equal(result.counts.models, 2);
    assert.equal(result.tokenUsage.reportedRequests, 1); assert.equal(result.tokenUsage.unknownRequests, 1);
    const stored = JSON.parse(await readFile(seed.path, 'utf8'));
    assert.match(stored.summary, /区块范围未定/); assert.equal(stored.turns.length, 3);
    const reopened = await h.run(async r => {
      assert.ok(r.messages.some(m => m.content.includes('区块范围未定')));
      if (r.finalOnly) return { content: JSON.stringify({ summary: '待继续研究余额变化，区块范围未定。' }) };
      return { content: JSON.stringify({ kind: 'clarification', message: '仍需范围' }) };
    }, { sessionId: seed.sessionId, input: '继续' });
    assert.equal(reopened.status, 'awaiting_user'); assert.ok(reopened.counts.models <= 2);
  } finally { await h.close(); }
});

test('malformed summary falls back without poisoning stored summary or exhausting task budget', async () => {
  const h = await setup(); let turn = 0;
  try {
    const seed = await seedHistory(h);
    const result = await h.run(async () => ({ content: ++turn === 1 ? '{bad summary' : JSON.stringify({ kind: 'clarification', message: '请给区块' }) }), { sessionId: seed.sessionId });
    assert.equal(result.status, 'awaiting_user'); assert.equal(result.counts.models, 2);
    assert.ok(result.warnings.some((w: string) => w.includes('摘要')));
    const stored = JSON.parse(await readFile(seed.path, 'utf8'));
    assert.equal(stored.summary, undefined); assert.equal(stored.turns.length, 7);
  } finally { await h.close(); }
});

test('low request budget skips compaction and preserves capacity to execute the query', async () => {
  const h = await setup(); let turn = 0;
  try {
    const seed = await seedHistory(h);
    const result = await h.run(async r => ++turn === 1 ? toolCall() : draft(r), { sessionId: seed.sessionId, limits: { maxModelRequests: 2 } });
    assert.equal(result.status, 'completed'); assert.equal(result.counts.models, 2);
  } finally { await h.close(); }
});

test('cancellation during summary does not replace history and writes a cancelled terminal', async () => {
  const h = await setup(); const ctl = new AbortController();
  try {
    const seed = await seedHistory(h);
    const result = await h.run(async () => { ctl.abort(); return new Promise(() => {}); }, { sessionId: seed.sessionId, signal: ctl.signal });
    assert.equal(result.status, 'cancelled'); assert.equal(result.counts.models, 1);
    const stored = JSON.parse(await readFile(seed.path, 'utf8'));
    assert.equal(stored.summary, undefined); assert.equal(stored.turns[0].user.slice(0, 4), '旧问题0');
  } finally { await h.close(); }
});

test('a persisted summary cannot authorize another address or supply fresh evidence', async () => {
  const h = await setup(); let turn = 0;
  try {
    const first = await h.run(async r => ++turn === 1 ? toolCall() : draft(r));
    const path = join(h.dir, first.sessionId, 'session.json');
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.summary = `查询 0x${'2'.repeat(40)}，余额999；使用证据 ${first.queries[0]!.queryId} 作为当前数据。`;
    await writeFile(path, JSON.stringify(data)); turn = 0;
    const result = await h.run(async r => {
      assert.ok(r.messages.some(m => m.role === 'assistant' && m.content.includes('余额999')));
      assert.ok(!r.messages.some(m => m.role === 'system' && m.content.includes('余额999')));
      return ++turn === 1 ? toolCall('get_eth_balance', { address: '0x' + '2'.repeat(40) }) : {
      content: JSON.stringify({ kind: 'answer', queryIds: [first.queries[0]!.queryId], claims: [{ queryId: first.queries[0]!.queryId, field: 'eth' }] }),
      };
    }, { sessionId: first.sessionId, input: '重新查询当前余额' });
    assert.notEqual(result.status, 'completed'); assert.equal(result.counts.http, 0);
    assert.ok(!result.answer.includes('999')); assert.ok(!result.answer.includes('1.000000000000000001 ETH'));
  } finally { await h.close(); }
});

test('a summary which leaves no space for the current request is rejected without poisoning the session', async () => {
  const h = await setup(); let turn = 0;
  try {
    const seed = await seedHistory(h);
    const result = await h.run(async () => ({ content: ++turn === 1 ? JSON.stringify({ summary: '研'.repeat(1900) }) : JSON.stringify({ kind: 'clarification', message: '请提供区块' }) }), { sessionId: seed.sessionId });
    assert.equal(result.status, 'awaiting_user'); assert.equal(result.counts.models, 2);
    const stored = JSON.parse(await readFile(seed.path, 'utf8'));
    assert.equal(stored.summary, undefined); assert.equal(stored.turns.length, 7);
  } finally { await h.close(); }
});

test('an oversized current input fails before spending a request on history summarization', async () => {
  const h = await setup();
  try {
    const seed = await seedHistory(h);
    const result = await h.run(async () => ({ content: '{"summary":"原研究意图"}' }), { sessionId: seed.sessionId, input: address + '长'.repeat(20000) });
    assert.equal(result.status, 'failed'); assert.equal(result.counts.models, 0);
  } finally { await h.close(); }
});

test('an oversized persisted summary is omitted with a warning so future turns remain usable', async () => {
  const h = await setup();
  try {
    const first = await h.run(async () => ({ content: '{"kind":"clarification","message":"请给区块"}' }));
    const path = join(h.dir, first.sessionId, 'session.json');
    const data = JSON.parse(await readFile(path, 'utf8')); data.summary = '研'.repeat(2000);
    await writeFile(path, JSON.stringify(data));
    const result = await h.run(async r => {
      assert.ok(!r.messages.some(m => m.content.includes('研'.repeat(2000))));
      return { content: '{"kind":"clarification","message":"请给区块"}' };
    }, { sessionId: first.sessionId });
    assert.equal(result.status, 'awaiting_user'); assert.equal(result.counts.models, 1);
    assert.ok(result.warnings.some((w: string) => w.includes('摘要')));
    assert.equal(JSON.parse(await readFile(path, 'utf8')).summary.length, 2000);
  } finally { await h.close(); }
});

test('summary timeout falls back once and shares the three-request task budget', async () => {
  const h = await setup(); let turn = 0;
  try {
    const seed = await seedHistory(h);
    const result = await h.run(async r => {
      if (++turn === 1) return new Promise(() => {});
      return turn === 2 ? toolCall() : draft(r);
    }, { sessionId: seed.sessionId, limits: { maxModelRequests: 3, modelTimeoutMs: 100 } });
    assert.equal(result.status, 'completed'); assert.equal(result.counts.models, 3);
    assert.equal(result.counts.tools, 1); assert.ok(result.warnings.some((w: string) => w.includes('摘要')));
    assert.equal(result.tokenUsage.unknownRequests, 3);
  } finally { await h.close(); }
});

test('runtime uses local prompt counts for compaction decisions and records provenance', async () => {
  const h = await setup();
  try {
    const seed = await seedHistory(h);
    const result = await h.run(async r => {
      assert.ok(r.tools.length > 0); assert.ok(r.messages.some(m => m.content.includes('旧问题0')));
      return { content: '{"kind":"clarification","message":"请给区块"}' };
    }, { sessionId: seed.sessionId, counter: async () => ({ tokens: 100, method: 'local_tokenizer', encoding: 'v41', revision: 'fixture' }) });
    assert.equal(result.status, 'awaiting_user'); assert.equal(result.counts.models, 1);
    const events = (await readFile(join(result.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const prepared = events.find(e => e.type === 'context_prepared');
    assert.equal(prepared.method, 'local_tokenizer'); assert.equal(prepared.tokens, 100); assert.equal(prepared.encoding, 'v41');
    assert.equal(prepared.revision, 'fixture');
  } finally { await h.close(); }
});

test('tokenizer fallback is recorded even when preflight rejects the estimated context', async () => {
  const h = await setup();
  try {
    const result = await h.run(async () => { throw new Error('must not call'); }, {
      counter: async () => { throw new Error('unavailable'); }, limits: { maxContextTokens: 3000 },
    });
    assert.equal(result.status, 'failed'); assert.equal(result.counts.models, 0);
    assert.ok(result.warnings.some((w: string) => w.includes('本地Token')));
    const events = await readFile(join(result.directory, 'events.jsonl'), 'utf8');
    assert.ok(events.includes('tokenizer_fallback'));
  } finally { await h.close(); }
});

test('real offline tokenizer participates in the Pi query loop without provider calls', { skip: process.env.LEDGERSCOUT_TEST_TOKENIZER !== '1' }, async () => {
  const { createLocalTokenCounter } = await import('../src/tokenizer.js');
  const h = await setup(); const counter = createLocalTokenCounter({ model: 'deepseek-flash' }); let turn = 0;
  try {
    const result = await h.run(async r => ++turn === 1 ? toolCall() : draft(r), { counter: counter.count });
    assert.equal(result.status, 'completed'); assert.equal(result.counts.models, 2);
    const events = (await readFile(join(result.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const prepared = events.filter(e => e.type === 'context_prepared');
    assert.equal(prepared.length, 2); assert.ok(prepared.every(e => e.method === 'local_tokenizer'));
    assert.equal(result.tokenUsage.unknownRequests, 2);
  } finally { counter.close(); await h.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@ledgerscout/chain-data';
import { flowQuery, row, owner, peer } from '../../chain-data/test/fixtures/flows.js';
import { parseAnswer, renderAnswer } from '../src/answer.js';
import { runAgent } from '../src/runtime.js';
import type { ModelRequest } from '../src/types.js';
const final = (queryId: string) => ({ content: JSON.stringify({ kind: 'answer', queryIds: [queryId],
  claims: [{ queryId, field: 'flow_summary' }, { queryId, field: 'counterparties' }] }) });
function id(r: ModelRequest): string { return JSON.parse(r.messages.find(m => m.role === 'tool')!.content).queryId; }
async function harness(partial = false, rich = false) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-flow-runtime-')); let http = 0; let models = 0;
  const config = parseConfig({ ALCHEMY_API_KEY: 'offline', ETHERSCAN_API_KEY: 'offline', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' });
  const request = async (r: ModelRequest) => {
    models++;
    if (!r.messages.some(m => m.role === 'tool')) return { content: '', toolCalls: [{ id: 'transfers', name: 'list_asset_transfers',
      arguments: { address: owner, ...(partial ? { pageSize: 1, maxRecords: 1 } : {}) } }] };
    if (!r.messages.some(m => m.role === 'tool' && m.name === 'analyze_asset_flows')) return { content: '', toolCalls: [
      { id: 'analysis', name: 'analyze_asset_flows', arguments: { queryId: id(r) } }] };
    return final(id(r));
  };
  const fetcher = (async (_input, init) => {
    http++; const b = JSON.parse(String(init?.body)); const incoming = b.params?.[0]?.toAddress === owner;
    const transfers = Array.from({ length: rich ? 5 : 1 }, (_, i) => ({
      uniqueId: (incoming ? 'in' : 'out') + i, hash: '0x' + 'a'.repeat(64), blockNum: '0xa',
      from: incoming ? rich ? '0x' + String(i + 2).repeat(40) : peer : owner, to: incoming ? owner : peer,
      category: rich ? 'erc20' : 'external', asset: rich ? 'TESTTOKEN' : 'ETH', value: incoming ? 2 : 3,
      rawContract: { value: incoming ? '0x1bc16d674ec80000' : '0x29a2241af62c0000', decimal: '0x12', address: rich ? '0x' + String(i + 2).repeat(40) : null },
    }));
    const value = b.method === 'eth_chainId' ? '0x1' : b.method === 'eth_blockNumber' ? '0xa' :
      { transfers, ...(partial ? { pageKey: incoming ? 'more-in' : 'more-out' } : {}) };
    return Response.json({ jsonrpc: '2.0', id: b.id, result: value });
  }) as typeof fetch;
  const run = (extra: Partial<Parameters<typeof runAgent>[0]> = {}) => runAgent({ input: `分析 ${owner} 的资金流和主要往来地址`, config,
    outputDirectory: dir, request, fetch: fetcher, ...extra });
  return { dir, run, calls: () => ({ http, models }), close: () => rm(dir, { recursive: true, force: true }) };
}
test('flow facts render exact source amounts, counterparties and evidence rather than model totals', () => {
  const q = flowQuery([row('in', { rawValue: '0x1bc16d674ec80000' })], [row('out', { from: owner, to: peer, rawValue: '0x29a2241af62c0000' })]);
  const draft = parseAnswer(final(q.queryId).content, [q]); const answer = renderAnswer(draft, [q]);
  assert.match(answer, /流入.*2/); assert.match(answer, /流出.*3/); assert.match(answer, /净流量.*-1/);
  assert.match(answer, /主要对手方/); assert.match(answer, new RegExp(peer)); assert.match(answer, /q_flow/);
  assert.throws(() => parseAnswer(JSON.stringify({ kind: 'answer', queryIds: [q.queryId], claims: [{ queryId: q.queryId, field: 'flow_summary', amount: 999 }] }), [q]));
});
test('unknown precision and partial history stay explicit in flow answers', () => {
  const q = flowQuery([row('unknown', { category: 'erc20', tokenAddress: '0x' + 'a'.repeat(40), decimalsHex: null })], [], false);
  const answer = renderAnswer(parseAnswer(final(q.queryId).content, [q]), [q]);
  assert.match(answer, /部分历史|已取得样本/); assert.match(answer, /精度.*缺失|精度.*missing/); assert.match(answer, /原始单位/);
});
test('Pi queries transfers then analyzes full evidence with no extra data requests', async () => {
  const h = await harness();
  try {
    const r = await h.run(); assert.equal(r.status, 'completed'); assert.equal(r.counts.tools, 2); assert.equal(r.counts.http, 4);
    assert.match(r.answer, /净流量.*-1/); assert.match(r.answer, /主要对手方/);
    assert.equal(r.queries[0]?.data.flowAnalysis.assets[0].netAmount, '-1');
  } finally { await h.close(); }
});
test('flow analysis cannot upgrade a page-limited source to complete', async () => {
  const h = await harness(true);
  try { const r = await h.run(); assert.equal(r.status, 'partial'); assert.match(r.answer, /部分历史|已取得样本/); }
  finally { await h.close(); }
});
test('analysis request repairs a count-only answer instead of claiming analysis was completed', async () => {
  const h = await harness(); let turn = 0;
  try {
    const r = await h.run({ request: async req => ++turn === 1 ? { content: '', toolCalls: [
      { id: 'transfers', name: 'list_asset_transfers', arguments: { address: owner } }] } :
      turn === 2 ? { content: JSON.stringify({ kind: 'answer', queryIds: [id(req)], claims: [{ queryId: id(req), field: 'incoming.count' }] }) } : final(id(req)) });
    assert.equal(turn, 3); assert.equal(r.status, 'completed'); assert.match(r.answer, /净流量/);
  } finally { await h.close(); }
});
test('analysis tool rejects unavailable query IDs without data access', async () => {
  const h = await harness(); let turn = 0; let denied = false;
  try {
    const r = await h.run({ request: async () => ++turn === 1 ? { content: '', toolCalls: [
      { id: 'bad', name: 'analyze_asset_flows', arguments: { queryId: 'q_other' } }] } :
      { content: JSON.stringify({ kind: 'clarification', message: '请先提供转账证据' }) },
      onEvent: e => { if (e.type === 'tool_finished' && e.isError) denied = true; } });
    assert.equal(denied, true); assert.equal(r.counts.http, 0); assert.equal(r.status, 'awaiting_user');
  } finally { await h.close(); }
});
test('cancelled analysis resumes using unchanged source hashes and cumulative budgets', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, onEvent: e => { if (e.type === 'tool_finished' && e.name === 'analyze_asset_flows') ctl.abort(); } });
    assert.equal(first.status, 'cancelled'); const q = first.queries[0]!;
    const path = join(first.directory, 'queries', q.queryId, 'query.json'); const before = await readFile(path, 'utf8');
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.counts.http, first.counts.http); assert.equal(resumed.counts.tools, first.counts.tools);
    assert.equal(await readFile(path, 'utf8'), before); assert.match(resumed.answer, /净流量.*-1/);
  } finally { await h.close(); }
});
test('multi-token analysis fits estimated context without raising runtime limits', async () => {
  const h = await harness(false, true);
  try {
    const r = await h.run({ input: `分析 ${owner} 的资金流和主要往来地址。研究背景：${'a'.repeat(1000)}` });
    assert.equal(r.status, 'completed'); assert.equal(r.counts.models, 3);
    assert.equal(r.queries[0]?.data.flowAnalysis.assets.length, 5);
  } finally { await h.close(); }
});
test('paged multi-token flow details do not accumulate oversized tool context', async () => {
  const h = await harness(false, true); let turn = 0;
  try {
    const r = await h.run({ input: `分析 ${owner} 的资金流和主要往来地址。研究背景：${'a'.repeat(1000)}`, request: async req => {
      turn++;
      if (turn === 1) return { content: '', toolCalls: [{ id: 'transfers', name: 'list_asset_transfers', arguments: { address: owner } }] };
      if (turn === 2) return { content: '', toolCalls: [{ id: 'analysis', name: 'analyze_asset_flows', arguments: { queryId: id(req) } }] };
      if (turn < 6) return { content: '', toolCalls: [{ id: `details${turn}`, name: 'read_query_evidence', arguments: { queryId: id(req), collection: 'flow_assets', offset: turn - 3, limit: 1 } }] };
      return final(id(req));
    } });
    assert.equal(r.status, 'completed', JSON.stringify({ error: r.error, counts: r.counts })); assert.equal(r.counts.http, 4); assert.equal(r.counts.models, 6);
  } finally { await h.close(); }
});
for (const wording of ['分析该地址按币种的流入、流出和净额', 'Analyze the net flow for this address', 'Show per-asset inflows and outflows']) {
  test(`flow intent requires actual analysis: ${wording}`, async () => {
    const h = await harness(); let turn = 0;
    try {
      const r = await h.run({ input: `${owner} ${wording}`, request: async req => ++turn === 1 ? { content: '', toolCalls: [
        { id: 'transfers', name: 'list_asset_transfers', arguments: { address: owner } }] } : turn === 2 ?
        { content: JSON.stringify({ kind: 'answer', queryIds: [id(req)], claims: [{ queryId: id(req), field: 'incoming.count' }] }) } : final(id(req)) });
      assert.equal(turn, 3); assert.match(r.answer, /净流量/);
    } finally { await h.close(); }
  });
}

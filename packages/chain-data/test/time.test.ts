import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueryService, parseConfig, type TimeWindow } from '../src/index.js';
const address = '0x' + '1'.repeat(40);
const timeWindow: TimeWindow = { startTimestamp: 100, endTimestamp: 199, referenceTimestamp: 250, timezone: 'Asia/Shanghai', clipped: false };
export async function timeHarness(change?: (url: URL, body: any, result: any) => any) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-date-')); const calls: { url: URL; body: any }[] = [];
  const config = parseConfig({ ALCHEMY_API_KEY: 'offline', ETHERSCAN_API_KEY: 'offline', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' });
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)); const body = JSON.parse(String(init?.body ?? '{}')); calls.push({ url, body });
    let result: any;
    if (body.method) {
      let value: any = body.method === 'eth_chainId' ? '0x1' : body.method === 'eth_blockNumber' ? '0x4' : '0x1';
      if (body.method === 'eth_getBlockByNumber') {
        const n = Number(BigInt(body.params[0])); const timestamp = [0, 90, 100, 199, 200][n]!;
        value = { number: body.params[0], timestamp: '0x' + timestamp.toString(16) };
      }
      if (body.method === 'alchemy_getAssetTransfers') value = { transfers: [] };
      result = { jsonrpc: '2.0', id: body.id, result: value };
    } else result = url.searchParams.get('action') === 'getblocknobytime' ?
      { status: '1', message: 'OK', result: url.searchParams.get('timestamp') === '99' ? '1' : '3' } : { status: '1', message: 'OK', result: [] };
    return Response.json(change ? change(url, body, result) : result);
  }) as typeof fetch;
  const service = createQueryService({ config, outputDirectory: dir, fetch: fetcher, timeWindow });
  const context = { sessionId: 's_test', runId: 'r_test', toolCallId: 'one' };
  return { dir, calls, config, fetcher, service, context, close: () => rm(dir, { recursive: true, force: true }) };
}
test('date mappings enforce inclusive boundaries and are shared across history tools', async () => {
  const h = await timeHarness();
  try {
    const q = await h.service.query('list_normal_transactions', { address }, h.context);
    assert.equal(q.status, 'ok'); assert.equal(q.range.startBlock, 2); assert.equal(q.range.endBlock, 3);
    assert.equal(q.range.timeWindow?.startTimestamp, 100); assert.equal(q.range.timeWindow?.sourceQueryId, q.queryId);
    const tx = h.calls.find(c => c.url.searchParams.get('action') === 'txlist')!;
    assert.equal(tx.url.searchParams.get('startblock'), '2'); assert.equal(tx.url.searchParams.get('endblock'), '3');
    const transfers = await h.service.query('list_asset_transfers', { address }, { ...h.context, toolCallId: 'two' });
    assert.equal(transfers.status, 'ok'); assert.equal(transfers.range.timeWindow?.sourceQueryId, q.queryId);
    assert.equal(h.calls.filter(c => c.url.searchParams.get('action') === 'getblocknobytime').length, 2);
    const data = h.calls.find(c => c.body.method === 'alchemy_getAssetTransfers')!.body.params[0];
    assert.equal(data.fromBlock, '0x2'); assert.equal(data.toBlock, '0x3');
  } finally { await h.close(); }
});
test('invalid boundary proof fails before reading history', async () => {
  const h = await timeHarness((_url, body, result) => body.method === 'eth_getBlockByNumber' && body.params[0] === '0x2' ?
    { ...result, result: { number: '0x2', timestamp: '0x63' } } : result);
  try {
    const q = await h.service.query('list_normal_transactions', { address }, h.context);
    assert.equal(q.status, 'error'); assert.equal(q.error?.code, 'PROVIDER_RESPONSE_INVALID');
    assert.ok(!h.calls.some(c => c.url.searchParams.get('action') === 'txlist'));
  } finally { await h.close(); }
});
test('provider mapping failure is recorded without broadening the date range', async () => {
  const h = await timeHarness((url, _body, result) => url.searchParams.get('action') === 'getblocknobytime' ?
    { status: '0', message: 'NOTOK', result: 'daily quota exhausted' } : result);
  try {
    const q = await h.service.query('list_normal_transactions', { address }, h.context);
    assert.equal(q.status, 'error'); assert.equal(q.error?.code, 'QUOTA_EXHAUSTED');
    assert.ok(!h.calls.some(c => c.url.searchParams.get('action') === 'txlist'));
  } finally { await h.close(); }
});
test('mapping HTTP attempts are budgeted and conflicts cannot widen the window', async () => {
  const h = await timeHarness(); let attempts = 0;
  try {
    const q = await h.service.query('list_normal_transactions', { address }, { ...h.context, beforeRequest: () => {
      if (++attempts > 3) throw new Error('HTTP request budget exhausted');
    } });
    assert.equal(q.error?.code, 'BUDGET_EXHAUSTED'); assert.equal(h.calls.length, 3);
    const conflict = await h.service.query('list_normal_transactions', { address, startBlock: 0 }, h.context);
    assert.equal(conflict.status, 'error'); assert.equal(conflict.error?.code, 'INVALID_ARGUMENT');
    assert.ok(!h.calls.some(c => c.url.searchParams.get('action') === 'txlist'));
  } finally { await h.close(); }
});
test('model previews omit boundary proof and bound records while retaining exact counts', async () => {
  const h = await timeHarness();
  try {
    const q = await h.service.query('list_normal_transactions', { address }, h.context);
    q.data.count = 3;
    q.data.transactions = Array.from({ length: 3 }, (_, i) => ({ hash: '0x' + String(i).repeat(64),
      from: address, to: address, valueWei: '1'.repeat(200), valueEth: '1'.repeat(200) }));
    const preview = h.service.preview(q);
    assert.equal(preview.data.count, 3); assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= 1800);
    assert.ok(q.range.timeWindow?.proof.length);
    assert.ok('timeWindow' in preview.range && !('proof' in preview.range.timeWindow));
    assert.equal(q.data.transactions.length, 3);
  } finally { await h.close(); }
});
test('a failed source evidence write cannot publish a reusable mapping', async () => {
  const h = await timeHarness(); let attempts = 0;
  try {
    await assert.rejects(h.service.query('list_normal_transactions', { address }, { ...h.context, beforeRequest: async () => {
      if (++attempts === 9) {
        const [id] = await readdir(h.dir); await mkdir(join(h.dir, id!, 'query.json'));
      }
    } }), /EVIDENCE_WRITE_FAILED/);
    const second = await h.service.query('list_normal_transactions', { address }, { ...h.context, toolCallId: 'retry' });
    assert.equal(second.status, 'ok'); assert.equal(second.range.timeWindow?.sourceQueryId, second.queryId);
    assert.equal(h.calls.filter(c => c.url.searchParams.get('action') === 'getblocknobytime').length, 4);
  } finally { await h.close(); }
});

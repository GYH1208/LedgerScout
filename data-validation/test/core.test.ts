import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfig } from '../src/config.js';
import { redact, Results } from '../src/output.js';
import { Transport } from '../src/http.js';
import { Api, formatWei } from '../src/api.js';
import { Checks } from '../src/checks.js';

const address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const hash = '0x' + 'a'.repeat(64);
const config = (extra: Record<string, string> = {}) => parseConfig({
  ALCHEMY_API_KEY: 'offline-alchemy-secret', ETHERSCAN_API_KEY: 'offline-etherscan-secret',
  REQUEST_INTERVAL_MS: '0', RETRY_BASE_MS: '1', RETRY_MAX_MS: '5', ...extra,
});
const transaction = { hash, blockNumber: '10', timeStamp: '1700000000', from: address,
  to: address, value: '1000000000000000001', isError: '0' };
const transfer = { hash, uniqueId: hash + ':external', blockNum: '0xa', from: address,
  to: address, category: 'external', value: 1, asset: 'ETH',
  rawContract: { value: '0xde0b6b3a7640000', decimal: '0x12', address: null } };
type Call = { url: URL; body: Record<string, any> };
function harness(handler: (call: Call, attempt: number) => unknown | Response, extra = {}) {
  const cfg = config(extra);
  const calls: Call[] = [];
  const records: unknown[] = [];
  const waits: number[] = [];
  const transport = new Transport(cfg, async record => { records.push(record); }, {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: new URL(String(input)), body: JSON.parse(String(init?.body ?? '{}')) };
      calls.push(call);
      const value = handler(call, calls.length);
      return value instanceof Response ? value : Response.json(value);
    }) as typeof fetch,
    sleep: async ms => { waits.push(ms); }, random: () => 0,
  });
  return { cfg, api: new Api(cfg, transport), calls, records, waits };
}
const rpc = (call: Call, result: unknown) => ({ jsonrpc: '2.0', id: call.body.id, result });

test('config validates unsafe addresses, numeric bounds and block ranges', () => {
  assert.equal(config().address, address);
  for (const extra of [{ TEST_ADDRESS: 'vitalik.eth' }, { MAX_RETRIES: '100' },
    { TX_PAGE_SIZE: '1.5' }, { START_BLOCK: '20', END_BLOCK: '10' }, { TEST_ADDRESS: '' }]) {
    assert.throws(() => config(extra));
  }
});
test('local env precedence is process > project > workspace without mutating process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chainpilot-env-'));
  try {
    const rootFile = join(dir, 'root.env'); const projectFile = join(dir, 'project.env');
    await writeFile(rootFile, 'ALCHEMY_API_KEY=root\nETHERSCAN_API_KEY=root\n');
    await writeFile(projectFile, 'ALCHEMY_API_KEY=project\n');
    const cfg = loadConfig({ ALCHEMY_API_KEY: 'process' }, [rootFile, projectFile]);
    assert.equal(cfg.alchemyKey, 'process'); assert.equal(cfg.etherscanKey, 'root');
  } finally { await rm(dir, { recursive: true }); }
});
test('redaction removes keys, encoded keys and credential fields from saved responses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chainpilot-output-'));
  const secret = 's/e+c?ret';
  try {
    const output = new Results(dir, [secret]);
    const file = await output.save('response', { apiKey: 'another', message: secret,
      url: 'https://eth-mainnet.g.alchemy.com/v2/' + encodeURIComponent(secret),
      query: '?apikey=' + encodeURIComponent(secret) });
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes(secret)); assert.ok(!text.includes(encodeURIComponent(secret)));
    assert.ok(!text.includes('another')); assert.match(text, /REDACTED/);
    assert.equal(redact('https://api.etherscan.io/v2/api?apikey=unknown', []),
      'https://api.etherscan.io/v2/api?apikey=[REDACTED]');
  } finally { await rm(dir, { recursive: true }); }
});
test('wei conversion preserves exact precision above Number limits', () => {
  assert.equal(formatWei('1000000000000000001'), '1.000000000000000001');
  assert.equal(formatWei('1'), '0.000000000000000001');
  assert.equal(formatWei('0'), '0');
});
test('connectivity rejects another chain and balance preserves wei', async () => {
  const h = harness(call => rpc(call, call.body.method === 'eth_chainId' ? '0x1' :
    call.body.method === 'eth_blockNumber' ? '0xa' : '0xde0b6b3a7640001'));
  const checks = new Checks(h.cfg, h.api);
  assert.equal((await checks.connectivity()).chainId, '1');
  assert.equal((await checks.balance()).eth, '1.000000000000000001');
  const wrong = harness(call => rpc(call, '0x89'));
  await assert.rejects(new Checks(wrong.cfg, wrong.api).connectivity(), /Mainnet/);
});
test('HTTP 429 and JSON-RPC rate limits retry, and every response is recorded', async () => {
  const h = harness((call, n) => n === 1 ? new Response('busy', { status: 429,
    headers: { 'Retry-After': '0' } }) : n === 2 ?
    { jsonrpc: '2.0', id: call.body.id, error: { code: 429, message: 'rate limit' } } : rpc(call, '0x1'));
  assert.equal(await h.api.rpc('eth_chainId', []), '0x1');
  assert.equal(h.records.length, 3); assert.equal(h.waits.length, 2);
});
test('retry bounds and Retry-After cap prevent unbounded attempts or sleeps', async () => {
  const h = harness(() => new Response('busy', { status: 429,
    headers: { 'Retry-After': '999999' } }), { MAX_RETRIES: '2' });
  await assert.rejects(h.api.rpc('eth_chainId', []), /HTTP 429/);
  assert.equal(h.calls.length, 3); assert.deepEqual(h.waits, [5, 5]);
});
test('authentication, malformed JSON, RPC IDs and invalid quantities fail without retry', async () => {
  for (const handler of [() => new Response('denied', { status: 401 }),
    () => new Response('<html>bad</html>'), () => ({ jsonrpc: '2.0', id: -1, result: '0x1' }),
    (call: Call) => rpc(call, 'garbage')]) {
    const h = harness(handler);
    await assert.rejects(new Checks(h.cfg, h.api).connectivity());
    assert.equal(h.calls.length, 1);
  }
});
test('timeout covers a stalled response body and reports a safe error', async () => {
  const cfg = config({ REQUEST_TIMEOUT_MS: '10', MAX_RETRIES: '0' });
  const records: unknown[] = [];
  const transport = new Transport(cfg, async r => { records.push(r); }, {
    fetch: (async (_input, init) => ({ ok: true, status: 200, headers: new Headers(),
      text: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort',
        () => reject(new Error('secret URL must not escape')))) })) as typeof fetch,
  });
  await assert.rejects(new Api(cfg, transport).rpc('eth_chainId', []), /timeout/i);
  assert.equal(records.length, 1);
});
test('Etherscan API rate limit retries; invalid key and fake empty success fail', async () => {
  const h = harness((_call, n) => n === 1 ? { status: '0', message: 'NOTOK', result: 'Max rate limit reached' } :
    { status: '0', message: 'No transactions found', result: [] });
  assert.deepEqual(await h.api.txPage(1, 10), []); assert.equal(h.calls.length, 2);
  for (const response of [{ status: '0', message: 'NOTOK', result: 'Invalid API Key' },
    { status: '0', message: 'NOTOK', result: [] }, { status: '1', message: 'OK', result: [{}] }]) {
    const bad = harness(() => response);
    await assert.rejects(bad.api.txPage(1, 10)); assert.equal(bad.calls.length, 1);
  }
});
test('transaction pagination uses fixed offset, frozen block and an honest limit summary', async () => {
  const h = harness(call => call.body.method ? rpc(call, '0xa') :
    { status: '1', message: 'OK', result: [
      { ...transaction, hash: '0x' + (call.url.searchParams.get('page') === '1' ? 'a' : 'c').repeat(64) },
      { ...transaction, hash: '0x' + (call.url.searchParams.get('page') === '1' ? 'b' : 'd').repeat(64) }] },
    { TX_PAGE_SIZE: '2', TX_LIMIT: '3', TX_MAX_PAGES: '3' });
  const result = await new Checks(h.cfg, h.api).transactions();
  assert.equal(result.count, 3); assert.equal(result.complete, false);
  assert.equal(result.stopReason, 'limit');
  const pages = h.calls.filter(c => !c.body.method);
  assert.deepEqual(pages.map(c => c.url.searchParams.get('page')), ['1', '2']);
  assert.deepEqual(pages.map(c => c.url.searchParams.get('offset')), ['2', '2']);
  assert.ok(pages.every(c => c.url.searchParams.get('chainid') === '1' && c.url.searchParams.get('endblock') === '10'));
});
test('transfer pagination follows pageKey separately for both directions and freezes the block', async () => {
  const h = harness(call => call.body.method === 'eth_blockNumber' ? rpc(call, '0xa') :
    rpc(call, { transfers: [{ ...transfer, uniqueId: hash + (call.body.params[0].pageKey ? ':second' : ':first') }],
      ...(call.body.params[0].pageKey ? {} : { pageKey: 'next-page' }) }),
    { TRANSFER_PAGE_SIZE: '1', TRANSFER_LIMIT: '5', TRANSFER_MAX_PAGES: '3' });
  const result = await new Checks(h.cfg, h.api).transfers();
  assert.equal(result.incoming.complete, true); assert.equal(result.outgoing.complete, true);
  assert.equal(result.incoming.count, 2); assert.equal(result.outgoing.count, 2);
  const calls = h.calls.filter(c => c.body.method === 'alchemy_getAssetTransfers');
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.deepEqual(call.body.params[0].category, ['external', 'internal', 'erc20']);
    assert.equal(call.body.params[0].toBlock, '0xa');
  }
  assert.equal(calls[0]?.body.params[0].toAddress, address);
  assert.equal(calls[1]?.body.params[0].pageKey, 'next-page');
  assert.equal(calls[2]?.body.params[0].fromAddress, address);
});
test('repeated transfer cursor fails instead of looping and malformed transfers fail validation', async () => {
  const h = harness(call => call.body.method === 'eth_blockNumber' ? rpc(call, '0xa') :
    rpc(call, { transfers: [transfer], pageKey: 'stuck' }));
  await assert.rejects(new Checks(h.cfg, h.api).transfers(), /pageKey/);
  const bad = harness(call => rpc(call, { transfers: [{}] }));
  await assert.rejects(bad.api.transferPage('incoming', 10));
});

test('raw response text is preserved, while JSON-escaped secrets are redacted', async () => {
  const h = harness(() => new Response('{ "jsonrpc": "2.0", "id": 1, "result": "0x1" }'));
  await h.api.rpc('eth_chainId', []);
  assert.equal((h.records[0] as { rawBody: string }).rawBody,
    '{ "jsonrpc": "2.0", "id": 1, "result": "0x1" }');
  const secret = 'secret"\\value';
  const encoded = JSON.stringify(secret).slice(1, -1);
  assert.equal(redact(encoded, [secret]), '[REDACTED]');
});

test('ETH internal transfers are included and normalized without being treated as ERC20', async () => {
  const h = harness(call => call.body.method === 'eth_blockNumber' ? rpc(call, '0xa') :
    rpc(call, { transfers: [{ ...transfer, category: 'internal', uniqueId: hash + ':internal' }] }));
  const result = await new Checks(h.cfg, h.api).transfers();
  assert.equal((result.incoming.byCategory as Record<string, number>).internal, 1);
  const query = h.calls.find(c => c.body.method === 'alchemy_getAssetTransfers');
  assert.ok(query?.body.params[0].category.includes('internal'));
});

test('daily quota exhaustion is not retried as a transient rate limit', async () => {
  const h = harness(() => ({ status: '0', message: 'NOTOK', result: 'Daily rate limit reached' }));
  await assert.rejects(h.api.txPage(1, 10));
  assert.equal(h.calls.length, 1);
});

test('transfer limits report replay of a partially consumed page and maxPages is explicit', async () => {
  const h = harness(call => call.body.method === 'eth_blockNumber' ? rpc(call, '0xa') :
    rpc(call, { transfers: [transfer, { ...transfer, uniqueId: hash + ':second' }], pageKey: 'next' }),
    { TRANSFER_PAGE_SIZE: '2', TRANSFER_LIMIT: '1' });
  const result = await new Checks(h.cfg, h.api).transfers();
  assert.equal(result.incoming.complete, false);
  assert.equal(result.incoming.replayCurrentPage, true);
  assert.equal(result.incoming.count, 1);
  const capped = harness(call => call.body.method === 'eth_blockNumber' ? rpc(call, '0xa') :
    rpc(call, { transfers: [transfer], pageKey: 'next' }), { TRANSFER_MAX_PAGES: '1' });
  const partial = await new Checks(capped.cfg, capped.api).transfers();
  assert.equal(partial.incoming.stopReason, 'maxPages');
  assert.equal(partial.incoming.nextPageKey, 'next');
});

test('repeated transaction pages fail and a short final page reports complete', async () => {
  const h = harness(call => call.body.method ? rpc(call, '0xa') :
    { status: '1', message: 'OK', result: [transaction] }, { TX_PAGE_SIZE: '1', TX_MAX_PAGES: '3' });
  await assert.rejects(new Checks(h.cfg, h.api).transactions(), /repeated transaction page/);
  const last = harness(call => call.body.method ? rpc(call, '0xa') :
    { status: '1', message: 'OK', result: [transaction] }, { TX_PAGE_SIZE: '2' });
  const result = await new Checks(last.cfg, last.api).transactions();
  assert.equal(result.complete, true); assert.equal(result.nextPage, null);
});

test('repeated transfer contents fail even when the server changes or removes pageKey', async () => {
  for (const finalCursor of ['changed-cursor', undefined]) {
    const h = harness(call => call.body.method === 'eth_blockNumber' ? rpc(call, '0xa') :
      rpc(call, { transfers: [transfer], ...(!call.body.params[0].pageKey ? { pageKey: 'first-cursor' } :
        finalCursor ? { pageKey: finalCursor } : {}) }));
    await assert.rejects(new Checks(h.cfg, h.api).transfers(), /repeated transfer page/);
  }
});

test('Unicode-escaped and mixed JSON credential strings cannot survive in saved raw bodies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chainpilot-unicode-'));
  const secret = 'test-Alchemy123';
  const escaped = secret.split('').map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const mixed = 'test-' + escaped.slice(5 * 6);
  try {
    const output = new Results(dir, [secret]);
    for (const variant of [escaped, mixed]) {
      const path = await output.save('raw', { rawBody: '{"echo":"' + variant + '"}' });
      const saved = JSON.parse(await readFile(path, 'utf8')) as { rawBody: string };
      const decoded = JSON.parse(saved.rawBody) as { echo: string };
      assert.equal(decoded.echo.includes(secret), false);
      assert.equal(decoded.echo, '[REDACTED]');
    }
  } finally { await rm(dir, { recursive: true }); }
});

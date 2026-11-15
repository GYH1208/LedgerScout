import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as chain from '../src/index.js';
const holder = '0x' + '1'.repeat(40), contract = '0x' + '2'.repeat(40);
const word = (hex: string) => '0x' + hex.padStart(64, '0');
async function harness(mode = 'ok', decimals = '6', balance = '20000000000001') {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-token-')); const calls: any[] = [];
  const service = chain.createQueryService({ outputDirectory: dir,
    config: chain.parseConfig({ ALCHEMY_API_KEY: 'offline', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' }),
    fetch: (async (_url, init) => {
      const q = JSON.parse(String(init?.body)); calls.push(q);
      if (q.method === 'eth_call' && q.params[0].data === '0x313ce567' && mode === 'revert')
        return Response.json({ jsonrpc: '2.0', id: q.id, error: { code: 3, message: 'execution reverted', data: '0x' } });
      const result = q.method === 'eth_chainId' ? (mode === 'chain' ? '0x89' : '0x1') : q.method === 'eth_blockNumber' ? '0xa' :
        q.params[0].data === '0x313ce567' ? (mode === 'bad-decimals' ? word('100') : word(decimals)) : mode === 'empty' ? '0x' : word(balance);
      return Response.json({ jsonrpc: '2.0', id: q.id, result });
    }) as typeof fetch });
  return { service, dir, calls, context: { sessionId: 's_test', runId: 'r_test', toolCallId: 'c1' }, close: () => rm(dir, { recursive: true, force: true }) };
}
test('ERC20 query requires an explicit contract and forbids unrelated arguments', () => {
  assert.equal(chain.isQueryKind('get_erc20_balance'), true);
  const input = chain.validateQuery('get_erc20_balance', { address: holder, contractAddress: contract, blockNumber: 3 });
  assert.equal((input as any).contractAddress, contract);
  for (const args of [{ address: holder }, { address: holder, contractAddress: 'USDT' },
    { address: holder, contractAddress: contract, startBlock: 0 }, { address: holder, contractAddress: contract, decimals: 18 }])
    assert.throws(() => chain.validateQuery('get_erc20_balance', args));
});
test('ERC20 fixed ABI whitelist rejects mutations, latest blocks and extra call fields', () => {
  const check = (chain as any).isTokenEthCall;
  assert.equal(typeof check, 'function');
  const call = { to: contract, data: '0x70a08231' + '0'.repeat(24) + holder.slice(2) };
  assert.equal(check([call, '0xa']), true); assert.equal(check([{ to: contract, data: '0x313ce567' }, '0x0']), true);
  for (const params of [[call, 'latest'], [call, '0x01'], [{ ...call, value: '0x0' }, '0xa'],
    [{ ...call, data: '0xa9059cbb' + '0'.repeat(128) }, '0xa'], [{ ...call, data: call.data + '00' }, '0xa'],
    [{ ...call, data: '0x70a08231' + 'f'.repeat(64) }, '0xa'], [call, '0xa', {}]]) assert.equal(check(params), false);
});
test('token amount uses full uint256 precision and validates decimals', () => {
  const format = (chain as any).formatTokenAmount, decode = (chain as any).decodeTokenWord;
  assert.equal(typeof format, 'function'); assert.equal(typeof decode, 'function');
  assert.equal(format('9007199254740993123456789', 6), '9007199254740993123.456789');
  assert.equal(format('0', 18), '0'); assert.equal(format('42', 0), '42');
  assert.equal(format('1', 255), '0.' + '0'.repeat(254) + '1');
  assert.equal(decode('0x' + 'f'.repeat(64)).toString(), '115792089237316195423570985008687907853269984665640564039457584007913129639935');
  for (const value of ['0x', '0x01', word('1') + '00', '-1', null]) assert.throws(() => decode(value));
  for (const n of [-1, 256, 1.5]) assert.throws(() => format('1', n));
});
test('fixed-block ERC20 balance persists exact amounts, holder, contract and raw evidence', async () => {
  const h = await harness();
  try {
    const q = await h.service.query('get_erc20_balance', { address: holder, contractAddress: contract, blockNumber: 7 }, h.context);
    assert.equal(q.status, 'ok'); assert.equal(q.address, holder); assert.equal((q as any).contractAddress, contract);
    assert.deepEqual(q.range, { blockNumber: 7 }); assert.equal(q.data.rawBalance, '9007199254740993');
    assert.equal(q.data.decimals, 6); assert.equal(q.data.amount, '9007199254.740993');
    assert.deepEqual(h.calls.slice(2).map(c => c.params), [
      [{ to: contract, data: '0x70a08231' + '0'.repeat(24) + holder.slice(2) }, '0x7'], [{ to: contract, data: '0x313ce567' }, '0x7']]);
    assert.equal(JSON.parse(await readFile(join(h.dir, q.queryId, 'query.json'), 'utf8')).data.rawBalance, '9007199254740993');
    assert.match(q.evidenceRefs[0]!.method, /balanceOf/); assert.match(q.evidenceRefs[0]!.method, /decimals/);
  } finally { await h.close(); }
});
for (const mode of ['revert', 'bad-decimals']) test(`metadata ${mode} preserves raw balance without inventing precision`, async () => {
  const h = await harness(mode);
  try {
    const q = await h.service.query('get_erc20_balance', { address: holder, contractAddress: contract }, h.context);
    assert.equal(q.status, 'partial'); assert.equal(q.completeness.complete, false);
    assert.equal(q.data.rawBalance, '9007199254740993'); assert.equal(q.data.decimals, null); assert.equal(q.data.amount, null);
    assert.ok(q.warnings.some(w => /精度|decimals/.test(w))); assert.ok(q.error);
  } finally { await h.close(); }
});
test('zero balance is valid; empty balance or wrong chain never becomes zero', async () => {
  for (const mode of ['ok', 'empty', 'chain']) {
    const h = await harness(mode, '0', '0');
    try {
      const q = await h.service.query('get_erc20_balance', { address: holder, contractAddress: contract }, h.context);
      assert.equal(q.status, mode === 'ok' ? 'ok' : 'error');
      if (mode === 'ok') { assert.equal(q.data.rawBalance, '0'); assert.equal(q.data.amount, '0'); }
      else assert.equal(q.data.rawBalance, undefined);
    } finally { await h.close(); }
  }
});
test('future block is rejected and HTTP budget bounds the metadata attempt', async () => {
  const h = await harness();
  try {
    const future = await h.service.query('get_erc20_balance', { address: holder, contractAddress: contract, blockNumber: 11 }, h.context);
    assert.equal(future.status, 'error'); assert.equal(h.calls.length, 2);
    let count = 0;
    const partial = await h.service.query('get_erc20_balance', { address: holder, contractAddress: contract }, {
      ...h.context, beforeRequest: () => { if (count === 1) throw new Error('HTTP request budget exhausted'); count++; } });
    assert.equal(partial.status, 'partial'); assert.equal(partial.error?.code, 'BUDGET_EXHAUSTED');
    assert.equal(partial.data.rawBalance, '9007199254740993'); assert.equal(count, 1);
  } finally { await h.close(); }
});
test('metadata evidence storage failure cannot be downgraded to optional decimals', async () => {
  const config = chain.parseConfig({ ALCHEMY_API_KEY: 'offline', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' });
  let records = 0;
  const transport = new chain.Transport(config, async () => { if (++records === 2) throw new Error('EVIDENCE_WRITE_FAILED: raw metadata evidence'); }, {
    fetch: (async (_url, init) => { const q = JSON.parse(String(init?.body)); return Response.json({ jsonrpc: '2.0', id: q.id, result: word('1') }); }) as typeof fetch });
  await assert.rejects(chain.readTokenBalance(new chain.Api(config, transport), holder, contract, 10), /EVIDENCE_WRITE_FAILED/);
});

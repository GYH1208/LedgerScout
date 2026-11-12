import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeEnsName, ensNamehash, encodeEnsCall, decodeEnsResult, EnsService, UNIVERSAL_RESOLVER } from '../src/ens.js';
import { Api } from '../src/api.js';
import { Transport } from '../src/http.js';
import { parseConfig } from '../src/config.js';
const address = '0x' + '1'.repeat(40); const resolver = '0x' + '2'.repeat(40);
const word = (n: number) => n.toString(16).padStart(64, '0');
export const ensResult = (a = address) => '0x' + word(64) + resolver.slice(2).padStart(64, '0') + word(32) + a.slice(2).padStart(64, '0');
test('ENS normalization uses ENSIP15 before namehash', () => {
  assert.equal(normalizeEnsName('ViTaLiK.ETH'), 'vitalik.eth');
  assert.equal(normalizeEnsName('RaFFY🚴‍♂️.eth'), 'raffy🚴‍♂.eth');
  assert.equal(ensNamehash('eth'), '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
  for (const name of ['a..eth', 'not-a-name.com', 'a\u0000.eth', 'eth', 'x'.repeat(256) + '.eth']) assert.throws(() => normalizeEnsName(name), /INVALID_ENS/);
});
test('universal resolver call has fixed selector and correct dynamic ABI layout', () => {
  const call = encodeEnsCall('vitalik.eth');
  assert.equal(call.slice(0, 10), '0x9061b923');
  assert.equal(call.slice(10, 74), word(64)); assert.equal(call.slice(74, 138), word(128));
  assert.ok(call.includes('07766974616c696b0365746800'));
  assert.ok(call.includes('3b3b57de' + ensNamehash('vitalik.eth').slice(2)));
});
test('ENS result requires exact ABI, nonzero resolver and nonzero ETH address', () => {
  assert.deepEqual(decodeEnsResult(ensResult()), { address, resolver });
  assert.equal(decodeEnsResult(ensResult('0x' + '0'.repeat(40))).address, null);
  for (const value of ['0x', ensResult().slice(0, -2), ensResult() + '00', '0x' + word(0) + ensResult().slice(66),
    ensResult().replace(resolver.slice(2).padStart(64, '0'), '0'.repeat(64))]) assert.throws(() => decodeEnsResult(value), /Response validation/);
});
test('eth_call cannot target arbitrary contracts or methods', async () => {
  let calls = 0; const cfg = parseConfig({ ALCHEMY_API_KEY: 'offline' });
  const api = new Api(cfg, new Transport(cfg, async () => {}, { fetch: (async () => { calls++; throw new Error('no'); }) as typeof fetch }));
  for (const params of [[{ to: address, data: encodeEnsCall('vitalik.eth') }, '0xa'],
    [{ to: UNIVERSAL_RESOLVER, data: '0x12345678' }, '0xa'],
    [{ to: UNIVERSAL_RESOLVER, data: encodeEnsCall('vitalik.eth') }, 'latest']]) await assert.rejects(api.rpc('eth_call', params));
  assert.equal(calls, 0);
});
test('resolution uses a fixed verified snapshot, shared budget and durable proof', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-ens-')); const methods: string[] = []; let reservations = 0;
  try {
    const service = new EnsService({ config: parseConfig({ ALCHEMY_API_KEY: 'offline', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' }),
      outputDirectory: dir, fetch: (async (_url, init) => {
        const b = JSON.parse(String(init?.body)); methods.push(b.method);
        if (b.method === 'eth_call') { assert.equal(b.params[0].to.toLowerCase(), UNIVERSAL_RESOLVER.toLowerCase()); assert.equal(b.params[1], '0xa'); }
        return Response.json({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_chainId' ? '0x1' : b.method === 'eth_blockNumber' ? '0xa' : ensResult() });
      }) as typeof fetch });
    const proof = await service.resolve('ViTaLiK.ETH', { sessionId: 's_test', runId: 'r_test', beforeRequest: () => { reservations++; } });
    assert.equal(proof.status, 'resolved'); assert.equal(proof.name, 'vitalik.eth'); assert.equal(proof.address, address);
    assert.equal(proof.blockNumber, 10); assert.equal(reservations, 3);
    const saved = JSON.parse(await readFile(join(dir, proof.resolutionId, 'resolution.json'), 'utf8'));
    assert.deepEqual(saved, proof); assert.deepEqual(methods, ['eth_chainId', 'eth_blockNumber', 'eth_call']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
for (const [data, status, code] of [['0x556f1830' + '0'.repeat(64), 'unsupported', 'ENS_OFFCHAIN_UNSUPPORTED'],
  ['0x77209fe8' + '0'.repeat(64), 'not_found', 'ENS_NOT_FOUND']] as const) {
  test(`resolver revert ${code} is explicit without gateway access`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-ens-revert-')); let calls = 0;
    try {
      const service = new EnsService({ config: parseConfig({ ALCHEMY_API_KEY: 'offline', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' }), outputDirectory: dir,
        initialSnapshot: 10, fetch: (async (url, init) => {
          calls++; assert.equal(new URL(String(url)).hostname, 'eth-mainnet.g.alchemy.com');
          const b = JSON.parse(String(init?.body));
          return Response.json({ jsonrpc: '2.0', id: b.id, error: { code: 3, message: 'execution reverted', data } });
        }) as typeof fetch });
      const proof = await service.resolve('missing.eth', { sessionId: 's_test', runId: 'r_test' });
      assert.equal(proof.status, status); assert.equal(proof.error?.code, code); assert.equal(calls, 1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFlows, previewFlows } from '../src/flows.js';
import { flowQuery, row, owner, peer, token } from './fixtures/flows.js';

test('ETH external and internal transfers use exact wei and signed net amounts', () => {
  const q = flowQuery([row('in', { rawValue: '0x1bc16d674ec80000' })],
    [row('out', { from: owner, to: peer, direction: 'outgoing', category: 'internal', rawValue: '0x29a2241af62c0000' })]);
  const report = analyzeFlows(q); const eth = report.assets[0]!;
  assert.equal(report.assets.length, 1); assert.equal(eth.incoming.amount, '2'); assert.equal(eth.outgoing.amount, '3');
  assert.equal(eth.netRaw, '-1000000000000000000'); assert.equal(eth.netAmount, '-1'); assert.equal(eth.amountsComplete, true);
  assert.deepEqual(eth.incoming.recordIds, ['in']); assert.equal(report.sourceQueryId, q.queryId);
  assert.equal(report.counterparties[0]?.transferCount, 2);
});
test('amounts above Number precision never use approximateValue', () => {
  const report = analyzeFlows(flowQuery([row('large', { category: 'erc20', tokenAddress: token, decimalsHex: '0x0', rawValue: '0x20000000000001' })]));
  assert.equal(report.assets[0]?.incoming.amount, '9007199254740993');
});
test('same symbols on different contracts stay separate and contract casing is normalized', () => {
  const report = analyzeFlows(flowQuery([
    row('a', { category: 'erc20', tokenAddress: token.toUpperCase().replace('0X', '0x'), asset: 'SAME', decimalsHex: '0x6', rawValue: '0xf4240' }),
    row('b', { category: 'erc20', tokenAddress: '0x' + 'b'.repeat(40), asset: 'SAME', decimalsHex: '0x12', rawValue: '0xde0b6b3a7640000' }),
  ]));
  assert.equal(report.assets.length, 2); assert.equal(report.assets[0]?.tokenAddress, token);
  assert.deepEqual(report.assets.map(a => a.incoming.amount), ['1', '1']);
});
test('duplicates and self transfers cannot inflate external flows or peer rankings', () => {
  const self = row('self', { from: owner, to: owner, rawValue: '0xde0b6b3a7640000' });
  const report = analyzeFlows(flowQuery([self, row('in'), row('in')], [{ ...self, direction: 'outgoing' }]));
  assert.deepEqual(report.counts, { incoming: 1, outgoing: 0, self: 1 });
  assert.equal(report.assets[0]?.self.amount, '1'); assert.equal(report.counterparties[0]?.transferCount, 1);
  assert.ok(!report.counterparties.some(p => p.address === owner));
});
test('conflicting duplicate IDs are excluded rather than arbitrarily choosing an amount', () => {
  const report = analyzeFlows(flowQuery([row('bad'), row('bad', { rawValue: '0x2' })]));
  assert.equal(report.assets.length, 0); assert.equal(report.excludedRecordIds.length, 1);
  assert.ok(report.issues.some(i => i.code === 'CONFLICTING_ID'));
});
test('missing raw amounts produce a labeled known subtotal with no invented float value', () => {
  const report = analyzeFlows(flowQuery([row('known'), row('unknown', { rawValue: null })]));
  const eth = report.assets[0]!;
  assert.equal(eth.incoming.raw, '1'); assert.equal(eth.incoming.missingCount, 1);
  assert.equal(eth.amountsComplete, false); assert.equal(eth.incoming.amount, '0.000000000000000001');
});
for (const [label, decimals] of [['missing', null], ['conflict', '0x9']] as const) test(`${label} ERC20 decimals suppress formatted amounts`, () => {
  const report = analyzeFlows(flowQuery([
    row('a', { category: 'erc20', tokenAddress: token, decimalsHex: '0x6' }),
    row('b', { category: 'erc20', tokenAddress: token, decimalsHex: decimals }),
  ]));
  assert.equal(report.assets[0]?.precisionStatus, label); assert.equal(report.assets[0]?.incoming.raw, '2');
  assert.equal(report.assets[0]?.incoming.amount, null); assert.equal(report.assets[0]?.netAmount, null);
});
test('invalid metadata cannot trigger unbounded arithmetic or symbol-based grouping', () => {
  const report = analyzeFlows(flowQuery([
    row('missing-contract', { category: 'erc20', tokenAddress: null }),
    row('huge-decimals', { category: 'erc20', tokenAddress: token, decimalsHex: '0x' + 'f'.repeat(10000) }),
    row('huge-amount', { rawValue: '0x' + 'f'.repeat(65) }),
  ]));
  assert.equal(report.unidentifiedAssetCount, 1);
  assert.equal(report.assets.find(a => a.key === 'eth')?.incoming.missingCount, 1);
  assert.equal(report.assets.find(a => a.tokenAddress === token)?.incoming.amount, null);
});
test('counterparty count and same-asset known amount rankings have deterministic ties', () => {
  const other = '0x' + '3'.repeat(40);
  const report = analyzeFlows(flowQuery([row('a', { rawValue: '0x2' }), row('b', { from: other, rawValue: '0x4' })]));
  assert.equal(report.counterparties[0]?.address, peer); assert.equal(report.assets[0]?.topIncoming[0]?.address, other);
  assert.deepEqual(report.assets[0]?.topIncoming[0]?.incoming.recordIds, ['b']);
});
test('partial, empty and unknown counterparties retain source coverage', () => {
  const partial = analyzeFlows(flowQuery([], [row('unknown-peer', { from: owner, to: null })], false));
  assert.equal(partial.complete, false); assert.equal(partial.unknownCounterpartyCount, 1); assert.equal(partial.counterparties.length, 0);
  const empty = analyzeFlows(flowQuery()); assert.deepEqual(empty.assets, []); assert.equal(empty.complete, true);
  assert.doesNotThrow(() => JSON.stringify(partial));
});
test('failed or non-transfer queries cannot supply flow facts', () => {
  assert.throws(() => analyzeFlows({ ...flowQuery(), kind: 'get_eth_balance' }), /INVALID_ARGUMENT/);
  assert.throws(() => analyzeFlows({ ...flowQuery(), status: 'error' }), /INVALID_ARGUMENT/);
});
test('analysis paging works for old evidence without mutating it or issuing HTTP', async () => {
  const { createQueryService, parseConfig } = await import('../src/index.js');
  const q = flowQuery([row('in')]); const original = JSON.stringify(q); let calls = 0;
  const service = createQueryService({ config: parseConfig({}), outputDirectory: 'unused', initialResults: [q],
    fetch: (async () => { calls++; throw new Error('must not fetch'); }) as typeof fetch });
  assert.equal(service.analyzeFlows(q.queryId).assets[0]?.incoming.raw, '1');
  assert.equal(service.readEvidence(q.queryId, 'flow_assets', 0, 1).records[0]?.key, 'eth');
  assert.equal(service.readEvidence(q.queryId, 'flow_counterparties', 0, 1).records[0]?.address, peer);
  assert.equal(JSON.stringify(q), original); assert.equal(calls, 0);
  assert.throws(() => service.analyzeFlows('q_other'), /INVALID_ARGUMENT/);
});
test('bounded flow preview retains counts and reports omitted groups', () => {
  const report = analyzeFlows(flowQuery(Array.from({ length: 50 }, (_, i) => row(`token${i}`, {
    category: 'erc20', tokenAddress: '0x' + i.toString(16).padStart(40, '0'), asset: 'SYMBOL'.repeat(20), decimalsHex: '0x0',
  }))));
  const preview = previewFlows(report);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= 1400); assert.equal(preview.assetCount, 50);
  assert.ok(preview.assets.length < 50); assert.equal(preview.counts.incoming, 50);
});

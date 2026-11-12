import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const a = '0x' + '1'.repeat(40); const b = '0x' + '2'.repeat(40);

for (const [message, expected] of [
  ['Etherscan: NOTOK: credits exhausted', 'QUOTA_EXHAUSTED'],
  ['Alchemy RPC -32000: monthly capacity limit exceeded', 'QUOTA_EXHAUSTED'],
  ['Etherscan: NOTOK: daily limit reached', 'QUOTA_EXHAUSTED'],
  ['Response validation: repeated pageKey', 'PROVIDER_RESPONSE_INVALID'],
  ['Response validation: invalid pageKey', 'PROVIDER_RESPONSE_INVALID'],
  ['Response validation: repeated transaction page', 'PROVIDER_RESPONSE_INVALID'],
  ['Etherscan: NOTOK: Max rate limit reached', 'RATE_LIMIT'],
  ['Alchemy RPC -32005: compute units per second limit exceeded', 'RATE_LIMIT'],
  ['HTTP 429', 'RATE_LIMIT'],
  ['Etherscan: NOTOK: Invalid API Key', 'AUTH_ERROR'],
  ['API Key missing or invalid', 'AUTH_ERROR'],
  ['Missing ALCHEMY_API_KEY; set it in local .env', 'AUTH_ERROR'],
  ['HTTP 403', 'AUTH_ERROR'],
  ['Ethereum Mainnet is not enabled for this app', 'AUTH_ERROR'],
  ['HTTP request budget exhausted', 'BUDGET_EXHAUSTED'],
  ['Runtime time budget exhausted', 'BUDGET_EXHAUSTED'],
  ['Operation cancelled', 'CANCELLED'],
  ['Request timeout', 'TIMEOUT'],
  ['Network or response read failure', 'NETWORK_ERROR'],
  ['EVIDENCE_WRITE_FAILED: unable to persist query evidence', 'EVIDENCE_WRITE_FAILED'],
] as const) {
  test(`diagnostic code: ${message}`, async () => {
    const { errorCode } = await import('../src/queries.js');
    assert.equal(errorCode(new Error(message)), expected);
  });
}
async function harness(handler?: (url: URL, body: any) => unknown) {
  const { createQueryService, parseConfig } = await import('../src/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'ledger-query-')); const calls: any[] = [];
  const config = parseConfig({ ALCHEMY_API_KEY: 'test-alchemy-secret', ETHERSCAN_API_KEY: 'test-etherscan-secret', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' });
  const service = createQueryService({ config, outputDirectory: dir, fetch: (async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')); const url = new URL(String(input)); calls.push({ body, url });
    const result = handler ? handler(url, body) : { jsonrpc: '2.0', id: body.id,
      result: body.method === 'eth_chainId' ? '0x1' : body.method === 'eth_blockNumber' ? '0xa' : '0x1' };
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch });
  const context = { sessionId: 'session', runId: 'run', toolCallId: 'call' };
  return { service, calls, dir, context, close: () => rm(dir, { recursive: true, force: true }) };
}

test('query arguments reject unknown fields and over-budget inputs before network', async () => {
  const h = await harness();
  try {
    for (const args of [{ address: a, endpoint: 'https://evil.invalid' }, { address: 'vitalik.eth' }, { address: a, maxRecords: 201 }, { address: a, startBlock: 10, endBlock: 9 }]) {
      await assert.rejects(h.service.query('list_normal_transactions', args, h.context), /INVALID_ARGUMENT/);
    }
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('snapshot persistence failure prevents a balance request at an uncommitted block', async () => {
  const { createQueryService, parseConfig } = await import('../src/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'ledger-snapshot-')); const methods: string[] = [];
  try {
    const service = createQueryService({ config: parseConfig({ ALCHEMY_API_KEY: 'offline', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' }), outputDirectory: dir,
      onSnapshot: async () => { throw new Error('snapshot checkpoint failed'); },
      fetch: (async (_url, init) => {
        const b = JSON.parse(String(init?.body)); methods.push(b.method);
        return Response.json({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_chainId' ? '0x1' : '0xa' });
      }) as typeof fetch,
    });
    const result = await service.query('get_eth_balance', { address: a }, { sessionId: 's_test', runId: 'r_test', toolCallId: 'a' });
    assert.equal(result.status, 'error'); assert.deepEqual(methods, ['eth_chainId', 'eth_blockNumber']);
    const retry = await service.query('get_eth_balance', { address: a }, { sessionId: 's_test', runId: 'r_test', toolCallId: 'b' });
    assert.equal(retry.status, 'error');
    assert.deepEqual(methods, ['eth_chainId', 'eth_blockNumber', 'eth_chainId', 'eth_blockNumber']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two addresses use a shared fixed snapshot with exact amounts and persisted evidence', async () => {
  const h = await harness();
  try {
    const first = await h.service.query('get_eth_balance', { address: a }, h.context);
    const second = await h.service.query('get_eth_balance', { address: b }, h.context);
    assert.equal(first.data.wei, '1'); assert.equal(first.data.eth, '0.000000000000000001');
    assert.equal(second.address, b); assert.equal(second.range.blockNumber, 10);
    const balances = h.calls.filter(c => c.body.method === 'eth_getBalance');
    assert.deepEqual(balances.map(c => c.body.params), [[a, '0xa'], [b, '0xa']]);
    assert.equal(h.calls.filter(c => c.body.method === 'eth_blockNumber').length, 1);
    const folders = await readdir(h.dir); assert.equal(folders.length, 2);
    const saved = await readFile(join(h.dir, first.queryId, 'query.json'), 'utf8');
    assert.ok(!saved.includes('test-alchemy-secret')); assert.match(saved, /0\.000000000000000001/);
  } finally { await h.close(); }
});

test('later page failures remain partial and evidence reading is scoped and bounded', async () => {
  const hash = '0x' + 'a'.repeat(64);
  const h = await harness((url, body) => {
    if (body.method) return { jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x1' : '0xa' };
    if (url.searchParams.get('page') === '2') return new Response('busy', { status: 503 });
    return { status: '1', message: 'OK', result: [{ hash, blockNumber: '10', timeStamp: '1', from: a, to: b, value: '1', isError: '1' }] };
  });
  try {
    const q = await h.service.query('list_normal_transactions', { address: a, pageSize: 1 }, h.context);
    assert.equal(q.status, 'partial'); assert.equal(q.data.count, 1); assert.equal(q.data.transactions[0].failed, true);
    assert.equal(q.completeness.complete, false); assert.equal(q.completeness.stopReason, 'error');
    assert.ok(!JSON.stringify(h.service.preview(q)).includes(h.dir));
    assert.equal(h.service.readEvidence(q.queryId, 'transactions', 0, 20).records.length, 1);
    assert.throws(() => h.service.readEvidence('../other', 'transactions', 0, 1));
    assert.throws(() => h.service.readEvidence(q.queryId, 'transactions', 0, 21));
    const other = await harness();
    try { assert.throws(() => other.service.readEvidence(q.queryId, 'transactions', 0, 1)); } finally { await other.close(); }
  } finally { await h.close(); }
});

test('provider quota after a successful page stays partial with a quota diagnostic', async () => {
  const h = await harness((url, body) => {
    if (body.method) return { jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x1' : '0xa' };
    if (url.searchParams.get('page') === '2') return { status: '0', message: 'NOTOK', result: 'credits exhausted' };
    return { status: '1', message: 'OK', result: [{ hash: '0x' + 'a'.repeat(64), blockNumber: '10', timeStamp: '1', from: a, to: b, value: '1', isError: '0' }] };
  });
  try {
    const q = await h.service.query('list_normal_transactions', { address: a, pageSize: 1 }, h.context);
    assert.equal(q.status, 'partial'); assert.equal(q.data.count, 1);
    assert.equal(q.error?.code, 'QUOTA_EXHAUSTED'); assert.equal(q.completeness.complete, false);
    const saved = JSON.parse(await readFile(join(h.dir, q.queryId, 'query.json'), 'utf8'));
    assert.equal(saved.error.code, 'QUOTA_EXHAUSTED');
  } finally { await h.close(); }
});
test('transfer analysis is durable while full report stays outside model record previews', async () => {
  const h = await harness((_url, body) => ({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x1' :
    body.method === 'eth_blockNumber' ? '0xa' : { transfers: [] } }));
  try {
    const q = await h.service.query('list_asset_transfers', { address: a }, h.context);
    const saved = JSON.parse(await readFile(join(h.dir, q.queryId, 'query.json'), 'utf8'));
    assert.equal(saved.data.flowAnalysis.sourceQueryId, q.queryId);
    assert.deepEqual(saved.data.flowAnalysis.assets, []);
    const preview = h.service.preview(q); assert.ok(!('flowAnalysis' in preview.data));
    assert.equal(preview.data.flowAnalysisAvailable, true);
  } finally { await h.close(); }
});
for (const acrossPages of [false, true]) test(`conflicting transfer IDs survive normalization (across pages=${acrossPages})`, async () => {
  const wire = (value: string) => ({ uniqueId: 'duplicate', hash: '0x' + 'a'.repeat(64), blockNum: '0xa',
    from: b, to: a, category: 'external', asset: 'ETH', value: 1, rawContract: { value, decimal: '0x12', address: null } });
  const h = await harness((_url, body) => {
    if (body.method !== 'alchemy_getAssetTransfers') return { jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x1' : '0xa' };
    const incoming = body.params[0].toAddress === a; const second = !!body.params[0].pageKey;
    return { jsonrpc: '2.0', id: body.id, result: !incoming ? { transfers: [] } : acrossPages ?
      { transfers: [wire(second ? '0x2' : '0x1')], ...(second ? {} : { pageKey: 'second' }) } : { transfers: [wire('0x1'), wire('0x2')] } };
  });
  try {
    const q = await h.service.query('list_asset_transfers', { address: a }, h.context);
    assert.deepEqual(q.data.flowAnalysis.excludedRecordIds, ['duplicate']);
    assert.equal(q.data.flowAnalysis.assets.length, 0);
    assert.ok(q.data.flowAnalysis.issues.some((i: any) => i.code === 'CONFLICTING_ID'));
  } finally { await h.close(); }
});

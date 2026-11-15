import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@ledgerscout/chain-data';
import { runAgent } from '../src/runtime.js';
import { parseAnswer, renderAnswer } from '../src/answer.js';
import type { ModelRequest } from '../src/types.js';
const holder = '0x' + '1'.repeat(40), contract = '0x' + '2'.repeat(40), other = '0x' + '3'.repeat(40);
const word = (n: number) => n.toString(16).padStart(64, '0');
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-token-runtime-')); const calls: any[] = [];
  const state = { contract, block: 10, metadataError: false };
  const request = async (r: ModelRequest) => {
    const last = r.messages.filter(m => m.role === 'tool').at(-1);
    if (!last) return { content: '', toolCalls: [{ id: 'token', name: 'get_erc20_balance', arguments: { address: holder, contractAddress: state.contract } }] };
    const q = JSON.parse(last.content);
    return { content: JSON.stringify({ kind: 'answer', queryIds: [q.queryId], claims: [{ queryId: q.queryId, field: 'token_balance' }] }) };
  };
  const run = (extra: Partial<Parameters<typeof runAgent>[0]> = {}) => runAgent({ input: `查询 ${holder} 的代币余额，合约 ${contract}`, outputDirectory: dir,
    config: parseConfig({ ALCHEMY_API_KEY: 'offline', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' }), request,
    fetch: (async (_url, init) => {
      const q = JSON.parse(String(init?.body)); calls.push(q); const data = q.params[0]?.data;
      if (data === '0x313ce567' && state.metadataError) return Response.json({ jsonrpc: '2.0', id: q.id, error: { code: 3, message: 'execution reverted' } });
      return Response.json({ jsonrpc: '2.0', id: q.id, result: q.method === 'eth_chainId' ? '0x1' : q.method === 'eth_blockNumber' ? `0x${state.block.toString(16)}` :
        q.method === 'eth_getBalance' ? '0x1' : data === '0x313ce567' ? '0x' + word(6) : data?.startsWith('0x9061b923') ? '0x' + word(64) + other.slice(2).padStart(64, '0') + word(32) + holder.slice(2).padStart(64, '0') : '0x' + '20000000000001'.padStart(64, '0') });
    }) as typeof fetch, ...extra });
  return { dir, calls, state, request, run, close: () => rm(dir, { recursive: true, force: true }) };
}
test('ERC20 tool separates holder/contract permissions and renders exact proof-backed amount', async () => {
  const h = await harness();
  try {
    const r = await h.run(); assert.equal(r.status, 'completed'); assert.equal(r.counts.http, 4);
    assert.equal(r.queries[0]?.contractAddress, contract); assert.equal(r.queries[0]?.address, holder);
    assert.match(r.answer, /9007199254\.740993/); assert.match(r.answer, /9007199254740993/); assert.match(r.answer, /精度.*6/);
    assert.ok(r.answer.includes(contract)); assert.ok(r.answer.includes('区块 10'));
    const session = JSON.parse(await readFile(join(h.dir, r.sessionId, 'session.json'), 'utf8'));
    assert.deepEqual(session.addresses, [holder]); assert.deepEqual(session.tokenContracts, [contract]);
  } finally { await h.close(); }
});
test('ENS holder with explicit contract resolves only the holder and shares its snapshot', async () => {
  const h = await harness();
  try {
    const r = await h.run({ input: `查询 vitalik.eth 的代币余额，合约 ${contract}` });
    assert.equal(r.status, 'completed'); assert.equal(r.counts.http, 5);
    const session = JSON.parse(await readFile(join(h.dir, r.sessionId, 'session.json'), 'utf8'));
    assert.deepEqual(session.addresses, [holder]); assert.deepEqual(session.literalAddresses, []);
    assert.equal(r.ensResolutions?.[0]?.blockNumber, r.queries[0]?.range.blockNumber);
  } finally { await h.close(); }
});
test('partial decimals metadata renders raw units, never a formatted or native balance', async () => {
  const h = await harness(); h.state.metadataError = true;
  try {
    const r = await h.run(); assert.equal(r.status, 'partial');
    assert.match(r.answer, /原始.*9007199254740993/); assert.match(r.answer, /精度.*未知|无法换算/);
    assert.doesNotMatch(r.answer, /9007199254\.740993|部分历史|ETH 余额/);
  } finally { await h.close(); }
});
test('wrong contract and using the contract as a holder are denied before data requests', async () => {
  for (const args of [{ address: holder, contractAddress: other }, { address: contract, contractAddress: contract }]) {
    const h = await harness(); let turns = 0;
    try {
      const r = await h.run({ request: async () => ++turns === 1 ? { content: '', toolCalls: [{ id: 'wrong', name: 'get_erc20_balance', arguments: args }] } :
        { content: JSON.stringify({ kind: 'clarification', message: '不能查询未指定目标' }) } });
      assert.equal(r.queries.length, 0); assert.equal(h.calls.length, 0);
    } finally { await h.close(); }
  }
});
test('explicit contract without any selected holder clarifies rather than querying itself', async () => {
  const h = await harness();
  try {
    const r = await h.run({ input: `查询代币余额，合约 ${contract}` });
    assert.equal(r.status, 'awaiting_user'); assert.equal(r.counts.models, 0); assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});
test('symbol-only or malformed contract requests clarify without old contract fallback', async () => {
  const h = await harness();
  try {
    const first = await h.run();
    for (const input of [`查询 ${holder} 的 USDT 余额`, `查询 ${holder} 代币余额 合约 0x123`, `查询 ${holder} 代币余额 合约 USDT`]) {
      const r = await h.run({ sessionId: first.sessionId, input });
      assert.equal(r.status, 'awaiting_user'); assert.equal(r.counts.models, 0); assert.equal(r.counts.http, 0);
    }
  } finally { await h.close(); }
});
test('reopened session reuses explicit contract selection and switching contract retains holder', async () => {
  const h = await harness();
  try {
    const first = await h.run();
    const again = await h.run({ sessionId: first.sessionId, input: '再查当前代币余额' });
    assert.equal(again.status, 'completed'); assert.equal(again.queries[0]?.contractAddress, contract);
    h.state.contract = other;
    const switched = await h.run({ sessionId: first.sessionId, input: `换合约 ${other} 查询当前代币余额` });
    assert.equal(switched.status, 'completed'); assert.equal(switched.queries[0]?.address, holder); assert.equal(switched.queries[0]?.contractAddress, other);
    const session = JSON.parse(await readFile(join(h.dir, first.sessionId, 'session.json'), 'utf8'));
    assert.deepEqual(session.addresses, [holder]); assert.deepEqual(session.tokenContracts, [other]);
  } finally { await h.close(); }
});
test('contract selection handles english labels and rejects more than four contracts', async () => {
  const h = await harness();
  try {
    const r = await h.run({ input: `token balance for ${holder}, contract address: ${contract}` });
    assert.equal(r.status, 'completed'); assert.equal(r.queries[0]?.address, holder);
    const tooMany = await h.run({ input: `查 ${holder} 代币余额 ` + [2, 3, 4, 5, 6].map(n => `合约 0x${String(n).repeat(40)}`).join(' ') });
    assert.equal(tooMany.status, 'awaiting_user'); assert.equal(tooMany.counts.http, 0);
  } finally { await h.close(); }
});
test('date-range token balance is clarified before resolving names or querying', async () => {
  const h = await harness();
  try {
    const r = await h.run({ input: `查询 vitalik.eth 最近七天代币余额 合约 ${contract}` });
    assert.equal(r.status, 'awaiting_user'); assert.equal(r.counts.http, 0);
  } finally { await h.close(); }
});
test('ERC20 cache distinguishes contracts and reuses a successful identical call', async () => {
  const h = await harness(); let turn = 0;
  try {
    const r = await h.run({ input: `查询 ${holder} 代币余额 合约 ${contract} 合约 ${other}`, request: async m => ++turn < 4 ? {
      content: '', toolCalls: [{ id: `c${turn}`, name: 'get_erc20_balance', arguments: { address: holder, contractAddress: turn === 3 ? other : contract } }] } :
      { content: JSON.stringify({ kind: 'answer', queryIds: m.messages.filter(x => x.role === 'tool').map(x => JSON.parse(x.content).queryId),
        claims: m.messages.filter(x => x.role === 'tool').map(x => ({ queryId: JSON.parse(x.content).queryId, field: 'token_balance' })) }) } });
    assert.equal(r.status, 'completed'); assert.equal(r.queries.length, 2); assert.equal(r.counts.http, 6);
  } finally { await h.close(); }
});
test('cancelled completed ERC20 tool resumes at the saved contract/block without more HTTP', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, onEvent: e => { if (e.type === 'query_finished') ctl.abort(); } });
    assert.equal(first.status, 'cancelled'); assert.equal(first.resumable, true);
    const count = h.calls.length; h.state.block = 11;
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.queries[0]?.range.blockNumber, 10);
    assert.equal(resumed.queries[0]?.contractAddress, contract); assert.equal(h.calls.length, count); assert.equal(resumed.counts.http, 4);
  } finally { await h.close(); }
});
test('tampered ERC20 evidence is rejected before recovery network work', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, onEvent: e => { if (e.type === 'query_finished') ctl.abort(); } });
    const q = first.queries[0]!; assert.ok(q);
    const path = join(first.directory, 'queries', q.queryId, 'query.json');
    const value = JSON.parse(await readFile(path, 'utf8')); value.contractAddress = other; await writeFile(path, JSON.stringify(value));
    await assert.rejects(h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId }), /checkpoint|evidence/);
    assert.equal(h.calls.length, 4);
  } finally { await h.close(); }
});
test('metadata HTTP budget exhaustion retains raw evidence and exhausted runtime status', async () => {
  const h = await harness();
  try {
    const r = await h.run({ limits: { maxHttpRequests: 3 } });
    assert.equal(r.status, 'exhausted'); assert.equal(r.counts.http, 3); assert.equal(r.queries[0]?.data.rawBalance, '9007199254740993');
  } finally { await h.close(); }
});
test('ERC20 fact parser rejects forged formatting and cross-kind balance facts', async () => {
  const h = await harness();
  try {
    const r = await h.run(); const q = r.queries[0]!; assert.ok(q);
    const draft = JSON.stringify({ kind: 'answer', queryIds: [q.queryId], claims: [{ queryId: q.queryId, field: 'token_balance' }] });
    assert.match(renderAnswer(parseAnswer(draft, [q]), [q]), /9007199254\.740993/);
    assert.throws(() => parseAnswer(draft, [{ ...q, data: { ...q.data, amount: '999' } }]));
    assert.throws(() => parseAnswer(draft, [{ ...q, kind: 'get_eth_balance' }]));
  } finally { await h.close(); }
});
test('legacy recovery cannot inherit contracts selected by a later session turn', async () => {
  const h = await harness(); const ctl = new AbortController(); let nativeTurn = 0;
  try {
    const first = await h.run({ input: `查询 ${holder} 当前ETH余额`, signal: ctl.signal, onEvent: e => { if (e.type === 'query_finished') ctl.abort(); },
      request: async () => ++nativeTurn === 1 ? { content: '', toolCalls: [{ id: 'native', name: 'get_eth_balance', arguments: { address: holder } }] } : { content: '' } });
    assert.equal(first.status, 'cancelled');
    const checkpointPath = join(first.directory, 'checkpoint.json');
    const legacyCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); delete legacyCheckpoint.tokenContracts;
    await writeFile(checkpointPath, JSON.stringify(legacyCheckpoint));
    await h.run({ sessionId: first.sessionId }); const count = h.calls.length; let turns = 0;
    await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId, request: async () => ++turns === 1 ?
      { content: '', toolCalls: [{ id: 'later-token', name: 'get_erc20_balance', arguments: { address: holder, contractAddress: contract } }] } :
      { content: JSON.stringify({ kind: 'clarification', message: '原运行未选择代币' }) } });
    assert.equal(h.calls.length, count);
  } finally { await h.close(); }
});
test('symbol references separated from balance by token words cannot reuse an old contract', async () => {
  for (const input of ['查询 USDC 的代币余额', 'USDC token balance', '查询 usdc 的代币余额', 'get balance for USDC', 'how much USDC do I hold?', '查询 USDC 持仓']) {
    const h = await harness();
    try {
      const first = await h.run();
      const r = await h.run({ sessionId: first.sessionId, input });
      assert.equal(r.status, 'awaiting_user', input); assert.equal(r.counts.models, 0); assert.equal(r.counts.http, 0);
      const session = JSON.parse(await readFile(join(h.dir, first.sessionId, 'session.json'), 'utf8'));
      assert.deepEqual(session.tokenContracts, []);
    } finally { await h.close(); }
  }
});
test('ordinary English balance requests still reach the native balance tool', async () => {
  for (const input of [`check balance for ${holder}`, `show balance ${holder}`, `wallet balance ${holder}`,
    `check native ETH balance ${holder}`, `show ETH balance in wei ${holder}`, `what's the ETH balance? ${holder}`]) {
    const h = await harness(); let turn = 0;
    try {
      const r = await h.run({ input, request: async m => ++turn === 1 ? { content: '', toolCalls: [{ id: 'native', name: 'get_eth_balance', arguments: { address: holder } }] } :
        { content: JSON.stringify({ kind: 'answer', queryIds: [JSON.parse(m.messages.filter(x => x.role === 'tool').at(-1)!.content).queryId],
          claims: [{ queryId: JSON.parse(m.messages.filter(x => x.role === 'tool').at(-1)!.content).queryId, field: 'eth' }] }) } });
      assert.equal(r.status, 'completed', input); assert.equal(r.queries[0]?.kind, 'get_eth_balance');
    } finally { await h.close(); }
  }
});

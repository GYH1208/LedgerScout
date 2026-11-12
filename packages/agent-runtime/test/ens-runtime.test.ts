import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@ledgerscout/chain-data';
import { runAgent } from '../src/runtime.js';
import { extractEnsTargets } from '../src/ens.js';
import { parseDateWindow } from '../src/dates.js';
import { isFlowAnalysisRequest } from '../src/flow-context.js';
import type { ModelRequest } from '../src/types.js';
import { spawn } from 'node:child_process';
const a = '0x' + '1'.repeat(40); const b = '0x' + '2'.repeat(40); const resolver = '0x' + '3'.repeat(40);
const word = (n: number) => n.toString(16).padStart(64, '0');
const result = (address: string) => '0x' + word(64) + resolver.slice(2).padStart(64, '0') + word(32) + address.slice(2).padStart(64, '0');
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-ens-runtime-')); const calls: any[] = [];
  const state = { address: a, block: 10, mode: 'ok' };
  const config = parseConfig({ ALCHEMY_API_KEY: 'offline', ETHERSCAN_API_KEY: 'offline', REQUEST_INTERVAL_MS: '0', MAX_RETRIES: '0' });
  const fetcher = (async (_url, init) => {
    const q = JSON.parse(String(init?.body)); calls.push(q);
    if (q.method === 'eth_call' && state.mode === 'error') return new Response('unavailable', { status: 503 });
    return Response.json({ jsonrpc: '2.0', id: q.id, result: q.method === 'eth_chainId' ? '0x1' : q.method === 'eth_blockNumber' ? '0x' + state.block.toString(16) :
      q.method === 'eth_call' ? result(state.mode === 'zero' ? '0x' + '0'.repeat(40) : state.address) : '0x1' });
  }) as typeof fetch;
  const request = async (r: ModelRequest) => {
    const tool = r.messages.filter(m => m.role === 'tool').at(-1);
    return !tool ? { content: '', toolCalls: [{ id: 'balance', name: 'get_eth_balance', arguments: { address: state.address } }] } :
      { content: JSON.stringify({ kind: 'answer', queryIds: [JSON.parse(tool.content).queryId], claims: [{ queryId: JSON.parse(tool.content).queryId, field: 'eth' }] }) };
  };
  const run = (extra: Partial<Parameters<typeof runAgent>[0]> = {}) => runAgent({ input: '查询 ViTaLiK.ETH 的当前 ETH 余额', config, request, fetch: fetcher, outputDirectory: dir, ...extra });
  return { dir, calls, state, run, close: () => rm(dir, { recursive: true, force: true }) };
}
test('target extraction normalizes names, rejects malformed boundaries and masks name keywords', () => {
  assert.equal(extractEnsTargets('查询 VITALIK.ETH 的余额').names[0]?.name, 'vitalik.eth');
  for (const input of ['查询 bad..eth 的余额', '查询 vitalik.eth.evil 的余额', '查询vitalik.eth余额',
    '查询 vitalik.eth 和 bad.eth.evil', '查询 vitalik.eth3', '查询 foo\u0000bar.eth 的余额',
    '查询 abc.ethé 的余额']) assert.ok(extractEnsTargets(input).error, input);
  assert.deepEqual(parseDateWindow('查询 2026-11.eth 余额', new Date('2026-11-12T01:00Z')), {});
  assert.equal(isFlowAnalysisRequest('查询 net-flow.eth 的余额'), false);
  assert.equal(extractEnsTargets('查询 foo$bar.eth 的余额').names[0]?.name, 'foo$bar.eth');
  assert.equal(extractEnsTargets("查询 foo'bar.eth 的余额").names[0]?.name, 'foo’bar.eth');
  assert.equal(extractEnsTargets("查询 'vitalik.eth' 的余额").names[0]?.name, 'vitalik.eth');
});
test('ENS balance authorizes only verified address and keeps fixed-block evidence', async () => {
  const h = await harness();
  try {
    const r = await h.run(); assert.equal(r.status, 'completed'); assert.equal(r.queries[0]?.address, a);
    assert.equal(r.counts.http, 4); assert.equal(r.counts.tools, 2); assert.equal(r.ensResolutions?.[0]?.blockNumber, 10);
    assert.match(r.answer, /ViTaLiK.ETH/); assert.match(r.answer, /vitalik.eth/); assert.match(r.answer, new RegExp(a));
  } finally { await h.close(); }
});
test('reopened session refreshes the name binding and explicit address clears name selection', async () => {
  const h = await harness();
  try {
    const first = await h.run(); h.state.address = b; h.state.block = 11;
    const next = await h.run({ sessionId: first.sessionId, input: '再查当前余额' });
    assert.equal(next.status, 'completed'); assert.equal(next.queries[0]?.address, b); assert.equal(next.ensResolutions?.[0]?.blockNumber, 11);
    h.state.address = a;
    const direct = await h.run({ sessionId: first.sessionId, input: `查询 ${a} 当前余额` });
    assert.equal(direct.status, 'completed'); assert.equal(direct.ensResolutions?.length ?? 0, 0);
    const calls = h.calls.filter(c => c.method === 'eth_call').length;
    await h.run({ sessionId: first.sessionId, input: '再查当前余额' });
    assert.equal(h.calls.filter(c => c.method === 'eth_call').length, calls);
  } finally { await h.close(); }
});
test('invalid or unresolved names never fall back to an old selected address', async () => {
  const h = await harness();
  try {
    const first = await h.run(); const before = h.calls.filter(c => c.method === 'eth_getBalance').length;
    const invalid = await h.run({ sessionId: first.sessionId, input: '查询 bad..eth 当前余额' });
    assert.equal(invalid.status, 'awaiting_user'); assert.equal(invalid.counts.http, 0);
    h.state.mode = 'zero';
    const missing = await h.run({ sessionId: first.sessionId, input: '查询 missing.eth 当前余额' });
    assert.equal(missing.status, 'awaiting_user'); assert.equal(missing.counts.models, 0);
    assert.equal(h.calls.filter(c => c.method === 'eth_getBalance').length, before);
  } finally { await h.close(); }
});
test('cancelled preflight resumes using saved mapping without re-resolution', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, onEvent: e => { if (e.type === 'ens_resolved') ctl.abort(); } });
    assert.equal(first.status, 'cancelled'); assert.equal(first.resumable, true);
    const calls = h.calls.filter(c => c.method === 'eth_call').length;
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.counts.http, 4); assert.equal(resumed.counts.tools, 2);
    assert.equal(h.calls.filter(c => c.method === 'eth_call').length, calls);
  } finally { await h.close(); }
});
test('failed ENS preflight with no address can resume and preserves HTTP budget', async () => {
  const h = await harness(); h.state.mode = 'error';
  try {
    const first = await h.run(); assert.equal(first.status, 'failed'); assert.equal(first.resumable, true);
    h.state.mode = 'ok';
    const resumed = await h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.counts.http, 5);
  } finally { await h.close(); }
});
test('changed resolution evidence rejects recovery before network', async () => {
  const h = await harness(); const ctl = new AbortController();
  try {
    const first = await h.run({ signal: ctl.signal, onEvent: e => { if (e.type === 'ens_resolved') ctl.abort(); } });
    const p = first.ensResolutions![0]!; const path = join(first.directory, 'resolutions', p.resolutionId, 'resolution.json');
    const proof = JSON.parse(await readFile(path, 'utf8')); proof.address = b; await writeFile(path, JSON.stringify(proof));
    const count = h.calls.length;
    await assert.rejects(h.run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId }), /checkpoint|evidence|ENS/i);
    assert.equal(h.calls.length, count);
  } finally { await h.close(); }
});
test('resolution shares original HTTP cap and never authorizes a guessed model address', async () => {
  const h = await harness();
  try {
    const limited = await h.run({ limits: { maxHttpRequests: 2 } }); assert.equal(limited.status, 'exhausted'); assert.equal(limited.counts.http, 2);
    let turn = 0;
    const denied = await h.run({ request: async () => ++turn === 1 ? { content: '', toolCalls: [
      { id: 'wrong', name: 'get_eth_balance', arguments: { address: b } }] } : { content: JSON.stringify({ kind: 'clarification', message: '无法查询未授权地址' }) } });
    assert.equal(denied.queries.length, 0); assert.equal(denied.counts.http, 3);
  } finally { await h.close(); }
});
test('address-like ENS labels cannot authorize that literal address', async () => {
  const h = await harness(); const label = '0x' + '9'.repeat(40); let turn = 0;
  try {
    const denied = await h.run({ input: `查询 ${label}.eth 的余额`, request: async () => ++turn === 1 ? { content: '', toolCalls: [
      { id: 'literal', name: 'get_eth_balance', arguments: { address: label } }] } : { content: JSON.stringify({ kind: 'clarification', message: '只能查询映射地址' }) } });
    assert.equal(denied.queries.length, 0); assert.equal(denied.counts.http, 3);
  } finally { await h.close(); }
});
test('history words inside ENS names cannot authorize stale query evidence', async () => {
  const h = await harness();
  try {
    const first = await h.run(); const old = first.queries[0]!;
    const next = await h.run({ sessionId: first.sessionId, input: '查询 previous.eth 的余额', request: async () =>
      ({ content: JSON.stringify({ kind: 'answer', queryIds: [old.queryId], claims: [{ queryId: old.queryId, field: 'eth' }] }) }) });
    assert.notEqual(next.status, 'completed'); assert.equal(next.queries.length, 0);
  } finally { await h.close(); }
});
test('explicit historical query-ID access does not refresh the selected ENS name', async () => {
  const h = await harness();
  try {
    const first = await h.run(); const old = first.queries[0]!; const count = h.calls.length;
    const history = await h.run({ sessionId: first.sessionId, input: `查看上次证据 ${old.queryId} 的余额`, request: async () =>
      ({ content: JSON.stringify({ kind: 'answer', queryIds: [old.queryId], claims: [{ queryId: old.queryId, field: 'eth' }] }) }) });
    assert.equal(history.status, 'completed'); assert.equal(h.calls.length, count);
    assert.match(history.answer, /历史查询证据/);
  } finally { await h.close(); }
});
test('balance/date guard reads the request rather than words in the name', async () => {
  const h = await harness();
  try {
    const blocked = await h.run({ input: '查询 交易.eth 最近七天余额' });
    assert.equal(blocked.status, 'awaiting_user'); assert.equal(blocked.counts.http, 0);
    const accepted = await h.run({ input: '分析 balance.eth 最近七天资金流',
      request: async () => ({ content: JSON.stringify({ kind: 'clarification', message: '测试模型未发历史工具' }) }) });
    assert.equal(accepted.counts.http, 3); assert.equal(accepted.counts.models, 1);
  } finally { await h.close(); }
});
test('refreshing ENS retains explicitly selected literal addresses in later turns', async () => {
  const h = await harness();
  try {
    const first = await h.run({ input: `查询 alice.eth 和 ${b} 当前余额` });
    const next = await h.run({ sessionId: first.sessionId, input: '再查当前余额' });
    const saved = JSON.parse(await readFile(join(h.dir, next.sessionId, 'session.json'), 'utf8'));
    assert.deepEqual(new Set(saved.addresses), new Set([a, b]));
    assert.deepEqual(saved.literalAddresses, [b]);
  } finally { await h.close(); }
});
test('combining an explicit old query with a fresh ENS target clarifies without resolution', async () => {
  const h = await harness();
  try {
    const first = await h.run(); const q = first.queries[0]!;
    const mixed = await h.run({ sessionId: first.sessionId, input: `查看 other.eth 上次证据 ${q.queryId} 的余额` });
    assert.equal(mixed.status, 'awaiting_user'); assert.equal(mixed.counts.http, 0); assert.equal(mixed.counts.models, 0);
    assert.equal(mixed.queries.length, 0);
  } finally { await h.close(); }
});
test('real process exit before the first model call recovers committed ENS proof', async () => {
  const h = await harness();
  try {
    const path = join(h.dir, 'ens-crash.mjs');
    await writeFile(path, `import {runAgent} from ${JSON.stringify(new URL('../src/runtime.ts', import.meta.url).href)};
import {parseConfig} from ${JSON.stringify(new URL('../../chain-data/src/config.ts', import.meta.url).href)};
await runAgent({input:'查询 vitalik.eth 当前余额',sessionId:'s_crash',outputDirectory:${JSON.stringify(h.dir)},
 config:parseConfig({ALCHEMY_API_KEY:'offline',REQUEST_INTERVAL_MS:'0',MAX_RETRIES:'0'}),
 request:async()=>{throw new Error('must not reach model before exit');},
 fetch:async(_u,init)=>{const b=JSON.parse(init.body);return Response.json({jsonrpc:'2.0',id:b.id,
 result:b.method==='eth_chainId'?'0x1':b.method==='eth_blockNumber'?'0xa':${JSON.stringify(result(a))}});},
 onEvent:e=>{if(e.type==='ens_resolved')process.exit(0);}});process.exit(2);`);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', path], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => child.kill(), 15000);
      child.on('error', e => { clearTimeout(timer); reject(e); }); child.on('exit', c => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0);
    const runId = (await readdir(join(h.dir, 's_crash'))).find(n => n.startsWith('r_'))!;
    const resumed = await h.run({ input: '', sessionId: 's_crash', resumeRunId: runId });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.counts.http, 4);
    assert.equal(h.calls.filter(c => c.method === 'eth_call').length, 0);
    assert.equal(resumed.ensResolutions?.[0]?.address, a);
  } finally { await h.close(); }
});

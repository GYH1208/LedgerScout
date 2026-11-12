/** Explicit, billable readonly acceptance. Never part of npm test. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from '@ledgerscout/chain-data';
import { loadRuntimeConfig, createDeepSeekRequest } from '../src/model.js';
import { runAgent, type RunResult } from '../src/runtime.js';
import { SessionStore } from '../src/session.js';
import type { RequestModel } from '../src/types.js';

const config = loadRuntimeConfig();
const secrets = [config.key, config.chain.alchemyKey, config.chain.etherscanKey];
const address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const root = join(config.outputDirectory, `live_${new Date().toISOString().replace(/[:.]/g, '-')}`);
const request = createDeepSeekRequest(config);
const input = `查询公开测试地址 ${address} 的当前 ETH 余额。必须查询真实数据并引用证据。`;
const records: Record<string, unknown>[] = [];
const run = (extra: Partial<Parameters<typeof runAgent>[0]> = {}) => runAgent({ input, config: config.chain, request,
  outputDirectory: root, secrets, ...extra });
const events = async (result: RunResult): Promise<Record<string, any>[]> =>
  (await readFile(join(result.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

async function scenario(name: string, work: () => Promise<unknown>) {
  console.log(`START ${name}`);
  try { records.push({ name, status: 'passed', details: await work() }); }
  catch (error) {
    records.push({ name, status: 'failed', error: String(redact(error instanceof Error ? error.message : 'Acceptance failed', secrets)) });
    process.exitCode = 1;
  }
  await writeFile(join(root, 'acceptance.json'), JSON.stringify(records, null, 2));
  console.log(JSON.stringify(records.at(-1)));
}
await mkdir(root, { recursive: true });

await scenario('real-compaction', async () => {
  const sessionId = `s_${randomUUID()}`;
  const store = new SessionStore(root, sessionId, secrets); await store.open();
  // Synthetic history is explicitly identified; only summary and query are live.
  store.data.addresses = [address];
  store.data.turns = Array.from({ length: 6 }, (_, i) => ({
    user: `验收合成背景第${i}轮，仅供压缩测试，不是真实研究事实。` + '用户希望公开地址研究可追溯，查询保持只读，金额来自证据。'.repeat(16),
    assistant: '验收合成回答：保留研究意图，后续查询必须刷新余额，不把背景当事实。'.repeat(16),
  }));
  await store.save();
  const result = await run({ sessionId });
  assert.equal(result.status, 'completed');
  assert.ok((await events(result)).some(e => e.type === 'context_compacted'));
  const saved = JSON.parse(await readFile(join(root, sessionId, 'session.json'), 'utf8'));
  assert.ok(saved.summary); assert.ok(result.queries.some(q => q.kind === 'get_eth_balance' && q.status === 'ok'));
  return { run: result.directory, counts: result.counts, tokenUsage: result.tokenUsage, syntheticHistory: true };
});

await scenario('real-tool-boundary-resume', async () => {
  const ctl = new AbortController();
  const first = await run({ signal: ctl.signal, onEvent: e => { if (e.type === 'tool_finished' && e.name === 'get_eth_balance') ctl.abort(); } });
  assert.equal(first.status, 'cancelled'); assert.equal(first.resumable, true);
  const original = first.queries.find(q => q.kind === 'get_eth_balance' && q.status === 'ok'); assert.ok(original);
  const resumed = await run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.resumeOf, first.runId);
  assert.equal(resumed.counts.http, first.counts.http); assert.equal(resumed.counts.tools, first.counts.tools);
  assert.ok(resumed.counts.models > first.counts.models);
  assert.ok(resumed.queries.some(q => q.queryId === original.queryId && q.range.blockNumber === original.range.blockNumber));
  return { first: first.directory, resumed: resumed.directory, firstCounts: first.counts, cumulativeCounts: resumed.counts, tokenUsage: resumed.tokenUsage };
});

await scenario('real-cancelled-request-retains-budget', async () => {
  const ctl = new AbortController(); let requests = 0;
  const limited: RequestModel = async r => {
    requests++; const pending = request(r);
    if (requests !== 2) return pending;
    const timer = setTimeout(() => ctl.abort(new Error('Live acceptance cancellation')), 25);
    try { return await pending; } finally { clearTimeout(timer); }
  };
  const first = await run({ request: limited, signal: ctl.signal, limits: { maxModelRequests: 2 } });
  assert.equal(first.status, 'cancelled'); assert.equal(first.counts.models, 2); assert.equal(first.resumable, true);
  let called = false;
  const resumed = await run({ input: '', sessionId: first.sessionId, resumeRunId: first.runId,
    request: async r => { called = true; return request(r); } });
  assert.equal(resumed.status, 'exhausted'); assert.equal(called, false);
  assert.equal(resumed.counts.models, 2); assert.equal(resumed.counts.http, first.counts.http);
  return { first: first.directory, resumed: resumed.directory, counts: resumed.counts, tokenUsage: resumed.tokenUsage };
});
console.log(`Evidence: ${root}`);

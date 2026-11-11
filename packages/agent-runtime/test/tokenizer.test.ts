import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureContext } from '../src/context.js';

async function worker() {
  const { createLocalTokenCounter } = await import('../src/tokenizer.js');
  const dir = await mkdtemp(join(tmpdir(), 'ledger-tokenizer-'));
  const path = join(dir, 'worker.mjs');
  await writeFile(path, `import { createInterface } from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const { id, payload } = JSON.parse(line);
 const text=payload.messages[0].content;
 if(text==='hang') continue;
 if(text==='exit') process.exit(1);
 if(text==='bad') { console.log('garbage'); continue; }
 if(process.env.DEEPSEEK_API_KEY || payload.headers || payload.key) process.exit(2);
 console.log(JSON.stringify({id,tokens:17,encoding:'v41',revision:'935817c66f5d6e64838f419692545f06787e485f'}));
}`);
  const counter = createLocalTokenCounter({ model: 'deepseek-flash', python: process.execPath, workerPath: path, assetsDirectory: dir, timeoutMs: 200 });
  return { counter, close: async () => { counter.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('local worker transports counts, reuses the process and excludes credentials', async () => {
  const h = await worker();
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'offline-test-secret';
  try {
    for (const content of ['hello', '中文']) {
      const result = await h.counter.count([{ role: 'user', content }], []);
      assert.equal(result.tokens, 17); assert.equal(result.method, 'local_tokenizer'); assert.equal(result.encoding, 'v41');
    }
    h.counter.close();
    await assert.rejects(h.counter.count([{ role: 'user', content: 'again' }], []));
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous;
    await h.close();
  }
});

test('worker timeout, exit and malformed replies settle and fall back to estimates', async () => {
  for (const content of ['hang', 'exit', 'bad']) {
    const h = await worker();
    try {
      const result = await measureContext([{ role: 'user', content }], [], h.counter.count);
      assert.equal(result.method, 'estimated'); assert.equal(result.fallback, 'TOKENIZER_UNAVAILABLE');
      const again = await measureContext([{ role: 'user', content: 'hello' }], [], h.counter.count);
      assert.equal(again.method, 'estimated');
    } finally { await h.close(); }
  }
});

test('cancelling the worker rejects pending work without an estimated success', async () => {
  const h = await worker(); const ctl = new AbortController();
  try {
    const pending = measureContext([{ role: 'user', content: 'hang' }], [], h.counter.count, ctl.signal);
    ctl.abort(); await assert.rejects(pending);
  } finally { await h.close(); }
});

test('missing local installation does not prevent estimated capacity checks', async () => {
  const { createLocalTokenCounter } = await import('../src/tokenizer.js');
  const h = createLocalTokenCounter({ model: 'deepseek-flash', python: '/not-a-python', assetsDirectory: '/not-installed' });
  try {
    const result = await measureContext([{ role: 'user', content: 'hello' }], [], h.count);
    assert.equal(result.method, 'estimated');
  } finally { h.close(); }
});

test('official offline worker counts both model templates including special-token text', { skip: process.env.LEDGERSCOUT_TEST_TOKENIZER !== '1' }, async () => {
  const { createLocalTokenCounter } = await import('../src/tokenizer.js');
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    const h = createLocalTokenCounter({ model });
    try {
      for (const [content, tokens] of [['Hello', 5], ['查询 ETH 余额', 8], ['<｜begin▁of▁sentence｜>', 16]] as const) {
        const result = await h.count([{ role: 'user', content }], []);
        assert.equal(result.tokens, tokens); assert.equal(result.method, 'local_tokenizer');
      }
      const tools = [{ name: 'get_eth_balance', description: 'Balance', parameters: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } }];
      const result = await h.count([{ role: 'user', content: 'Balance?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_eth_balance', arguments: { address: '0x' + '1'.repeat(40) } }] },
        { role: 'tool', content: '{"wei":"1"}', callId: 'c1', name: 'get_eth_balance' }], tools);
      assert.ok(result.tokens > 50); assert.equal(result.encoding, model === 'deepseek-flash' ? 'v41' : 'v4');
    } finally { h.close(); }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as context from '../src/context.js';
import type { ChatMessage, ToolDefinition } from '../src/types.js';

const schema: ToolDefinition[] = [{ name: 'query', description: 'x'.repeat(1500), parameters: { type: 'object' } }];
test('tool schemas cannot silently exceed the model input capacity', () => {
  assert.throws(() => context.fitContext([{ role: 'user', content: 'hello' }], 1000, { tools: schema, maxTokens: 10000 }), /CONTEXT_TOO_LARGE/);
});
test('token capacity removes complete old rounds while retaining the current tool batch', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'rules' },
    { role: 'user', content: 'old'.repeat(300) }, { role: 'assistant', content: 'old answer' },
    { role: 'user', content: '余额' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'query', arguments: {} }] },
    { role: 'tool', content: 'result', callId: 'c', name: 'query' }];
  const result = context.fitContext(messages, 24000, { maxTokens: 600 });
  assert.equal(result.length, 4); assert.equal(result[1]?.content, '余额');
  assert.equal(result.at(-1)?.callId, 'c');
  assert.throws(() => context.fitContext(messages.slice(2), 24000, { maxTokens: 10 }), /CONTEXT_TOO_LARGE/);
});
test('capacity reporting labels multilingual and schema counts as estimates', () => {
  const report = context.estimateContext([{ role: 'user', content: 'hello 余额🙂' }], schema);
  assert.equal(report.method, 'estimated');
  assert.ok(report.tokens >= 1500); assert.ok(report.bytes > 1500);
});

test('history summary survives old-round removal without gaining system privileges', () => {
  const result = context.fitContext([{ role: 'system', content: 'rules' },
    { role: 'assistant', content: '研究意图摘要' },
    { role: 'user', content: 'x'.repeat(2000) }, { role: 'assistant', content: 'old answer' },
    { role: 'user', content: '继续' }], 1000, { maxTokens: 1000 });
  assert.equal(result.length, 3); assert.equal(result[1]?.role, 'assistant');
  assert.equal(result[1]?.content, '研究意图摘要'); assert.equal(result[2]?.content, '继续');
});

test('async capacity uses tokenizer result with tools instead of byte-derived token estimate', async () => {
  const messages: ChatMessage[] = [{ role: 'user', content: '中'.repeat(500) }];
  const fitted = await context.fitContextAsync(messages, 24000, { tools: schema, maxTokens: 100,
    counter: async (m, t) => {
      assert.equal(m[0]?.content, messages[0]?.content); assert.equal(t[0]?.name, 'query');
      return { tokens: 80, method: 'local_tokenizer', encoding: 'v41', revision: 'pinned' };
    } });
  assert.equal(fitted.messages.length, 1); assert.equal(fitted.measurement.tokens, 80);
  assert.equal(fitted.measurement.method, 'local_tokenizer');
});

test('async counter failure falls back to estimates and keeps tool-call pairs', async () => {
  const fitted = await context.fitContextAsync([{ role: 'user', content: 'x'.repeat(2000) },
    { role: 'assistant', content: 'old' }, { role: 'user', content: 'now' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'query', arguments: {} }] },
    { role: 'tool', content: 'ok', callId: 'c', name: 'query' }], 24000, { maxTokens: 600, counter: async () => { throw new Error('unavailable'); } });
  assert.equal(fitted.messages.length, 3); assert.equal(fitted.messages[2]?.callId, 'c');
  assert.equal(fitted.measurement.method, 'estimated'); assert.equal(fitted.measurement.fallback, 'TOKENIZER_UNAVAILABLE');
});

test('async measurement cancellation cannot degrade into an estimated successful request', async () => {
  const ctl = new AbortController();
  await assert.rejects(context.measureContext([{ role: 'user', content: 'now' }], [], async () => {
    ctl.abort(); throw new Error('cancelled');
  }, ctl.signal));
});

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

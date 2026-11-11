import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRequest } from '../src/types.js';
const key = 'offline-deepseek-secret';
const request: ModelRequest = { messages: [{ role: 'user', content: 'query' }], tools: [] };
test('DeepSeek adapter uses official endpoint and returns validated function arguments', async () => {
  const { createDeepSeekRequest } = await import('../src/model.js');
  let payload: any;
  const call = createDeepSeekRequest({ key, model: 'deepseek-flash' }, (async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
    assert.equal(init?.redirect, 'error'); payload = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_eth_balance', arguments: '{"address":"0x1111111111111111111111111111111111111111"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  }) as typeof fetch);
  const r = await call({ ...request, tools: [{ name: 'get_eth_balance', description: 'balance', parameters: { type: 'object', properties: {} } }] });
  assert.equal(payload.model, 'deepseek-flash'); assert.equal(payload.thinking.type, 'disabled');
  assert.equal(r.toolCalls?.[0]?.id, 'c1'); assert.equal(r.usage?.totalTokens, 15);
  assert.ok(!JSON.stringify(r).includes(key));
});

test('DeepSeek wire messages preserve tool-call identities and no synthetic tool results', async () => {
  const { createDeepSeekRequest } = await import('../src/model.js');
  const call = createDeepSeekRequest({ key, model: 'deepseek-flash' }, (async (_url, init) => {
    const p = JSON.parse(String(init?.body));
    assert.equal(p.messages[1].tool_calls[0].id, 'c');
    assert.equal(p.messages[2].tool_call_id, 'c');
    assert.equal(p.tool_choice, 'none'); assert.equal(p.tools, undefined);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] });
  }) as typeof fetch);
  await call({ tools: [], messages: [{ role: 'user', content: 'query' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'balance', arguments: {} }] },
    { role: 'tool', content: '{"ok":true}', callId: 'c', name: 'balance' }] });
});

test('DeepSeek credentials, authentication errors and malformed responses never leak secrets', async () => {
  const { createDeepSeekRequest } = await import('../src/model.js');
  assert.throws(() => createDeepSeekRequest({ key: '', model: 'deepseek-flash' }), /DEEPSEEK_API_KEY/);
  const auth = createDeepSeekRequest({ key, model: 'deepseek-flash' }, (async () => new Response(key, { status: 401 })) as typeof fetch);
  await assert.rejects(auth(request), (e: any) => !e.retryable && !e.message.includes(key));
  const limited = createDeepSeekRequest({ key, model: 'deepseek-flash' }, (async () => new Response(key, { status: 429 })) as typeof fetch);
  await assert.rejects(limited(request), (e: any) => e.retryable === true && !e.message.includes(key));
  const malformed = createDeepSeekRequest({ key, model: 'deepseek-flash' }, (async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '',
    tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{bad' } }] } }] })) as typeof fetch);
  await assert.rejects(malformed(request), /invalid|malformed/i);
});

test('DeepSeek adapter honours a parent abort and redacts response echoes', async () => {
  const { createDeepSeekRequest } = await import('../src/model.js');
  const ctl = new AbortController(); ctl.abort();
  const call = createDeepSeekRequest({ key, model: 'deepseek-flash' }, (async () => { throw new Error('must not fetch'); }) as typeof fetch);
  await assert.rejects(call({ ...request, signal: ctl.signal }));
  const echo = createDeepSeekRequest({ key, model: 'deepseek-flash' }, (async () => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: key } }] })) as typeof fetch);
  assert.equal((await echo(request)).content, '[REDACTED]');
});

test('per-request output reserve caps the provider payload and invalid limits never fetch', async () => {
  const { createDeepSeekRequest } = await import('../src/model.js');
  let calls = 0;
  const call = createDeepSeekRequest({ key, model: 'deepseek-flash' }, (async (_url, init) => {
    calls++; assert.equal(JSON.parse(String(init?.body)).max_tokens, 500);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] });
  }) as typeof fetch);
  await call({ ...request, maxOutputTokens: 500 });
  for (const maxOutputTokens of [0, -1, NaN, 1.5]) await assert.rejects(call({ ...request, maxOutputTokens }), /output limit/i);
  assert.equal(calls, 1);
});

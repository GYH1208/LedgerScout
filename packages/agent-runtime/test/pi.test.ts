import test from 'node:test';
import assert from 'node:assert/strict';

test('Pi boundary executes tools and preserves call IDs through follow-up', async () => {
  const { runPi } = await import('../src/engine/pi.js');
  let turn = 0;
  const events: string[] = [];
  const result = await runPi({
    messages: [{ role: 'user', content: 'query' }], maxRequests: 8,
    tools: [{ name: 'count', description: 'count', parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ count: 7 }) }],
    request: async request => {
      if (++turn === 1) return { content: '', toolCalls: [{ id: 'call-1', name: 'count', arguments: {} }] };
      const tool = request.messages.find(m => m.role === 'tool');
      assert.equal(tool?.callId, 'call-1'); assert.match(tool?.content ?? '', /"count":7/);
      return { content: 'done' };
    },
    onEvent: async e => { events.push(e.type); },
  });
  assert.equal(result.content, 'done'); assert.equal(result.requests, 2);
  assert.ok(events.indexOf('tool_execution_start') < events.indexOf('tool_execution_end'));
});

test('Pi boundary rejects additional arguments before side effects', async () => {
  const { runPi } = await import('../src/engine/pi.js');
  let executed = false; let turn = 0;
  await runPi({ messages: [{ role: 'user', content: 'query' }], maxRequests: 3,
    tools: [{ name: 'count', description: 'count', parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => { executed = true; return {}; } }],
    request: async () => ++turn === 1 ? { content: '', toolCalls: [{ id: 'x', name: 'count', arguments: { extra: 1 } }] } : { content: 'done' },
  });
  assert.equal(executed, false);
});

test('final model slot disables tools even if provider returns a tool anyway', async () => {
  const { runPi } = await import('../src/engine/pi.js');
  let executed = false;
  const result = await runPi({ messages: [{ role: 'user', content: 'query' }], maxRequests: 1,
    tools: [{ name: 'count', description: 'count', parameters: { type: 'object', properties: {} },
      execute: async () => { executed = true; return {}; } }],
    request: async request => { assert.equal(request.tools.length, 0); return { content: '', toolCalls: [{ id: 'x', name: 'count', arguments: {} }] }; },
  });
  assert.equal(executed, false); assert.equal(result.requests, 1); assert.equal(result.exhausted, true);
});

test('cancellation settles an uncooperative pending model without new tools', async () => {
  const { runPi } = await import('../src/engine/pi.js');
  const controller = new AbortController();
  const pending = runPi({ messages: [{ role: 'user', content: 'query' }], tools: [], maxRequests: 8,
    signal: controller.signal, request: async () => { controller.abort(); return new Promise(() => {}); },
  });
  await assert.rejects(pending, /cancel|abort/i);
});

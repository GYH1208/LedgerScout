import test from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory } from '../src/compaction.js';

const turns = Array.from({ length: 6 }, (_, i) => ({ user: `研究问题${i}: ` + 'x'.repeat(600), assistant: 'y'.repeat(600) }));
test('summary sources fit the request budget and preserve unsummarized rounds', async () => {
  const result = await compactHistory({ turns, summary: '之前的意图', maxBytes: 4000, maxTokens: 4000, summarize: async r => {
    const source = JSON.parse(r.messages[1]!.content);
    assert.equal(source.previousSummary, '之前的意图'); assert.equal(source.turns.length, 2);
    assert.equal(r.tools.length, 0); assert.ok(!JSON.stringify(source).includes('研究问题5'));
    return { content: '{"summary":"延续研究方向，尚需区块范围"}' };
  } });
  assert.equal(result.compacted, 2); assert.equal(result.turns.length, 4);
  assert.equal(result.turns[0]!.user, turns[2]!.user);
});
test('truncated, oversized or tool-calling summaries never replace the source history', async () => {
  for (const reply of [{ content: '{"summary":"意图"}', truncated: true },
    { content: JSON.stringify({ summary: '中'.repeat(2001) }) },
    { content: '{"summary":"意图"}', toolCalls: [{ id: 'c', name: 'query', arguments: {} }] }]) {
    await assert.rejects(compactHistory({ turns, maxBytes: 24000, maxTokens: 10000, summarize: async () => reply }), /summary/i);
  }
  assert.equal(turns.length, 6);
});

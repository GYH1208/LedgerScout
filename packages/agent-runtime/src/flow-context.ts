import type { ChatMessage } from './types.js';
import { maskEnsNames } from '@ledgerscout/chain-data';

export const isFlowAnalysisRequest = (input: string) =>
  /资金流|净流|净额|主要往来|对手方|funds?[ -]?flows?|cash[ -]?flows?|net[ -]?flows?|counterpart(?:y|ies)|\b(?:inflows?|outflows?)\b|流入.*流出|流出.*流入/i.test(maskEnsNames(input));

/** Preserve tool pairs and IDs, retaining full detail only for the latest result.
 * Earlier readonly flow results can be reread from immutable query evidence. */
export function compactFlowContext(messages: ChatMessage[]): ChatMessage[] {
  const related = (m: ChatMessage) => {
    if (m.role !== 'tool') return false;
    if (m.name === 'list_asset_transfers' || m.name === 'analyze_asset_flows') return true;
    return m.name === 'read_query_evidence';
  };
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (related(messages[i]!)) { last = i; break; }
  const compacted = messages.map((m, i) => {
    if (i === last || !related(m)) return m;
    try {
      const value = JSON.parse(m.content);
      if (typeof value.queryId !== 'string') return m;
      return { ...m, content: JSON.stringify({ queryId: value.queryId }) };
    } catch { return m; }
  });
  // Content-only compaction still accumulates call arguments, JSON envelopes
  // and per-message framing. Replace only entire successful, completed older
  // flow batches; never orphan a tool result or remove a mixed/error batch.
  const removed = new Set<number>();
  const refs = new Set<string>();
  for (let i = 0; i < compacted.length; i++) {
    const message = compacted[i]!;
    const calls = message.role === 'assistant' ? message.toolCalls : undefined;
    if (!calls?.length || !calls.every(c => ['list_asset_transfers', 'analyze_asset_flows', 'read_query_evidence'].includes(c.name))) continue;
    let end = i + 1;
    while (end < compacted.length && compacted[end]!.role === 'tool') end++;
    if (end - 1 >= last) continue;
    const results = compacted.slice(i + 1, end);
    if (results.length !== calls.length || !calls.every(c => results.filter(r => r.callId === c.id).length === 1)) continue;
    const ids: string[] = [];
    for (const result of results) {
      try {
        const value = JSON.parse(result.content);
        if (typeof value.queryId !== 'string' || !/^q_[a-zA-Z0-9_-]+$/.test(value.queryId)) break;
        ids.push(value.queryId);
      } catch { break; }
    }
    if (ids.length !== results.length) continue;
    ids.forEach(id => refs.add(id));
    for (let index = i; index < end; index++) removed.add(index);
  }
  if (!removed.size) return compacted;
  let inserted = false;
  const output: ChatMessage[] = [];
  for (let i = 0; i < compacted.length; i++) {
    const message = compacted[i]!;
    if (!removed.has(i)) { output.push(message); continue; }
    if (!inserted) {
      output.push({ role: 'assistant', content: '可重读的历史工具证据索引（完整事实须通过工具读取）：' + JSON.stringify({ queryIds: [...refs] }) });
      inserted = true;
    }
    if (message.role === 'assistant' && message.content) output.push({ role: 'assistant', content: message.content });
  }
  return output;
}

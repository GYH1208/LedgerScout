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
  return messages.map((m, i) => {
    if (i === last || !related(m)) return m;
    try {
      const value = JSON.parse(m.content);
      if (typeof value.queryId !== 'string') return m;
      return { ...m, content: JSON.stringify({ queryId: value.queryId }) };
    } catch { return m; }
  });
}

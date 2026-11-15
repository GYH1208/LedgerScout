import type { RunResult } from '@ledgerscout/agent-runtime';
import type { QueryResult } from '@ledgerscout/chain-data';

export const validId = (value: unknown, prefix: string): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,78}$`).test(value);

export function publicQuery(q: QueryResult) {
  return {
    queryId: q.queryId, kind: q.kind, address: q.address, network: q.network,
    ...(q.kind === 'get_erc20_balance' ? { contractAddress: q.contractAddress } : {}),
    range: q.range, fetchedAt: q.fetchedAt, status: q.status, completeness: q.completeness,
    error: q.error, warnings: q.warnings, evidenceRefs: q.evidenceRefs,
    ...(q.kind === 'get_eth_balance' && q.status !== 'error' ? { balance: { wei: q.data.wei, eth: q.data.eth } } : {}),
    ...(q.kind === 'get_erc20_balance' && q.status !== 'error' ? { tokenBalance: { rawBalance: q.data.rawBalance, decimals: q.data.decimals, amount: q.data.amount } } : {}),
    ...(q.kind === 'list_asset_transfers' ? { counts: { incoming: q.data.incoming?.count ?? 0, outgoing: q.data.outgoing?.count ?? 0 } } : {}),
    ...(q.kind === 'list_normal_transactions' ? { count: q.data.count ?? 0 } : {}),
  };
}
export function publicRun(r: RunResult) {
  return { sessionId: r.sessionId, runId: r.runId, status: r.status, answer: r.answer,
    counts: r.counts, tokenUsage: r.tokenUsage, resumable: Boolean(r.resumable), resumeOf: r.resumeOf,
    error: r.error, warnings: r.warnings, queries: r.queries.map(publicQuery), ensResolutions: r.ensResolutions };
}
export type PublicRun = ReturnType<typeof publicRun>;
export type StoredJob = {
  id: string; sessionId: string; question: string; status: string; runId?: string;
  resumeOf?: string; progress: { type: string; name?: string }[]; error?: string; run?: PublicRun;
};

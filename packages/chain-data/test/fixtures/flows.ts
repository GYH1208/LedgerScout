import type { QueryResult } from '../../src/queries.js';
export const owner = '0x' + '1'.repeat(40);
export const peer = '0x' + '2'.repeat(40);
export const token = '0x' + 'a'.repeat(40);
export const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, hash: '0x' + 'a'.repeat(64),
  blockNumber: '10', direction: 'incoming', from: peer, to: owner, category: 'external', asset: 'ETH',
  rawValue: '0x1', decimalsHex: '0x12', tokenAddress: null, approximateValue: 999999, ...extra });
export function flowQuery(incoming: Record<string, unknown>[] = [], outgoing: Record<string, unknown>[] = [], complete = true): QueryResult {
  const direction = (transfers: Record<string, unknown>[]) => ({ transfers, count: transfers.length, complete,
    stopReason: complete ? 'exhausted' : 'limit', byCategory: { external: transfers.length, internal: 0, erc20: 0 } });
  return { schemaVersion: 1, queryId: 'q_flow', kind: 'list_asset_transfers', sessionId: 's_flow', runId: 'r_flow', toolCallId: 'flow',
    network: 'Ethereum Mainnet', address: owner, range: { startBlock: 0, endBlock: 10 }, fetchedAt: '2026-11-12T01:00:00Z',
    status: complete ? 'ok' : 'partial', data: { incoming: direction(incoming), outgoing: direction(outgoing) },
    completeness: { complete, stopReason: complete ? 'exhausted' : 'partial' }, evidenceRefs: [], warnings: [] };
}

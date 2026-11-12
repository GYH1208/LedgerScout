import { formatWei, type QueryResult } from '@ledgerscout/chain-data';
type Claim = { queryId: string; field: string; recordId?: string };
export type AnswerDraft = { kind: 'answer' | 'clarification' | 'unsupported'; queryIds?: string[]; claims?: Claim[]; message?: string; interpretation?: string };
const fields = new Set(['eth', 'wei', 'count', 'incoming.count', 'outgoing.count', 'categories', 'transaction']);
export function parseAnswer(text: string, queries: QueryResult[]): AnswerDraft {
  const source = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const value = JSON.parse(source) as AnswerDraft;
  if (!value || !['answer', 'clarification', 'unsupported'].includes(value.kind)) throw new Error('Invalid answer kind');
  if (Object.keys(value).some(k => !['kind', 'queryIds', 'claims', 'message', 'interpretation'].includes(k))) throw new Error('Unexpected answer field');
  if (value.kind !== 'answer') {
    if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 2000) throw new Error('Missing clarification');
    return value;
  }
  if (!Array.isArray(value.queryIds) || !value.queryIds.length || value.queryIds.length > 12 || !Array.isArray(value.claims) || !value.claims.length || value.claims.length > 30) throw new Error('Missing evidence claims');
  const ids = new Set(value.queryIds);
  if (value.queryIds.some(id => typeof id !== 'string' || !queries.some(q => q.queryId === id))) throw new Error('Unknown query reference');
  for (const claim of value.claims) {
    if (!claim || !ids.has(claim.queryId) || !fields.has(claim.field) || Object.keys(claim).some(k => !['queryId', 'field', 'recordId'].includes(k))) throw new Error('Invalid fact reference');
    claimText(claim, queries.find(q => q.queryId === claim.queryId)!);
  }
  if (value.interpretation !== undefined && (typeof value.interpretation !== 'string' || value.interpretation.length > 2000)) throw new Error('Invalid interpretation');
  return value;
}
function claimText(claim: Claim, q: QueryResult): string {
  if (q.status === 'error') throw new Error('Failed query cannot supply facts');
  if (claim.field === 'eth' || claim.field === 'wei') {
    if (q.kind !== 'get_eth_balance' || typeof q.data.wei !== 'string' || !/^\d+$/.test(q.data.wei) || formatWei(q.data.wei) !== q.data.eth) throw new Error('Invalid balance evidence');
    return claim.field === 'eth' ? `ETH 余额：${q.data.eth} ETH` : `ETH 余额：${q.data.wei} wei`;
  }
  if (claim.field === 'count') {
    if (q.kind !== 'list_normal_transactions' || !Number.isSafeInteger(q.data.count)) throw new Error('Invalid count evidence');
    return `已获取普通交易：${q.data.count} 条`;
  }
  if (claim.field === 'incoming.count' || claim.field === 'outgoing.count') {
    const direction = claim.field.split('.')[0]!;
    if (q.kind !== 'list_asset_transfers' || !Number.isSafeInteger(q.data[direction]?.count)) throw new Error('Invalid transfer evidence');
    return `已获取${direction === 'incoming' ? '流入' : '流出'}转账：${q.data[direction].count} 条`;
  }
  if (claim.field === 'categories') {
    if (q.kind !== 'list_asset_transfers') throw new Error('Invalid category evidence');
    return ['incoming', 'outgoing'].map(d => `${d === 'incoming' ? '流入' : '流出'}类别：外部 ETH ${q.data[d].byCategory.external}，内部 ETH ${q.data[d].byCategory.internal}，ERC20 ${q.data[d].byCategory.erc20}`).join('\n');
  }
  const records = q.kind === 'list_normal_transactions' ? q.data.transactions : [...(q.data.incoming?.transfers ?? []), ...(q.data.outgoing?.transfers ?? [])];
  const record = records?.find((r: any) => (r.id ?? r.hash) === claim.recordId);
  if (!record || !/^0x[0-9a-fA-F]{64}$/.test(record.hash)) throw new Error('Unknown record');
  return `交易：${record.hash}${typeof record.failed === 'boolean' ? `（${record.failed ? '失败' : '成功'}）` : `（${record.direction} ${record.category}）`} https://etherscan.io/tx/${record.hash}`;
}
function section(q: QueryResult, claims: Claim[]) {
  const range = q.range.blockNumber !== undefined ? `区块 ${q.range.blockNumber}` : `区块 ${q.range.startBlock ?? '?'}–${q.range.endBlock ?? '?'}`;
  const w = q.range.timeWindow ?? q.range.requestedTimeWindow;
  const time = (n: number) => new Date((n + 8 * 3600) * 1000).toISOString().replace('T', ' ').replace('.000Z', '');
  const window = w ? `\n目标时间：${time(w.startTimestamp)} 至 ${time(w.endTimestamp)}（北京时间 Asia/Shanghai，含首尾秒）${w.clipped ? '；末端已截到查询时刻' : ''}` : '';
  const header = `Ethereum Mainnet | 地址 ${q.address}\n${range} | 获取时间 ${q.fetchedAt}${window}\n证据：${q.queryId}`;
  if (q.status === 'error') return `${header}\n查询失败：${q.error?.code ?? 'ERROR'} ${q.error?.message ?? ''}`;
  const facts = claims.map(c => claimText(c, q));
  const completeness = q.completeness.complete ? '该查询声明范围已遍历完成。' : '仅获取部分历史，未覆盖完整查询范围。';
  const directions = q.kind === 'list_asset_transfers' ? ['incoming', 'outgoing'].map(d => `${d === 'incoming' ? '流入' : '流出'}：${q.data[d].complete ? '范围完成' : '部分历史'}，停止原因 ${q.data[d].stopReason}`).join('；') : `停止原因：${q.completeness.stopReason}`;
  return `${header}\n${facts.join('\n')}\n${completeness}\n${directions}${q.error ? `\n异常：${q.error.code} ${q.error.message}` : ''}`;
}
export function renderAnswer(draft: AnswerDraft, queries: QueryResult[]): string {
  if (draft.kind !== 'answer') return draft.message!;
  const selected = queries.filter(q => draft.queryIds!.includes(q.queryId));
  return selected.map(q => section(q, draft.claims!.filter(c => c.queryId === q.queryId))).join('\n\n') +
    (draft.interpretation ? `\n\n解释与假设：${draft.interpretation}` : '');
}
export function fallbackAnswer(queries: QueryResult[], reason = ''): string {
  const text = queries.map(q => {
    const fields = q.kind === 'get_eth_balance' ? ['eth', 'wei'] : q.kind === 'list_normal_transactions' ? ['count'] : ['incoming.count', 'outgoing.count', 'categories'];
    return section(q, q.status === 'error' ? [] : fields.map(field => ({ queryId: q.queryId, field })));
  }).join('\n\n');
  return [text, reason].filter(Boolean).join('\n\n') || '未取得可用于回答的数据。';
}

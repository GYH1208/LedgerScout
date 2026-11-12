import type { QueryResult } from './queries.js';

export type FlowAmount = { count: number; knownCount: number; missingCount: number; raw: string; amount: string | null; recordIds: string[] };
export type FlowPeerAmount = { address: string; incoming: FlowAmount; outgoing: FlowAmount };
export type FlowAsset = {
  key: string; symbol: string | null; tokenAddress: string | null; decimals: number | null;
  precisionStatus: 'known' | 'missing' | 'conflict'; incoming: FlowAmount; outgoing: FlowAmount; self: FlowAmount;
  netRaw: string; netAmount: string | null; amountsComplete: boolean;
  topIncoming: FlowPeerAmount[]; topOutgoing: FlowPeerAmount[];
};
export type FlowCounterparty = { address: string; transferCount: number; incomingCount: number; outgoingCount: number; recordIds: string[] };
export type FlowAnalysis = {
  schemaVersion: 1; sourceQueryId: string; address: string; complete: boolean;
  coverage: { incoming: { complete: boolean; stopReason: string }; outgoing: { complete: boolean; stopReason: string } };
  counts: { incoming: number; outgoing: number; self: number }; assets: FlowAsset[]; counterparties: FlowCounterparty[];
  unidentifiedAssetCount: number; unknownCounterpartyCount: number; excludedRecordIds: string[];
  issues: { recordId: string; code: string }[];
};
type Entry = { id: string; direction: 'incoming' | 'outgoing' | 'self'; peer: string | null; raw: bigint | null; decimals: number | null; source: Record<string, any> };
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const rawAmount = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null;
const precision = (v: unknown) => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,4}$/.test(v)) return null;
  const n = Number(BigInt(v)); return n <= 255 ? n : null;
};
export const flowRecordFingerprint = (source: Record<string, any>) => JSON.stringify([
  String(source.from).toLowerCase(), String(source.to).toLowerCase(), source.category,
  String(source.tokenAddress).toLowerCase(), rawAmount(source.rawValue)?.toString() ?? source.rawValue,
  precision(source.decimalsHex), source.hash, source.blockNumber,
]);
export function formatUnits(raw: bigint, decimals: number): string {
  const sign = raw < 0n ? '-' : ''; const absolute = raw < 0n ? -raw : raw; const scale = 10n ** BigInt(decimals);
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return sign + (absolute / scale).toString() + (fraction ? '.' + fraction : '');
}
function amount(rows: Entry[], decimals: number | null): FlowAmount {
  const known = rows.filter(r => r.raw !== null); const raw = known.reduce((sum, r) => sum + r.raw!, 0n);
  return { count: rows.length, knownCount: known.length, missingCount: rows.length - known.length,
    raw: raw.toString(), amount: decimals === null ? null : formatUnits(raw, decimals), recordIds: rows.map(r => r.id) };
}

/** Monetary facts always come from full retrieved records, never approximateValue. */
export function analyzeFlows(query: QueryResult): FlowAnalysis {
  if (query.kind !== 'list_asset_transfers' || query.status === 'error' || !address(query.address) ||
    !Array.isArray(query.data.incoming?.transfers) || !Array.isArray(query.data.outgoing?.transfers)) throw new Error('INVALID_ARGUMENT: flow analysis requires usable transfer evidence');
  const owner = query.address.toLowerCase(); const report: FlowAnalysis = {
    schemaVersion: 1, sourceQueryId: query.queryId, address: owner, complete: query.completeness.complete,
    coverage: { incoming: { complete: query.data.incoming.complete, stopReason: query.data.incoming.stopReason },
      outgoing: { complete: query.data.outgoing.complete, stopReason: query.data.outgoing.stopReason } },
    counts: { incoming: 0, outgoing: 0, self: 0 }, assets: [], counterparties: [],
    unidentifiedAssetCount: 0, unknownCounterpartyCount: 0, excludedRecordIds: [], issues: [],
  };
  const unique = new Map<string, { source: Record<string, any>; fingerprint: string }>();
  const conflicts = new Set<string>([...(query.data.incoming.conflictingRecordIds ?? []), ...(query.data.outgoing.conflictingRecordIds ?? [])]);
  for (const source of [...query.data.incoming.transfers, ...query.data.outgoing.transfers] as Record<string, any>[]) {
    if (!source || typeof source.id !== 'string' || !source.id) throw new Error('INVALID_ARGUMENT: transfer evidence lacks record identity');
    const fingerprint = flowRecordFingerprint(source);
    const previous = unique.get(source.id);
    if (previous && previous.fingerprint !== fingerprint) conflicts.add(source.id);
    else if (!previous) unique.set(source.id, { source, fingerprint });
  }
  const groups = new Map<string, Entry[]>(); const peers = new Map<string, FlowCounterparty>();
  for (const [id, { source }] of unique) {
    if (conflicts.has(id)) { report.excludedRecordIds.push(id); report.issues.push({ recordId: id, code: 'CONFLICTING_ID' }); continue; }
    const from = address(source.from) ? source.from.toLowerCase() : null;
    const to = address(source.to) ? source.to.toLowerCase() : null;
    const direction = from === owner && to === owner ? 'self' : to === owner ? 'incoming' : from === owner ? 'outgoing' : null;
    if (!direction || !['external', 'internal', 'erc20'].includes(source.category)) {
      report.excludedRecordIds.push(id); report.issues.push({ recordId: id, code: 'INVALID_TRANSFER_SCOPE' }); continue;
    }
    report.counts[direction]++;
    const peer = direction === 'self' ? null : direction === 'incoming' ? from : to;
    if (direction !== 'self') {
      if (!peer) report.unknownCounterpartyCount++;
      else {
        const p = peers.get(peer) ?? { address: peer, transferCount: 0, incomingCount: 0, outgoingCount: 0, recordIds: [] };
        p.transferCount++; p[direction === 'incoming' ? 'incomingCount' : 'outgoingCount']++; p.recordIds.push(id); peers.set(peer, p);
      }
    }
    const native = source.category !== 'erc20';
    if (!native && !address(source.tokenAddress)) { report.unidentifiedAssetCount++; report.issues.push({ recordId: id, code: 'MISSING_TOKEN_CONTRACT' }); continue; }
    const key = native ? 'eth' : `erc20:${source.tokenAddress.toLowerCase()}`;
    const entry: Entry = { id, direction, peer, raw: rawAmount(source.rawValue), decimals: native ? 18 : precision(source.decimalsHex), source };
    if (entry.raw === null) report.issues.push({ recordId: id, code: 'MISSING_OR_INVALID_AMOUNT' });
    if (entry.decimals === null) report.issues.push({ recordId: id, code: 'MISSING_OR_INVALID_PRECISION' });
    const entries = groups.get(key) ?? []; entries.push(entry); groups.set(key, entries);
  }
  for (const [key, rows] of groups) {
    const precisions = new Set(rows.flatMap(r => r.decimals === null ? [] : [r.decimals]));
    const precisionStatus = precisions.size > 1 ? 'conflict' : rows.some(r => r.decimals === null) ? 'missing' : 'known';
    const decimals = precisionStatus === 'known' ? rows[0]!.decimals : null;
    if (precisionStatus === 'conflict') for (const r of rows) report.issues.push({ recordId: r.id, code: 'CONFLICTING_PRECISION' });
    const incoming = amount(rows.filter(r => r.direction === 'incoming'), decimals);
    const outgoing = amount(rows.filter(r => r.direction === 'outgoing'), decimals);
    const self = amount(rows.filter(r => r.direction === 'self'), decimals);
    const net = BigInt(incoming.raw) - BigInt(outgoing.raw);
    const peerAmounts: FlowPeerAmount[] = [...new Set(rows.flatMap(r => r.peer ? [r.peer] : []))].map(peer => ({ address: peer,
      incoming: amount(rows.filter(r => r.peer === peer && r.direction === 'incoming'), decimals),
      outgoing: amount(rows.filter(r => r.peer === peer && r.direction === 'outgoing'), decimals) }));
    const ranking = (direction: 'incoming' | 'outgoing') => peerAmounts.filter(p => p[direction].knownCount > 0).sort((a, b) => {
      const x = BigInt(a[direction].raw); const y = BigInt(b[direction].raw);
      return x === y ? a.address.localeCompare(b.address) : x > y ? -1 : 1;
    }).slice(0, 5);
    const symbol = key === 'eth' ? 'ETH' : typeof rows[0]!.source.asset === 'string' ? rows[0]!.source.asset.replace(/\s+/g, ' ').slice(0, 40) : null;
    report.assets.push({ key, symbol, tokenAddress: key === 'eth' ? null : key.slice(6), decimals, precisionStatus,
      incoming, outgoing, self, netRaw: net.toString(), netAmount: decimals === null ? null : formatUnits(net, decimals),
      amountsComplete: precisionStatus === 'known' && rows.every(r => r.raw !== null), topIncoming: ranking('incoming'), topOutgoing: ranking('outgoing') });
  }
  report.assets.sort((a, b) => (b.incoming.count + b.outgoing.count + b.self.count) - (a.incoming.count + a.outgoing.count + a.self.count) || a.key.localeCompare(b.key));
  report.counterparties = [...peers.values()].sort((a, b) => b.transferCount - a.transferCount || a.address.localeCompare(b.address));
  return report;
}

export function previewFlows(report: FlowAnalysis) {
  const preview = { queryId: report.sourceQueryId, complete: report.complete, counts: report.counts,
    assetCount: report.assets.length, counterpartyCount: report.counterparties.length, issueCount: report.issues.length,
    unidentifiedAssetCount: report.unidentifiedAssetCount, excludedRecordCount: report.excludedRecordIds.length,
    assets: report.assets.slice(0, 3).map(a => ({ key: a.key, symbol: a.symbol, incoming: a.incoming.amount,
      outgoing: a.outgoing.amount, net: a.netAmount, amountsComplete: a.amountsComplete, precisionStatus: a.precisionStatus })),
    counterparties: report.counterparties.slice(0, 3).map(p => ({ address: p.address, transferCount: p.transferCount })),
    note: '已取得样本概览；完整结果用flow_assets/flow_counterparties分页读取。',
  };
  while (Buffer.byteLength(JSON.stringify(preview), 'utf8') > 800 && (preview.assets.length || preview.counterparties.length)) {
    if (preview.assets.length >= preview.counterparties.length) preview.assets.pop(); else preview.counterparties.pop();
  }
  return preview;
}

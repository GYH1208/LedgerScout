import { analyzeFlows, type QueryResult, type FlowAmount, type FlowAsset } from '@ledgerscout/chain-data';

const units = (a: FlowAmount, asset: FlowAsset) => a.amount !== null ? a.amount : `${a.raw} 原始单位（精度${asset.precisionStatus === 'conflict' ? '冲突' : '缺失'}，未换算）`;
const records = (ids: string[]) => ids.slice(0, 3).join(', ') + (ids.length > 3 ? `，另${ids.length - 3}条` : '');
export function renderFlowSummary(query: QueryResult): string {
  const r = analyzeFlows(query);
  const lines = [`资金流分析：${r.complete ? '源查询声明范围完成' : '仅已取得样本，部分历史'}；净流量不等于利润或余额变化，不含gas。`,
    `去重后流入 ${r.counts.incoming} 条，流出 ${r.counts.outgoing} 条；自转 ${r.counts.self} 条单列，不参与净额及对手方排名。`];
  for (const a of r.assets.slice(0, 10)) {
    const label = a.tokenAddress ? `${JSON.stringify(a.symbol ?? '未标识')} ERC20 ${a.tokenAddress}` : 'ETH（外部与内部转账）';
    const net = a.netAmount !== null ? a.netAmount : `${a.netRaw} 原始单位（精度${a.precisionStatus === 'conflict' ? '冲突' : '缺失'}，未换算）`;
    const prefix = a.amountsComplete ? '' : '已知小计（金额信息不完整）：';
    lines.push(`${label}\n${prefix}流入 ${units(a.incoming, a)}；流出 ${units(a.outgoing, a)}；净流量 ${net}；自转 ${units(a.self, a)}。`);
    if (!a.amountsComplete) lines.push(`缺失金额：流入${a.incoming.missingCount}、流出${a.outgoing.missingCount}、自转${a.self.missingCount}条；精度状态 ${a.precisionStatus}。已知净额不能代表完整净额。`);
    for (const [direction, peers] of [['incoming', a.topIncoming], ['outgoing', a.topOutgoing]] as const) {
      if (!peers.length) continue;
      lines.push(`本币种${direction === 'incoming' ? '流入' : '流出'}已知金额排名（已取得样本）：`);
      for (const p of peers.slice(0, 3)) lines.push(`  ${p.address}：${units(p[direction], a)}；记录 ${records(p[direction].recordIds)}`);
    }
  }
  if (!r.assets.length) lines.push('没有可归类的币种金额记录。');
  if (r.assets.length > 10) lines.push(`共${r.assets.length}个币种，展示按记录数排序前10个；其余用flow_assets分页读取。`);
  if (r.issues.length) lines.push(`数据质量：${r.issues.length}项；排除冲突/异常记录${r.excludedRecordIds.length}条，未识别币种${r.unidentifiedAssetCount}条，未知对手方${r.unknownCounterpartyCount}条。统计受这些缺口影响。`);
  return lines.join('\n');
}
export function renderCounterparties(query: QueryResult): string {
  const r = analyzeFlows(query);
  const lines = ['主要对手方（按已取得样本的唯一转账记录数排序，自转排除；地址不代表身份归因）：'];
  for (const p of r.counterparties.slice(0, 5)) lines.push(`${p.address}：${p.transferCount}条（流入${p.incomingCount}，流出${p.outgoingCount}）；记录 ${records(p.recordIds)}`);
  if (!r.counterparties.length) lines.push('没有可识别的外部对手方记录。');
  if (r.unknownCounterpartyCount) lines.push(`另${r.unknownCounterpartyCount}条无法识别对手方，未列入排名。`);
  if (r.counterparties.length > 5) lines.push(`共${r.counterparties.length}个对手方，其余用flow_counterparties分页读取。`);
  if (!r.complete) lines.push('部分历史排名仅覆盖已取得样本，不能认定为全窗口最大对手方。');
  return lines.join('\n');
}

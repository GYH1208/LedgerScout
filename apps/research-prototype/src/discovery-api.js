export const DISCOVERY_METRICS = { revenue:'收入', netIncome:'净利润', revenueGrowth:'收入同比增速', netMargin:'净利润率', operatingCashFlow:'经营现金流', freeCashFlow:'自由现金流', revenueTtm:'过去12个月收入', netIncomeTtm:'过去12个月净利润', operatingCashFlowTtm:'过去12个月经营现金流', freeCashFlowTtm:'过去12个月自由现金流', pe:'市盈率', priceReturn21:'21日价格涨跌幅' };

export function parseDiscoverySymbols(input, maximum = 30) {
  const symbols = [...new Set(String(input).trim().toUpperCase().split(/[\s,，;；]+/).filter(Boolean))];
  if (symbols.some(symbol => !/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,2})?$/.test(symbol))) throw Error('请输入有效股票代码。');
  if (symbols.length > maximum) throw Error(`本次最多支持 ${maximum} 家公司。`);
  return symbols;
}
export function selectedDiscoverySymbols(symbols, maximum) {
  const selected = parseDiscoverySymbols(symbols.join(' '), maximum);
  if (!selected.length) throw Error(`请明确选择 1 至 ${maximum} 家公司。`);
  return selected;
}
export function universePayload(expectedVersion, members) {
  parseDiscoverySymbols(members.map(m => m.symbol).join(' '));
  if (members.length > 30) throw Error('发现目录最多 30 家公司。');
  return { expectedVersion, members: members.map(member => ({symbol:member.symbol, ...(member.name ? {name:member.name} : {}), themes:[...member.themes], sources:member.sources.map(source => ({id:source.id, kind:source.kind, url:source.url, allowedHosts:[new URL(source.url).hostname], pathPrefix:source.pathPrefix, maxPages:source.kind === 'index' ? Number(source.maxPages || 1) : 1}))})) };
}
export function draftThesis(job, opportunity) {
  return {title:opportunity.title, statement:opportunity.mechanism, theme:opportunity.theme, symbols:[...new Set(opportunity.candidates.map(c => c.symbol))], sourceJobId:job.id, opportunityId:opportunity.id,
    support:opportunity.support.flatMap(c => c.citations), opposing:opportunity.opposing.flatMap(c => c.citations), gaps:[...new Set([...(job.gaps??[]),...opportunity.gaps])],
    conditions:opportunity.checks.map((description,i) => ({id:`check-${i+1}`,kind:'manual',description})), invalidation:opportunity.invalidation, nextCheck:opportunity.nextCheck, horizonMonths:24};
}
export function thesisPayload(input, confirmed, expectedVersion) {
  if (!confirmed) throw Error('请明确确认研究观点及检查条件。');
  if (!input.title.trim() || !input.statement.trim() || ![12,24].includes(input.horizonMonths)) throw Error('请填写观点标题、判断和观察区间。');
  for (const c of input.conditions) if (c.kind === 'metric' && (!Object.hasOwn(DISCOVERY_METRICS,c.field) || !['gt','gte','lt','lte'].includes(c.op) || !Number.isFinite(c.value) || !c.period?.trim())) throw Error('可计算条件需要已支持指标、比较符、数值与准确期间。');
  return {input,expectedVersion};
}
export function citationDocumentId(chunkId) {
  return typeof chunkId === 'string' ? chunkId.match(/^(.+):c\d+$/)?.[1] ?? null : null;
}
export const isDiscoveryRunning = state => Boolean(state?.busy || state?.activeJob?.status === 'loading');

export function createDiscoveryApi(fetcher = (...args) => fetch(...args)) {
  async function request(path, body, signal) {
    const response = await fetcher(`/api/equity/discovery/${path}`, {signal, ...(body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json','x-ledgerscout-client':'web'},body:JSON.stringify(body)})});
    let value;try {value=await response.json();} catch {throw Error('发现研究服务尚未连接，无法读取真实资料。');}
    if (!response.ok) throw Error(typeof value?.error === 'string' ? value.error : `本地服务请求失败（${response.status}）`);
    return value;
  }
  return {state:signal=>request('state',undefined,signal),document:(id,query='',offset=0)=>request(`documents/${encodeURIComponent(id)}?query=${encodeURIComponent(query)}&offset=${offset}`),thesis:id=>request(`theses/${encodeURIComponent(id)}`),
    universe:body=>request('universe',body),refresh:body=>request('refresh',body),scan:body=>request('scan',body),handoff:body=>request('handoff',body),saveThesis:body=>request('theses',body),review:body=>request('review',body),proposal:(id,body)=>request(`proposals/${encodeURIComponent(id)}`,body),cancel:jobId=>request('cancel',{jobId}),resume:jobId=>request('resume',{jobId})};
}
export const discoveryApi = createDiscoveryApi();

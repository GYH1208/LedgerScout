export function parseSymbols(input, maximum = 10) {
  const symbols = [...new Set(String(input).trim().toUpperCase().split(/[\s,，;；]+/).filter(Boolean))];
  if (symbols.some(symbol => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))) throw new Error('请输入有效股票代码，以逗号或空格分隔。');
  if (symbols.length > maximum) throw new Error(`本次最多支持 ${maximum} 个股票代码。`);
  return symbols;
}

export const isEquityRunning = state => Boolean(state?.busy || state?.activeJob?.status === 'loading');
export function marketReturnPair(row, days) {
  const key=`${days}d`;
  return {value:row.returns?.[key]??null,relative:row.relativeToSpy?.[key]??null};
}
export function refreshProgress(job) {
  const reasons={PERMISSION_DENIED:'供应商权限不足或免费接口未开放',RATE_LIMIT:'供应商限流，已停止',QUOTA_EXHAUSTED:'本应用今日行情额度已用完',HTTP_BUDGET:'本轮数据请求预算已用完',RECORD_FAILED:'证据保存失败，已停止',MISSING_SEC_USER_AGENT:'缺少SEC联系标识'};
  const errors=(job.errors??[]).map(e=>`${e.symbol}：${reasons[e.code]??e.code}`).join('；');
  return `已完成：${job.completed?.join('、')||'尚无'}。剩余：${job.remaining?.join('、')||'无'}。${errors||job.error||''}`;
}

export function createEquityApi(fetcher = (...args) => fetch(...args)) {
  async function request(path, body, signal) {
    const response = await fetcher(`/api/equity/${path}`, {
      signal,
      ...(body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ledgerscout-client': 'web' },
        body: JSON.stringify(body),
      }),
    });
    let value;
    try { value = await response.json(); }
    catch { throw new Error('美股研究服务尚未连接，无法读取真实数据。'); }
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : `本地服务请求失败（${response.status}）`);
    return value;
  }
  return {
    state: signal => request('state', undefined, signal),
    pool: symbols => request('pool', { symbols }),
    refresh: body => request('refresh', body),
    screen: body => request('screen', body),
    research: body => request('research', body),
    cancel: jobId => request('cancel', { jobId }),
    resume: (sessionId, runId) => request('resume', { sessionId, runId }),
    evidence: (jobId, queryId, offset = 0) => request(`evidence/${encodeURIComponent(jobId)}/${encodeURIComponent(queryId)}?offset=${offset}`),
  };
}

export const equityApi = createEquityApi();

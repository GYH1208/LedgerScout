import { useEffect, useRef, useState } from 'react';
import { equityApi, isEquityRunning, parseSymbols, marketReturnPair, refreshProgress } from './equity-api.js';
import './equity.css';
import DiscoveryApp from './DiscoveryApp.jsx';

const PROXIES = ['SPY', 'QQQ', 'XLC', 'XLY', 'XLP', 'XLE', 'XLF', 'XLV', 'XLI', 'XLB', 'XLRE', 'XLK', 'XLU'];
const FIELDS = {
  revenueGrowth: { label: '收入同比增速', unit: '%', percent: true },
  netMargin: { label: '净利润率', unit: '%', percent: true },
  operatingCashFlow: { label: '经营现金流', unit: 'USD' },
  freeCashFlow: { label: '自由现金流', unit: 'USD' },
  pe: { label: '市盈率', unit: '倍' },
  return1d: { label: '1交易日价格涨跌幅', unit: '%', percent: true },
  return5d: { label: '5交易日价格涨跌幅', unit: '%', percent: true },
  priceReturn21: { label: '21日价格涨跌幅', unit: '%', percent: true },
  return63d: { label: '63交易日价格涨跌幅', unit: '%', percent: true },
};
const OPS = { gt: '>', gte: '≥', lt: '<', lte: '≤' };
const STATUS = { loading: '正在研究', completed: '研究完成', partial: '部分完成', failed: '研究失败', cancelled: '已取消', exhausted: '预算耗尽', interrupted: '已中断', awaiting_user: '需要补充信息' };
const DEFAULT_QUESTION = '请根据已取得的公司披露与财务数据，分析业务、财务趋势、估值口径及主要风险，并列明证据和数据缺口。';
const dt = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone:'Asia/Shanghai' }) : '尚未取得';
const num = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
const pct = value => typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
const metricText = (field, metric) => metric?.value == null ? '缺失' : FIELDS[field]?.percent ? pct(metric.value) : `${num(metric.value)} ${metric.unit ?? ''}`;
const stale = date => date && Date.now() - new Date(date).getTime() > 24 * 60 * 60 * 1000;
function Empty({ children }) { return <div className="eq-empty">{children}</div>; }
function Conditions({ filters }) {
  return <div className="eq-conditions">{filters.length ? filters.map((f, i) => <span key={i}>{FIELDS[f.field]?.label ?? f.field} {OPS[f.op]} {num(f.value)} {FIELDS[f.field]?.unit}</span>) : <span>无过滤条件 · 展示本机股票池</span>}</div>;
}
function MetricDetails({ metrics = {} }) {
  return <div className="eq-metric-list">{Object.entries(metrics).map(([field, m]) => <div key={field}><div><strong>{FIELDS[field]?.label ?? field}</strong><b>{metricText(field, m)}</b></div><p>{m.definition}</p><p>{m.period} · 单位 {m.unit} {m.reason && `· ${m.reason}`}</p><p className="eq-mono">来源：{m.sourceRefs?.join('、') || '未提供'}</p></div>)}</div>;
}
function CompanyDetails({ company }) {
  if (!company) return <Empty>选择已有公司快照，查看证券身份、财务口径与原始披露。</Empty>;
  const s = company.security;
  return <><div className="eq-evidence-kicker">公司快照 · {s.symbol}</div><h3>{s.name}</h3><dl className="eq-definition"><dt>证券身份</dt><dd>{s.exchange} · {s.kind === 'common-stock' ? '普通股' : s.kind === 'etf' ? 'ETF' : '不支持的证券类型'}</dd><dt>CIK / 币种</dt><dd>{s.cik || '未取得'} / {s.currency}</dd><dt>行业</dt><dd>{s.sector || '未取得'} · {s.industry || '未取得'}</dd><dt>获取时间</dt><dd>{dt(company.fetchedAt)} {stale(company.fetchedAt) && '· 超过24小时'}</dd><dt>行情日期</dt><dd>{company.prices?.bars?.at(-1)?.date || '未取得'}</dd><dt>价格口径</dt><dd>{{ 'split-adjusted': '拆股复权', unadjusted: '未复权', unknown: '未知' }[company.prices?.adjustment] || '未取得'}</dd></dl>
    {[...(company.warnings ?? []), ...(company.financials?.warnings ?? []), company.financials?.industryExclusion].filter(Boolean).map((w, i) => <p className="eq-warning" key={i}>{w}</p>)}
    <h4>指标定义与期间</h4><MetricDetails metrics={company.metrics} />
    <h4>财务记录</h4>{['annual', 'quarterly'].map(kind => <details key={kind}><summary>{kind === 'annual' ? '年度' : '季度'}财务 · {company.financials?.[kind]?.length ?? 0} 条</summary>{company.financials?.[kind]?.map((p, i) => <div className="eq-financial-point" key={i}><b>{p.metric} · {num(p.value)} {p.unit}</b><p>{p.start || '时点'} 至 {p.end}</p><p>{p.form} · 披露 {p.filed} · {p.accession}</p>{p.derivedFrom?.length > 0 && <p>推导依据：{p.derivedFrom.join('、')}</p>}</div>)}</details>)}
    <h4>近期披露</h4>{company.filings?.length ? company.filings.slice(0, 12).map(f => <p key={f.accession} className="eq-filing">{f.filed} · {f.form}<br />{/^https:\/\/(?:www\.)?sec\.gov\//i.test(f.url) ? <a href={f.url} target="_blank" rel="noreferrer">查看 SEC 原文 ↗</a> : <span>原文链接未验证</span>}</p>) : <p className="eq-muted">尚未取得近期披露。</p>}
    <h4>快照来源</h4>{company.sourceRefs?.map(ref => <p className="eq-source" key={ref.id}>{ref.source} · {dt(ref.fetchedAt)}<br /><span className="eq-mono">{ref.id}</span></p>)}</>;
}
function ResearchTurn({ turn, busy, openEvidence, resume }) {
  return <article className="eq-turn"><div className="eq-question">{turn.question}</div><div className="eq-answer"><div className="eq-answer-title"><span className={turn.status === 'loading' ? 'eq-pulse' : ''} />LedgerScout <span>{STATUS[turn.status] ?? turn.status}</span></div>{turn.status === 'loading' && <p role="status">正在读取可用证据并整理分析，结果将保存在本机。</p>}
    {turn.answer && <><h4>已核验事实</h4>{turn.answer.facts?.length ? <ul>{turn.answer.facts.map((fact, i) => <li key={i}>{fact}</li>)}</ul> : <p className="eq-muted">本轮未取得可核验事实。</p>}<h4>分析</h4><div className="eq-prose">{turn.answer.analysis}</div><h4>数据缺口</h4>{turn.answer.dataGaps?.length ? <ul>{turn.answer.dataGaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul> : <p className="eq-muted">本轮未列出额外数据缺口，请结合证据覆盖判断。</p>}<p className="eq-muted eq-mono">报告引用：{turn.answer.sourceRefs?.join('、') || '无'}</p></>}
    {turn.error && <p className="eq-error">{turn.error}</p>}{!turn.answer && turn.status !== 'loading' && !turn.error && <p className="eq-muted">本轮尚无研究结论。</p>}
    {!!turn.queries?.length && <div className="eq-query-links">{turn.queries.map(q => <button className="eq-link" key={q.queryId} onClick={() => openEvidence(turn.id, q.queryId)}>{q.symbol} · {q.source} ↗</button>)}</div>}
    {turn.counts && <p className="eq-run-counts">模型 {turn.counts.modelRequests} · 工具 {turn.counts.toolCalls} · 数据请求 {turn.counts.dataHttpRequests} · {(turn.counts.elapsedMs / 1000).toFixed(1)} 秒{turn.tokenUsage && ` · Token ${num(turn.tokenUsage.totalTokens)}${turn.tokenUsage.unknownRequests ? `（${turn.tokenUsage.unknownRequests} 次用量未知）` : ''}`}</p>}
    {turn.resumable && turn.status !== 'loading' && <button className="eq-button" disabled={busy} onClick={() => resume(turn)}>继续这次研究</button>}</div></article>;
}

export default function EquityApp({ onEthereum }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [pending, setPending] = useState(false), [tab, setTab] = useState('market');
  const [active, setActive] = useState(null), [symbol, setSymbol] = useState(''), [question, setQuestion] = useState(''), [navOpen, setNavOpen] = useState(false);
  const [poolInput, setPoolInput] = useState(''), [selectedStocks, setSelectedStocks] = useState([]), [screen, setScreen] = useState(null), [screenContext, setScreenContext] = useState(null);
  const [filters, setFilters] = useState([]), [field, setField] = useState('revenueGrowth'), [op, setOp] = useState('gte'), [value, setValue] = useState(''), [sortBy, setSortBy] = useState(''), [descending, setDescending] = useState(true);
  const [discoveryContext,setDiscoveryContext]=useState(null), [panel, setPanel] = useState(null), [notice, setNotice] = useState('');
  const mounted = useRef(false), timer = useRef(), evidenceVersion = useRef(0), poolVersion = useRef(null);
  const busy = pending || isEquityRunning(state), session = state?.sessions?.find(s => s.id === active), turns = session?.turns ?? [];
  async function refreshState(signal) {
    const data = await equityApi.state(signal);
    if (!mounted.current) return data;
    setState(data); setError('');
    if (poolVersion.current !== data.pool?.version) { poolVersion.current = data.pool?.version; setPoolInput(data.pool?.symbols?.join(', ') || ''); }
    return data;
  }
  function schedule(data) {
    clearTimeout(timer.current);
    if (isEquityRunning(data)) timer.current = setTimeout(async () => {
      try { schedule(await refreshState()); } catch (e) { if (mounted.current) setError(e.message); }
    }, 1500);
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    refreshState(controller.signal).then(schedule).catch(e => { if (e.name !== 'AbortError' && mounted.current) setError(e.message); });
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer.current); evidenceVersion.current++; };
  }, []);
  useEffect(() => {
    const closeOnEscape = event => {
      if (event.key === 'Escape') { evidenceVersion.current++; setPanel(null); setNavOpen(false); }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);
  async function action(fn, message) {
    if (pending) return;
    setPending(true); setNotice('');
    try { const result = await fn(); if (mounted.current) { if (message) setNotice(message); schedule(await refreshState()); } return result; }
    catch (e) { if (mounted.current) setNotice(e.message); }
    finally { if (mounted.current) setPending(false); }
  }
  function chooseSession(s) { setDiscoveryContext(null); setActive(s.id); setSymbol(s.symbol); setQuestion(''); setScreenContext(null); setTab('research'); setNavOpen(false); evidenceVersion.current++; setPanel(null); }
  function newResearch() { setDiscoveryContext(null); setActive(null); setSymbol(''); setQuestion(''); setScreenContext(null); setTab('research'); setNavOpen(false); }
  function candidate(match) { setDiscoveryContext(null); setActive(null); setSymbol(match.symbol); setQuestion(''); setScreenContext({ filters: structuredClone(screen.filters), ...(match.snapshotId ? { snapshotId: match.snapshotId } : {}) }); setTab('research'); }
  async function research(event, withRefresh = false) {
    event?.preventDefault(); if (busy) return;
    let ticker;
    try { const symbols = parseSymbols(symbol, 1); if (!symbols.length) throw new Error('请先输入一个准确的股票代码。'); ticker = symbols[0]; }
    catch (e) { setNotice(e.message); return; }
    if (session && ticker !== session.symbol) { setNotice('当前会话的股票固定；请新建研究查询其他股票。'); return; }
    await action(async () => {
      const result = await equityApi.research({ symbol: ticker, question: question.trim() || DEFAULT_QUESTION, ...(active ? { sessionId: active } : {}), ...(screenContext ? { screenContext } : {}), ...(discoveryContext ? { discoveryContext } : {}), ...(withRefresh ? { refresh: true } : {}) });
      if (mounted.current) { setActive(result.sessionId); setSymbol(ticker); setQuestion(''); setDiscoveryContext(null); }
    });
  }
  async function openEvidence(jobId, queryId, offset = 0) {
    const version = ++evidenceVersion.current;
    setPanel({ kind: 'query', jobId, queryId, loading: true });
    try { const data = await equityApi.evidence(jobId, queryId, offset); if (mounted.current && version === evidenceVersion.current) setPanel({ kind: 'query', jobId, queryId, ...data }); }
    catch (e) { if (mounted.current && version === evidenceVersion.current) setPanel({ kind: 'query', error: e.message }); }
  }
  function openCompany(company) { evidenceVersion.current++; setPanel({ kind: 'company', company }); }
  function addFilter() {
    if (value.trim() === '' || !Number.isFinite(Number(value))) { setNotice('筛选条件需要一个有效数字。'); return; }
    setFilters([...filters, { field, op, value: Number(value) }]); setValue(''); setScreen(null);
  }
  async function savePool() {
    try { const symbols = parseSymbols(poolInput); await action(() => equityApi.pool(symbols), '股票池已保存；点击更新才会获取新数据。'); setSelectedStocks([]); setScreen(null); }
    catch (e) { setNotice(e.message); }
  }
  async function refreshStocks() {
    if (!selectedStocks.length || selectedStocks.length > 5) { setNotice('请明确选择 1 至 5 只股票。'); return; }
    await action(() => equityApi.refresh({ kind: 'stocks', symbols: selectedStocks }), '股票更新已提交；下一批需要再次选择并点击更新。');
  }
  const displayedMarket = PROXIES.map(ticker => state?.market?.rows?.find(row => row.symbol === ticker) ?? { symbol: ticker, label: ticker === 'SPY' || ticker === 'QQQ' ? '大盘 ETF 代理' : 'S&P 500 行业 ETF 样本' });
  const missingConfig = state && (!state.configured?.fmp || !state.configured?.twelveData || !state.configured?.sec || !state.configured?.deepseek);
  return <div className="equity-app">
    <aside className={`eq-sidebar ${navOpen ? 'eq-nav-open' : ''}`}><div className="eq-wordmark">LedgerScout</div><p className="eq-sidebar-caption">美股研究 · 本机工作台</p><div className="eq-domain-nav"><button aria-pressed="true">美股</button><button onClick={onEthereum}>链上 ↗</button></div><button className="eq-primary eq-new" onClick={newResearch}>＋ 新建研究</button><div className="eq-history-label">研究会话</div><nav aria-label="美股研究会话">{state?.sessions?.map(s => <button key={s.id} className={`eq-session ${s.id === active ? 'eq-selected' : ''}`} onClick={() => chooseSession(s)} aria-current={s.id === active ? 'page' : undefined}><b>{s.symbol}</b><span>{s.title}</span><small>{dt(s.createdAt)}</small></button>)}{!state?.sessions?.length && <p className="eq-muted">还没有美股研究记录</p>}</nav><div className="eq-sidebar-footer">会话与证据保存在本机<br />浏览历史不更新外部数据</div></aside>
    <div className="eq-workspace"><header className="eq-header"><div><button className="eq-menu eq-button" aria-label="展开研究会话" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>☰</button><span>美股研究</span></div><div className="eq-source-status" aria-label="数据源配置状态"><span className={state?.configured?.sec ? 'eq-ready' : ''}>SEC 披露 {state?.configured?.sec ? '已配置' : '未配置'}</span><span className={state?.configured?.fmp ? 'eq-ready' : ''}>FMP 公司资料 {state?.configured?.fmp ? '已配置' : '未配置'}</span><span className={state?.configured?.twelveData ? 'eq-ready' : ''}>Twelve Data 行情 {state?.configured?.twelveData ? '已配置' : '未配置'}</span></div></header>
      <nav className="eq-tabs" aria-label="美股研究视图">{[['market', '市场概览'], ['screen', '股票池筛选'], ['research', '个股研究'], ['discover','AI 应用发现'], ['theses','研究观点']].map(([key, label]) => <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => { setTab(key); setNavOpen(false); }}>{label}</button>)}</nav>
      <main className="eq-main">
        {error && <div role="alert" className="eq-error eq-banner">{error}<button className="eq-link" onClick={() => action(() => Promise.resolve(), '已重新读取本机状态')}>重新读取本机状态</button></div>}
        {notice && <div role="status" className="eq-notice">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
        {!state && !error && <Empty>正在读取本机研究记录…</Empty>}
        {missingConfig && <div className="eq-config-note"><strong>数据源配置尚未齐全</strong><p>{!state.configured.sec && 'SEC 披露需要真实联系标识。'}{!state.configured.fmp && 'FMP 公司资料尚未配置。'}{!state.configured.twelveData && 'Twelve Data 行情 行情尚未配置。'}{!state.configured.deepseek && 'DeepSeek 分析尚未配置。'}已配置不代表免费权限已通过验证；已有快照仍可浏览。</p></div>}
        {state?.error && <p role="alert" className="eq-error eq-banner">{state.error}</p>}
        {!['discover','theses'].includes(tab)&&state?.activeJob?.kind && <section className="eq-card" aria-live="polite"><strong>{state.activeJob.kind==='market'?'市场更新':'股票更新'} · {STATUS[state.activeJob.status]??state.activeJob.status}</strong><p className="eq-muted">{refreshProgress(state.activeJob)}</p>{state.activeJob.status==='loading'&&<button className="eq-button" disabled={pending} onClick={()=>action(()=>equityApi.cancel(state.activeJob.id),'取消请求已提交；已完成数据保留。')}>取消更新</button>}</section>}
        {['discover','theses'].includes(tab)&&<DiscoveryApp view={tab} onCompany={data=>{setActive(null);setSymbol(data.symbol);setQuestion(data.question);setDiscoveryContext(data.discoveryContext);setScreenContext(null);setTab('research');}}/>}
        {state && tab === 'market' && <><div className="eq-section-heading"><div><p className="eq-eyebrow">MARKET OVERVIEW</p><h1>市场与板块</h1><p>从大盘与行业 ETF 样本发现研究线索。</p></div><button className="eq-button" disabled={busy || !state.capabilities?.market} onClick={() => action(() => equityApi.refresh({ kind: 'market' }), '市场更新已提交。')}>{busy ? '正在处理…' : '更新市场数据'}</button></div><div className="eq-summary-row"><div><span>市场代理覆盖</span><strong>{state.market?.coverage ?? 0}<small> / 13</small></strong></div><div><span>共同可比日期</span><strong>{state.market?.commonDate || '未取得'}</strong></div><div><span>今日 ETF 请求（UTC）</span><strong>{state.marketQuota?.used ?? 0}<small> / {state.marketQuota?.limit ?? '—'}</small></strong></div></div>
          <div className="eq-table-wrap"><table className="eq-market-table"><caption>Twelve Data · 拆股复权 · ETF 价格表现 · 相对 SPY 为相同区间收益率之差</caption><thead><tr><th>ETF 样本</th><th>价格 / 日期</th>{['1', '5', '21', '63'].map(days => <th key={days}>{days} 日<br /><small>涨跌 / 相对 SPY</small></th>)}</tr></thead><tbody>{displayedMarket.map(row => <tr key={row.symbol}><td><b>{row.symbol}</b><small>{row.label}</small>{row.reason && <small className="eq-warning-text">{row.reason}</small>}</td><td>{num(row.price)}<small>{row.asOf || '尚未取得'}</small></td>{['1', '5', '21', '63'].map(days => <td key={days}><span className={(marketReturnPair(row, days).value ?? 0) < 0 ? 'eq-negative' : ''}>{pct(marketReturnPair(row, days).value)}</span><small>{pct(marketReturnPair(row, days).relative)}</small></td>)}</tr>)}</tbody></table></div>
          <div className="eq-footnote">SPY、QQQ 是大盘 ETF 代理；其余 11 只为 S&P 500 行业 ETF 样本，不代表全美股行业。行情保守截止到纽约前一日，更新13只约需100秒。以上为价格收益，非含分红总回报。缺失或口径不可比的区间显示「—」。{state.market && <p>获取时间：{dt(state.market.fetchedAt)} {stale(state.market.fetchedAt) && '· 快照超过24小时，请核对行情日期'}</p>}</div>{state.market?.warnings?.map((w, i) => <p className="eq-warning" key={i}>{w}</p>)}{!state.market && <Empty>尚无市场快照。配置并验证行情权限后，点击「更新市场数据」。</Empty>}</>}
        {state && tab === 'screen' && <><div className="eq-section-heading"><div><p className="eq-eyebrow">YOUR RESEARCH POOL</p><h1>股票池筛选</h1><p>只筛选本机已取得的数据，股票池最多 10 只。</p></div></div><section className="eq-card"><label htmlFor="eq-pool">股票代码（逗号或空格分隔）</label><div className="eq-inline"><input id="eq-pool" value={poolInput} onChange={e => setPoolInput(e.target.value)} placeholder="输入准确股票代码" /><button className="eq-button" disabled={busy} onClick={savePool}>保存股票池</button></div><p className="eq-muted">版本 {state.pool?.version ?? 0} · 修改于 {dt(state.pool?.updatedAt)} · 保存不会自动获取数据。</p><div className="eq-stock-select">{state.pool?.symbols?.map(ticker => <label key={ticker}><input type="checkbox" checked={selectedStocks.includes(ticker)} disabled={busy || (!selectedStocks.includes(ticker) && selectedStocks.length >= 5)} onChange={e => setSelectedStocks(e.target.checked ? [...selectedStocks, ticker] : selectedStocks.filter(s => s !== ticker))} />{ticker}{!state.companies?.some(c => c.security.symbol === ticker) && <small>未取得</small>}</label>)}</div><button className="eq-button" disabled={busy || !selectedStocks.length || (!state.configured.sec || !state.configured.fmp)} onClick={refreshStocks}>更新所选 {selectedStocks.length} 只（每批最多 5 只）</button><p className="eq-muted">每次只处理所选股票。其余股票请明确选择后再次更新。</p></section>
          <section className="eq-card"><h2>组合条件</h2><div className="eq-filter-builder"><select aria-label="筛选指标" value={field} onChange={e => setField(e.target.value)}>{Object.entries(FIELDS).map(([key, f]) => <option key={key} value={key}>{f.label}（{f.unit}）</option>)}</select><select aria-label="比较方式" value={op} onChange={e => setOp(e.target.value)}>{Object.entries(OPS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><input aria-label="筛选阈值" type="number" value={value} onChange={e => setValue(e.target.value)} placeholder={FIELDS[field].percent ? '百分比数值' : FIELDS[field].unit} /><button className="eq-button" onClick={addFilter}>添加</button></div><Conditions filters={filters} />{filters.length > 0 && <button className="eq-link" onClick={() => { setFilters([]); setScreen(null); }}>清空条件</button>}<div className="eq-inline eq-sort"><label>排序 <select aria-label="排序指标" value={sortBy} onChange={e => { setSortBy(e.target.value); setScreen(null); }}><option value="">不排序</option>{Object.entries(FIELDS).map(([key, f]) => <option key={key} value={key}>{f.label}</option>)}</select></label><label><input type="checkbox" checked={descending} onChange={e => { setDescending(e.target.checked); setScreen(null); }} />从高到低</label><button className="eq-primary" disabled={busy} onClick={() => action(async () => { const result = await equityApi.screen({ filters, ...(sortBy ? { sortBy, descending } : {}) }); setScreen(result); })}>筛选本机快照</button></div><p className="eq-muted">百分比按输入值执行（例如 10 表示 10%）。所需字段缺失的股票会被排除。价格涨跌按同一交易窗口计算，采用拆股复权。</p></section>
          {screen ? <section><div className="eq-section-heading"><div><h2>筛选结果</h2><p>池内 {screen.total} 只 · 满足 {screen.matches.length} 只 · 缺失 {screen.missing} 只</p></div></div><Conditions filters={screen.filters} /><p className="eq-muted">筛选时间：{dt(screen.asOf)}</p>{screen.matches.map(match => <div className="eq-candidate" key={match.symbol}><button className="eq-company-name" onClick={() => { const company = state.companies.find(c => c.security.symbol === match.symbol); if (company) openCompany(company); }}><b>{match.symbol}</b><span>{match.name}</span></button><div className="eq-candidate-metrics">{[...new Set([...screen.filters.map(f=>f.field), ...(sortBy ? [sortBy] : []), ...Object.keys(match.metrics)])].slice(0, 6).map(key=>[key,match.metrics[key]]).map(([key, m]) => <span key={key}>{FIELDS[key]?.label ?? key}<b>{metricText(key, m)}</b>{(key==='priceReturn21'||/^return\d+d$/.test(key))&&m?.period&&<small>{m.period}</small>}</span>)}</div><button className="eq-button" onClick={() => candidate(match)}>研究这家公司 →</button></div>)}{!screen.matches.length && <Empty>没有股票满足当前条件。请核对数据覆盖或调整条件。</Empty>}{screen.excluded?.length > 0 && <details className="eq-card"><summary>未纳入结果的股票（{screen.excluded.length}）</summary>{screen.excluded.map((item, i) => <p key={i}>{item.symbol} · {item.reason}</p>)}</details>}</section> : <Empty>保存股票池并取得数据后，选择条件运行筛选。</Empty>}
          <section className="eq-card"><h2>已有公司快照</h2>{state.companies?.length ? state.companies.map(company => <button className="eq-snapshot" key={company.security.symbol} onClick={() => openCompany(company)}><b>{company.security.symbol}</b><span>{company.security.name}</span><small>{dt(company.fetchedAt)}{stale(company.fetchedAt) ? ' · 超过24小时' : ''}</small><span>查看口径 ↗</span></button>) : <p className="eq-muted">尚未取得公司快照。</p>}</section></>}
        {state && tab === 'research' && <><div className="eq-section-heading"><div><p className="eq-eyebrow">COMPANY RESEARCH</p><h1>{session ? `${session.symbol} 研究` : '从一家公司开始'}</h1><p>输入准确股票代码，以披露、财务与可验证行情为依据。</p></div>{session && <button className="eq-button" onClick={newResearch}>新建研究</button>}</div>{screenContext && <section className="eq-context"><b>来自股票池筛选</b><Conditions filters={screenContext.filters} /><p className="eq-muted">筛选快照：{screenContext.snapshotId || '未提供独立引用'}。筛选背景不替代当前问题所需的证据。</p></section>}
          {!turns.length && <Empty>业务、财务趋势与主要风险<br /><span>仅使用已取得证据。同行比较最多选择 3 家已核验的池内公司；缺少合适同行时说明缺口。</span></Empty>}
          {turns.map(turn => <ResearchTurn key={turn.id} turn={turn} busy={busy} openEvidence={openEvidence} resume={turn => action(() => equityApi.resume(turn.sessionId, turn.runId))} />)}
          <form className="eq-composer" onSubmit={research}><div className="eq-ticker-row"><label htmlFor="eq-symbol">股票代码</label><input id="eq-symbol" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} readOnly={Boolean(session)} placeholder="准确代码，如 AAPL" autoComplete="off" /><span>{session ? '本会话股票固定' : '支持池外单只研究'}</span></div><textarea aria-label="美股研究问题" value={question} onChange={e => setQuestion(e.target.value)} placeholder={session ? '继续追问这家公司…' : '输入研究问题；留空则分析业务、财务、估值与风险'} rows={3} /><div className="eq-composer-bottom"><p>默认复用已取得证据；需要新数据时明确选择刷新。</p><div>{state.activeJob?.status === 'loading' && <button type="button" className="eq-button" disabled={pending} onClick={() => action(() => equityApi.cancel(state.activeJob.id), '取消请求已提交，等待结果保存。')}>取消研究</button>}<button type="button" className="eq-button" disabled={busy || Boolean(discoveryContext) || !state.capabilities?.research || !symbol.trim()} onClick={() => research(null, true)}>刷新并研究</button><button className="eq-primary" type="submit" disabled={busy || !state.capabilities?.research || !symbol.trim()}>{busy ? '处理中…' : session ? '继续追问' : '开始研究 →'}</button></div></div></form></>}
      </main></div>
    <aside className={`eq-evidence ${panel ? 'eq-evidence-open' : ''}`} aria-label="美股研究证据"><header><h2>证据与口径</h2>{panel && <button className="eq-button" aria-label="关闭证据" onClick={() => { evidenceVersion.current++; setPanel(null); }}>×</button>}</header><div className="eq-evidence-body">{!panel && <Empty>选择公司快照或报告中的证据引用，查看来源、日期与财务口径。</Empty>}{panel?.kind === 'company' && <CompanyDetails company={panel.company} />}{panel?.kind === 'query' && <>{panel.loading ? <p role="status">正在读取已保存证据…</p> : panel.error ? <p role="alert" className="eq-error">{panel.error}</p> : <><div className="eq-evidence-kicker">已保存查询证据 · {panel.query?.symbol}</div><dl className="eq-definition"><dt>来源</dt><dd>{panel.query?.source}</dd><dt>获取时间</dt><dd>{dt(panel.query?.fetchedAt)}</dd><dt>引用</dt><dd className="eq-mono">{panel.query?.queryId}</dd></dl><pre className="eq-raw-evidence">{JSON.stringify(panel.data, null, 2)}</pre><p className="eq-muted">本页起始 {panel.offset ?? 0} · 共 {panel.total ?? 0} 条；分页只读取已保存证据。</p>{panel.nextOffset != null && <button className="eq-button" onClick={() => openEvidence(panel.jobId, panel.queryId, panel.nextOffset)}>下一页证据</button>}</>}</>}</div></aside>
  </div>;
}

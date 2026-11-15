import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowCounterClockwise,
  Plus,
  List,
  User,
  Sparkle,
  X,
  FileText,
} from "@phosphor-icons/react";
import { Composer, Drawer, CopyAddress, useNarrow } from "./App.jsx";
import { getState, startRun, cancelRun, getEvidence } from "./live-api.js";
const statuses = {
  loading: "正在查询",
  completed: "查询完成",
  partial: "部分结果",
  awaiting_user: "需要补充信息",
  failed: "查询失败",
  cancelled: "已取消",
  exhausted: "预算耗尽",
  interrupted: "查询已中断",
};
const short = (v) => (v?.length > 18 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v);
const date = (value) =>
  new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
function range(q) {
  const w = q.range.timeWindow ?? q.range.requestedTimeWindow;
  if (w)
    return `${date(w.startTimestamp * 1000)} 至 ${date(
      w.endTimestamp * 1000
    )}（北京时间）`;
  return q.range.blockNumber !== undefined
    ? `区块 ${q.range.blockNumber}`
    : `区块 ${q.range.startBlock ?? "?"}–${q.range.endBlock ?? "?"}`;
}
function QueryInfo({ data, notify, loadMore }) {
  const q = data.query;
  return (
    <div className="evidence-content live-evidence">
      <div className="evidence-kicker">真实查询证据 · Ethereum Mainnet</div>
      <section>
        <h3>查询对象</h3>
        <div className="full-address">
          {q.address}
          <CopyAddress value={q.address} notify={notify} />
        </div>
        {data.ensResolutions.map((e) => (
          <p key={e.resolutionId} className="muted">
            {e.name} → {e.address ?? e.status}
            <br />
            解析区块 {e.blockNumber} · 当前快照绑定
          </p>
        ))}
      </section>
      <section>
        <h3>范围与完整性</h3>
        <p>{range(q)}</p>
        <p className="muted">获取时间：{date(q.fetchedAt)} · Asia/Shanghai</p>
        <p>
          {q.completeness.complete
            ? "该查询声明范围已遍历完成"
            : "部分数据，仅覆盖已取得记录"}
        </p>
        <p className="muted">停止原因：{q.completeness.stopReason}</p>
        {q.error && (
          <p className="live-error">
            {q.error.code}：{q.error.message}
          </p>
        )}
      </section>
      {q.balance && (
        <section>
          <h3>精确余额</h3>
          <p className="full-address">{q.balance.eth} ETH</p>
          <p className="muted full-address">{q.balance.wei} wei</p>
        </section>
      )}
      <section>
        <h3>来源与引用</h3>
        <p className="full-address">{q.queryId}</p>
        {q.evidenceRefs.map((ref) => (
          <p key={ref.id} className="muted full-address">
            {ref.provider} · {ref.method}
            <br />
            {ref.id}
          </p>
        ))}
      </section>
      {!!data.total && (
        <section>
          <h3>
            已取得明细（{data.records.length}/{data.total}）
          </h3>
          {data.records.map((record, i) => (
            <div
              className="live-record"
              key={`${record.id ?? record.hash}-${i}`}
            >
              {Object.entries(record).map(([key, value]) => (
                <div key={key}>
                  <span>{key}</span>
                  <p>{String(value)}</p>
                </div>
              ))}
              {typeof record.hash === "string" &&
                /^0x[0-9a-fA-F]{64}$/.test(record.hash) && (
                  <a
                    href={`https://etherscan.io/tx/${record.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    在 Etherscan 查看
                    <ArrowRight size={12} />
                  </a>
                )}
            </div>
          ))}
          {data.nextOffset !== null && (
            <button
              className="text-action"
              disabled={data.loadingMore}
              onClick={loadMore}
            >
              {data.loadingMore ? "正在读取…" : "加载更多已取得明细"}
            </button>
          )}
        </section>
      )}
      <p className="evidence-note">
        金额保留原始精度。明细以源记录为准；分页仅浏览已取得证据，不会额外查询链上历史。
      </p>
    </div>
  );
}
function LiveAnswer({ turn, open, resume, busy }) {
  if (turn.status === "loading")
    return (
      <div className="run-message" role="status">
        <div className="loading-indicator" />
        <div>
          <strong>正在查询真实数据</strong>
          <p>
            {turn.progress?.some((p) => p.type === "tool_started")
              ? "正在调用只读数据工具并保存证据"
              : "正在准备查询或等待模型响应"}
          </p>
          {turn.progress
            ?.filter((p) => p.type === "tool_started")
            .slice(-3)
            .map((p, i) => (
              <p className="muted" key={i}>
                {p.name}
              </p>
            ))}
        </div>
      </div>
    );
  const r = turn.run;
  if (!r)
    return (
      <div className="state-message" role="status">
        <h2>{statuses[turn.status] ?? "连接异常"}</h2>
        <p>{turn.error ?? "未取得运行结果。"}</p>
        {turn.recovery && (
          <button className="text-action" disabled={busy} onClick={() => resume(turn.recovery)}>
            <ArrowCounterClockwise size={16} />
            恢复本轮查询
          </button>
        )}
        {turn.status === "interrupted" && !turn.recovery && (
          <p>没有通过校验的恢复检查点。你可以重新提交问题；系统不会自动重试。</p>
        )}
      </div>
    );
  const ids = new Map(r.queries.map((q) => [q.queryId, q]));
  return (
    <div className="answer live-answer">
      <h1>
        {r.ensResolutions?.find((e) => e.status === "resolved")?.name ??
          short(r.queries[0]?.address) ??
          "链上研究"}{" "}
        · {r.queries[0]?.kind === "get_eth_balance" ? "ETH 余额" : "研究结果"}
      </h1>
      <div className="coverage">
        <span className="status-badge">{statuses[r.status]}</span>
        <span>真实查询 · 以各条证据的取得时间与区块为准</span>
      </div>
      <section className="live-answer-text">
        {r.answer.split(/(q_[A-Za-z0-9_-]+)/g).map((part, i) =>
          ids.has(part) ? (
            <button
              className="citation"
              key={i}
              onClick={(e) => open(turn.id, part, e.currentTarget)}
            >
              {part}
            </button>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </section>
      {r.queries.length > 0 && (
        <section className="sources">
          <h2>相关证据</h2>
          {r.queries.map((q, i) => (
            <button
              className="live-query-link"
              key={q.queryId}
              onClick={(e) => open(turn.id, q.queryId, e.currentTarget)}
            >
              <FileText size={16} />
              <span>
                [{i + 1}]{" "}
                {q.kind === "get_eth_balance"
                  ? "ETH 余额"
                  : q.kind === "list_asset_transfers"
                  ? "双向转账"
                  : "普通交易"}{" "}
                · {q.completeness.complete ? "范围完成" : "部分数据"}
                <small>{q.queryId}</small>
              </span>
              <ArrowRight size={16} />
            </button>
          ))}
        </section>
      )}
      {r.warnings?.map((warning, i) => (
        <p className="result-footnote" key={i}>
          {warning}
        </p>
      ))}
      <p className="result-footnote full-address">
        运行 {r.runId}
        <br />
        模型 {r.counts.models} 次 · 工具 {r.counts.tools} 次 · 数据 HTTP{" "}
        {r.counts.http} 次<br />
        供应商已报告 {r.tokenUsage.totalTokens} Token
        {r.tokenUsage.unknownRequests
          ? `；${r.tokenUsage.unknownRequests} 次请求用量未知`
          : ""}
      </p>
      {r.resumable && (
        <button
          className="text-action"
          disabled={busy}
          onClick={() => resume(r)}
        >
          <ArrowCounterClockwise size={16} />
          恢复本轮查询
        </button>
      )}
    </div>
  );
}
export function LiveApp() {
  const [state, setState] = useState({
      sessions: [],
      ready: false,
      busy: false,
    }),
    [active, setActive] = useState(null),
    [question, setQuestion] = useState(""),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false),
    [nav, setNav] = useState(false),
    [panel, setPanel] = useState(null),
    [notice, setNotice] = useState("");
  const narrow = useNarrow(),
    inputRef = useRef(null),
    scroll = useRef(null),
    trigger = useRef(null),
    sequence = useRef(0),
    mounted = useRef(true),
    noticeTimer = useRef(null),
    previous = useRef({ id: null, length: 0 });
  const refreshSequence = useRef(0);
  async function refresh(signal) {
    const ticket = ++refreshSequence.current;
    const next = await getState(signal);
    if (mounted.current && ticket === refreshSequence.current) {
      setState(next);
      setError("");
    }
    return next;
  }
  useEffect(() => {
    mounted.current = true;
    let alive = true,
      timer;
    const controller = new AbortController();
    async function poll() {
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (alive) setError(e.message);
      }
      if (alive) timer = setTimeout(poll, 1000);
    }
    poll();
    return () => {
      mounted.current = false;
      alive = false;
      controller.abort();
      clearTimeout(timer);
      clearTimeout(noticeTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!narrow) setNav(false);
  }, [narrow]);
  const session = state.sessions.find((s) => s.id === active),
    turns = session?.turns ?? [],
    loading = turns.some((t) => t.status === "loading"),
    home = !turns.length;
  useEffect(() => {
    if (scroll.current) {
      if (previous.current.id !== active) scroll.current.scrollTop = 0;
      else if (turns.length > previous.current.length)
        scroll.current
          .querySelector(".turn:last-child")
          ?.scrollIntoView({ block: "start" });
    }
    previous.current = { id: active, length: turns.length };
  }, [active, turns.length]);
  function notify(text) {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 3000);
  }
  function close() {
    sequence.current++;
    setPanel(null);
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
    });
  }
  useEffect(() => {
    if (!panel || narrow) return;
    const fn = (e) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [panel, narrow]);
  function choose(id) {
    setActive(id);
    setQuestion("");
    setNav(false);
    sequence.current++;
    setPanel(null);
  }
  function newResearch() {
    choose(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }
  async function submit() {
    if (!question.trim() || sending || state.busy || !state.ready || error) return;
    setSending(true);
    try {
      const next = await startRun({
        question: question.trim(),
        ...(active ? { sessionId: active } : {}),
      });
      setActive(next.sessionId);
      setQuestion("");
      sequence.current++;
      setPanel(null);
      await refresh();
    } catch (e) {
      notify(e.message);
    } finally {
      setSending(false);
    }
  }
  async function cancel() {
    const running = turns.find((t) => t.status === "loading");
    if (!running) return;
    try {
      await cancelRun(running.id);
      notify("取消请求已提交，等待证据保存完成");
      await refresh();
    } catch (e) {
      notify(e.message);
    }
  }
  async function resume(run) {
    if (state.busy || sending) return;
    setSending(true);
    try {
      await startRun({ sessionId: run.sessionId, resumeRunId: run.runId });
      await refresh();
    } catch (e) {
      notify(e.message);
    } finally {
      setSending(false);
    }
  }
  async function open(jobId, queryId, element) {
    trigger.current = element;
    const seq = ++sequence.current;
    setPanel({ jobId, queryId, loading: true });
    try {
      const data = await getEvidence(jobId, queryId);
      if (seq === sequence.current) setPanel({ jobId, queryId, ...data });
    } catch (e) {
      if (seq === sequence.current)
        setPanel({ jobId, queryId, error: e.message });
    }
  }
  async function loadMore() {
    if (!panel || panel.nextOffset === null || panel.loadingMore) return;
    const seq = sequence.current,
      current = panel;
    setPanel({ ...current, loadingMore: true });
    try {
      const data = await getEvidence(
        current.jobId,
        current.queryId,
        current.nextOffset
      );
      if (seq === sequence.current)
        setPanel({
          ...current,
          ...data,
          records: [...current.records, ...data.records],
          loadingMore: false,
        });
    } catch (e) {
      if (seq === sequence.current)
        setPanel({ ...current, loadingMore: false });
      notify(e.message);
    }
  }
  const sidebar = (
    <>
      <a
        href="?mode=live"
        className="wordmark"
        onClick={(e) => {
          e.preventDefault();
          newResearch();
        }}
      >
        LedgerScout
      </a>
      <p className="sidebar-caption">Ethereum Mainnet · 真实查询</p>
      <button className="primary new-research" onClick={newResearch}>
        <Plus size={17} />
        新建研究
      </button>
      <div className="history-heading">研究会话</div>
      <nav aria-label="真实研究会话">
        {state.sessions.map((s) => (
          <button
            key={s.id}
            className={`session-item ${s.id === active ? "selected" : ""}`}
            aria-current={s.id === active ? "page" : undefined}
            onClick={() => choose(s.id)}
          >
            <span>{s.title}</span>
            <time>{s.date}</time>
          </button>
        ))}
        {!state.sessions.length && <p className="muted">还没有真实查询</p>}
        {state.hasMoreSessions && <p className="muted">当前展示最近 30 个会话，更早历史仍保存在本机。</p>}
      </nav>
      <div className="sidebar-bottom">
        <p className="live-mode-label">
          真实数据 · {state.model ?? "DeepSeek"}
        </p>
        <p>
          <span>会话与证据保存在本机</span>
          <br />
          重启后可继续研究
        </p>
        <a className="text-action" href="?mode=demo">
          查看演示界面
          <ArrowRight size={13} />
        </a>
      </div>
    </>
  );
  const panelContent = panel?.loading ? (
    <p className="muted panel-message" role="status">
      正在读取真实证据…
    </p>
  ) : panel?.error ? (
    <p className="live-error panel-message">{panel.error}</p>
  ) : panel ? (
    <QueryInfo data={panel} notify={notify} loadMore={loadMore} />
  ) : null;
  return (
    <div className={`app ${panel && !narrow ? "with-evidence" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-inner">{sidebar}</div>
      </aside>
      <main className={`workspace ${home ? "is-home" : ""}`}>
        <header className="mobile-header">
          <button
            className="icon-button"
            aria-label="打开研究会话"
            onClick={() => setNav(true)}
          >
            <List size={23} />
          </button>
          <span className="wordmark">LedgerScout</span>
          <span className="mobile-demo">真实</span>
        </header>
        {(error || !state.ready) && (
          <div className="live-banner" role="status">
            {error ||
              "真实查询需要本机配置 DeepSeek、Alchemy 和 Etherscan 密钥。填写 .env 后会自动重新检查。"}
          </div>
        )}
        {state.busy && !loading && (
          <div className="live-banner" role="status">
            其他会话正在查询，可切换回该会话查看进度或取消。
          </div>
        )}
        {session?.hasMoreTurns && <div className="live-banner" role="status">当前展示此会话最近 20 轮对话，更早历史仍保存在本机。</div>}
        {state.importWarnings > 0 && <div className="live-banner" role="status">部分旧记录无法读取，原文件已保留；当前展示可读取的历史记录。</div>}
        {home ? (
          <div className="home-content">
            <div className="welcome">
              <h1>看清链上资金的来龙去脉。</h1>
              <p>从一个地址、一个问题开始。</p>
            </div>
            <Composer
              live
              value={question}
              setValue={setQuestion}
              submit={submit}
              home
              loading={false}
              blocked={!state.ready || state.busy || sending || Boolean(error)}
              inputRef={inputRef}
            />
            <div className="suggestions">
              <p>你也可以尝试：</p>
              {[
                [
                  "查询 vitalik.eth 当前 ETH 余额",
                  "查看 vitalik.eth 的当前 ETH 余额",
                ],
                [
                  "分析 vitalik.eth 最近七天的资金流",
                  "分析 vitalik.eth 最近七天的资金流",
                ],
              ].map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => {
                    setQuestion(value);
                    inputRef.current?.focus();
                  }}
                >
                  <span>{label}</span>
                  <ArrowRight size={18} />
                </button>
              ))}
            </div>
            <p className="home-disclaimer">
              真实查询 · Ethereum Mainnet
              <span>余额以快照为准，历史以查询范围为准</span>
            </p>
          </div>
        ) : (
          <>
            <div className="conversation-scroll" ref={scroll}>
              <div className="conversation">
                {turns.map((t) => (
                  <article className="turn" key={t.id}>
                    <div className="user-question">
                      <span className="user-avatar">
                        <User size={19} weight="fill" />
                      </span>
                      <p>{t.question}</p>
                    </div>
                    <div className="assistant-response">
                      <span className="assistant-avatar">
                        <Sparkle size={20} weight="fill" />
                      </span>
                      <LiveAnswer
                        turn={t}
                        open={open}
                        resume={resume}
                        busy={state.busy || sending}
                      />
                    </div>
                  </article>
                ))}
              </div>
            </div>
            <div className="composer-dock">
              <Composer
                live
                value={question}
                setValue={setQuestion}
                submit={submit}
                loading={loading}
                blocked={
                  sending ||
                  (!loading && state.busy) ||
                  !state.ready ||
                  Boolean(error)
                }
                cancel={cancel}
                inputRef={inputRef}
              />
              <p>
                真实查询 · 只读数据<span>部分结果不代表完整历史</span>
              </p>
            </div>
          </>
        )}
      </main>
      {panel &&
        (narrow ? (
          <Drawer title="真实证据" onClose={close} className="evidence-drawer">
            {panelContent}
          </Drawer>
        ) : (
          <aside className="evidence-panel" aria-label="真实证据">
            <div className="drawer-head">
              <h2>证据</h2>
              <button
                className="icon-button"
                aria-label="关闭证据"
                onClick={close}
              >
                <X size={20} />
              </button>
            </div>
            {panelContent}
          </aside>
        ))}
      {nav && narrow && (
        <Drawer
          title="研究会话"
          onClose={() => setNav(false)}
          className="nav-drawer"
        >
          <div className="sidebar-inner">{sidebar}</div>
        </Drawer>
      )}
      <div
        className={`toast ${notice ? "visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        {notice}
      </div>
    </div>
  );
}

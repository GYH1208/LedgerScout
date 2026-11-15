import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  CaretDown,
  Check,
  Copy,
  Info,
  List,
  Plus,
  Sparkle,
  Stop,
  User,
  X,
  ArrowCounterClockwise,
} from "@phosphor-icons/react";
import {
  TARGET,
  QUESTION,
  STATUS,
  SCENARIOS,
  classify,
  resultFor,
  newSession,
  seedSessions,
} from "./demo.js";
const short = (v) => `${v.slice(0, 6)}…${v.slice(-4)}`;
function useNarrow() {
  const [value, setValue] = useState(
    () => matchMedia("(max-width: 1000px)").matches
  );
  useEffect(() => {
    const m = matchMedia("(max-width: 1000px)");
    const change = () => setValue(m.matches);
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, []);
  return value;
}
function Drawer({ title, onClose, children, className = "" }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current,
      previous = document.activeElement;
    node.showModal();
    return () => {
      node.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`drawer ${className}`}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = [
          ...ref.current.querySelectorAll(
            'button:not(:disabled), a[href], select, textarea:not(:disabled), input:not(:disabled), [tabindex="0"]'
          ),
        ].filter((node) => node.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (!first) {
          event.preventDefault();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !ref.current.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !ref.current.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < box.left ||
          e.clientX > box.right ||
          e.clientY < box.top ||
          e.clientY > box.bottom
        )
          onClose();
      }}
    >
      <div className="drawer-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label={`关闭${title}`}
          onClick={onClose}
        >
          <X size={21} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function CopyAddress({ value, notify }) {
  const [copied, setCopied] = useState(false),
    timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      notify("完整地址已复制");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      notify("复制失败，请选中完整地址手动复制");
    }
  }
  return (
    <button
      className="icon-button copy"
      aria-label="复制完整地址"
      title={value}
      onClick={copy}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  scenario,
  setScenario,
  mobile = false,
}) {
  return (
    <div className="sidebar-inner">
      {!mobile && (
        <>
          <a
            className="wordmark"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onNew();
            }}
          >
            LedgerScout
          </a>
          <p className="sidebar-caption">Ethereum Mainnet · 只读研究</p>
        </>
      )}
      <button className="primary new-research" onClick={onNew}>
        <Plus size={17} />
        新建研究
      </button>
      <div className="history-heading">最近会话</div>
      <nav aria-label="研究会话">
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`session-item ${s.id === activeId ? "selected" : ""}`}
            aria-current={s.id === activeId ? "page" : undefined}
            onClick={() => onSelect(s.id)}
          >
            <span>{s.title}</span>
            <time>{s.date ?? "2026-11-14"}</time>
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <label
          className="scenario-label"
          htmlFor={mobile ? "mobile-scenario" : "scenario"}
        >
          演示场景
          <Info size={14} />
        </label>
        <div className="select-wrap">
          <select
            id={mobile ? "mobile-scenario" : "scenario"}
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
          >
            {SCENARIOS.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
          <CaretDown size={13} />
        </div>
        <p>
          本地交互原型 · 不发起真实查询
          <br />
          会话仅在当前页面保留
        </p>
      </div>
    </div>
  );
}
function Composer({
  value,
  setValue,
  submit,
  loading,
  cancel,
  home,
  inputRef,
  live = false,
  blocked = false,
}) {
  return (
    <form
      className={`composer ${home ? "home-composer" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label
        className="sr-only"
        htmlFor={home ? "home-question" : "followup-question"}
      >
        {home ? "研究问题" : "继续提问"}
      </label>
      <textarea
        ref={inputRef}
        id={home ? "home-question" : "followup-question"}
        rows={1}
        maxLength={2000}
        value={value}
        disabled={loading || blocked}
        onChange={(e) => setValue(e.target.value)}
        placeholder={
          home
            ? "例如：分析 vitalik.eth 最近七天的资金流"
            : live
            ? "继续提问，例如：查看主要往来地址"
            : "继续提问，例如：查看这笔 1.00 ETH 转账的来源"
        }
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!loading) submit();
          }
        }}
      />
      {loading ? (
        <button
          type="button"
          className="primary cancel-button"
          onClick={cancel}
        >
          <Stop size={14} weight="fill" />
          {live ? "取消查询" : "停止演示"}
        </button>
      ) : (
        <button
          type="submit"
          className="primary submit-button"
          aria-label={home ? "开始研究" : "继续研究"}
          disabled={!value.trim() || blocked}
        >
          <span>{home ? "开始研究" : "继续研究"}</span>
          <ArrowUp className="submit-arrow" size={19} />
        </button>
      )}
    </form>
  );
}
export { Composer, Drawer, CopyAddress, useNarrow };
function Evidence({ selection, close, notify, mobile }) {
  const { evidence, result } = selection;
  const content = (
    <div className="evidence-content">
      <div className="evidence-kicker">演示来源 · 非真实链上证据</div>
      <section>
        <h3>地址信息（当前快照）</h3>
        <dl>
          <dt>ENS</dt>
          <dd>vitalik.eth</dd>
          <dt>绑定地址</dt>
          <dd className="address-value">
            {short(TARGET)}
            <CopyAddress value={TARGET} notify={notify} />
          </dd>
        </dl>
        <p className="muted">当前快照时点的 ENS 绑定，不代表历史日期的绑定。</p>
      </section>
      <section>
        <h3>查询范围</h3>
        <p>{result.range}</p>
        <p className="muted">Asia/Shanghai</p>
      </section>
      <section>
        <h3>{evidence.title}</h3>
        <dl>
          <dt>类型</dt>
          <dd>{evidence.type}</dd>
          <dt>数量</dt>
          <dd>{evidence.amount}</dd>
          <dt>时间</dt>
          <dd>{evidence.time}</dd>
        </dl>
        {evidence.peer && (
          <>
            <p className="muted">往来地址（演示）</p>
            <div className="full-address">
              {evidence.peer}
              <CopyAddress value={evidence.peer} notify={notify} />
            </div>
          </>
        )}
        <p className="evidence-note">
          仅为界面示例。两条明细并非汇总的全部记录，也不提供真实交易哈希。
        </p>
      </section>
      <section>
        <h3>数据范围</h3>
        <p>{STATUS[result.status]}</p>
        <p className="muted">
          {result.status === "partial"
            ? "仅覆盖已取得记录，不代表完整历史。"
            : "仅表示演示场景完成，不代表真实查询。"}
        </p>
      </section>
      <section>
        <h3>完整研究地址</h3>
        <div className="full-address">
          {TARGET}
          <CopyAddress value={TARGET} notify={notify} />
        </div>
      </section>
    </div>
  );
  return mobile ? (
    <Drawer title="证据" onClose={close} className="evidence-drawer">
      {content}
    </Drawer>
  ) : (
    <aside className="evidence-panel" aria-label="证据">
      <div className="drawer-head">
        <h2>证据</h2>
        <button className="icon-button" aria-label="关闭证据" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {content}
    </aside>
  );
}
function Answer({ turn, openEvidence, resume, notify }) {
  if (turn.status === "loading")
    return (
      <div className="run-message" role="status">
        <div className="loading-indicator" />
        <div>
          <strong>正在演示查询流程</strong>
          <p>解析名称 → 获取转账 → 整理分析</p>
          <p className="muted">此过程使用本地演示数据，不会请求链上服务。</p>
        </div>
      </div>
    );
  if (!turn.result) {
    const messages = {
      awaiting_user:
        "当前原型支持 vitalik.eth 的资金流或 ETH 余额示例。请输入相应问题继续。",
      failed: "演示场景：数据服务暂时不可用。你可以显式恢复这次演示。",
      cancelled: "本轮演示已停止。可以恢复本轮，或输入新的问题。",
      exhausted:
        "演示场景：本轮查询预算已耗尽，无法继续恢复。请缩小查询范围后重新提问。",
    };
    return (
      <div className={`state-message state-${turn.status}`} role="status">
        <h2>{STATUS[turn.status]}</h2>
        <p>{messages[turn.status]}</p>
        <p className="muted">演示数据 · 非实时查询</p>
        {turn.resumable && (
          <button className="text-action" onClick={() => resume(turn)}>
            <ArrowCounterClockwise size={16} />
            恢复本轮演示
          </button>
        )}
      </div>
    );
  }
  const r = turn.result,
    partial = r.status === "partial",
    balance = r.kind === "balance";
  const open = (row, e) =>
    openEvidence({ evidence: row, result: r }, e.currentTarget);
  return (
    <div className="answer">
      <h1>vitalik.eth {balance ? "ETH 余额" : "资金流分析"}</h1>
      <p className="result-meta">
        {r.range}
        {!balance && "（7 天）"}
        <span>·</span>演示数据 · 非实时查询
      </p>
      <div className="coverage">
        <span className={`status-badge ${partial ? "" : "complete"}`}>
          {STATUS[r.status]}
        </span>
        <span>
          {partial
            ? "仅覆盖已取得记录，不代表完整历史。"
            : "本地演示场景已完成，不代表真实查询。"}
        </span>
      </div>
      <section className="conclusion">
        <h2>核心结论</h2>
        {balance ? (
          <p>
            当前演示快照中的 ETH 余额为 <strong>5.79 ETH</strong>
            。此数字仅用于展示余额查询界面。
            <button
              className="citation"
              aria-label="查看证据 1"
              onClick={(e) => open(r.evidence[0], e)}
            >
              [1]
            </button>
          </p>
        ) : (
          <p>
            在本次{partial ? "已取得样本" : "演示数据"}中，vitalik.eth 的 ETH
            净流入为 <strong>+0.38 ETH</strong>。资金流入 1.24 ETH，资金流出
            0.86 ETH；下方列出两笔往来示例，可查看对应证据{" "}
            <button
              className="citation"
              aria-label="查看证据 1"
              onClick={(e) => open(r.evidence[0], e)}
            >
              [1]
            </button>{" "}
            <button
              className="citation"
              aria-label="查看证据 2"
              onClick={(e) => open(r.evidence[1], e)}
            >
              [2]
            </button>
            。
          </p>
        )}
      </section>
      <section className="summary">
        <h2>{balance ? "余额概览（ETH）" : "资金概览（ETH）"}</h2>
        <div className="metrics">
          {(balance
            ? [["当前余额", "5.79 ETH"]]
            : [
                ["流入", "1.24 ETH"],
                ["流出", "0.86 ETH"],
                ["净流入", "+0.38 ETH"],
              ]
          ).map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>
      {!balance && (
        <section className="counterparties">
          <h2>资金往来明细（示例）</h2>
          <p className="section-caption">两笔示例记录 · 不代表全部记录或排名</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>对手地址</th>
                  <th>方向</th>
                  <th>金额（ETH）</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {r.evidence.map((row, i) => (
                  <tr key={row.id}>
                    <td>
                      <button
                        className="address-link"
                        onClick={(e) => open(row, e)}
                      >
                        {short(row.peer)}
                      </button>
                      <CopyAddress value={row.peer} notify={notify} />
                    </td>
                    <td>{i === 0 ? "流入" : "流出"}</td>
                    <td>{i === 0 ? "1.00" : "0.50"}</td>
                    <td>
                      <button
                        className="date-link"
                        aria-label={`查看证据 ${i + 1} 明细`}
                        onClick={(e) => open(row, e)}
                      >
                        {row.time}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="sources">
        <h2>相关证据</h2>
        {r.evidence.map((row, i) => (
          <p key={row.id}>
            <button className="citation" onClick={(e) => open(row, e)}>
              [{i + 1}]
            </button>
            <span>
              {row.time} · {row.title} · {row.amount}
            </span>
          </p>
        ))}
        <button className="text-action" onClick={(e) => open(r.evidence[0], e)}>
          查看证据
          <ArrowRight size={16} />
        </button>
      </section>
      <p className="result-footnote">
        不含 gas、NFT 与法币估值；资金流不代表利润或余额变化。
      </p>
    </div>
  );
}
export function App() {
  const [sessions, setSessions] = useState(seedSessions),
    [activeId, setActiveId] = useState(null),
    [question, setQuestion] = useState(""),
    [scenario, setScenario] = useState("partial"),
    [evidence, setEvidence] = useState(null),
    [navOpen, setNavOpen] = useState(false),
    [notice, setNotice] = useState("");
  const inputRef = useRef(null),
    scrollRef = useRef(null),
    evidenceTrigger = useRef(null),
    timers = useRef(new Map()),
    noticeTimer = useRef(null),
    narrow = useNarrow();
  const session = sessions.find((s) => s.id === activeId),
    turns = session?.turns ?? [],
    loading = turns.some((t) => t.status === "loading"),
    home = turns.length === 0;
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      clearTimeout(noticeTimer.current);
    },
    []
  );
  useEffect(() => {
    if (!narrow) setNavOpen(false);
  }, [narrow]);
  const previousView = useRef({ activeId: null, count: 0 });
  useEffect(() => {
    if (scrollRef.current) {
      if (previousView.current.activeId !== activeId)
        scrollRef.current.scrollTop = 0;
      else if (turns.length > previousView.current.count)
        scrollRef.current
          .querySelector(".turn:last-child")
          ?.scrollIntoView({ block: "start" });
    }
    previousView.current = { activeId, count: turns.length };
  }, [activeId, turns.length]);
  useEffect(() => {
    if (!evidence || narrow) return;
    const close = (e) => {
      if (e.key === "Escape") closeEvidence();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [evidence, narrow]);
  function notify(message) {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2800);
  }
  function closeEvidence() {
    setEvidence(null);
    requestAnimationFrame(() => {
      if (evidenceTrigger.current?.isConnected) evidenceTrigger.current.focus();
    });
  }
  function choose(id) {
    setActiveId(id);
    setQuestion("");
    setEvidence(null);
    setNavOpen(false);
  }
  function onNew() {
    setActiveId(null);
    setQuestion("");
    setEvidence(null);
    setNavOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }
  function openEvidence(value, trigger) {
    evidenceTrigger.current = trigger;
    setEvidence(value);
  }
  function updateTurn(sid, tid, change) {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sid
          ? {
              ...s,
              turns: s.turns.map((t) =>
                t.id === tid ? { ...t, ...change } : t
              ),
            }
          : s
      )
    );
  }
  function schedule(sid, tid, kind, outcome) {
    const timer = setTimeout(() => {
      timers.current.delete(tid);
      updateTurn(sid, tid, {
        status: outcome,
        result: ["partial", "completed"].includes(outcome)
          ? resultFor(kind, outcome)
          : null,
        resumable: ["failed", "cancelled"].includes(outcome),
      });
    }, 1800);
    timers.current.set(tid, timer);
  }
  function submit() {
    const text = question.trim();
    if (!text || loading) return;
    const current = session ?? newSession(text),
      previous = [...current.turns].reverse().find((t) => t.result)?.kind,
      kind = classify(text, previous),
      turn = {
        id: crypto.randomUUID(),
        question: text,
        kind,
        status: kind ? "loading" : "awaiting_user",
      };
    setSessions((prev) =>
      session
        ? prev.map((s) =>
            s.id === activeId ? { ...s, turns: [...s.turns, turn] } : s
          )
        : [{ ...current, turns: [turn] }, ...prev]
    );
    setActiveId(current.id);
    setQuestion("");
    setEvidence(null);
    if (kind) schedule(current.id, turn.id, kind, scenario);
  }
  function cancel() {
    const turn = turns.find((t) => t.status === "loading");
    if (!turn) return;
    clearTimeout(timers.current.get(turn.id));
    timers.current.delete(turn.id);
    updateTurn(activeId, turn.id, { status: "cancelled", resumable: true });
  }
  function resume(turn) {
    if (!turn.resumable || loading) return;
    updateTurn(activeId, turn.id, { status: "loading", resumable: false });
    schedule(activeId, turn.id, turn.kind, "partial");
  }
  const sidebarProps = {
    sessions,
    activeId,
    onSelect: choose,
    onNew,
    scenario,
    setScenario,
  };
  return (
    <div className={`app ${evidence && !narrow ? "with-evidence" : ""}`}>
      <aside className="sidebar">
        <Sidebar {...sidebarProps} />
      </aside>
      <main className={`workspace ${home ? "is-home" : ""}`}>
        <header className="mobile-header">
          <button
            className="icon-button"
            aria-label="打开研究会话"
            onClick={() => setNavOpen(true)}
          >
            <List size={23} />
          </button>
          <span className="wordmark">LedgerScout</span>
          <span className="mobile-demo">演示</span>
        </header>
        {home ? (
          <div className="home-content">
            <div className="welcome">
              <h1>看清链上资金的来龙去脉。</h1>
              <p>从一个地址、一个问题开始。</p>
            </div>
            <Composer
              value={question}
              setValue={setQuestion}
              submit={submit}
              home
              loading={loading}
              cancel={cancel}
              inputRef={inputRef}
            />
            <div className="suggestions">
              <p>你也可以尝试：</p>
              {[
                [QUESTION, "分析一个地址在近七天的资金流"],
                [
                  "查询 vitalik.eth 当前 ETH 余额",
                  "查看 vitalik.eth 的当前 ETH 余额",
                ],
              ].map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => {
                    setQuestion(v);
                    inputRef.current?.focus();
                  }}
                >
                  <span>{label}</span>
                  <ArrowRight size={18} />
                </button>
              ))}
            </div>
            <p className="home-disclaimer">
              演示数据 · 非实时查询<span>支持 vitalik.eth 示例</span>
            </p>
          </div>
        ) : (
          <>
            <div className="conversation-scroll" ref={scrollRef}>
              <div className="conversation">
                {turns.map((turn) => (
                  <article className="turn" key={turn.id}>
                    <div className="user-question">
                      <span className="user-avatar">
                        <User size={19} weight="fill" />
                      </span>
                      <p>{turn.question}</p>
                    </div>
                    <div className="assistant-response">
                      <span className="assistant-avatar">
                        <Sparkle size={20} weight="fill" />
                      </span>
                      <Answer
                        turn={turn}
                        openEvidence={openEvidence}
                        resume={resume}
                        notify={notify}
                      />
                    </div>
                  </article>
                ))}
              </div>
            </div>
            <div className="composer-dock">
              <Composer
                value={question}
                setValue={setQuestion}
                submit={submit}
                loading={loading}
                cancel={cancel}
                inputRef={inputRef}
              />
              <p>
                演示数据 · 非实时查询<span>研究结果以证据范围为准</span>
              </p>
            </div>
          </>
        )}
      </main>
      {evidence && (
        <Evidence
          selection={evidence}
          close={closeEvidence}
          notify={notify}
          mobile={narrow}
        />
      )}{" "}
      {navOpen && narrow && (
        <Drawer
          title="研究会话"
          onClose={() => setNavOpen(false)}
          className="nav-drawer"
        >
          <Sidebar {...sidebarProps} mobile />
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

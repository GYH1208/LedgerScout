import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import {
  runAgent,
  loadRuntimeConfig,
  createDeepSeekRequest,
  type RunResult,
} from "@ledgerscout/agent-runtime";
import { redact, type QueryResult } from "@ledgerscout/chain-data";

type Config = ReturnType<typeof loadRuntimeConfig>;
type Runner = typeof runAgent;
type Job = {
  id: string;
  question: string;
  status: string;
  progress: { type: string; name?: string }[];
  controller: AbortController;
  result?: RunResult;
  error?: string;
  resumeOf?: string;
};
type Session = { id: string; title: string; date: string; jobs: Job[] };
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const validId = (value: unknown, prefix: string) =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,78}$`).test(value);
function publicQuery(q: QueryResult) {
  return {
    queryId: q.queryId,
    kind: q.kind,
    address: q.address,
    network: q.network,
    range: q.range,
    fetchedAt: q.fetchedAt,
    status: q.status,
    completeness: q.completeness,
    error: q.error,
    warnings: q.warnings,
    evidenceRefs: q.evidenceRefs,
    ...(q.kind === "get_eth_balance" && q.status !== "error"
      ? { balance: { wei: q.data.wei, eth: q.data.eth } }
      : {}),
    ...(q.kind === "list_asset_transfers"
      ? {
          counts: {
            incoming: q.data.incoming?.count ?? 0,
            outgoing: q.data.outgoing?.count ?? 0,
          },
        }
      : {}),
    ...(q.kind === "list_normal_transactions"
      ? { count: q.data.count ?? 0 }
      : {}),
  };
}
function publicRun(r: RunResult) {
  return {
    sessionId: r.sessionId,
    runId: r.runId,
    status: r.status,
    answer: r.answer,
    counts: r.counts,
    tokenUsage: r.tokenUsage,
    resumable: Boolean(r.resumable),
    resumeOf: r.resumeOf,
    error: r.error,
    warnings: r.warnings,
    queries: r.queries.map(publicQuery),
    ensResolutions: r.ensResolutions,
  };
}
async function readBody(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 16384) throw new HttpError(413, "请求过大");
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "请求必须为 JSON 对象");
  }
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

export function createWebServer(
  options: { config?: () => Config; run?: Runner } = {}
) {
  const sessions = new Map<string, Session>(),
    jobs = new Map<string, Job>();
  let busy = false;
  const load = options.config ?? loadRuntimeConfig;
  const secrets = () => {
    try {
      const c = load();
      return [c.key, c.chain.alchemyKey, c.chain.etherscanKey].filter(Boolean);
    } catch {
      return [];
    }
  };
  const clean = (value: unknown) => redact(value, secrets());
  function status() {
    try {
      const c = load();
      const configured = {
        deepseek: Boolean(c.key),
        alchemy: Boolean(c.chain.alchemyKey),
        etherscan: Boolean(c.chain.etherscanKey),
      };
      return {
        ready: Object.values(configured).every(Boolean),
        configured,
        model: c.model,
      };
    } catch {
      return {
        ready: false,
        configured: { deepseek: false, alchemy: false, etherscan: false },
        model: "deepseek-flash",
        error: "本地配置无法读取，请检查 .env 格式。",
      };
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent)
        send(res, error instanceof HttpError ? error.status : 500, {
          error:
            error instanceof HttpError
              ? error.message
              : "本地服务处理失败，请检查服务端日志。",
        });
      else res.end();
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(req.headers.host ?? ""))
      throw new HttpError(403, "仅允许本地访问");
    const origin = req.headers.origin;
    if (
      origin &&
      !["http://127.0.0.1:4173", "http://localhost:4173"].includes(origin)
    )
      throw new HttpError(403, "不允许此请求来源");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (
      req.method === "POST" &&
      (req.headers["x-ledgerscout-client"] !== "web" ||
        !/^application\/json(?:;|$)/.test(req.headers["content-type"] ?? ""))
    )
      throw new HttpError(403, "缺少本地客户端请求标记");
    if (req.method === "GET" && url.pathname === "/api/state") {
      const recent = [...sessions.values()]
        .reverse()
        .slice(0, 30)
        .map((s) => ({
          id: s.id,
          title: s.title,
          date: s.date,
          turns: s.jobs.slice(-20).map((j) => ({
            id: j.id,
            question: j.question,
            status: j.status,
            progress: j.progress,
            error: j.error,
            resumable:
              Boolean(j.result?.resumable) &&
              !s.jobs.some((child) => child.resumeOf === j.result?.runId),
            run: j.result
              ? {
                  ...publicRun(j.result),
                  resumable:
                    Boolean(j.result.resumable) &&
                    !s.jobs.some((child) => child.resumeOf === j.result?.runId),
                }
              : undefined,
          })),
        }));
      return send(res, 200, clean({ ...status(), busy, sessions: recent }));
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      const body = await readBody(req);
      if (
        Object.keys(body).some(
          (k) => !["question", "sessionId", "resumeRunId"].includes(k)
        )
      )
        throw new HttpError(400, "不支持的请求字段");
      const { question, sessionId, resumeRunId } = body;
      if (
        (sessionId !== undefined && !validId(sessionId, "s")) ||
        (resumeRunId !== undefined && !validId(resumeRunId, "r"))
      )
        throw new HttpError(400, "无效的会话或运行 ID");
      const resume = resumeRunId !== undefined;
      if (
        resume
          ? !sessionId || question !== undefined
          : typeof question !== "string" ||
            !question.trim() ||
            question.length > 4000
      )
        throw new HttpError(
          400,
          "恢复不能附带新问题；研究问题需为 1–4000 字符"
        );
      const existing =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (sessionId && !existing) throw new HttpError(404, "未找到此 Web 会话");
      let source: Job | undefined;
      if (resume) {
        source = existing?.jobs.find((j) => j.result?.runId === resumeRunId);
        if (!source) throw new HttpError(404, "未找到此会话的源运行");
        if (
          !source.result?.resumable ||
          existing!.jobs.some((j) => j.resumeOf === resumeRunId)
        )
          throw new HttpError(409, "源运行不可恢复或已被恢复");
      }
      if (busy)
        throw new HttpError(409, "已有查询正在执行，请等待或取消后再试");
      if (!status().ready)
        throw new HttpError(
          503,
          "请先在本地 .env 配置 DeepSeek、Alchemy 和 Etherscan 密钥"
        );
      if (jobs.size >= 200)
        throw new HttpError(
          429,
          "本地会话容量已满，请重启本地服务；证据已保存在磁盘"
        );
      const config = load();
      const secretValues = [
        config.key,
        config.chain.alchemyKey,
        config.chain.etherscanKey,
      ].filter(Boolean);
      const safeText = (text: string) => String(redact(text, secretValues));
      const current = existing ?? {
        id: `s_${randomUUID()}`,
        title: safeText(String(question).trim()).slice(0, 100),
        date: new Intl.DateTimeFormat("sv-SE", {
          timeZone: "Asia/Shanghai",
        }).format(new Date()),
        jobs: [],
      };
      const job: Job = {
        id: `j_${randomUUID()}`,
        question: resume ? "恢复上一次运行" : safeText(String(question).trim()),
        status: "loading",
        progress: [],
        controller: new AbortController(),
        ...(resume ? { resumeOf: String(resumeRunId) } : {}),
      };
      sessions.set(current.id, current);
      current.jobs.push(job);
      jobs.set(job.id, job);
      busy = true;
      send(res, 202, { sessionId: current.id, jobId: job.id });
      void execute();
      async function execute() {
        try {
          const run = options.run ?? runAgent;
          const result = await run({
            input: resume ? "" : String(question).trim(),
            sessionId: current.id,
            ...(resume ? { resumeRunId: String(resumeRunId) } : {}),
            config: config.chain,
            request: options.run
              ? async () => {
                  throw Error("Injected runner must provide its own model");
                }
              : createDeepSeekRequest(config),
            outputDirectory: config.outputDirectory,
            signal: job.controller.signal,
            secrets: secretValues,
            onEvent: (event) => {
              const entry: { type: string; name?: string } = {
                type: event.type,
              };
              if (typeof event.name === "string")
                entry.name = safeText(event.name).slice(0, 100);
              job.progress.push(entry);
              job.progress = job.progress.slice(-12);
            },
          });
          job.result = redact(result, secretValues) as RunResult;
          job.status = result.status;
        } catch {
          job.status = "failed";
          job.error =
            "本地运行初始化或记录保存失败，请检查服务端配置与证据目录。";
        } finally {
          busy = false;
        }
      }
      return;
    }
    const cancellation = /^\/api\/runs\/(j_[a-zA-Z0-9_-]+)\/cancel$/.exec(
      url.pathname
    );
    if (req.method === "POST" && cancellation) {
      const job = jobs.get(cancellation[1]!);
      if (!job) throw new HttpError(404, "运行不存在");
      if (job.status === "loading")
        job.controller.abort(new Error("User cancelled"));
      return send(res, 200, { requested: job.status === "loading" });
    }
    const evidence =
      /^\/api\/evidence\/(j_[a-zA-Z0-9_-]+)\/(q_[a-zA-Z0-9_-]+)$/.exec(
        url.pathname
      );
    if (req.method === "GET" && evidence) {
      const job = jobs.get(evidence[1]!),
        q = job?.result?.queries.find((q) => q.queryId === evidence[2]);
      if (!q) throw new HttpError(404, "该运行未引用此证据");
      const rawOffset = url.searchParams.get("offset") ?? "0";
      if (!/^\d{1,6}$/.test(rawOffset)) throw new HttpError(400, "无效分页");
      const offset = Number(rawOffset);
      const rows =
        q.kind === "list_asset_transfers"
          ? [
              ...(q.data.incoming?.transfers ?? []),
              ...(q.data.outgoing?.transfers ?? []),
            ]
          : q.kind === "list_normal_transactions"
          ? q.data.transactions ?? []
          : [];
      const allowed = [
        "id",
        "hash",
        "blockNumber",
        "timestamp",
        "from",
        "to",
        "direction",
        "category",
        "asset",
        "rawValue",
        "decimalsHex",
        "tokenAddress",
        "valueWei",
        "wei",
        "eth",
        "failed",
        "isError",
        "conflictingDuplicate",
      ];
      const records = rows
        .slice(offset, offset + 10)
        .map((row: Record<string, unknown>) =>
          Object.fromEntries(
            allowed
              .filter((key) => Object.hasOwn(row, key))
              .map((key) => [key, row[key]])
          )
        );
      return send(
        res,
        200,
        clean({
          query: publicQuery(q),
          records,
          offset,
          total: rows.length,
          nextOffset:
            offset + records.length < rows.length
              ? offset + records.length
              : null,
          ensResolutions: job!.result!.ensResolutions ?? [],
        })
      );
    }
    throw new HttpError(404, "接口不存在");
  }
  server.on("close", () => {
    for (const job of jobs.values())
      if (job.status === "loading")
        job.controller.abort(new Error("Server closed"));
  });
  return server;
}

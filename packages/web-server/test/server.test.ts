import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createWebServer } from "../src/server.js";
import { parseConfig } from "@ledgerscout/chain-data";
const address = "0x" + "1".repeat(40),
  queryId = "q_test";
const config = () => ({
  key: "model-secret",
  model: "deepseek-flash",
  chain: parseConfig({
    ALCHEMY_API_KEY: "chain-secret",
    ETHERSCAN_API_KEY: "scan-secret",
  }),
  outputDirectory: "/local/private/results",
});
const query = (sessionId: string, runId: string) => ({
  schemaVersion: 1 as const,
  queryId,
  kind: "get_eth_balance" as const,
  sessionId,
  runId,
  toolCallId: "tool",
  network: "Ethereum Mainnet" as const,
  address,
  range: { blockNumber: 10 },
  fetchedAt: "2026-11-15T00:00:00Z",
  status: "ok" as const,
  data: { wei: "1000000000000000001", eth: "1.000000000000000001" },
  completeness: { complete: true, stopReason: "complete" },
  evidenceRefs: [
    { id: "raw_1", provider: "Alchemy", method: "eth_getBalance" },
  ],
  warnings: [],
});
const result = (o: any) => ({
  sessionId: o.sessionId,
  runId: "r_" + crypto.randomUUID(),
  directory: "/local/private/results",
  status: "completed" as const,
  answer: "ETH 余额：1.000000000000000001 ETH",
  counts: { models: 2, tools: 1, http: 3 },
  queries: [] as any[],
  warnings: [],
  resumable: false,
  tokenUsage: {
    source: "provider" as const,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    reportedRequests: 1,
    unknownRequests: 0,
  },
});
async function setup(options: any = {}) {
  const server = createWebServer({ config, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
const headers = {
  "content-type": "application/json",
  "x-ledgerscout-client": "web",
  origin: "http://127.0.0.1:4173",
};
const post = (base: string, path: string, body: unknown = {}, extra = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
  });
async function done(base: string) {
  for (let i = 0; i < 100; i++) {
    const state = (await (await fetch(base + "/api/state")).json()) as any;
    if (!state.busy) return state;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("job timeout");
}

test("HTTP boundary rejects foreign origin, missing client header, unknown keys and oversized body before runtime", async () => {
  let calls = 0;
  const h = await setup({
    run: async (o: any) => {
      calls++;
      return result(o);
    },
  });
  try {
    assert.equal(
      (
        await post(
          h.base,
          "/api/runs",
          { question: "test" },
          { origin: "https://evil.example" }
        )
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(h.base + "/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403
    );
    assert.equal(
      (
        await post(h.base, "/api/runs", {
          question: "test",
          outputDirectory: "/tmp",
        })
      ).status,
      400
    );
    assert.equal(
      (await post(h.base, "/api/runs", { question: "x".repeat(20000) })).status,
      413
    );
    assert.equal(calls, 0);
  } finally {
    await h.close();
  }
});
test("missing configuration reports only presence and does not invoke runtime", async () => {
  let calls = 0;
  const h = await setup({
    config: () => ({ ...config(), key: "" }),
    run: async () => {
      calls++;
    },
  });
  try {
    const response = await fetch(h.base + "/api/state");
    const state = (await response.json()) as any;
    assert.equal(state.ready, false);
    assert.equal(JSON.stringify(state).includes("chain-secret"), false);
    assert.equal(
      (await post(h.base, "/api/runs", { question: "test" })).status,
      503
    );
    assert.equal(calls, 0);
  } finally {
    await h.close();
  }
});
test("real result keeps exact values and only registered evidence is readable", async () => {
  const h = await setup({
    run: async (o: any) => {
      const r = result(o);
      r.queries = [query(o.sessionId, r.runId)];
      return r;
    },
  });
  try {
    const start = (await (
      await post(h.base, "/api/runs", { question: "balance" })
    ).json()) as any;
    const state = await done(h.base);
    const turn = state.sessions[0].turns[0];
    assert.equal(turn.run.queries[0].balance.eth, "1.000000000000000001");
    assert.equal(JSON.stringify(state).includes("/local/private"), false);
    assert.equal(JSON.stringify(state).includes("model-secret"), false);
    const evidence = (await (
      await fetch(h.base + `/api/evidence/${start.jobId}/${queryId}?offset=0`)
    ).json()) as any;
    assert.equal(evidence.query.balance.wei, "1000000000000000001");
    assert.equal(
      (await fetch(h.base + `/api/evidence/${start.jobId}/q_other`)).status,
      404
    );
    assert.equal(
      (
        await post(h.base, "/api/runs", {
          question: "x",
          sessionId: "s_unknown",
        })
      ).status,
      404
    );
  } finally {
    await h.close();
  }
});
test("busy runs serialize; cancel uses signal; explicit resume delegates only registered resumable run", async () => {
  const seen: any[] = [];
  const h = await setup({
    run: async (o: any) => {
      seen.push(o);
      if (!o.resumeRunId)
        await new Promise<void>((resolve) =>
          o.signal.addEventListener("abort", () => resolve(), { once: true })
        );
      const r = result(o);
      if (!o.resumeRunId) {
        r.status = "cancelled" as any;
        r.resumable = true;
      }
      return r;
    },
  });
  try {
    const start = (await (
      await post(h.base, "/api/runs", { question: "cancel test" })
    ).json()) as any;
    assert.equal(
      (await post(h.base, "/api/runs", { question: "duplicate" })).status,
      409
    );
    assert.equal(
      (await post(h.base, `/api/runs/${start.jobId}/cancel`)).status,
      200
    );
    const state = await done(h.base);
    const previous = state.sessions[0].turns[0].run;
    assert.equal(previous.status, "cancelled");
    assert.equal(
      (
        await post(h.base, "/api/runs", {
          sessionId: start.sessionId,
          resumeRunId: previous.runId,
          question: "new",
        })
      ).status,
      400
    );
    assert.equal(
      (
        await post(h.base, "/api/runs", {
          sessionId: start.sessionId,
          resumeRunId: "r_unknown",
        })
      ).status,
      404
    );
    assert.equal(
      (
        await post(h.base, "/api/runs", {
          sessionId: start.sessionId,
          resumeRunId: previous.runId,
        })
      ).status,
      202
    );
    await done(h.base);
    assert.equal(seen[1].resumeRunId, previous.runId);
    assert.equal(seen[1].input, "");
    const afterResume = await done(h.base);
    assert.equal(afterResume.sessions[0].turns[0].run.resumable, false);
  } finally {
    await h.close();
  }
});

test("HTTP adapter executes actual Pi runtime offline and exposes the same persisted evidence", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runAgent } = await import("@ledgerscout/agent-runtime");
  const dir = await mkdtemp(join(tmpdir(), "ledger-web-"));
  const cfg = {
    ...config(),
    chain: parseConfig({
      ALCHEMY_API_KEY: "offline-chain",
      ETHERSCAN_API_KEY: "offline-scan",
      REQUEST_INTERVAL_MS: "0",
      MAX_RETRIES: "0",
    }),
    outputDirectory: dir,
  };
  let calls = 0;
  const h = await setup({
    config: () => cfg,
    run: async (o: any) =>
      runAgent({
        ...o,
        request: async (request: any) => {
          calls++;
          if (calls === 1)
            return {
              content: "",
              toolCalls: [
                {
                  id: "balance-call",
                  name: "get_eth_balance",
                  arguments: { address },
                },
              ],
            };
          const q = JSON.parse(
            request.messages.filter((m: any) => m.role === "tool").at(-1)
              .content
          );
          return {
            content: JSON.stringify({
              kind: "answer",
              queryIds: [q.queryId],
              claims: [{ queryId: q.queryId, field: "eth" }],
            }),
          };
        },
        fetch: async (_url: any, init: any) => {
          const body = JSON.parse(init.body);
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result:
              body.method === "eth_chainId"
                ? "0x1"
                : body.method === "eth_blockNumber"
                ? "0xa"
                : "0xde0b6b3a7640001",
          });
        },
      }),
  });
  try {
    await post(h.base, "/api/runs", {
      question: `查询 ${address} 当前 ETH 余额`,
    });
    const state = await done(h.base),
      r = state.sessions[0].turns[0].run;
    assert.equal(r.status, "completed");
    assert.match(r.answer, /1\.000000000000000001 ETH/);
    const disk = JSON.parse(
      await readFile(
        join(dir, r.sessionId, r.runId, "run-summary.json"),
        "utf8"
      )
    );
    assert.equal(disk.answer, r.answer);
    assert.equal(disk.queries[0].queryId, r.queries[0].queryId);
    assert.equal(calls, 2);
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("transfer evidence pages are bounded and preserve exact raw units", async () => {
  const h = await setup({
    run: async (o: any) => {
      const r = result(o);
      const q: any = query(o.sessionId, r.runId);
      q.kind = "list_asset_transfers";
      q.data = {
        incoming: {
          count: 23,
          transfers: Array.from({ length: 23 }, (_, i) => ({
            id: `row-${i}`,
            hash: "0x" + "a".repeat(64),
            from: address,
            to: address,
            rawValue: "0xffffffffffffffffffff",
            decimalsHex: "0x12",
            approximateValue: 1e30,
          })),
        },
        outgoing: { count: 0, transfers: [] },
      };
      r.queries = [q];
      return r;
    },
  });
  try {
    const start = (await (
      await post(h.base, "/api/runs", { question: "flows" })
    ).json()) as any;
    await done(h.base);
    const path = `/api/evidence/${start.jobId}/${queryId}`;
    const first = (await (await fetch(h.base + path)).json()) as any;
    assert.equal(first.records.length, 10);
    assert.equal(first.nextOffset, 10);
    assert.equal(first.records[0].rawValue, "0xffffffffffffffffffff");
    assert.equal("approximateValue" in first.records[0], false);
    const last = (await (
      await fetch(h.base + path + "?offset=20")
    ).json()) as any;
    assert.equal(last.records.length, 3);
    assert.equal(last.nextOffset, null);
    assert.equal((await fetch(h.base + path + "?offset=-1")).status, 400);
  } finally {
    await h.close();
  }
});

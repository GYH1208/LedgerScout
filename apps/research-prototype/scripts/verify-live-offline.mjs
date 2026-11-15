import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const output = fileURLToPath(
    new URL("../../../docs/design/qa/", import.meta.url)
  ),
  browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1024 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const address = "0x" + "1".repeat(40),
  query = {
    queryId: "q_fixture",
    kind: "get_eth_balance",
    address,
    network: "Ethereum Mainnet",
    range: { blockNumber: 10 },
    fetchedAt: "2026-11-15T00:00:00Z",
    status: "ok",
    completeness: { complete: true, stopReason: "complete" },
    evidenceRefs: [
      {
        id: "offline_raw",
        provider: "Offline test fixture",
        method: "eth_getBalance",
      },
    ],
    balance: { eth: "1.000000000000000001", wei: "1000000000000000001" },
  };
const run = {
  sessionId: "s_fixture",
  runId: "r_fixture",
  status: "completed",
  answer: "ETH 余额：1.000000000000000001 ETH\n证据：q_fixture",
  counts: { models: 2, tools: 1, http: 3 },
  tokenUsage: { totalTokens: 100, unknownRequests: 0 },
  warnings: [],
  queries: [query],
  resumable: false,
};
let state = {
    ready: true,
    busy: false,
    model: "offline-test-fixture",
    sessions: [
      {
        id: "s_fixture",
        title: "离线接入测试",
        date: "2026-11-15",
        turns: [
          {
            id: "j_fixture",
            question: "查询测试地址余额（离线响应）",
            status: "completed",
            run,
          },
        ],
      },
    ],
  },
  delayEvidence = 0;
await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  let value;
  if (url.pathname === "/api/state") value = structuredClone(state);
  else if (url.pathname.startsWith("/api/evidence/")) {
    await new Promise((r) => setTimeout(r, delayEvidence));
    value = {
      query,
      ensResolutions: [],
      records: [],
      total: 0,
      nextOffset: null,
    };
  } else if (url.pathname === "/api/runs") {
    const body = route.request().postDataJSON();
    state.busy = true;
    state.sessions[0].turns.push({
      id: "j_next",
      question: body.question ?? "恢复查询",
      status: "loading",
      progress: [],
    });
    value = { sessionId: "s_fixture", jobId: "j_next" };
  } else if (url.pathname.endsWith("/cancel")) {
    state.busy = false;
    const turn = state.sessions[0].turns.at(-1);
    turn.status = "cancelled";
    turn.run = {
      ...run,
      runId: "r_cancel",
      status: "cancelled",
      answer: "用户已取消本次运行。",
      queries: [],
      resumable: true,
    };
    value = { requested: true };
  } else
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: '{"error":"fixture missing"}',
    });
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
});
try {
  await page.goto("http://127.0.0.1:4173/?mode=live");
  await page.getByRole("button", { name: "离线接入测试" }).click();
  await page.getByRole("heading", { name: /ETH 余额/ }).waitFor();
  assert(
    (await page.locator(".live-answer-text").innerText()).includes(
      "1.000000000000000001"
    )
  );
  await page.locator(".live-query-link").click();
  await page
    .locator(".evidence-panel")
    .getByRole("heading", { name: "精确余额" })
    .waitFor();
  await page.screenshot({ path: `${output}/live-offline-result.png` });
  await page.getByRole("button", { name: "关闭证据" }).click();
  delayEvidence = 800;
  await page.locator(".live-query-link").click();
  await page.getByRole("textbox", { name: "继续提问" }).fill("再查询一次余额");
  await page.getByRole("button", { name: "继续研究", exact: true }).click();
  await page.waitForTimeout(1100);
  assert.equal(
    await page.locator(".evidence-panel").count(),
    0,
    "old evidence must not reopen after submission"
  );
  await page.getByRole("button", { name: "取消查询" }).click();
  await page.getByRole("button", { name: "恢复本轮查询" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "离线接入测试" }).click();
  assert.equal(await page.locator(".turn").count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开研究会话" }).click();
  await page
    .getByRole("dialog", { name: "研究会话" })
    .getByRole("button", { name: "离线接入测试" })
    .click();
  delayEvidence = 0;
  await page.locator(".live-query-link").click();
  await page
    .getByRole("dialog", { name: "真实证据" })
    .getByRole("heading", { name: "精确余额" })
    .waitFor();
  await page.screenshot({ path: `${output}/live-offline-evidence-mobile.png` });
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/live-offline-ui-results.json`,
    JSON.stringify(
      {
        transport: "browser-intercepted offline fixture; no provider requests",
        checks: [
          "exact balance",
          "evidence identity",
          "stale evidence invalidation",
          "cancel/resume availability",
          "reload retains server session",
          "mobile evidence drawer",
        ],
        errors,
      },
      null,
      2
    )
  );
  console.log(
    "PASS live UI with offline transport, including evidence race and mobile drawer"
  );
} finally {
  await browser.close();
}

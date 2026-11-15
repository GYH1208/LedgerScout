// Explicit, bounded live acceptance. This command calls paid model/data providers.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../../../", import.meta.url)),
  base = process.env.PROTOTYPE_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1024 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const output = `${root}/runtime-results/web-live_${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}`;
const checks = [];
async function state() {
  return (await page.request.get(base + "/api/state")).json();
}
async function execute(question) {
  const input = page.getByRole("textbox", {
    name: checks.length ? "继续提问" : "研究问题",
  });
  await input.fill(question);
  const response = page.waitForResponse(
    (r) => r.url() === base + "/api/runs" && r.request().method() === "POST"
  );
  await page
    .getByRole("button", {
      name: checks.length ? "继续研究" : "开始研究",
      exact: true,
    })
    .click();
  const accepted = await (await response).json();
  assert(accepted.jobId, accepted.error ?? "No accepted run");
  let turn;
  const deadline = Date.now() + 330000;
  while (Date.now() < deadline) {
    const current = await state();
    turn = current.sessions
      .find((s) => s.id === accepted.sessionId)
      ?.turns.find((t) => t.id === accepted.jobId);
    if (turn?.status !== "loading" && turn?.run) break;
    await page.waitForTimeout(1000);
  }
  assert(turn?.run, "Runtime did not reach a durable result");
  const run = turn.run;
  checks.push({
    question,
    ...accepted,
    runId: run.runId,
    status: run.status,
    counts: run.counts,
    tokenUsage: run.tokenUsage,
    queryIds: run.queries.map((q) => q.queryId),
  });
  await writeFile(
    output + "/acceptance.json",
    JSON.stringify({ checks, errors }, null, 2)
  );
  assert(
    ["completed", "partial"].includes(run.status),
    `Run status: ${run.status}; ${run.error ?? run.answer}`
  );
  assert(
    run.counts.models <= 15 && run.counts.tools <= 12 && run.counts.http <= 32
  );
  const disk = JSON.parse(
    await readFile(
      `${root}/runtime-results/${run.sessionId}/${run.runId}/run-summary.json`,
      "utf8"
    )
  );
  assert.equal(disk.answer, run.answer);
  assert(run.queries.length > 0, "No evidence");
  await page.waitForFunction(
    (id) =>
      [...document.querySelectorAll(".live-answer")].some((node) =>
        node.textContent.includes(id)
      ),
    run.runId
  );
  await page.screenshot({ path: `${output}/run-${checks.length}.png` });
  return run;
}
try {
  await page.goto(base + "/?mode=live");
  const initial = await state();
  assert(
    initial.ready,
    "Missing local credentials. No provider requests made."
  );
  assert(!initial.busy, "Another run is active");
  await mkdir(output, { recursive: true });
  const balance = await execute("查询 vitalik.eth 当前 ETH 余额");
  const b = balance.queries.find((q) => q.balance);
  assert(b, "No balance evidence");
  assert(
    (await page.locator(".live-answer-text").last().innerText()).includes(
      b.balance.eth
    )
  );
  await page.locator(".live-query-link").last().click();
  await page
    .locator(".evidence-panel")
    .getByRole("heading", { name: "精确余额" })
    .waitFor();
  assert(
    (await page.locator(".evidence-panel").innerText()).includes(b.balance.wei)
  );
  await page.getByRole("button", { name: "关闭证据" }).click();
  const flows = await execute(
    "分析 vitalik.eth 最近七天的资金流和主要往来地址"
  );
  const transfer = flows.queries.find(
    (q) => q.kind === "list_asset_transfers" && q.status !== "error"
  );
  assert(transfer, "No usable transfer evidence");
  assert(transfer.range.timeWindow, "Date window not verified");
  await page.locator(".live-query-link").last().click();
  await page
    .locator(".evidence-panel")
    .getByRole("heading", { name: "范围与完整性" })
    .waitFor();
  assert(
    (await page.locator(".evidence-panel").innerText()).includes(
      transfer.queryId
    )
  );
  await page.screenshot({ path: `${output}/flow-evidence.png` });
  await page.getByRole("button", { name: "关闭证据" }).click();
  const followup = await execute(
    `请基于查询 ${transfer.queryId} 的现有证据解释主要往来地址，不要刷新数据`
  );
  assert.equal(
    followup.counts.http,
    0,
    "Historical evidence follow-up unexpectedly fetched new data"
  );
  assert.deepEqual(errors, []);
  await writeFile(
    output + "/acceptance.json",
    JSON.stringify({ status: "passed", checks, errors }, null, 2)
  );
  console.log(
    JSON.stringify({ status: "passed", directory: output, checks }, null, 2)
  );
} catch (error) {
  if (checks.length)
    await writeFile(
      output + "/acceptance.json",
      JSON.stringify(
        { status: "failed", error: error.message, checks, errors },
        null,
        2
      )
    );
  throw error;
} finally {
  await browser.close();
}

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const base = process.env.PROTOTYPE_URL || "http://127.0.0.1:4173",
  output = fileURLToPath(new URL("../../../docs/design/qa/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 1,
    permissions: ["clipboard-read", "clipboard-write"],
  }),
  page = await context.newPage();
const errors = [],
  external = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("request", (r) => {
  if (!r.url().startsWith(base) && !r.url().startsWith("data:"))
    external.push(r.url());
});
const check = (name) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  },
  shot = (name) => page.screenshot({ path: `${output}/${name}.png` }),
  settle = () => page.waitForTimeout(1950),
  flow = "分析 vitalik.eth 最近七天的资金流";
async function start(scenario = "partial", question = flow) {
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await page.getByLabel("演示场景").selectOption(scenario);
  await page.getByRole("textbox", { name: "研究问题" }).fill(question);
  await page.getByRole("button", { name: "开始研究", exact: true }).click();
}
try {
  await page.goto(base);
  await page
    .getByRole("heading", { name: "看清链上资金的来龙去脉。" })
    .waitFor();
  assert(
    await page
      .getByRole("button", { name: "开始研究", exact: true })
      .isDisabled()
  );
  await shot("home-desktop");
  check("empty input disabled; desktop home rendered");
  await page
    .getByRole("button", { name: "分析一个地址在近七天的资金流" })
    .click();
  assert.equal(
    await page.getByRole("textbox", { name: "研究问题" }).inputValue(),
    flow
  );
  await page.getByRole("button", { name: "开始研究", exact: true }).click();
  await page.getByRole("button", { name: "停止演示" }).waitFor();
  assert(await page.getByRole("textbox", { name: "继续提问" }).isDisabled());
  await shot("loading-desktop");
  await page.getByRole("heading", { name: "vitalik.eth 资金流分析" }).waitFor();
  assert.equal(await page.locator(".turn").count(), 1);
  check("example fill, submit, loading and partial result");
  await page.getByRole("button", { name: "查看证据 1", exact: true }).click();
  await page
    .locator(".evidence-panel")
    .getByRole("heading", { name: "流入记录示例" })
    .waitFor();
  assert(
    (
      await page
        .getByRole("heading", { name: "vitalik.eth 资金流分析" })
        .boundingBox()
    ).y > 0
  );
  await shot("result-desktop");
  await page.getByRole("button", { name: "查看证据 2", exact: true }).click();
  await page
    .locator(".evidence-panel")
    .getByRole("heading", { name: "流出记录示例" })
    .waitFor();
  await page
    .locator(".evidence-panel")
    .getByRole("button", { name: "复制完整地址" })
    .first()
    .click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".evidence-panel").count(), 0);
  await page.waitForFunction(
    () => document.activeElement.getAttribute("aria-label") === "查看证据 2"
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.getAttribute("aria-label")
    ),
    "查看证据 2"
  );
  check("separate citations, full-address copy and Escape focus restoration");
  await page
    .getByRole("textbox", { name: "继续提问" })
    .fill("查看这笔 1.00 ETH 转账的来源");
  await page.getByRole("button", { name: "继续研究", exact: true }).click();
  await settle();
  assert.equal(await page.locator(".turn").count(), 2);
  check("follow-up preserves conversation");
  await start();
  await page.getByRole("button", { name: "停止演示" }).click();
  await settle();
  assert.equal(await page.locator(".answer").count(), 0);
  await page.getByRole("heading", { name: "已取消", exact: true }).waitFor();
  await shot("cancelled-desktop");
  await page.getByRole("button", { name: "恢复本轮演示" }).click();
  await page.getByRole("heading", { name: "vitalik.eth 资金流分析" }).waitFor();
  check("cancel prevents stale completion; explicit resume works");
  await start("partial", "分析 unknown.eth 最近七天的资金流");
  await page.getByRole("heading", { name: "需要补充信息" }).waitFor();
  assert.equal(await page.locator(".answer").count(), 0);
  check("unknown target clarifies instead of inventing facts");
  for (const [scenario, heading] of [
    ["failed", "查询失败"],
    ["exhausted", "预算耗尽"],
    ["awaiting_user", "需要补充信息"],
    ["completed", "vitalik.eth 资金流分析"],
  ]) {
    await start(scenario);
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "恢复本轮演示" }).count(),
      scenario === "failed" ? 1 : 0
    );
    if (scenario === "failed") await shot("failed-desktop");
    check(`${scenario} scenario and resume availability`);
  }
  await start();
  await page.getByRole("button", { name: "vitalik.eth ETH 余额" }).click();
  await settle();
  assert.equal(
    await page.getByRole("heading", { name: "vitalik.eth ETH 余额" }).count(),
    1
  );
  assert.equal(await page.locator(".turn").count(), 1);
  check("background completion stays in original session");
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 vitalik.eth 的当前 ETH 余额" })
    .click();
  await page.getByRole("button", { name: "开始研究", exact: true }).click();
  await page.getByRole("heading", { name: "vitalik.eth ETH 余额" }).waitFor();
  check("balance example has its own layout");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await shot("home-mobile");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth
    ),
    false
  );
  await page.getByRole("button", { name: "打开研究会话" }).click();
  await page.getByRole("dialog", { name: "研究会话" }).waitFor();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    assert(
      await page.evaluate(() => !!document.activeElement.closest("dialog"))
    );
  }
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.getAttribute("aria-label")
    ),
    "打开研究会话"
  );
  check("mobile navigation traps and restores focus");
  await page.getByRole("button", { name: "打开研究会话" }).click();
  await page
    .getByRole("dialog", { name: "研究会话" })
    .getByRole("button", { name: "vitalik.eth 资金流分析" })
    .click();
  await shot("result-mobile");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth
    ),
    false
  );
  await page.getByRole("button", { name: "查看证据 1", exact: true }).click();
  await page
    .getByRole("dialog", { name: "证据", exact: true })
    .getByRole("heading", { name: "流入记录示例" })
    .waitFor();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    assert(
      await page.evaluate(() => !!document.activeElement.closest("dialog"))
    );
  }
  await shot("evidence-mobile");
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.getAttribute("aria-label")
    ),
    "查看证据 1"
  );
  await page.getByRole("textbox", { name: "继续提问" }).fill("查看资金流来源");
  await page.getByRole("button", { name: "继续研究", exact: true }).click();
  await page.getByRole("button", { name: "停止演示" }).click();
  await page.getByRole("heading", { name: "已取消", exact: true }).waitFor();
  check("mobile evidence, follow-up and cancellation");
  await page.setViewportSize({ width: 320, height: 640 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth
    ),
    false
  );
  check("320px viewport has no horizontal page overflow");
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  check("no browser console errors or external requests");
  await writeFile(
    `${output}/interaction-results.json`,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        errors,
        externalRequests: external,
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}

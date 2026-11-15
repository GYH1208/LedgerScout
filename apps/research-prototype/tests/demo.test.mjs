import test from "node:test";
import assert from "node:assert/strict";
import { classify, QUESTION, TARGET } from "../src/demo.js";

test("unsupported targets and lookalike names require clarification even in a follow-up", () => {
  for (const question of [
    "分析 vitalik.eth.evil 的资金流",
    "查询 alice.xyz 的余额",
    "查询 unknown.eth 余额",
    "查询 0x1234 的余额",
  ]) {
    assert.equal(classify(question, "flows"), null, question);
  }
});
test("unsupported asset, chain, time and unrelated intents do not receive fixed demo conclusions", () => {
  for (const question of [
    "查询 vitalik.eth 的 USDT 余额",
    "分析 vitalik.eth 去年的资金流",
    "分析 vitalik.eth 的 Polygon 资金流",
    "不要查询 vitalik.eth 的余额",
    "查询 vitalik.eth 昨天余额",
    "查询 vitalik.eth 和 alice.xyz 的余额",
  ]) {
    assert.equal(classify(question, "flows"), null, question);
  }
});
test("approved flow, balance and contextual source examples remain usable", () => {
  assert.equal(classify(QUESTION), "flows");
  assert.equal(classify("查询 vitalik.eth 当前 ETH 余额"), "balance");
  assert.equal(classify(`查询 ${TARGET} 当前 ETH 余额`), "balance");
  assert.equal(classify("查看这笔 1.00 ETH 转账的来源", "flows"), "flows");
  assert.equal(classify("查看资金流来源", "flows"), "flows");
  assert.equal(classify("查看资金流来源"), null);
});

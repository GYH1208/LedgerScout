export const TARGET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
export const QUESTION = "分析 vitalik.eth 最近七天的资金流";
export const RANGE = "2026.11.07 – 2026.11.14";
export const STATUS = {
  loading: "正在演示查询",
  partial: "部分数据",
  completed: "查询完成",
  awaiting_user: "需要补充信息",
  failed: "查询失败",
  cancelled: "已取消",
  exhausted: "预算耗尽",
};
export const SCENARIOS = [
  ["partial", "部分结果"],
  ["completed", "查询完成"],
  ["awaiting_user", "需要补充信息"],
  ["failed", "查询失败（可恢复）"],
  ["cancelled", "已取消（可恢复）"],
  ["exhausted", "预算耗尽"],
];
export function classify(question, previousKind) {
  // This is a bounded demonstration, not a natural-language query engine.
  // Match whole supported requests so a new target/scope can never inherit facts.
  const text = question
    .trim()
    .replace(/\s+/g, "")
    .replace(/[。？！?!]+$/, "")
    .toLowerCase();
  const request = text.replace(/^(?:分析|查询|查看)/, "");
  for (const target of ["vitalik.eth", TARGET.toLowerCase()]) {
    if (!request.startsWith(target)) continue;
    const scope = request.slice(target.length);
    if (/^(?:的)?(?:当前)?(?:eth)?余额$/.test(scope)) return "balance";
    if (
      /^(?:的)?(?:最近七天|最近7天|近七天|近7天|过去七天|过去7天)?(?:的)?(?:eth)?(?:资金流|流入流出|净流量|资金流和主要往来地址)$/.test(
        scope
      )
    )
      return "flows";
  }
  if (
    previousKind === "flows" &&
    [
      "查看这笔1.00eth转账的来源",
      "查看资金流来源",
      "查看证据",
      "查看流入记录",
      "查看流出记录",
    ].includes(text)
  )
    return "flows";
  return null;
}
export function resultFor(kind, status) {
  return {
    kind,
    status,
    range: kind === "balance" ? "当前快照（演示）" : RANGE,
    evidence:
      kind === "balance"
        ? [
            {
              id: "balance",
              title: "ETH 余额快照",
              amount: "5.79 ETH",
              time: "2026.11.14 10:00",
              type: "余额",
            },
          ]
        : [
            {
              id: "incoming",
              title: "流入记录示例",
              amount: "1.00 ETH",
              time: "2026.11.08 14:27",
              type: "转入",
              peer: "0x9f3a000000000000000000000000000000007d21",
            },
            {
              id: "outgoing",
              title: "流出记录示例",
              amount: "0.50 ETH",
              time: "2026.11.12 09:16",
              type: "转出",
              peer: "0x4c2b00000000000000000000000000000000e9a8",
            },
          ],
  };
}
export const newSession = (title) => ({
  id: crypto.randomUUID(),
  title,
  turns: [],
});
export function seedSessions() {
  return [
    ["vitalik.eth 资金流分析", QUESTION, "flows", "2026-11-14"],
    [
      "vitalik.eth ETH 余额",
      "查询 vitalik.eth 当前 ETH 余额",
      "balance",
      "2026-11-13",
    ],
  ].map(([title, question, kind, date]) => ({
    ...newSession(title),
    date,
    turns: [
      {
        id: crypto.randomUUID(),
        question,
        kind,
        status: "partial",
        result: resultFor(kind, "partial"),
      },
    ],
  }));
}

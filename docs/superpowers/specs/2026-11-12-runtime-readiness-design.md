# Runtime readiness

用户授权按 2 → 3 → 4 推进；Windows 编码器安装延期，继续使用估算。

## 错误诊断修复

已复现：`Etherscan: NOTOK: credits exhausted` 被归为 BUDGET_EXHAUSTED；`Response validation: repeated pageKey` 被归为 AUTH_ERROR。
原因是通用 `exhausted`、`key` 子串规则优先于供应商额度及响应校验规则。
采用现有错误协议的定向修复，明确识别本地 budget、供应商 quota/rate limit、认证和响应校验；保留原始脱敏消息，不改变重试或预算。
相比引入完整的结构化错误类型迁移，此修复保持现有 partial 查询中的字符串错误兼容；代价是未来新增供应商错误仍需维护分类回归。

## 真实验收

在已配置的 DeepSeek、Alchemy、Etherscan 上执行有界、只读验收，使用 README 的公开测试地址。
长对话采用明确标记的验收背景文本，摘要使用真实 DeepSeek；中断通过模型/工具事件触发取消，随后显式恢复。
断言恢复沿用快照、完成工具不重复查询、模型/工具/HTTP预算累计；保存原始运行证据和验收索引。离线测试与真实验收分开记录。
网络使用进程级现有代理配置；不打印密钥，不变更系统网络设置。

## 日期窗口

日期接口与时间语义已呈现选项，等待用户选择后单独补充设计。此阶段尚不实现日期行为。

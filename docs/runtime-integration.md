# LedgerScout Runtime 集成与验收记录

日期：2026 年 11 月 11 日。首版采用 TypeScript、npm workspaces、Pi Agent Core 和 DeepSeek 官方接口。

## 实际集成

执行内核锁定为 `@earendil-works/pi-agent-core@1.5.2`，配套 `pi-ai` 与 `pi-schema` 均为 `1.5.2`。已用发布包验证调用 ID、参数 Schema 拒绝、事件顺序、终轮禁用工具和取消等待，未依赖默认分支中尚未发布的接口。

`packages/agent-runtime/src/engine/pi.ts` 是唯一使用 Pi 消息和循环的模块。DeepSeek 适配器使用内部协议和原生 HTTP，固定官方端点并拒绝重定向；没有向 OpenAI 发请求。默认 `deepseek-flash` 非思考模式，也可选 `deepseek-v4-pro`。依据：[官方快速开始](https://api-docs.deepseek.com/guides/coding_agents/)、[工具调用说明](https://api-docs.deepseek.com/guides/tool_calls/)。

公共数据包提取原 Alchemy/Etherscan 解析、精确金额、分页、重试与脱敏能力；原验证 CLI 通过兼容导出复用。新增不可变查询、共享调度、取消、部分结果与证据包。

## 真实端到端调用

以下均为真实 DeepSeek 选择工具并读取真实主网数据，使用已知公开测试地址，不代表用户钱包或地址身份判断。

| 场景 | 结果 | 模型请求 | 工具 | 数据 HTTP 尝试 |
| --- | --- | --- | --- | --- |
| ETH 余额 | `completed`，区块 26390903，精确余额 5.794616987480413546 ETH | 2 | 1 | 3 |
| 重开同一会话查询普通交易与双向转账 | `partial`，普通交易 50 条，流入、流出各 50 条，均保留不完整标记 | 2 | 2 | 8 |
| 最终代码在同一会话刷新当前余额 | `completed`，重新执行工具与主网请求，没有采用旧余额代替新查询 | 2 | 1 | 3 |

余额运行的[最终摘要](../runtime-results/s_07e82a50-bbf8-4c33-b1d1-21eb289fa1ea/r_5f262c37-ec36-49a2-9972-6acfbd115797/run-summary.json)与历史查询的[最终摘要](../runtime-results/s_07e82a50-bbf8-4c33-b1d1-21eb289fa1ea/r_8cab3353-4d44-4b3f-b36d-552edefa8755/run-summary.json)关联查询 ID、原始响应与答案。

最终代码刷新余额的[运行摘要](../runtime-results/s_07e82a50-bbf8-4c33-b1d1-21eb289fa1ea/r_a07b306d-a799-4b6b-bb4e-5c8103c28e36/run-summary.json)验证了审阅修复后的实际路径。原四项验证 CLI 也在固定小窗口重新通过，[清单在此](../data-validation/results/2026-11-11T09-59-49-432Z-3c36fac5/0012-run-summary.json)。

转账样本覆盖外部 ETH、内部 ETH 和 ERC20；流入分类为 7、5、38 条，流出分类为 3、0、47 条。这些是已取样本，不代表全历史。网络使用已有本地 HTTP 代理和 `NODE_USE_ENV_PROXY=1`，未修改系统设置。

## 离线验证

命令为根目录 `npm test` 与 `npm run typecheck`。最终 63 项测试全部通过，包含原 22 项测试和新增 Pi、传输、查询、DeepSeek、CLI 与 Runtime 回归。根和旧模块类型检查、两个运行目录的依赖安装 dry-run 均通过。

独立审阅发现的旧证据目标不匹配和写盘失败终态不一致问题已用失败回归测试修复；具体结论、采用的取舍和剩余 Minor 见[实施记录](superpowers/plans/2026-11-11-agent-runtime-progress.md)。

覆盖预算（含模型重试与大量未知工具）、超时和取消、分页失败后的部分记录、重复查询缓存与失败限制、事实引用修正、非法地址不回退旧地址、日期输入澄清、会话隔离与中断标记。写盘失败不报告可复核成功，取消后先进行有界明细收尾。原数据层的既有成功记录不作为 Runtime 的测试替代。

## 首版边界

- 会话保留 20 轮上下文和 32 个查询；没有向量记忆、后台任务或自动恢复执行。
- 当前模型适配仅支持 DeepSeek 官方的上述两个模型标识，其他供应商可通过内部接口扩展。
- 日期识别采用保守规则，不进行日期到区块转换；工具仍校验参数及用户已选地址。
- 上下文按保守字节上限估算容量，未返回用量时标为未知，不声称精确费用控制。
- 精确事实由程序生成；模型自由文本解释仍可能出错，证据引用不保证任意因果解释成立。
- 少数错误的诊断码分类尚需细化，可能影响错误标签；不会放宽预算、只读范围或重试策略，原始脱敏错误仍可查看。
- 本次目录不是 Git 仓库，没有创建提交、推送或部署。根目录锁文件统一管理依赖。

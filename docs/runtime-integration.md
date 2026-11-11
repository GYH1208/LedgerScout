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

- 会话最多保留 20 轮原文和 32 个查询；后续上下文增强增加了可持久化摘要（见下），没有向量记忆、后台任务或自动恢复执行。
- 当前模型适配仅支持 DeepSeek 官方的上述两个模型标识，其他供应商可通过内部接口扩展。
- 日期识别采用保守规则，不进行日期到区块转换；工具仍校验参数及用户已选地址。
- 上下文按保守字节上限估算容量，未返回用量时标为未知，不声称精确费用控制。
- 精确事实由程序生成；模型自由文本解释仍可能出错，证据引用不保证任意因果解释成立。
- 少数错误的诊断码分类尚需细化，可能影响错误标签；不会放宽预算、只读范围或重试策略，原始脱敏错误仍可查看。
- 本次目录不是 Git 仓库，没有创建提交、推送或部署。根目录锁文件统一管理依赖。

## 后续增强：Token 用量与上下文摘要

2026 年 11 月 11 日在现有 Git 项目的 `feat/context-compaction` 分支增加上下文增强，前述首版验收保持历史记录。

- 每个真实模型请求前检查消息和工具定义的字节与保守 Token 估算，预留输出空间；事件明确标记 `estimated`。该阶段尚未接入 DeepSeek tokenizer，后续本地编码器见下。
- 供应商响应的实际 input/output/total 用量累计进入运行结果。摘要、重试同样计数；失败和未返回用量的请求计入 unknownRequests，已知用量合计不代表完整消耗。
- 接近容量 80% 时，至多一次摘要请求压缩旧轮次，保留最近两轮和当前输入。摘要使用无工具请求，计入原有最多8次请求及超时；至少留两次任务请求预算。
- 摘要以低权限背景消息传递，不能授权新地址或充当事实证据。程序另提供最多8个当前可用历史查询的范围、时间、状态与完整性索引，仍执行原有历史/刷新权限校验。
- 摘要不合法、工具调用、截断、没有缩小原文或超出长度时不替换历史；降级完整轮次裁剪并记录警告。当前轮无法容纳时明确失败，原工具调用配对保持完整。

此增强通过离线真实 Pi 循环、模拟供应商与文件持久化测试验证；本轮不新增真实供应商调用记录。官方说明将调用实际用量与文本估算区分，参考 [Token Usage](https://api-docs.deepseek.com/quick_start/token_usage/) 和 [DeepSeek tokenizer 文档](https://github.com/deepseek-ai/deepseek-recipe/blob/main/docs/tokenizer.md)。

最终增强后全套80项测试通过，根目录与原数据模块类型检查通过。独立审阅发现的摘要过大导致后续请求失败问题已通过失败回归修复并复核；过大旧摘要暂不注入且保留原文，新摘要必须先通过真实任务容量校验。

## 后续增强：官方离线模板计数

已接入可选 deepseek-recipe==0.2.0 Python worker，固定资产 revision `935817c66f5d6e64838f419692545f06787e485f`。V4.1 / V4词表的SHA-256分别为官方记录的 `81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99` / `97d2f31b020d18b5aee5c9b3d5b4efb10ea210f3fe3f7dffe3f1cd90542d6b19`，安装时与worker启动时验证。保留编码器与词表MIT许可证；资产在忽略的.runtime目录。

HTTP请求与本地计数复用同一wire转换。worker只接收消息/工具，不继承API密钥；超时5秒，支持取消，CLI结束时关闭。未安装保持估算，已安装但失败会记录 `tokenizer_fallback`；本地结果标记 `local_tokenizer`，附encoding/revision，实际供应商usage继续单独记录。

本机已完成安装和真实离线验证。两个模型模板的英文Hello为5 tokens、中文查询为8 tokens、控制token字面文本为16 tokens；工具调用/结果配对及真实Pi循环也经本地worker验证。没有发起模型推理或链上真实请求。

`LEDGERSCOUT_TEST_TOKENIZER=1 npm test` 91/91通过，根和原数据模块类型检查通过。普通npm test跳过两项本地资产测试。独立审阅无重大问题；其指出的前置检查未记录fallback原因问题已用失败回归修复。

依据：[官方计数与模板说明](https://github.com/deepseek-ai/deepseek-recipe/blob/935817c66f5d6e64838f419692545f06787e485f/docs/tokenizer.md)、[资产来源与许可证](https://github.com/deepseek-ai/deepseek-recipe/blob/935817c66f5d6e64838f419692545f06787e485f/static/tokenizers/README.md)。本地模板计数仍不承诺等于远端账单；未来服务端模板变化需要重新验证。

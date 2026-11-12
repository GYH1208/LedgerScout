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
- 初版日期识别采用保守规则，日期到区块转换在2026年11月12日新增（见下）；工具始终校验参数及用户已选地址。
- 上下文按保守字节上限估算容量，未返回用量时标为未知，不声称精确费用控制。
- 精确事实由程序生成；模型自由文本解释仍可能出错，证据引用不保证任意因果解释成立。
- 初版遗留少数错误诊断分类，2026年11月12日已修正（见下）；预算、只读范围与重试策略保持原规则，原始脱敏错误可查看。
- 初版实施时目录尚不是 Git 仓库；该段保留当时验收背景。根目录锁文件统一管理依赖。

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

## 后续增强：显式中断恢复

前两个增强提交a5ca687、f4ecdc6已按用户要求快进合并到本地main，合并后91项测试及类型检查通过。显式恢复在feat/run-resume开发，默认打开会话继续保持不自动重放。

新增 `--session S --resume R`，从原子检查点恢复最后模型轮次。保存响应可经同一Pi路径重放，已完成工具按调用ID返回保存值；剩余查询沿用原快照，可从头重试。原始HTTP、查询文件和被替代的中断尝试继续保存；最终事实只采用该工具调用的最新尝试。所有调用预算和用量累计，崩溃时对在途请求保守扣除等待上限。

子检查点先写盘，源resumedBy提交后才激活；加载时验证父链接，防止崩溃留下可分叉的孤立子运行。终态摘要先声明resumable意图，加载同时校验终态与checkpoint.closed，覆盖终态提交与检查点关闭之间的窗口。查询引用按文件哈希验证，损坏、跨会话、路径穿越、已消费源在网络前拒绝。

离线测试包含真实Pi工具批次取消、模型等待取消、数据HTTP中断、真实子进程exit后恢复、累计限制与未知用量、证据损坏、孤立子运行、终态关闭窗口、检查点写入失败以及快照持久化失败后的再次查询。均未调用真实模型或链上API。

最终106/106测试（启用本地编码器）及两个模块类型检查通过；独立审阅的3项Important均经失败回归修复并复核。超大历史写盘前拟合，存储失败不声明可恢复。首版仍不支持多进程协调、分页游标续传或后台自动恢复。

## 2026 年 11 月 12 日 本地复验与诊断修复

Windows Node 24.19.0；本机未安装可选编码器，按用户要求继续使用 estimated。下文真实验收使用本地已有密钥和进程级 127.0.0.1:10808 代理，没有改动系统配置。

修正错误分类中的宽泛 `exhausted` / `key` 匹配：供应商额度耗尽、重复 pageKey、每秒算力限流与本地预算分别分类，并保留证据写入失败诊断。21项新增测试覆盖分类和分页后额度失败的实际 QueryService 持久化；完整127项测试125通过、2项可选编码器测试跳过，两个模块类型检查通过。

运行 `npx tsx packages/agent-runtime/scripts/verify-live.ts` 进行真实 DeepSeek + Alchemy 验收。脚本不包含在 npm test 中，每次显式执行会产生真实调用和费用。记录保存在 [本轮验收索引](../runtime-results/live_2026-11-12T01-19-13-587Z/acceptance.json)。

| 场景 | 结果与核对项 | 模型/工具/数据HTTP | 供应商已报告Token |
| --- | --- | --- | --- |
| 真实摘要与余额 | completed；明确标记的合成验收背景触发真实摘要，summary持久化，真实主网余额来自证据 | 3 / 1 / 3 | 6650 |
| 工具完成边界取消后显式恢复 | cancelled → completed；原快照与queryId不变，恢复未增加数据HTTP与工具调用 | 累计 2 / 1 / 3 | 3354 |
| 在途模型取消与累计预算 | 两次模型预算下取消第2个真实请求；恢复为exhausted，未新增模型请求或数据HTTP | 累计 2 / 1 / 3 | 已知1496，另1次未知用量 |

这些验收验证真实供应商路径；不把合成背景当成用户研究事实，也不把未报告用量的中断请求算作零费用。Etherscan日期映射及日期查询在后续日期功能验收中另行记录。

## 2026 年 11 月 12 日 日期窗口验收

按用户选择实现 Etherscan `getblocknobytime`，最近七天为滚动168小时，日历日期按 Asia/Shanghai。使用 Alchemy 边界及相邻区块头校验映射。参考 [Etherscan 时间接口](https://docs.etherscan.io/api-reference/endpoint/getblocknobytime) 与 [Alchemy 区块头接口](https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-get-block-by-number)。

真实公开测试地址的组合查询已完成：[运行摘要](../runtime-results/s_a5930ea3-5edf-4ca1-b038-c42fe5ea1b81/r_b3ab2343-40ce-4bee-8282-f0c84bb7a81e/run-summary.json)。北京时间目标窗口为2026-11-05 09:28:49至2026-11-12 09:28:49，实际区块26345343至26395575，快照26395580。边界证据验证前一区块早于起点、起始区块位于窗口内、结束区块不晚于末端且后一区块晚于末端。

普通交易6条、流入转账29条、流出2条，三者均遍历完成；仅表示该测试地址此时此窗口的结果。运行completed，2次模型、2次工具、12次数据HTTP，供应商报告4331输入+405输出=4736 Token。

首次组合验收暴露estimated模式中完整工具预览超过输入容量，运行真实记录保留为partial。已加入失败回归并将模型预览中的边界proof保留在磁盘、记录数组按1800字节目标裁剪，真实重跑completed；不提高预算或假装完成模型解释。映射、完整已取得数据和proof仍保存在query.json及原始响应中。

日期恢复只保存原始时间窗口；完成查询中的映射随queryRefs哈希校验并复用。崩溃发生在查询边界提交之前时，可按同一窗口与快照重做映射，仍受累计预算限制。已有旧格式检查点不需要日期字段。

最终离线验证183项：181通过，2项可选本地编码器测试跳过，0失败；根与数据验证模块类型检查通过。独立审阅发现的日期修饰词、会话裁剪丢失映射来源、映射证据未提交即复用，以及旧证据日期范围不匹配问题，均已用失败回归修复并复核。未安装或改变Windows编码器。

## 2026 年 11 月 12 日 地址资金流分析

新增按原始整数与合约分组的确定性分析、`analyze_asset_flows` 只读工具、分析证据分页和 `flow_summary` / `counterparties` 事实引用。新转账证据持久化完整派生报告；旧查询可按相同口径重新计算，分析工具不修改源文件或其检查点哈希。数据依据为既有 [Alchemy Transfers API](https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers) 的 rawContract 和 uniqueId，普通交易不重复计入转账金额。

真实公开测试地址最近七天的资金流研究已 [completed](../runtime-results/s_9bb0b4b8-5f29-4d6d-bb9d-02cbd14d5eff/r_3b856d30-904e-4b86-a09b-fa6fafd60bc9/run-summary.json)：31条唯一转账（流入29/流出2/自转0）、17个币种、23个对手方；源窗口已遍历完成。3次模型、2次工具、11次数据HTTP；供应商报告6523输入+380输出=6903 Token。

另用未导入生产聚合器的独立 BigInt 脚本，直接从保存的原始单位重算全部17币种的流入/流出/自转/净额和23个对手方次数，逐项一致：[独立核对记录](../runtime-results/s_9bb0b4b8-5f29-4d6d-bb9d-02cbd14d5eff/r_3b856d30-904e-4b86-a09b-fa6fafd60bc9/flow-verification.json)。ETH已取得转账净流量为14175945283203034wei，此数不是利润或余额差。

最初两次真实验收暴露概览与大量分析分页累积导致estimated上下文溢出，记录仍保留为partial。通过有界概览、大小受限的精简分析分页，以及对较早分析工具结果保留queryId引用修复；工具调用配对、最新结果、完整源证据与原预算保持。资金流专用说明仅注入分析请求，避免影响已有日期组合查询。

独立审阅的2项Important（归一化覆盖冲突ID、常见分析意图漏判）都以失败回归复现并修复：分页/游标重复保护前先标记冲突，分析排除同ID所有变体；中英文净额/流入流出请求均要求真实分析事实。复核54项定向测试通过，无遗留Critical/Important。最终完整212项测试210通过、2项可选编码器跳过，类型检查通过。

## 2026 年 11 月 12 日 ENS 正向解析

新增 `.eth` 及子域的 ENSIP-15 规范化和固定主网快照解析，使用官方 UniversalResolver 的 `resolve(bytes,bytes)` 查询 ETH 地址记录。锁定 `@adraffy/ens-normalize@1.11.1`、`@noble/hashes@2.4.0`；只允许固定合约、方法和合法ABI的 `eth_call`。参考 [官方部署](https://docs.ens.domains/learn/deployments/)、[名称规范化](https://docs.ens.domains/resolution/names/) 与 [ENSIP-10](https://docs.ens.domains/ensip/10/)。

解析证据独立保存在 `resolutions/<resolutionId>/`，包含原名称、规范化名称、主网区块、地址、解析器、时间和原始RPC。成功证据落盘并建立哈希引用后，程序才授权模型查询派生地址。每轮最多4个名称；普通下一轮刷新名称绑定，明确旧查询ID保持历史语义；恢复固定原映射。任何名称失败都不会借用旧目标。当前不访问 CCIP-Read 网关，也不重建历史名称绑定。

| 真实公开名称验收 | 结果 | 模型 / 工具 / 数据HTTP | 已报告Token |
| --- | --- | --- | --- |
| `vitalik.eth` 当前ETH余额 | completed；区块26396033，5.794616987480413546 ETH | 2 / 2 / 4 | 3570输入 + 172输出 = 3742 |
| `vitalik.eth` 最近七天资金流 | completed；解析快照26396079，29条流入/2条流出，17币种、23对手方 | 4 / 5 / 12 | 8837输入 + 588输出 = 9425 |

对应[余额摘要](../runtime-results/s_da8442ed-939d-4fb2-b8f7-0c605db714c8/r_da30da11-e213-4020-bc23-22abd708e93c/run-summary.json)与[日期资金流摘要](../runtime-results/s_2c7be68b-5b85-4c29-8360-1eb880013bb2/r_8fcbc07b-18c3-4d84-a444-b1df40c3cf13/run-summary.json)均解析为 `0xd8da6bf26964af9d7eed9e03e53415d37aa96045`。日期资金流目标为北京时间2026-11-05 11:08:43至2026-11-12 11:08:43，实际区块26345841至26396074；映射使用查询快照的绑定。

首次ENS组合资金流验收在读取原始明细后触发上下文上限，保留为partial。修复后资金流轮次的证据分页最多2条，并压缩较早的证据读取结果，完整源记录仍保存；重复真实调用完成，原8/12/32预算不变。

独立审阅的3项Important（完整名称边界、名称内语义干扰、混合目标刷新丢失直接地址）均已修复并复核。离线覆盖真实进程在首次模型调用前退出、恢复不重复解析、映射哈希损坏、失败不回退、跨轮改绑与预算限制。最终完整235项测试233通过、2项可选编码器跳过、0失败；根及原数据模块类型检查通过。详细证据和剩余范围见[实施记录](superpowers/plans/2026-11-12-ens-progress.md)。

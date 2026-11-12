# LedgerScout

只读的 Ethereum Mainnet 研究助手。首版使用 Pi Agent Core 执行工具循环，DeepSeek 选择工具并组织解释；精确余额、普通交易和双向 ETH/ERC20 转账来自 Alchemy 与 Etherscan。

已经提供命令行、多轮本地会话、证据引用、部分历史提示、日期窗口查询、地址资金流分析、运行预算、超时、取消及显式恢复。股票、跨资产研究、ENS和后台自动恢复执行尚未实现。

## 本地配置

在项目根目录 `.env` 中配置 `ALCHEMY_API_KEY`、`ETHERSCAN_API_KEY`、`DEEPSEEK_API_KEY`。已有 `.env` 时保留原文件；首次安装可复制根目录 `.env.example`。密钥只在本地填写，不发到聊天或提交到 Git。

链上配置优先级：进程环境 > `data-validation/.env` > 根目录 `.env`。DeepSeek 配置：进程环境 > 根目录 `.env`。空进程变量会覆盖文件值，不自动读取 `.env.local`。默认 `DEEPSEEK_MODEL=deepseek-flash`，也支持 `deepseek-v4-pro`；连接官方 API，关闭思考模式，单次输出最多 2000 Token。

## 安装与使用

核心依赖要求 Node.js >=22.19.0；建议使用 Node.js 24，当前电脑验证版本为 24.19.0。在项目根目录执行：

```powershell
npm ci --ignore-scripts
npm run agent:config
npm run agent
```

`agent:config` 只显示配置存在性，不发请求。`agent` 进入多轮命令行，输入 `/exit` 结束。单次提问：

```powershell
npm run agent -- "查询 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 的 ETH 余额"
```

这是已知公开测试地址，不代表用户钱包。实际使用请明确给出研究地址，Runtime 不会静默使用验证脚本默认地址。输出包括会话 ID 和证据目录；继续已有会话时将下例 ID 替换为实际值：

```powershell
npm run agent -- --session s_YOUR_SESSION_ID "再查它的普通交易和双向转账"
```

机器可读输出使用 `npm --silent run agent -- --json "问题"`。`--json` 必须同时给出问题。`Ctrl+C` 取消本轮，已收到的证据进行有界保存。

历史查询未指定日期或区块时，默认从区块 0 到本轮快照，按最新优先，每页 25 条、2 页、最多 50 条；流入和流出分别计数。达到上限显示 `partial`，不等于完整历史。可明确指定起止区块和更小上限；最近若干条不代表指定天数。

### 日期窗口

```powershell
npm run agent -- "查询 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 最近七天的普通交易和双向转账"
npm run agent -- "查询 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 昨天的转账"
npm run agent -- "查询 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 2026-11-01 至 2026-11-03 的普通交易"
```

支持最近/过去/近 N 小时、天、周（中文数字一至九十九或阿拉伯数字），以及英文 `last/past N hours/days/weeks`。最近七天为本轮创建时刻向前168小时。
今天、昨天、前天、本周、上周、本月、上月及明确日期按北京时间 `Asia/Shanghai`；自然周从周一开始。日期支持 `YYYY-MM-DD`、`YYYY/MM/DD`、`YYYY年M月D日`，区间用“至”“到”或 `to` 连接，末日完整包含；未来部分截到查询时刻并明确提示。未支持或有歧义的表达会要求补充，不自动当作全历史。日期与显式区块不可混用。

日期窗口用于普通交易和转账。余额是区块时点的值，需查询当前余额或明确指定区块。日期映射同时需要 Etherscan 与 Alchemy 密钥：两个 Etherscan 时间请求，再读取最多四个边界/相邻区块头校验，所有请求计入原HTTP预算。映射失败、窗口没有已出块或边界校验失败会明确报错，不扩大查询范围。

回答和查询证据同时保存目标时间与实际区块范围。分页达到上限仍为 `partial`；模型只收到有限预览，完整已取得记录通过证据读取工具查看。显式恢复使用原时间窗口和快照；完成查询的映射可复用，中途未提交的映射可能重做并继续累计预算。

### 地址资金流分析

```powershell
npm run agent -- "分析 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 最近七天的资金流和主要往来地址"
```

先查询双向转账，再由本地代码基于完整已取得记录计算，分析本身不增加数据HTTP请求：

- 分别统计 ETH 和每个 ERC20 合约的流入、流出、净流量，自转单独列出。原始整数使用 BigInt，不累计浮点近似值，不把同名不同合约合并。
- 主要对手方按唯一转账记录数排序；每币种另有流入/流出已知金额排名。不同币种的金额不相加。
- 默认展示按记录数排序前10个币种、前5个对手方；每币种展示最多3个已知金额对手方。完整派生分析保存在对应转账 `query.json` 的 `data.flowAnalysis`，包含贡献记录ID。

金额缺失时只显示已知小计；ERC20精度缺失或冲突时保留原始单位并明确不换算。同ID的冲突记录从分析中排除，原始响应和冲突标记仍保留。自转从净额及对手方排名中排除。

报告继承源查询的日期/区块范围和每方向完整性。`partial`时，净流量与排名只覆盖已取得样本；不包含gas、NFT与零值转账，不代表利润、法币估值或余额变化。地址只作为往来地址，不推断身份。

模型使用 `analyze_asset_flows(queryId)` 获取有界概览；通过 `read_query_evidence` 的 `flow_assets` / `flow_counterparties` 分页读取精简统计（每页最多5条，实际还按大小裁剪，应根据返回条数和 `hasMore` 继续）。原始记录仍可通过 `incoming` / `outgoing` 读取。模型只引用 `flow_summary` / `counterparties` 事实，最终金额和排名由程序重新计算。恢复与旧证据访问沿用原日期、地址及预算约束。

## 测试与原数据验证

```powershell
npm test
npm run typecheck
npm run check:config --workspace data-validation
npm run test:all --workspace data-validation
```

`npm test` 完全离线。`test:all` 执行原有四项真实数据检查，结果仍保存到 `data-validation/results/`。原命令在子目录中继续可用，源码通过兼容导出复用 `packages/chain-data`，没有维护两套分页或金额算法。

详细参数和接口范围见 [模块说明](data-validation/README.md)。需求依据为本目录的产品需求文档。

## 运行记录与状态

记录保存在 `runtime-results/<sessionId>/<runId>/`，包括 `events.jsonl`、`queries/<queryId>/` 的原始响应与归一化结果、`answer.json` 和 `run-summary.json`。模型只看到证据 ID 与有限预览，不获得任意文件路径。

| 状态 | 含义 |
| --- | --- |
| `completed` | 本轮完成，依赖数据在其声明范围内取得 |
| `partial` | 有可用结果，但历史不完整、部分失败或最终模型回答未完全生成 |
| `awaiting_user` | 需要补充地址、区块范围等输入 |
| `failed` | 未能回答，或无法可靠保存证据 |
| `cancelled` | 用户取消 |
| `exhausted` | 请求、调用或运行时间预算耗尽 |

`completed`、`partial`、`awaiting_user` 的退出码为 0，`failed`、`exhausted` 为 1，取消为 130。判断数据完整性需同时看状态和 `completeness`。

事实区根据合法证据字段生成；模型解释单独标注，仍应视为解释与假设。普通交易与转账不相加为总次数，不将跨 Token 金额直接相加，不把资金流当作利润。

会话最多保留最近 20 轮原文、一个历史摘要和最近 32 个查询。上下文接近容量 80% 时，尝试一次模型摘要，压缩较旧完整轮次并保留最近两轮原文；摘要会随会话保存，重新打开后继续使用。摘要只承接研究意图和未完成事项，事实仍需引用真实查询证据。摘要失败会记录警告并降级按完整轮次裁剪；取消时不替换摘要。

容量默认按 12000 Token、预留 2000 输出 Token 控制，同时保留 24000 字节上限。未安装本地编码器时，请求前的 Token 数采用包含消息和工具定义的保守估算，不能作为精确账单。`events.jsonl` 的 `context_prepared` 记录计数方法及丢弃消息数量；`run-summary.json` / `--json` 的 `tokenUsage` 累计供应商已报告用量，`unknownRequests` 表示失败或未报告用量的请求数，不能把这些请求理解为零消耗。

可选安装官方本地编码器（需要 `uv`，或用 Python 3.10+ 执行脚本）：

```sh
npm run tokenizer:setup
```

安装后 CLI 自动使用官方离线模板计数，`context_prepared.method` 为 `local_tokenizer`，包含 encoding 和固定资产 revision；未安装或计数失败时仍使用 `estimated`。安装不需要API密钥，资产保存在忽略的 `.runtime/tokenizer/`，不随 Git 提交；下载校验失败可重跑命令。`deepseek-flash` 对应 V4.1，`deepseek-v4-pro` 对应 V4；两个词表均校验 SHA-256，worker只做本地编码、不联网，不接收API密钥。离线模板计数不等于供应商实际账单；服务端或模型映射更新后需要重新验证。

普通 `npm test` 不需要本地资产。安装后可运行 `LEDGERSCOUT_TEST_TOKENIZER=1 npm test` 验证真实离线编码器；该测试不会调用模型API。

摘要请求也占用原有模型请求次数和超时预算，不额外调用工具；不足三次模型请求预算时跳过摘要。缺少终态摘要的旧运行标记为 `interrupted`，不会自动重放。当前面向单用户、单进程，不提供多进程协同锁。

需要继续已取消、失败或进程中断的运行时，显式提供会话和运行 ID：

```sh
npm run agent -- --session s_会话ID --resume r_运行ID
```

恢复不能附带新问题，会生成带 `resumeOf` 的新运行；旧日志和证据保留。检查点复用已完成工具结果和原区块快照；中断中的只读查询可能从第一页重试，不支持分页游标续传。被替代的中断尝试保留在旧证据文件中，不作为成功重试的答案依据。恢复结果使用原查询时间和区块，不等于刷新当前数据。

调用次数、Token用量和原有限制沿恢复链累计；崩溃时对在途模型/工具保守扣除超时额度。已完成、待用户补充、正常分页上限回答或预算耗尽的运行不可恢复。源运行只能恢复一次；再次使用旧ID会提示后续运行ID。子检查点只有在源链接提交后才可激活；终态摘要与证据文件也参与恢复校验。旧版未保存检查点的运行需重新提问。

`run-summary.json` 的 `resumable` 表示本轮是否留下可恢复检查点；恢复前还会校验证据完整性、源链接及剩余预算。检查点位于运行目录的 `checkpoint.json`，已脱敏，不包含API密钥。

首版每轮最多 8 次模型请求（含重试与收尾）、12 次工具调用、32 次数据 HTTP 尝试；单次模型 30 秒、工具 45 秒、运行 120 秒。工具串行执行，同一供应商共享调度，只有临时错误进行有限重试。

[架构与选型说明](docs/superpowers/specs/2026-11-11-agent-runtime-design.md)记录 AstrBot、Pi 与 LangGraph.js 的源码参考；[集成与验收记录](docs/runtime-integration.md)记录实际依赖和真实调用证据。

## 当前电脑的网络配置

2026 年 11 月 11 日实测，Etherscan 直连超时，使用 Windows 已配置的本地 HTTP 代理 `127.0.0.1:10808` 后四项检查通过。当前 Node.js 24.19.0 支持通过环境变量使用代理。在运行真实检查的同一个 PowerShell 窗口设置：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:10808'
$env:HTTP_PROXY = 'http://127.0.0.1:10808'
$env:NODE_USE_ENV_PROXY = '1'
npm run agent
```

上述命令在项目根目录执行，仅影响当前终端及子进程。代理程序需保持运行；更换电脑或端口后按实际设置调整。不要关闭 TLS 校验来解决网络问题。Alchemy 应用还需启用 Ethereum Mainnet。

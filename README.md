# LedgerScout

只读的 Ethereum Mainnet 研究助手。首版使用 Pi Agent Core 执行工具循环，DeepSeek 选择工具并组织解释；精确余额、普通交易和双向 ETH/ERC20 转账来自 Alchemy 与 Etherscan。

已经提供命令行、多轮本地会话、证据引用、部分历史提示、运行预算、超时和取消。股票、跨资产研究、ENS、日期到区块转换和自动恢复执行尚未实现。

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

历史查询默认从区块 0 到本轮快照，按最新优先，每页 25 条、2 页、最多 50 条；流入和流出分别计数。达到上限显示 `partial`，不等于完整历史。可明确指定起止区块和更小上限；首版不把最近若干条当作最近七天。

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

容量默认按 12000 Token、预留 2000 输出 Token 控制，同时保留 24000 字节上限。请求前的 Token 数是保守估算，包含消息和工具定义，不能作为精确账单。`events.jsonl` 的 `context_prepared` 记录估算及丢弃消息数量；`run-summary.json` / `--json` 的 `tokenUsage` 累计供应商已报告用量，`unknownRequests` 表示失败或未报告用量的请求数，不能把这些请求理解为零消耗。

摘要请求也占用原有模型请求次数和超时预算，不额外调用工具；不足三次模型请求预算时跳过摘要。缺少终态摘要的旧运行标记为 `interrupted`，不会自动重放。当前面向单用户、单进程，不提供多进程协同锁。

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

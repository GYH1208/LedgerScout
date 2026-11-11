# ChainPilot · data-validation

独立、只读的 Ethereum Mainnet API 验证项目。使用 Node.js + TypeScript + tsx，无需钱包私钥、助记词或签名，不发送链上交易。

本次开发环境：Node **24.19.0**、npm **11.17.0**。代码兼容 Node **22+**；依赖版本由 `package-lock.json` 固定。

## 快速开始（PowerShell）

在本工作区打开终端：

```powershell
cd .\data-validation
npm ci
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
notepad .env
```

只在本地编辑器中填入 `ALCHEMY_API_KEY` 和 `ETHERSCAN_API_KEY`。Alchemy 应用需启用 Ethereum Mainnet 和 Transfers API；Etherscan 使用支持 V2 的 API key。不要将密钥粘贴到聊天、命令参数或截图中。

如果现有系统 npm 缓存出现 `EEXIST`，可使用独立缓存安装（不需要删除原缓存）：

```powershell
npm ci --cache ../work/npm-cache
```

检查配置并逐项运行：

```powershell
npm run check:config
npm run typecheck
npm test
npm run test:connectivity
npm run test:balance
npm run test:transactions
npm run test:transfers
# 一次执行全部四项；默认上限下，每次最多 12 个请求（重试另计）
npm run test:all
```

`npm test` 和 `npm run test:offline` 只运行离线测试，不访问 Alchemy/Etherscan。`test:all` 等四个命令才访问真实 API。

`npm run check:config` 仅显示地址、密钥是否存在及配置优先级，不验证密钥有效性。缺少所需密钥时，命令以退出码 1 结束，并在任何网络请求或结果文件创建前说明缺少哪些变量。

## 配置

配置优先级为：**进程环境变量 > 项目 `data-validation/.env` > 工作区根目录 `.env` > 默认值**。始终按项目路径加载，与运行时所在目录无关；不修改 `process.env`。空的进程变量或项目变量会覆盖下级值；如需使用下级配置，请移除上级空变量。不会自动加载 `.env.local` 等其他文件。

| 变量 | 默认值 / 范围 | 含义 |
| --- | --- | --- |
| `ALCHEMY_API_KEY` | 无 | 连通性、余额、转账，以及默认交易快照所需 |
| `ETHERSCAN_API_KEY` | 无 | Etherscan V2 交易历史所需 |
| `TEST_ADDRESS` | `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` | vitalik.eth 的公开地址；配置时必须用完整 0x 地址，不接受 ENS 名称 |
| `REQUEST_TIMEOUT_MS` | 15000；1–120000 | 单次请求超时，包含读取响应体 |
| `MAX_RETRIES` | 3；0–5 | 首次请求之外的重试次数 |
| `RETRY_BASE_MS` | 1000；1–60000 | 指数退避基础时间，附带随机抖动 |
| `RETRY_MAX_MS` | 10000；不低于基础时间，最高 60000 | 每次退避硬上限，`Retry-After` 同样受此限制 |
| `REQUEST_INTERVAL_MS` | 600；0–10000 | 串行请求之间最小间隔；重试也适用 |
| `START_BLOCK` | 0 | 历史查询起始区块，十进制非负整数 |
| `END_BLOCK` | 留空 | 留空时各检查开始前获取当前区块并固定分页终点；可指定十进制区块 |
| `TX_PAGE_SIZE` | 25；1–1000 | Etherscan 固定 `offset`，后续页不改变 |
| `TX_MAX_PAGES` | 2；1–100 | 交易历史最多请求页数 |
| `TX_LIMIT` | 50；1–10000 | 最多保留的去重交易数 |
| `TRANSFER_PAGE_SIZE` | 25；1–1000 | Alchemy `maxCount`，发送为十六进制 |
| `TRANSFER_MAX_PAGES` | 2；1–100 | 每个方向最多请求页数 |
| `TRANSFER_LIMIT` | 50；1–10000 | 每个方向最多保留的去重转账数 |

配置了无效地址、非整数或越界值会在请求前失败。余额单独固定当前区块，`START_BLOCK` / `END_BLOCK` 只影响历史查询。区块快照减少分页时新增区块造成的漂移，但不保证链重组或索引更新时的原子快照。

仅有 Etherscan key 时，可在 `.env` 明确填写 `END_BLOCK` 后运行 `test:transactions`；其余检查需要 Alchemy。单独执行某项检查不需要无关平台的 key。

## 四项检查与输出

1. **连通性**：调用 `eth_chainId`，验证为 `0x1`；调用 `eth_blockNumber`，验证十六进制区块并归一化为十进制。
2. **ETH 余额**：获取当前区块，在该区块调用 `eth_getBalance`；使用 `BigInt` 输出精确 `wei` 和 `eth` 字符串，不经过浮点转换。
3. **交易历史**：GET `https://api.etherscan.io/v2/api`，参数包含 `chainid=1&module=account&action=txlist`，以 `sort=desc` 从第 1 页开始获取普通交易。验证地址、区块、哈希、金额和失败标记，按哈希去重，保留原始 wei 与精确 ETH。
4. **转账**：对目标地址分别使用 `toAddress` 和 `fromAddress` 调用 `alchemy_getAssetTransfers`，类别为 `external`、`internal`、`erc20`。每个方向独立跟随 `pageKey`；按 `uniqueId` 去重。摘要含每类数量，归一化明细保留原始 hex 金额、decimals、token 合约；API 的 `value` 标为 `approximateValue`，不作为精确金额计算依据。

成功时控制台打印 `PASS <检查名>`、简要摘要和文件路径；失败时打印 `FAIL`、脱敏错误和错误文件路径。`test:all` 会继续检查后续项目，任何一项失败则最终退出码为 1；分页达到上限属于检查成功，但 **`complete: false`**。

结果目录形状（以下只有占位符，不代表已发生真实调用）：

```text
results/<UTC时间戳>-<随机后缀>/
  0001-eth_chainId.json
  ... 每个请求尝试的原始响应 ...
  ... 每项检查的 summary 或 error ...
  ...-run-summary.json
```

每个响应文件包含 UTC 时间、调用标签、尝试次数、HTTP 状态、`rawBody` 原始响应文本和可解析时的 `rawResponse`。必要的密钥脱敏会替换响应内容；不保存请求 URL、请求头或 API key。HTTP 错误、非 JSON 响应、JSON-RPC 错误、重试中的响应也会保存；未收到响应时只记录安全错误。每项摘要另存完整归一化明细，运行清单记录各项实际结果。

分页摘要中的 `complete` 只表示配置区块范围和查询类别已遍历完毕。`stopReason` 为 `exhausted`、`limit`、`maxPages` 或交易查询的 `resultWindow`。Etherscan 中途达到数量上限时 `nextPage` 可能指向当前未完整消费的页；Alchemy 的 `replayCurrentPage: true` 表示需从当前页起点重放并去重。脚本每次从第一页重新验证，不提供断点续传命令；要获取更多记录，请提高上限并重新运行。重复 Etherscan 整页、重复 Alchemy 游标或转账整页内容会报错，避免静默循环或错误宣称完整。

## API 范围与限制

以下根据官方文档核对于 **2026-11-11**；没有通过本地真实密钥验证账户权限或套餐额度。

- **Etherscan**：V2 必须传链 ID。`txlist` 返回普通交易，不等于内部调用或 ERC-20 事件。`status=0` 既可能表示无记录，也可能表示失败；代码只接受明确的 “No transactions found” 空结果，其余报错。[V2 txlist 文档](https://docs.etherscan.io/api-reference/endpoint/txlist)
- 官方限流表列出 Free 为 **3 次/秒、100,000 次/天**，且只覆盖选定网络。日额度耗尽会阻断，付费套餐是否允许超额依账户设置而定。默认 600ms 间隔只控制本进程；同一 key 在其他程序的请求仍会占用额度。[Etherscan Rate Limits](https://docs.etherscan.io/rate-limits)
- 本工具保守限制单页 1000 条、单区块窗口分页最多 10000 个位置；这属于工具保护上限，**不承诺平台能完整返回 10000 条历史**。大地址应缩小 `START_BLOCK` / `END_BLOCK` 后分段验证；不会因达到保护上限而宣称全历史已完整获取。
- **Alchemy**：`maxCount` 最多 1000；`pageKey` 有约 **10 分钟**有效期，应及时跟随，过期后重新开始查询。[Alchemy 官方参数说明](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/references/data-transfers-api.md)、[Transfers API Overview](https://www.alchemy.com/docs/reference/transfers-api-quickstart)
- Alchemy 使用账户级 Compute Units 吞吐额度，与其他应用共享；HTTP 429 或 RPC 限流错误会触发有界重试。权限、套餐、日额度及可用性需要用你自己的账户实际验证。[Alchemy Throughput](https://www.alchemy.com/docs/reference/throughput)
- 内部转账在 Ethereum Mainnet 上受支持。此项目排除零值转账、NFT，不把 gas 费用或质押奖励当作转账；历史转账并不是完整的余额变动账本。目标是验证数据接口，结果不用于推断资产价值或地址身份。[Alchemy Transfers endpoint](https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers)

## 错误处理与排查

| 现象 | 处理方式 |
| --- | --- |
| Missing API key | 在本地 `.env` 填入 key；检查上级进程变量是否为空并覆盖了文件 |
| HTTP 401 / 403、Invalid API Key | 核查账户、key、Ethereum Mainnet 权限、IP/来源限制；这类错误不重试 |
| HTTP 429、RPC / Etherscan 秒级限流 | 自动按指数退避与 `Retry-After` 重试；默认最多 4 次尝试，等待最多 10 秒/次；可提高请求间隔 |
| 日额度或月额度用尽 | 不进行 API 消息层的短期重试；等待额度恢复或在平台自行处理套餐 |
| Request timeout / Network failure | 检查本机 DNS、TLS、网络访问、公司网络策略；请求失败会有界重试，底层可能含凭据的异常不会输出 |
| HTTP 5xx | 有界重试，所有收到的响应保存在当前运行目录 |
| Invalid JSON / Response validation | 查看脱敏响应，确认不是代理 HTML、API 返回格式变化或不匹配的数据；不会把格式错误当成功 |
| Query timeout / record window error | 缩小区块范围、减少单页数量；不盲目重复历史查询 |
| 过期 pageKey / repeated pageKey | 重新运行；若仍出现，检查保存的原始响应和平台状态 |
| 保存结果失败 | 检查目录权限和磁盘空间；结果无法记录时本次检查失败 |

重试只针对网络/超时、HTTP 429/5xx 和识别出的 API 秒级限流。禁止重定向，防止携带 key 的请求被转发至其他地址。没有自动修改账户、升级套餐、开启超额付费的操作。

## 文件与安全

```text
.env.example / .gitignore    本地配置模板、忽略规则
package.json / package-lock.json / tsconfig.json
src/config.ts               配置读取、优先级、边界验证
src/output.ts               脱敏、独立运行目录、响应落盘
src/http.ts                 超时、重试、间隔、每次尝试记录
src/api.ts                  只读 API 调用、响应验证、金额转换
src/checks.ts               四项检查、分页、归一化
src/cli.ts                  命令分发、状态与结果路径
test/core.test.ts           离线响应/错误/分页验证
test/cli.test.ts            子进程命令行验证
```

`.gitignore` 排除 `.env`、其他 `.env.*`（保留 `.env.example`）、`results/`、依赖及日志。结果即使脱敏仍可能包含公开钱包活动，不应默认分享。提交前确认 Git 暂存区；忽略规则不能移除此前已被跟踪的文件。

本项目未自动创建含密钥的 `.env`。所有离线样本只存在测试代码和临时目录，不会写入 `results/` 冒充真实数据。

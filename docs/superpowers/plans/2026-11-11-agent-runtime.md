# LedgerScout Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 实现使用 Pi Agent Core、DeepSeek 与现有链上数据服务的本地只读研究助手。

**Architecture:** npm workspaces 提取共享 chain-data，原验证 CLI 保持兼容。Pi 执行循环由内部适配层隔离；Runtime 控制预算、工具、证据与终态，DeepSeek 使用官方 Chat Completions 接口。

**Tech Stack:** Node.js >=22.19，TypeScript，tsx，node:test，Pi Agent Core 1.5.2 与配套 Pi AI/Schema。

**Spec:** `docs/superpowers/specs/2026-11-11-agent-runtime-design.md`

## Global Constraints

- 单用户、本地单进程、Ethereum Mainnet、串行工具；不提供签名、广播、Shell、任意 HTTP 或任意文件工具。
- 默认每页 25、2 页、50 条；Runtime 上限每页 100、4 页、200 条；本地证据每次最多 20 条。
- 模型请求最多 8 次（含重试和收尾）、工具最多 12 次、HTTP 尝试最多 32 次。
- 模型超时 30 秒、工具 45 秒、运行 120 秒；所有等待可取消。
- 所有金额与精度保留精确字符串；部分历史不可被回答格式化丢失。
- 同会话证据读取，五类关联 ID，日志脱敏，一个运行一个终态。
- 用户已批准设计并要求直接实施；本会话原地执行，不另设计划批准关卡。

## Review Focus

- 跨工具地址切换与旧会话证据不得污染新查询；Task 3/4 覆盖。
- 分页已经取得数据后失败或取消，保留真实证据并输出正确状态；Task 2/3 覆盖。
- Pi 吞掉回调异常、模型永不响应或一次返回大量工具时仍须硬性停止；Task 1/4 覆盖。
- Token/合约元数据含伪指令或密钥回显时，只能作为脱敏数据；Task 3/4 覆盖。
- 写盘失败或进程遗留半成品时，不能宣称已完成或自动重放；Task 4/5 覆盖。

---

### Task 1: Workspace 与 Pi 内核边界

**Files:** root `package.json`, `tsconfig.json`; `packages/agent-runtime/package.json`, `src/engine/pi.ts`, `test/pi.test.ts`; `packages/chain-data/package.json`。

**Interfaces:** `runPi({messages, tools, request, signal, onEvent, maxRequests}): Promise<EngineResult>`；内部消息为 user/assistant/tool，工具为 `{name,description,parameters,execute(args,callId,signal)}`，请求为 `(ModelRequest)=>Promise<ModelReply>`。

- [x] 写测试：脚本模型发起工具后根据实际结果回答；非法参数不执行；取消停止；最后一次请求不暴露工具。
- [x] 运行 `node --import tsx --test packages/agent-runtime/test/pi.test.ts`，确认缺少适配功能失败。
- [x] 验证已发布 1.5.2 的接口，实现 Pi 消息/事件转换和收尾控制。
- [x] 重跑测试与根目录 `npm run typecheck`；记录发布版本兼容结论。

### Task 2: 公共数据包与取消调度

**Files:** `packages/chain-data/src/{config,http,api,checks,output,index}.ts`, `test/transport.test.ts`; 原 `data-validation/src` 对应文件改为 re-export。

**Interfaces:** 原 `Config/Api/Checks/Transport/Results` 保持兼容；新增 `RequestScope {signal?,beforeRequest?}`；`RequestScheduler` 串行执行并保持最小间隔；Checks 的参数增加 `preservePartial` 和可选余额区块。

- [x] 写测试：上层取消中止在途响应与退避，不重试；共享调度不能重叠；第二页失败保留首批记录；两方向一方失败不抹掉另一方。
- [x] 先运行新增测试观察失败。
- [x] 提取已有算法、加入取消与 scope；原 22 项测试保持兼容。
- [x] 运行 `npm test` 和 `npm run typecheck`，确认旧 CLI 的缺密钥行为保持。

### Task 3: 查询服务与证据协议

**Files:** `packages/chain-data/src/queries.ts`, `test/queries.test.ts`; `packages/agent-runtime/src/{tools,types}.ts`。

**Interfaces:** `createQueryService(options): QueryService`；`service.query(name,args,context): Promise<QueryResult>`；`readEvidence(queryId,collection,offset,limit)`；结果字段使用设计稿第 7.1 节。

- [x] 写测试：非法参数不请求；固定快照复用；两地址不串；部分记录保留；完整性、精确金额、证据与脱敏落盘；证据读取越权拒绝。
- [x] 先运行新增测试观察失败。
- [x] 实现服务和四个工具 Schema；查询原始响应有 callId/queryId 关联，不把磁盘路径回传模型。
- [x] 运行数据包全部测试、原 CLI 测试和类型检查。

### Task 4: Runtime 状态、预算、会话与回答

**Files:** `packages/agent-runtime/src/{runtime,session,context,answer,types}.ts`, `test/runtime.test.ts`。

**Interfaces:** `runAgent(options): Promise<RunResult>`；`SessionStore` 单写者事件和原子摘要；`renderAnswer(draft,queries)` 只从合法证据生成事实；上下文按完整轮次限制。

- [x] 写测试：真实内核调用链上假响应后确定性事实；达到记录上限为 partial；未知证据只允许一次修正；模型/工具/HTTP 预算、重复查询缓存与失败限制。
- [x] 写测试：取消、无结果错误、写盘错误、空模型输出、跨会话引用、缺地址和日期窗口澄清、恢复中断标记、上下文过大。
- [x] 先运行新增测试观察失败。
- [x] 实现有界生命周期、5 秒收尾期限、请求超时与有限模型重试、关联事件、只读工具与结构化答案。
- [x] 运行 `npm test`、`npm run typecheck`，检查最终状态恰好一次。

### Task 5: DeepSeek 与 CLI

**Files:** `packages/agent-runtime/src/{model,cli,index}.ts`, `test/{model,cli}.test.ts`; root `.env.example`, `.gitignore`, `README.md`。

**Interfaces:** `createDeepSeekRequest(config,fetch?)` 返回内核请求函数；默认官方 `https://api.deepseek.com`、当前官方 `deepseek-flash`、关闭思考模式；`npm run agent -- [--session ID] [--json] [问题]`，`npm run agent:config` 仅打印存在性。

- [x] 写测试：官方协议的 tools/arguments/tool_call_id、缺密钥提前失败、401 不重试、429/5xx 有限重试、超时与异常脱敏、禁用工具时忽略伪工具调用、CLI 不泄密。
- [x] 先运行新增测试观察失败。
- [x] 实现 DeepSeek 请求、模型名可配置、SIGINT、单轮/交互模式和配置检查；仅追加缺失的空密钥配置，不覆盖现有密钥。
- [x] 运行根目录测试、类型检查及 CLI 离线 smoke；凭据就绪时真实 DeepSeek→链上端到端验证并保存证据。

### Task 6: 全面核验与独立代码审阅

**Files:** `docs/superpowers/plans/2026-11-11-agent-runtime-progress.md`, `docs/runtime-integration.md`, 前述实现文件。

- [x] 自查设计稿所有验收条目与对应测试，记录差异及真实验证限制。
- [x] 运行全套测试、类型检查、原验证 CLI 和 Runtime 命令；扫描新增日志及证据中的凭据回显，不输出密钥。
- [x] 派独立审阅者只读检查最终代码与设计，修复重要问题；每项修复先加失败回归测试再修改。
- [x] 完成使用说明和实施记录，报告实际完成项、测试结果、依赖版本与外部配置限制。

## 执行约定

当前文件夹尚无 `.git`，本次按用户要求在当前项目实施，不创建另一个代码副本，不自动关联/推送远程仓库。进度使用同目录 `2026-11-11-agent-runtime-progress.md` 保存。测试命令的完整输出可保存在被忽略的 `.superpowers/`；未初始化仓库时不虚构提交。

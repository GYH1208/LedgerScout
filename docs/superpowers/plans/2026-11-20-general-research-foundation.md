# General Research Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付阶段A：直接提供文本即可进行有来源的摘要/比较，通用能力循环有界、可恢复，并保留Ethereum入口与旧历史。

**Architecture:** 在现有agent-runtime包新增research子目录，复用Pi与模型接口；Ethereum通过明确的兼容路由继续调用原runAgent，不嵌套Agent。SQLite增加通用元数据，Web按会话种类选择一个实际运行器；阶段A不迁移全部Ethereum业务。

**Tech Stack:** Node >=22.19.0、TypeScript、现有锁定Pi 1.5.2、DeepSeek、node:sqlite、React/Vite；不增加服务或数据库，不引入新运行依赖。

**Spec:** `docs/superpowers/specs/2026-11-20-general-research-agent-design.md`（阶段A；B/C/D另行计划）

## Global Constraints

- 默认15次模型请求、35秒单次模型超时、300秒整轮、12次工具调用、32次数据HTTP尝试；工具45秒，上下文24000字节/12000tokens，输出预留2000tokens。
- 恢复与子步骤累计计数和时间，不隐式扩大；保留一次收尾机会，不能保证超时或取消后还能调用模型。
- 通用入口只需DeepSeek；Ethereum仍检查Alchemy/Etherscan。无配置、失败和不可读材料不以样例结果替代。
- A仅接收用户直接提供的文本；无联网、文件上传/扫描、任意代码执行、通用多Agent或美股能力承诺。
- 旧session/checkpoint/query格式、地址授权、严格数值验证和恢复器不改写；新会话显式选择research或ethereum。
- 维持现有三栏视觉、demo/live隔离与Sites构建文件；普通测试离线且使用临时目录，不读取真实密钥或改动个人历史。

## Review Focus

1. 文本包含“忽略规则”、密钥样式或其他会话ID：材料不能授予能力；日志脱敏、跨会话读取拒绝（任务2/4）。
2. 重复同页读取、参数换序、超大分页：缓存签名稳定，第2次无进展读取封闭此路径，实际返回与Schema一致（任务2/4）。
3. 模型/工具在取消后晚返回，进程在请求中崩溃：不追加有效结果，预扣预算不退款，不自动重放（任务3/4）。
4. 旧SQLite/WAL、迁移失败、检查点版本未知或源文件被改/换成符号链接：备份可核验、迁移回滚、恢复拒绝，旧记录可读（任务3）。
5. 缺少链上配置、会话种类混用、伪造来源引用：通用仍可用，明确拒绝混用与无效引用，未验证答案不能标为完成（任务1/4/5）。

---

## 文件职责与公共契约

- `packages/agent-runtime/src/research/contracts.ts`：版本化数据与验证；`registry.ts`：能力选择/权限/Schema；`evidence.ts`：直接文本快照与有界读取。
- `research/budget.ts`：纯预算与收敛策略；`research/runtime.ts`：通用Pi编排与收尾；`research/store.ts`：通用日志、检查点与安全读取。
- `src/model.ts`：拆出独立模型配置，旧loadRuntimeConfig签名兼容；`src/limits.ts`：现有默认值的共同来源；`src/dispatch.ts`：显式兼容路由。
- `packages/web-server/src/research-history.ts`：通用历史验证/投影；现有storage/server/views/history只增加按种类分派，不把通用结果塞入QueryResult。
- `apps/research-prototype/src/ResearchResult.jsx`：通用结果/来源展示；`LiveApp.jsx`和`live-api.js`：模式选择与请求。

所有通用协议带`version: 1`。ID沿用安全的前缀+UUID形式，禁止以客户端路径定位文件。下列类型在contracts.ts定义并导出，非任意字典扩展：

```ts
type TaskKind = 'research' | 'ethereum';
type TextInput = { title: string; text: string };
type Source = { version: 1; id: string; sessionId: string; kind: 'user_text';
  title: string; fetchedAt: string; hash: string; revision: number };
type Evidence = { version: 1; id: string; sourceId: string; sourceHash: string;
  locator: { kind: 'paragraph'; start: number; end: number; charStart: number; charEnd: number }; text: string };
type Analysis = { version: 1; id: string; inputEvidenceIds: string[];
  operation: string; parameters: Record<string, unknown>; result: unknown };
type Artifact = { version: 1; id: string; taskId: string; revision: number;
  hash: string; mediaType: string; evidenceIds: string[] };
type BudgetLimits = typeof defaultLimits;
type BudgetState = { models: number; tools: number; http: number;
  elapsedMs: number; reservedMs: number };
type Task = { version: 1; id: string; sessionId: string; goal: string;
  sourceIds: string[]; allowedCapabilities: string[];
  resourceIds: string[]; expectedOutputs: string[];
  steps: { name: string; status: 'pending' | 'running' | 'completed' | 'skipped' }[];
  status: 'running' | RunStatus; limits: BudgetLimits; budget: BudgetState };
type ResearchDraft = { answer: string; evidenceIds: string[]; gaps: string[] };
type ResearchResult = { version: 1; kind: 'research'; sessionId: string; runId: string;
  task: Task; answer: string; sources: Source[]; evidence: Evidence[];
  analyses: Analysis[]; artifacts: Artifact[]; warnings: string[];
  tokenUsage: RunResult['tokenUsage']; resumeOf?: string; resumable: boolean };
```

A中Analysis/Artifact定义和校验存在，数组为空；不暴露没有实现的计算或导出工具。Source的hash固定UTF-8快照字节，Evidence的段落索引从1开始，统一CRLF为LF后按空行分段，保留规范化快照用于定位；charStart/charEnd是该段内从0开始的Unicode码点半开区间。未来增加source/locator种类需显式协议升级。

## Task 1: 协议、模型配置与旧运行器兼容路由

**Files:** Create `research/contracts.ts`, `src/limits.ts`, `src/dispatch.ts`; Modify `src/model.ts`, `src/runtime.ts`, `src/index.ts`; Test `test/research-contracts.test.ts`, `test/model.test.ts`, `test/dispatch.test.ts`（src/test相对agent-runtime）。

**Interfaces:**
- Consumes: `runAgent(options): Promise<RunResult>`、现有`RequestModel`/`RunStatus`。
- Produces: 上述契约与`validateTask(value: unknown): Task`；`loadModelConfig(env?: NodeJS.ProcessEnv): {key:string; model:string; outputDirectory:string}`；`defaultLimits`从limits.ts导出并由runtime.ts兼容再导出。
- Produces: `dispatchTask<T>(kind: TaskKind, runners: {research:()=>Promise<T>; ethereum:()=>Promise<T>}): Promise<T>`，只执行所选runner一次，无额外模型判断。

- [ ] **Step 1: 写失败测试。** `model_config_independent_of_chain`通过依赖注入/临时配置夹具断言只设DeepSeek、不读chain配置也可加载；旧loadRuntimeConfig仍返回chain。`dispatch_exactly_one_runner`断言ethereum调用数1、research调用数0。`reject_unknown_protocol`断言version2抛错、task缺resourceIds抛错；`defaults_unchanged`断言模型15/35000、整轮300000、工具12/HTTP32。
```ts
assert.deepEqual([defaultLimits.maxModelRequests, defaultLimits.modelTimeoutMs,
  defaultLimits.runTimeoutMs, defaultLimits.maxToolCalls, defaultLimits.maxHttpRequests],
  [15, 35000, 300000, 12, 32]);
assert.throws(() => validateTask({version: 2}));
```

- [ ] **Step 2: 运行并确认新增测试因缺少导出失败。** `npx tsx --test packages/agent-runtime/test/research-contracts.test.ts packages/agent-runtime/test/model.test.ts packages/agent-runtime/test/dispatch.test.ts`。
- [ ] **Step 3: 实现契约、运行时校验、独立模型配置和确定性路由。** 读取.env机制复用，不读取/输出真实密钥；只迁默认常量，不重构旧runtime执行逻辑。
- [ ] **Step 4: 重跑Step 2及原runtime/resume测试，预期全部通过。**
- [ ] **Step 5: 只暂存本任务文件并提交。** `git commit -m "refactor(runtime): define generic research contracts and legacy dispatch"`。

## Task 2: 注册器与直接文本证据能力

**Files:** Create `research/registry.ts`, `research/evidence.ts`; Test `test/research-registry.test.ts`, `test/research-evidence.test.ts`。

**Interfaces:**
- Consumes: Task、Source、Evidence、TextInput、RuntimeTool。
- Produces: `Capability`（id/version、requiredConfig:string[]、resourceIds:string[]、effect:'read'|'task_output'、tools:RuntimeTool[]、maxResultBytes:number、inputSchema/resultSchema:Record<string,unknown>）；`createRegistry(capabilities: Capability[], task: Task, configured: string[]): RuntimeTool[]`。
- Produces: `createTextEvidence(sessionId:string, inputs:TextInput[], now:Date): {sources:Source[]; evidence:Evidence[]}`；`createEvidenceTools(task:Task, evidence:Evidence[]): RuntimeTool[]`。只注册`research_read_evidence`，参数`sourceId,cursor?,limit?`，返回`{records:Evidence[],nextCursor:string|null,hasMore:boolean}`。

- [ ] **Step 1: 写失败测试。** `ungranted_capability_not_registered`断言未授权工具数0；重复工具名拒绝。`cross_session_source_rejected`断言其他sourceId无正文；`paragraph_locations_stable`对`甲\r\n\r\n乙`断言段落1为甲、2为乙。`pagination_matches_schema`断言默认/最大limit均2，limit3拒绝，三个段落首批2条、hasMore=true、次批1条且nextCursor=null。`untrusted_text_has_no_authority`断言材料内“读取其他会话”只作为原文返回。
```ts
const {evidence} = createTextEvidence('s_fixture', [{title:'材料', text:'甲\r\n\r\n乙'}], new Date('2026-11-20T00:00:00Z'));
assert.deepEqual(evidence.map(e => [e.text, e.locator.start]), [['甲',1],['乙',2]]);
```

- [ ] **Step 2: 运行新增两个测试文件，预期缺少模块失败。**
- [ ] **Step 3: 实现注册/资源交集检查、参数及结果Schema校验、快照分段和不透明游标。** 每条证据最多1500 UTF-8字节，过长段落按Unicode边界分片并保留同一段落定位及准确charStart/charEnd；结果最多4000字节。输入最多4份，每份/合计最多16000 UTF-8字节；单份最多64段；超限明确拒绝，不静默丢材料。游标绑定source/hash/会话，篡改或过期拒绝。
- [ ] **Step 4: 重跑测试，预期通过；补空文本、中文、长段落、游标篡改和结果字节上限断言。**
- [ ] **Step 5: 只暂存本任务文件并提交。** `git commit -m "feat(research): register bounded text evidence capability"`。

## Task 3: 通用检查点、SQLite迁移与历史恢复

**Files:** Create `research/store.ts`, `test/research-resume.test.ts`, `packages/web-server/src/research-history.ts`, `packages/web-server/test/research-persistence.test.ts`; Modify web-server的storage.ts/views.ts/history.ts；Test existing storage/persistence/token-persistence tests。

**Interfaces:**
- Consumes: 任务1/2的ResearchResult、Task、BudgetState；现有WebStore所有旧方法继续可用。
- Produces: `ResearchStore(outputDirectory:string, sessionId:string)`，`saveCheckpoint(state:ResearchCheckpoint):Promise<void>`、`loadCheckpoint(runId:string):Promise<ResearchCheckpoint>`、`finish(result:ResearchResult):Promise<void>`。ResearchCheckpoint含version/kind、runId/lineage、task、sources/evidence、messages、capabilityVersions、cache/noProgress、已完成callId与待决调用、tokenUsage及关闭/恢复标记。
- Produces: WebStore.accept的可选`kind?:TaskKind`（默认ethereum）；`finishResearch(jobId:string,result:ResearchResult):void`；StoredJob用kind区分PublicRun与ResearchResult受控投影。`loadResearchSummary(base:string,sessionId:string,runId:string):Promise<ResearchResult>`；旧恢复继续只走CheckpointStore。

- [ ] **Step 1: 写失败测试。** `resume_keeps_spent_budget`预扣2模型/1工具后中断，恢复首次调用断言模型3而非1；已完成只读call不重放，未知写入步骤不可恢复。`changed_source_or_grant_rejects_resume`断言哈希/资源/能力版本变更拒绝。`migration_preserves_legacy`构造schema2+WAL+旧证据，迁移后原记录/哈希不变。`migration_failure_rolls_back`故障注入断言user_version仍2且备份可读。`safe_read_rejects_symlink`和未来版本检查点均拒绝。
以下断言接在临时schema2数据库、迁移故障注入和备份读取夹具之后：
```ts
assert.equal(afterFailure.userVersion, 2);
assert.deepEqual(backupEvidenceHashes, originalEvidenceHashes);
assert.equal(migratedLegacyJob.kind, 'ethereum');
assert.equal(startupSupplierCalls, 0);
```

- [ ] **Step 2: 运行新恢复/持久化测试，预期缺少API失败。**
- [ ] **Step 3: 实现通用检查点与摘要。** 放在`runtime-results/research/<sessionId>/<runId>/`，与旧导入扫描隔离。原子写、哈希验证、路径每层拒绝符号链接、有界读取；每次外调先保存累计预扣计数与时间预留。恢复消耗已预留时间，保守不退款；恢复上限取原/当前较小值，闭合/已恢复/耗尽任务拒绝。无自动恢复。
- [ ] **Step 4: 实现schema3迁移。** sessions/jobs增加kind默认ethereum；新增research_sources/research_evidence_refs，复用jobs的全局单运行约束，跨种类会话拒绝。仅在获得owner lease、无活跃写入后迁移；迁移前用SQLite一致快照备份（覆盖WAL已提交内容），复制被引用的不可变原文件并保存哈希清单至唯一backup目录，全部成功才事务迁移。备份失败不迁移，迁移失败回滚并保留备份；不自动覆盖损坏的原库。旧history/query路径不改；初始化分派通用与旧结果恢复，启动无供应商调用。
- [ ] **Step 5: 运行新增测试及web-server全部测试，预期通过。** 加入结果文件已写/SQLite未finish的崩溃窗口、双服务owner冲突、重复finish幂等、跨会话evidence访问；备份恢复到临时目录核验原结果和源哈希。
- [ ] **Step 6: 只暂存本任务文件并提交。** `git commit -m "feat(storage): persist versioned research tasks alongside legacy history"`。

## Task 4: 有界通用执行、引用校验与收尾

**Files:** Create `research/budget.ts`, `research/runtime.ts`; Modify `src/engine/pi.ts`, `src/index.ts`; Test `test/research-budget.test.ts`, `test/research-runtime.test.ts`, existing `test/pi.test.ts`。

**Interfaces:**
- Consumes: Tasks 1–3，ResearchStore检查点API；`runPi`、`fitContextAsync`、RequestModel。
- Produces: `runResearch(options: ResearchOptions): Promise<ResearchResult>`；ResearchOptions为`{input:string; texts?:TextInput[]; request:RequestModel; outputDirectory:string; sessionId?:string; resumeRunId?:string; signal?:AbortSignal; counter?:TokenCounter; limits?:Partial<BudgetLimits>; secrets?:string[]; now?:()=>Date; onEvent?:(event:EngineEvent)=>void}`。
- Produces: `BudgetController(limits:BudgetLimits, saved?:BudgetState)`，`reserve(kind:'models'|'tools'|'http'):void`、`snapshot():BudgetState`、`mustFinalize():boolean`；同步预扣，超额抛有类型错误。
- Extends: runPi增加可选`shouldFinalize?:()=>boolean`；默认不改变旧行为。提前收尾和最后一次请求均不给tools，拒绝执行该次回复中的工具调用。

- [ ] **Step 1: 写失败测试。** `summarizes_two_user_texts`用固定RequestModel断言completed、来源2、有效引用2、HTTP0，无ETH字段。`no_materials_asks_user`断言awaiting_user且模型0。`foreign_or_missing_citation_is_partial`断言假引用不能completed。`finalization_reserves_last_request`设模型3，断言第3次tools=[]、总计3；单次超时配置35000。`no_progress_signature_is_canonical`用参数换序连续读同页，断言底层执行1次、第二次重复返回NO_PROGRESS并转收尾；工具计数包含缓存命中和阻断尝试且不超过12。
```ts
const budget = new BudgetController({...defaultLimits, maxModelRequests:3},
  {models:2, tools:0, http:0, elapsedMs:0, reservedMs:0});
assert.equal(budget.mustFinalize(), true);
budget.reserve('models');
assert.equal(budget.snapshot().models, 3);
assert.throws(() => budget.reserve('models'));
```

- [ ] **Step 2: 运行新增测试文件及pi.test.ts，预期新接口缺失失败。**
- [ ] **Step 3: 实现runResearch与预算控制，并接入任务3的ResearchStore。** 阶段为understand/collect/verify/report；固定输出ResearchDraft JSON，程序检查引用归属/定位/哈希，完成必须有非空答案、有效引用、无未完成要求。语义正确性另由评测检查；不因JSON有效宣称事实已验证。收尾时只用现有证据；无法生成时确定性返回已有来源和缺口，状态partial/exhausted，空结果failed。取消保持cancelled，不为收尾重新发模型请求。
- [ ] **Step 4: 实现缓存与无进展策略。** 只读签名按能力版本/源hash/排序参数/游标规范化；唯一读取后第一次重复复用，第二次重复封闭此签名并要求收尾。缓存命中不耗HTTP，工具尝试仍计数。模型和工具用取消/超时race，晚到结果不写入；预算预扣保存后才能开始调用。上下文优先读取有界证据，fitContext不能容纳时明确给缺口，禁止截断成损坏tool批次。
- [ ] **Step 5: 运行新增测试及完整agent-runtime测试，预期通过。** 加入恶意末轮toolCalls、模型异常用量缺失、取消后晚返回、纯空回答、上下文超限；断言计数与状态准确且日志无secrets。
- [ ] **Step 6: 只暂存本任务文件并提交。** `git commit -m "feat(research): run bounded evidence tasks with finalization"`。

## Task 5: 本地Web入口与按能力配置

**Files:** Modify `packages/web-server/src/server.ts`, `apps/research-prototype/src/LiveApp.jsx`, `apps/research-prototype/src/live-api.js`, `apps/research-prototype/src/styles.css`（仅必要样式）；Create `apps/research-prototype/src/ResearchResult.jsx`, `packages/web-server/test/research-server.test.ts`, `apps/research-prototype/scripts/verify-research-offline.mjs`。

**Interfaces:**
- Consumes: dispatchTask、runResearch、WebStore与ResearchResult。
- Produces: `/api/state`新增`capabilities:{research:{ready:boolean},ethereum:{ready:boolean}}`与会话kind；旧顶层ready保留Ethereum语义兼容。`POST /api/runs`增加`kind?:TaskKind,texts?:TextInput[]`，缺省ethereum；通用恢复只附sessionId/resumeRunId/kind，禁止附新问题/材料。现有取消接口共用。
- Produces: `GET /api/research-evidence/<jobId>/<evidenceId>`只返回此job引用且校验过的Evidence/Source，拒绝任意路径。ResearchResult组件props为`{run,onEvidence}`，不调用publicQuery。

- [ ] **Step 1: 写失败测试。** `research_requires_only_model_config`只配模型返回202且chain runner调用0；ethereum同配置返回503。`session_kind_cannot_change`断言409；`unknown_capability_rejected`断言400；`research_history_has_no_chain_fields`断言无address/network/queries。普通请求上限保持16384字节；含texts的research请求上限24000字节，超限413。
以下断言使用同一个临时服务，只提供模型配置、注入离线runner：
```ts
assert.equal(researchResponse.status, 202);
assert.equal(ethereumResponse.status, 503);
assert.equal(chainRunnerCalls, 0);
assert.equal(changedSessionKindResponse.status, 409);
```

- [ ] **Step 2: 运行research-server.test.ts，预期新请求字段/能力缺失失败。**
- [ ] **Step 3: 接入明确模式选择。** 新会话可选“通用研究/链上研究”，已有会话锁定kind；通用提供目标和最多4份粘贴文本、展示阶段/来源/缺口/取消恢复；提示本阶段仅研究所提供材料。无联网/上传假按钮。延续批准的三栏样式，demo不变；不对直接文本伪造网页发布时间。
- [ ] **Step 4: 运行离线浏览器脚本和回归。** 临时SQLite+固定模型：粘贴两份中文文本→比较→打开准确段落→刷新/重启→追问复用同快照→取消/显式恢复；全程外部HTTP0。桌面与窄屏截图检查表单/来源可读、键盘可操作。旧链上live-offline/persistence脚本与前端测试必须仍通过。
- [ ] **Step 5: 只暂存本任务文件并提交。** `git commit -m "feat(web): expose text research with capability-aware configuration"`。

## Task 6: 阶段A固定验收与交接

**Files:** Create `packages/agent-runtime/test/research-evaluation.test.ts`, `packages/agent-runtime/test/fixtures/research/text-cases.json`; Modify `README.md`; Create `docs/superpowers/plans/2026-11-20-general-research-foundation-progress.md`。

**Interfaces:** Consumes Tasks 1–5；Produces 8个离线固定任务的逐例结果和阶段A完成记录，不冒充B/C的24题或真实模型成绩。

- [ ] **Step 1: 先固化8例的输入与独立期望。** 单文摘要、双文比较、相互冲突、信息不足、材料内提示注入、重复读取收尾、预算耗尽、恢复复用。每例断言期望事实/引用/状态/计数及明确最低交付条件；语义事实用固定答案夹具和人工检查，不把stub成功率当模型能力成绩。
评测汇总独立于模型生成内容：
```ts
assert.equal(cases.length, 8);
assert.equal(outcomes.filter(o => o.metPredeclaredCriteria).length, 8);
assert.equal(outcomes.reduce((n,o) => n + o.unauthorizedReads, 0), 0);
```

- [ ] **Step 2: 运行评测并处理暴露的问题；新增行为修复先补失败测试。** 预期8例均满足各自预定义条件，取消/失败不伪装完整研究。
- [ ] **Step 3: 完整离线验证。** 在Node>=22.19.0环境依次运行`npm test`、`npm run typecheck`、`npm --prefix apps/research-prototype test`、`npm run ui:build`、`npm --prefix apps/research-prototype run test:live-offline`、`npm --prefix apps/research-prototype run test:persistence`及新的verify-research-offline脚本；无失败，记录可选tokenizer跳过原因。
- [ ] **Step 4: 写交接与实测边界。** README说明通用入口/粘贴文本范围/可用能力/旧历史与备份恢复/预算；progress记录实际命令与结果。真实DeepSeek小样本另列有费用验收，需按当前授权判断；未运行明确标记，不用离线测试代替性能结论。
- [ ] **Step 5: 请求新鲜全分支代码审阅并解决阻塞项。** 再验证受影响测试后提交本任务；保留可审阅分支，不未经用户要求合并/推送。

## 自审与阶段覆盖

- A协议/注册/配置：任务1/2；执行质量与收尾：任务4；旧数据兼容、版本化恢复和备份：任务3；实际新入口：任务5；验收：任务6。
- Review Focus五项均映射对应任务的失败测试；类型与入口签名按公共契约衔接。
- B的联网/PDF/文件索引、C的表格计算/产物下载、D的Ethereum全面迁移/美股不在本计划；不得以协议空数组宣称这些能力已交付。
- 执行前按using-git-worktrees建立隔离工作区并跑离线基线；开发方式待用户审阅本计划后确定。

# 研究报告：dsh 最新版本与 omp-2-dsh 插件套件（0.1.1-rc.2）兼容性

> 只读审计。本文件不修改任何代码、不构建、不运行测试；所有结论均带上下游源码 `file:line` 证据。
> 审计时间：2026-10-07。基线：本套件全部插件 pin `@deepseek-ai/dsh-*@0.1.1-rc.2` + `@deepseek-ai/cordis@4.0.1`。

---

## 0. 结论速览（TL;DR）

- **当前最新版本 = `0.2.0-rc.2`**（npm `latest` 与 `next` 同时指向它，2026-09-29 发布）。**比 0.1.1-rc.2 晚 9 个已发版本、22 个 tag**，不是一次小版本漂移，而是一次跨代升级。
- **不存在 stable（非预发布）版本**：GitHub 上抓取的 25 个最近 release 全部 `prerelease = true`；`0.2.1-alpha.1`（2026-10-03）是最新发布，`master` HEAD 即该 release 的 merge commit。上游整个 0.2.x 线都是预发布。
- **cordis 必须从 `4.0.1` 升到 `4.0.4`**：0.2.0-rc.2 每个包发布后的 `peerDependencies` 都是 `"@deepseek-ai/cordis": "~4.0.4"`。
- **新增一个必需依赖包 `@deepseek-ai/dsh-util-values@0.2.0-rc.2`**：`deepFreeze`、`JsonValue` 从 `dsh-llm` / `dsh-session` 迁出到该包。
- **`Session.events` 被彻底删除**（本套件 18 处调用点，4 个插件受影响），替代面 `seq` / `eventAt()` / `snapshotEvents()` / `ownEvents()` 本身也已被上游正式 `@deprecated`（见 §3.1）。
- **14 组破坏性变更 + 4 项改名命中本套件**，涉及约 70 处调用点，其中 14 组均为"类型检查直接失败"级；7 个插件里 6 个需要改动（仅 `dsh-tree-engine` 完全不受影响——它没有任何 `@deepseek-ai/*` 依赖）。
- **一个容易漏掉的装配级问题**：新版插件解析只把**写在 `peerDependencies` 里的 `@deepseek-ai/dsh*` 名字**路由到宿主运行时；写在 `dependencies` 里的会走物理 `node_modules`（即我们自己安装的 0.1.1-rc.2 旧副本）。本套件目前把 36 个 `dsh-*` 全写在 `dependencies` 里，必须迁移（见 §5 阶段 0）。

---

## 1. 版本现状（截至 2026-10-07）

### 1.1 npm dist-tags

| 包 | `latest` | `next` | `alpha` | 备注 |
|---|---|---|---|---|
| `@deepseek-ai/dsh` | **0.2.0-rc.2** | **0.2.0-rc.2** | 0.2.1-alpha.1 | `latest` 已被预发布占据 |
| `@deepseek-ai/dsh-agent` | 0.1.0-rc.6（滞后） | 0.2.0-rc.2 | 0.2.1-alpha.1 | `latest` 不可信，须按 `next` 或精确版本取 |
| `@deepseek-ai/cordis` | **4.0.4** | 4.0.1-rc.4 | — | 另有 `dsh-0-2-1-alpha-1` → 4.0.5-alpha.1 |
| `@deepseek-ai/dsh-util-values` | 0.1.2-alpha.2（滞后） | 0.2.0-rc.2 | 0.2.1-alpha.1 | 新包，`dependencies` 里必须显式 pin |

已抓取的 `@deepseek-ai/dsh` 版本序列（尾部）：
`… 0.1.1-rc.2 → 0.1.2-alpha.2…0.1.2-rc.1 → 0.1.3-alpha.2 → 0.1.5-alpha.1/2 → 0.1.5-rc.1/2/3 → 0.1.6-alpha.1/2 → 0.1.7-alpha.1/2 → 0.1.7-rc.1/2 → 0.2.0-rc.1 → 0.2.0-rc.2 → 0.2.1-alpha.1`

### 1.2 GitHub releases

| tag | 发布日 | prerelease | 说明 |
|---|---|---|---|
| `dsh-v0.2.1-alpha.1` | 2026-10-03 | true | **最新发布**；`master` HEAD = `5badb15009`（该 release 的 merge commit） |
| `dsh-v0.2.0-rc.2` | 2026-09-29 | true | **npm `latest`/`next` 指向的版本 —— 本报告的适配对标版本** |
| `dsh-v0.2.0-rc.1` | 2026-09-28 | true | 0.2.0 首个 RC，汇总 0.1.7-rc.2 以来变更 |
| `dsh-v0.1.7-rc.2` | 2026-09-24 | true | |
| `dsh-v0.1.1-rc.2` | 2026-08-21 | true | **本套件当前基线** |

- 抓取的 25 个 release 中 **`non-prerelease` 数量 = 0**；因此"是否存在比 0.1.1-rc.2 更新的 stable"的答案是：**没有 stable，只有更新的 rc/alpha**。
- 官方 migration 文档位于 `docs/upgrade-guide/<版本>/<主题>/guide.md`；0.2.0-rc.2 仅有两个与本套件无关的 guide，`remove-runtime-invariants` 与 `subpath-plugin-display-manifest` 两个 **只存在于 0.2.1-alpha.1**（属前瞻风险，见 §8）。

### 1.3 证据来源与复核方法

- 本地克隆 `C:/Users/Vantage_XLST/Documents/dsh`；旧修订 = commit `b150a551b8`（tag `dsh-v0.1.1-rc.2`），新修订 = tag `dsh-v0.2.0-rc.2`；前瞻 = tag `dsh-v0.2.1-alpha.1`（已 `git fetch --tags`）。
- 本文件引用上游时统一写作 `<tag>:packages/<path>:<line>`；引用本套件时写作 `plugins/<pkg>/src/<file>:<line>`。
- 复核手段：① 24 个被依赖包的**具名导出差集**（逐 tag 导出源码后按 `export` 语句 + `export * from` 闭包求值）；② 方法/接口签名逐条 diff；③ 全部候选调用点回到本仓库源码确认行号；④ 官方 release notes 与 `.agents/notes/**` 设计笔记交叉验证。
- 上游 0.2.0-rc.2 的注解性依据（可查证）：
  - `dsh-v0.2.0-rc.2:.agents/notes/archived/architecture/2026-08-21-session-log-read-intent.md`（`seq`/`eventAt`/`snapshotEvents` 的引入理由）
  - `dsh-v0.2.0-rc.2:.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`（**再次弃用**这三个读取面）
  - `dsh-v0.2.0-rc.2:packages/boot/app-boot/README.md:52,134`（插件兼容门禁与 peer 感知解析）

---

## 2. 破坏性变更清单（0.1.1-rc.2 → 0.2.0-rc.2）

按影响面分 8 组。`严重度` 口径：`breaking` = 编译失败或运行时行为必然错误；`mechanical` = 签名/名字变化但改法唯一；`rename` = 纯改名；`no-op` = 兼容。

### 2.1 会话事件读取面（最高影响）

| # | 变更 | 旧 | 新 | 严重度 |
|---|---|---|---|---|
| S1 | `Session.events` 删除 | `get events(): readonly SessionEvent[]` | 无该 getter；改用 `get seq(): SessionLogOffset`、`eventAt(seq: SessionSeq)`、`snapshotEvents(fromSeq?, toSeqExclusive?)`、`ownEvents()` | breaking |
| S2 | seq 全面品牌化 | `number` | `SessionSeq` / `SessionLogOffset`（= `BrandedNumber<...>`，构造器做非负安全整数校验） | breaking |
| S3 | `SurfaceOp.replace` 字段改名 | `{ op:'replace'; start: number; end: number }` | `{ op:'replace'; startSeq: SessionSeq; endSeq: SessionSeq }` | breaking |
| S4 | `SurfaceIntent` 泛型化 + 品牌化 | `interface SurfaceIntent { surfaceOp: SurfaceOp; sourceEventSeqs?: number[] }` | `type SurfaceIntent<T = SurfaceEventType> = { surfaceOp: SurfaceOp } & (T extends 'assistant/message' ? { sourceEventSeqs?: never } : { sourceEventSeqs?: SessionSeq[] })` | mechanical |
| S5 | surface 事件类型扩充 | `'user/message' \| 'assistant/message' \| 'tool/result'` | 追加 `'system/message'`、`'developer/message'`；`SurfaceEvent = SessionEvent<SurfaceEventType>`（`surfaceOp` 内联进条件信封） | mechanical |
| S6 | 会话格式 V4 | `SESSION_FORMAT_VERSION = 0`；header 可有 `seedLength?: number` | `SESSION_FORMAT_VERSION = 4`；header 必填 `isSeeded: boolean`，**出现 `seedLength` 直接抛错**；fork 前缀长度改由 `inheritedEventCount` 表达 | breaking |
| S7 | `assistant/message` 载荷 | `{ turn, step, message, usage?, interrupted? }`；另有 `assistant/chunk` | 新增**必填** `stream: AssistantStreamRecord[]`；`assistant/chunk` 移除，新增 `assistant/attempt` | breaking |
| S8 | `JsonValue` 迁出 | `dsh-session` 根导出 | `@deepseek-ai/dsh-util-values` | breaking |

证据：
- S1：`b150a551b8:packages/core/session/src/index.ts:559`（`get events()`）→ `dsh-v0.2.0-rc.2:packages/core/session/src/index.ts:635/649/666/681`（依次为 `eventAt` / `snapshotEvents` / `ownEvents` / `get seq`）。
- S2：`dsh-v0.2.0-rc.2:packages/core/session/src/types.ts:32,47,39,54`（`SessionSeq` / `SessionLogOffset` 及其构造器）；旧版全树无此符号。
- S3/S4：`b150a551b8:packages/core/session/src/types.ts:376-401` → `dsh-v0.2.0-rc.2:packages/core/session/src/types.ts:462-478`。
- S5：`b150a551b8:.../types.ts:347-361` → `dsh-v0.2.0-rc.2:.../types.ts:439-447`。
- S6：`b150a551b8:.../types.ts:56` 与 `index.ts:61-105` → `dsh-v0.2.0-rc.2:.../types.ts:89`、`index.ts:84-86`（拒绝 `seedLength`）、`index.ts:117-119`（要求 `isSeeded`）。
- S7：`b150a551b8:.../types.ts:275-281` → `dsh-v0.2.0-rc.2:.../types.ts:338-352`。
- S8：`b150a551b8:packages/core/session/src/index.ts:27-28` → `dsh-v0.2.0-rc.2:packages/core/session/src/types.ts:17`（改为 `import type { JsonValue } from '@deepseek-ai/dsh-util-values'`，`json.ts` 已删除、不再再导出）。
- 「替代面亦被弃用」：`dsh-v0.2.0-rc.2:.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md` 明文禁止新增对 `eventAt` / `snapshotEvents` / `ownEvents` 的调用，并要求新逻辑改为消费 `session/event` 事件或 session projection。

### 2.2 Agent 生命周期与钩子

| # | 变更 | 旧 | 新 | 严重度 |
|---|---|---|---|---|
| A1 | `agent/session-start` 事件删除 | `'agent/session-start'(payload: { agent; source })`（emit，不可 veto） | **事件不存在**；职责并入 `'agent/created'` | breaking |
| A2 | `agent/created` 载荷与派发模式 | `{ agent }`，emit（同步） | `{ agent; source: SessionStartSource; signal? }`，**serial 且被 await**；listener 抛错会导致创建失败 | mechanical→breaking（语义） |
| A3 | `Context.agent` 反向属性删除 | `declare module '@deepseek-ai/cordis' { interface Context { agents; agent?: Agent } }` | 只剩 `agents`；子 agent 由 `AgentSetup = (agentCtx, agent) => …` 显式传入 | breaking |
| A4 | `Inbox.hasPending` / `claim` 移出公共接口 | `class Inbox { get hasPending(); claim(target, turn) }` | `interface Inbox`（仅类型）；仅保留 `nextTurn/nextStep/clear/append/prepend/replace/remove/splice` | breaking |
| A5 | `ctx.subagents.followup` 改名 | `followup(parent, childId, content, { source, signal })` | `sendMessage(sender, targetId, content, { signal })`（`source` 移除，归属由 exact live sender 推导） | rename + mechanical |
| A6 | `ctx.subagents.listChildren` 行结构换代 | `SubagentListEntry = { kind:'child'; id; activity; hasChildren; … }` | `SubagentCatalogEntry = { id; createdAt } & ({mode:'one-shot'\|'continuable'\|'unknown'; label?})` | breaking |
| A7 | `AgentRegistry.announce/register` | `announce(agent): void`；`register(agent): () => void` | `announce(agent, source, signal?): Promise<void>`；`register` 返回 effect | mechanical（测试脚手架） |
| A8 | `AgentPresets` 包改名 | 包 `@deepseek-ai/dsh-agent-presets` | 包 `@deepseek-ai/dsh-agent-preset-registry`（ctx key `agentPresets` 与 `composeFrom(ctx,parent)` 签名不变） | rename |

证据：
- A1：`b150a551b8:packages/core/agent/src/runtime-types.ts:217` → 全树 0 命中（`git grep "agent/session-start" dsh-v0.2.0-rc.2` 仅命中 `.agents/notes/archived/**` 历史笔记）。
- A2：`b150a551b8:.../runtime-types.ts:159` → `dsh-v0.2.0-rc.2:.../runtime-types.ts:261`。
- A3：`b150a551b8:packages/core/agent/src/index.ts:36-52` → `dsh-v0.2.0-rc.2:packages/core/agent/src/index.ts:27-30,51-54`。
- A4：`b150a551b8:packages/core/agent/src/inbox.ts:25,53-55` → `dsh-v0.2.0-rc.2:packages/core/agent/src/runtime-types.ts:48-95`（无 `hasPending`/`claim`）；上游替代实现见 `dsh-v0.2.0-rc.2:packages/subagent/subagent/src/inbox.ts:37-39`。
- A5：`b150a551b8:packages/subagent/subagent/src/index.ts:231-238` → `dsh-v0.2.0-rc.2:packages/subagent/subagent/src/index.ts:279-286`。
- A6：`b150a551b8:.../index.ts:355` → `dsh-v0.2.0-rc.2:.../index.ts:374`。
- A7：`b150a551b8:packages/core/agent/src/index.ts:450,549` → `dsh-v0.2.0-rc.2:.../index.ts:437-440,537`。
- A8：`b150a551b8:packages/preset/agent-presets/package.json` → 新 tag 无此目录，替代 `packages/preset/agent-preset-registry`、`packages/preset/agent-preset`。

### 2.3 消息与内容块词表

| # | 变更 | 旧 | 新 | 严重度 |
|---|---|---|---|---|
| M1 | `MessageSourceMap` 删除通配 `plugin` kind | `plugin: { kind:'plugin'; plugin: string } & ContextFormed` | 无 `plugin` 键；每个生产者在自己的模块 `declare module '@deepseek-ai/dsh-llm'` 合并自有 kind | breaking |
| M2 | `ContentBlockMap` 删除 `'tool-result'` | `text/reasoning/image/tool-call/tool-result` | `text/reasoning/image/file/tool-call/tool-addition/tool-removal` | breaking |
| M3 | `ToolResultMessage` 角色与外形 | `role: 'user'`，`content: [ToolResultBlock]`（外层包裹） | `role: 'tool'`，`content: readonly ContentBlock[]` 即结果块本身，`toolCallId` 提到顶层 | breaking |
| M4 | `Message` 由单接口变角色联合 | `Message { role: 'system'\|'user'\|'assistant' }` | 角色接口联合，新增 `developer`/`tool`；`content` 收紧为 `readonly` | mechanical |
| M5 | `CallId` 改名 | `CallId` | `ToolCallId`（`'tool/call'.callId` 等随之） | rename |
| M6 | 消息来源的**运行期**宽松度 | 校验 kind | 无运行期校验、**未知 kind 会被消费者 fall-through**（≠ 崩溃，但显示/归属异常） | 语义提示 |

证据：
- M1：`b150a551b8:packages/llm/llm/src/message.ts:100-105` → `dsh-v0.2.0-rc.2:packages/llm/llm/src/message.ts:105-115`（doc 原文："each producer declares its own `kind` in its own module; there is no shared catch-all `plugin` kind"）；上游合并范式见 `dsh-v0.2.0-rc.2:packages/plan/plan-mode/src/index.ts` 与 `packages/subagent/subagent/src/continuation-messages.ts:41-47`。
- M2：`b150a551b8:packages/llm/llm/src/types.ts:99-105` → `dsh-v0.2.0-rc.2:.../types.ts:137-145`。
- M3：`b150a551b8:packages/llm/llm/src/message.ts:152` → `dsh-v0.2.0-rc.2:.../message.ts:173`；构造器签名未变 `createToolResultMessage({callId, content, isError})`（`dsh-v0.2.0-rc.2:.../message.ts:299`）。
- M5：`b150a551b8:packages/llm/llm/src/brand.ts:31` → `dsh-v0.2.0-rc.2:.../brand.ts:31`（`ToolCallId`）。
- M6：`dsh-v0.2.0-rc.2:packages/llm/llm/src/message.ts:108`（"consumers fall through unknown kinds"）。

### 2.4 压缩（compaction）与计量

| # | 变更 | 旧 | 新 | 严重度 |
|---|---|---|---|---|
| C1 | `CompactionResult` / `compaction/summary` / `compaction/prune` 全部序号品牌化 | `startSeq/summarySeq/endSeq: number`；`shadowedRange: {start,end}`；`shadowedSeqs: number[]` | 同名但 `SessionSeq` | breaking |
| C2 | checkpoint 标记值变更 | `{ kind:'plugin', plugin:'compact' }`；谓词判 `kind === 'plugin'` | `{ kind:'compact-checkpoint' }`；新增类型谓词 `isCompactCheckpointSource` | breaking（含**旧日志兼容**） |
| C3 | `CompactionEngine.compactRegion` 形参品牌化 | `(start: number, end: number, …)` | `(start: SessionSeq, end: SessionSeq, …)` | mechanical |
| C4 | `toolPairingBalancedBefore/After` 形参品牌化 | `(session, seq: number)` | `(session, seq: SessionSeq)` | mechanical |
| C5 | `TokenMeasurement` 品牌化 + 新必填字段 | `logRevision: number`；`nodes[].seq: number` | `logRevision: SessionLogOffset`；`seq: SessionSeq`；**新增必填 `heuristicTokens`** | mechanical（构造侧）/no-op（只读侧） |
| C6 | `TokenMeter` 变为强制依赖 `sessionProjections` | `ctx.inject(['sessionProjections'], …)` 可选 | `static inject = ['sessionProjections']` | mechanical（装配） |
| C7 | `ctx.compaction` / `CompactionTrigger` / `ManualCompactionError` / `ctx.spillStore` / `ctx.toolResultPruner` | — | **逐字不变** | no-op |

证据：
- C1：`b150a551b8:packages/compaction/compaction/src/types.ts:99-119` → `dsh-v0.2.0-rc.2:.../types.ts:100-119`。
- C2：`b150a551b8:packages/compaction/compaction/src/checkpoint.ts:19,57` → `dsh-v0.2.0-rc.2:.../checkpoint.ts:19,58`。
- C3：`b150a551b8:packages/compaction/compaction/src/index.ts:164-167` → `dsh-v0.2.0-rc.2:.../index.ts:187-190`。
- C4：`b150a551b8:packages/compaction/compaction/src/tool-pairing.ts:135` → `dsh-v0.2.0-rc.2:.../tool-pairing.ts:147`。
- C5：`b150a551b8:packages/llm/token-meter/src/types.ts:21-42` → `dsh-v0.2.0-rc.2:.../types.ts:22-54`。
- C6：`b150a551b8:packages/llm/token-meter/src/index.ts:76-84` → `dsh-v0.2.0-rc.2:.../index.ts:107,115-117`。
- C7：`ctx.compaction` 服务键与三个抽象方法在 `b150a551b8:.../index.ts:64-123` 与 `dsh-v0.2.0-rc.2:.../index.ts:64-123` 逐字一致；`ctx.spillStore`/`ctx.toolResultPruner` 服务名与 `saveText`/`pruneSession` 签名两版一致（`packages/spill/spill/src/index.ts`、`packages/compaction/compaction-tool-result-pruner/src/index.ts`）。
- 另有新增（可选、非必需）事件 `compaction/summary-error`（waterfall）。

### 2.5 设置与配置

| # | 变更 | 旧 | 新 | 严重度 |
|---|---|---|---|---|
| P1 | `installSettingsSection` / `settingsNamespace` 删除 | 运行时注册式设置段 | 二者均不存在；改为 schemastery Config 上的 `.volatile()` 字段 + 框架投影表单；`ctx.settings` 变成 `SettingsForms`（configure/describe/update/replace/mutate/writable/documentPath/prepareDocument） | breaking |
| P2 | `SettingsNamespace` 语义 | 带 kebab-case 校验的构造函数 | 纯品牌类型 = 一个 profile 插件**条目 id**，无构造函数 | mechanical |
| P3 | `SettingsDescriptor` | `applies: 'live'\|'restart'` | `applies: 'live'`（收敛）+ 新增 `autoGenerate` | mechanical |

证据：`b150a551b8:packages/settings/settings/src/index.ts:26,863`（`settingsNamespace` / `installSettingsSection`）→ `dsh-v0.2.0-rc.2:packages/settings/settings/src/index.ts:223,231`（`class SettingsForms` / `super(ownerContext,'settings')`），`dsh-v0.2.0-rc.2:packages/settings/settings/src/types.ts:6`（`SettingsNamespace = Branded<'SettingsNamespace'>`）。

### 2.6 客户端（Web）

| # | 变更 | 旧 | 新 | 严重度 |
|---|---|---|---|---|
| W1 | `@deepseek-ai/dsh-client-runtime` **整包删除** | 提供 `ClientContext`、`SlotRegistry`、`SessionRuntime`、`SettingsScope`、snapshot store、`dsh-client-runtime/client` 入口 | 拆到 `dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-renderer`、`dsh-api-session-controller/client`、`dsh-client-ui-settings` | breaking |
| W2 | 客户端共享模块表 baseline | `PLATFORM_MODULES` 无 store/dockkit；`PRELOADED_CLIENT_EXTERNALS = ['@deepseek-ai/dsh-client-runtime/client']` | `PLATFORM_MODULES` 增 `dsh-client-store`、`dsh-client-ui-dockkit`；`PRELOADED_CLIENT_EXTERNALS = []` | mechanical |
| W3 | `ctx.settingsScope` → `ctx.configForms` | `SettingsScope/SettingsScopeSnapshot`，`scope.set('field', v)` | `ConfigForms.get<T>(entryId): ConfigForm<T>`、`ConfigFormSnapshot<T>`、`form.set()` 返回 `Promise<boolean>` | breaking |
| W4 | `ctx.sessions.open(id)` 删除 | 客户端会话导航 `open` | `ISessions` 提供 `retain/using/…`（引用保留模型），**无 `open`** | breaking |
| W5 | slot 契约 | `conversation` 面板 | v0.1.5-alpha.2 起为 `main` 下的 `conversation` key；`sidebar.panellist` 全局面板 | 本套件用到的三个 slot 键**均无变化**（no-op） |
| W6 | `dsh.client` manifest 字段 | `{ platform, inject?, external?, immediately? }` | 字段语义不变；**`inject` 降级为信息性依赖**，不再决定激活顺序；`external` 用于声明 `<pkg>/client` 等精确模块请求 | no-op（但含失效包名要清理） |

证据：`b150a551b8:packages/client/runtime/src/client/index.ts:112` → 新 tag 无 `packages/client/runtime`；`dsh-v0.2.0-rc.2:packages/client/web/src/platform.ts:8,17`；`dsh-v0.2.0-rc.2:packages/client/ui-settings/src/client/config-form.ts:229-231,293`；`dsh-v0.2.0-rc.2:packages/api/session-controller/src/client/contract/sessions.ts:58,96`；`dsh-v0.2.0-rc.2:packages/util/package-manifest/src/types.ts:29-58`（`DshManifest`/`DshClientManifest`/`DshEnginesManifest`）。

### 2.7 装配、依赖与加载

| # | 变更 | 说明 | 严重度 |
|---|---|---|---|
| D1 | cordis 版本要求 | 所有 0.2.0-rc.2 包发布的 `peerDependencies["@deepseek-ai/cordis"] = "~4.0.4"` | breaking（对本套件 pin 4.0.1） |
| D2 | **peer 感知解析** | 对 linked/开发目录插件：只有写在 `peerDependencies` 里的 `@deepseek-ai/dsh*` 名字会解析到宿主运行时包；其余名字走物理 `node_modules`（= 我们的旧副本）。已安装（profile 内）插件则由 runtime table 直接占据包名 | breaking（装配级，易漏） |
| D3 | 兼容门禁只读 `peerDependencies` | 门禁遍历 `peerDependencies` 中 `@deepseek-ai/dsh`/`@deepseek-ai/dsh-*`，`semver.satisfies(..., {includePrerelease:true})`；不匹配则拒载（可用 profile 的 `compatibility.json` 做精确版本豁免） | 中性（本套件当前**不含** dsh 类 peer，故不会被拒载） |
| D4 | `engines.dsh` 为声明式 | 作者声明兼容 dsh 范围的字段；0.2.0-rc.2 的 loader/installer **不强制**它 | no-op（建议补齐） |
| D5 | 部分包的 `./invariant` 子路径导出被移除 | 实测**移除** `./invariant` 且无同名替代的包：`dsh-sandbox`、`dsh-session-projection`、`dsh-token-meter`（改为公开 `./estimate`）、`dsh-invariants`(自身子路径)、`dsh-attachment`、`dsh-atomic-write`、`dsh-settings`、`dsh-compaction-basic`、`dsh-agent-instructions`、`dsh-acp`、`dsh-tool-fs`、`dsh-spill`、`dsh-compaction-tool-result-pruner`、`dsh-timeout`、`dsh-subagent-spawn-in-process`。实测**保留** `./invariant` 的包：`dsh-session`（另新增 `./fork`）、`dsh-llm`、`dsh-subagent`（另新增 `./internal`/`./typert`/`./remote`）、`dsh-plan-mode`、`dsh-scope`。**包根符号无一被删**（除迁包项 S8/M5 外） | no-op（已 grep 确认本套件不 import 任何 `*/invariant` 子路径） |
| D6 | 自动化任务/调度包 | 0.2.0-rc.1 起由可选组合包提供；0.2.1-alpha.1 起并入 Web 内置 | no-op（本套件不涉及） |
| D7 | `dsh-ptc-runtime` 命名族 | `PTC`/workflow 执行器统一为 `ptc-runtime`，旧名不兼容 | no-op（本套件不涉及） |

证据：
- D1：`npm view @deepseek-ai/dsh-session@0.2.0-rc.2 peerDependencies` → `{"@deepseek-ai/cordis":"~4.0.4", ...}`（`dsh-agent`/`dsh-tools`/`dsh-compaction`/`dsh-util-values` 同为 `~4.0.4`）。
- D2：`dsh-v0.2.0-rc.2:packages/boot/app-boot/src/profile-resolution/resolver.ts:211-218`（`readPeerNames`）与 `:527`（`ancestorSet.has(searchPath) && readPeerNames(directory).has(name)`）；文字说明 `dsh-v0.2.0-rc.2:packages/boot/app-boot/README.md:134`。
- D3：`dsh-v0.2.0-rc.2:packages/boot/app-boot/src/plugin-compatibility.ts:71-83`（`:75` 名字过滤、`:77` 范围判定）；`dsh-v0.2.0-rc.2:packages/boot/app-boot/README.md:52`。
- D4：`dsh-v0.2.0-rc.2:packages/util/package-manifest/src/types.ts:52-59`；README `:53`、`:93`（"do not enforce `dsh.manifestVersion` or `engines.dsh`"）。
- D5：逐包 `package.json exports` 双 tag 对比（见 §附录 A）。

### 2.8 明确为 no-op 的高风险面（已逐条核实，避免误判）

| 面 | 结论 | 证据 |
|---|---|---|
| `ctx.fs` | 我们使用的 `resolve/processPath/stat/readText/streamText/readBytes/listDir/writeText/editText/sandboxMode` **签名逐字一致** | `b150a551b8:packages/fs/fs/src/index.ts:132-287` ↔ `dsh-v0.2.0-rc.2:.../index.ts:132-287` |
| `FsError`/`FsErrorCode`/`FsTarget`/`FsInfo`/`FsDirEntry`/`FsWriteOutcome` | 完全一致 | 同上两 tag |
| `ctx.tools` | `register`/`restrict`/`presentAs`/`schemas`/`get` 签名一致；`ToolRestriction` 一致 | `b150a551b8:packages/core/tools/src/index.ts:946,1037,1071,1234` ↔ `dsh-v0.2.0-rc.2:.../index.ts:974,1063,1097,1260` |
| `defineTool`/`ToolDefinition`/`ToolExecution`/`ToolResult`/工具视图/`FileDiff` | 具名导出无变化 | 导出差集为空 |
| `ctx.sandbox` 升级面 | `ESCALATION_TARGETS`/`sandboxDenialMarker`/`escalationHintMarker`/`validateEscalationArgs`/`canonicalPath`/`SandboxExecutionPolicy`/`SandboxMode` 一致（新增 `sandboxPermissionsDescription`） | `dsh-v0.2.0-rc.2:packages/sandbox/sandbox/src/escalation.ts` |
| `SandboxPolicyService` | `resolve`/`overrideOf` 一致 | `b150a551b8:packages/sandbox/sandbox-policy/src/index.ts:135,149` ↔ `dsh-v0.2.0-rc.2:.../index.ts:164,178` |
| `ctx.systemPrompt.section` | `section(PromptSection)` 一致；`PromptSection` 仅新增可选 `interpolate?` | `b150a551b8:packages/core/system-prompt/src/index.ts:381` ↔ `dsh-v0.2.0-rc.2:.../index.ts:454` |
| `ctx.commands` + `CommandDefinition`/`CommandResult`/`CommandId` | 兼容（新增可选 `definitionId`；`CommandInputDescriptor.images?` → `attachments?`；`CommandResult.sourceEventSeq` 品牌化） | `b150a551b8:packages/interaction/commands/src/index.ts:68` ↔ `dsh-v0.2.0-rc.2:.../index.ts:77` |
| `ctx.llm.stream` + `purpose: 'compaction'\|'session-title'` | 签名与 purpose 不变（`messages` 放宽为 `RequestMessage[]`，新增可选 `toolHistory`） | `b150a551b8:packages/llm/llm/src/index.ts:985` ↔ `dsh-v0.2.0-rc.2:.../index.ts:1135` |
| `agent/pre-step` + `PreStepDecision` | 钩子签名逐字一致；`PreStepDecision` 仅新增可选 `startsRequestSeries?: true` | `b150a551b8:packages/core/agent/src/runtime-types.ts:231,53-55` ↔ `dsh-v0.2.0-rc.2:.../runtime-types.ts:320,112-119` |
| `deriveEventMessage` | 函数版新增**可选**第二参数；`Session.deriveEventMessage` 签名不变（语义改为带实时投影） | `b150a551b8:.../surface.ts:83` ↔ `dsh-v0.2.0-rc.2:.../surface.ts:120-123`；`index.ts:755-757` ↔ `889-891` |
| `isSurfaceEvent`/`isAppendSurfaceEvent`/`isReplacementSurfaceEvent` | 名称/参数/守卫形状不变 | `dsh-v0.2.0-rc.2:.../surface.ts:72,89,102` |
| `dsh-session-projection/types` 声明合并 | 出口与两个空表一致 | `b150a551b8:.../types.ts:14,22` ↔ `dsh-v0.2.0-rc.2:.../types.ts:14,22` |
| `@deepseek-ai/dsh-attachment` 类型 | `ImageAttachmentRef`/`ImageMediaType`/`AttachmentId`/`AttachmentError` 一致（`readImageRequest` 第二参改名 `ImageRequestPolicy`→`ImageRequestTarget`，**我们未使用**） | `dsh-v0.2.0-rc.2:packages/attachment/attachment/src/types.ts:7-27,135-143` |
| `dsh-atomic-write` | `writeFileAtomic`/`withFileLock` 签名一致 | `dsh-v0.2.0-rc.2:packages/util/atomic-write/src/index.ts:20-26,79` |
| `dsh-storage-domain` | `defineDomain`/`domainTable`/`DomainSpec` 一致（新增可选字段） | `dsh-v0.2.0-rc.2:packages/storage/storage-domain/src/spec.ts:47-77` |
| `dsh-invariants`（0.2.0-rc.2 内） | `InvariantFailure`/`InvariantInstaller`/`ctx.invariants.register` 逐字一致（**移除发生在 0.2.1-alpha.1**） | `dsh-v0.2.0-rc.2:packages/runtime-diagnostics/invariants/src/index.ts:29` |
| `ctx.spillStore` / `ctx.toolResultPruner` | 服务名与 `saveText`/`pruneSession` 一致 | 见 §2.4 C7 |
| `spill-policy` 的 `maxInlineBytes`→`maxInlineTokens` | 属**profile 配置层**（`packages/bundle/base/cordis.patch.yml:410`），本套件代码不配置该字段，**不受影响** | `git grep maxInlineTokens dsh-v0.2.0-rc.2 -- packages` 仅命中 bundle 与 spill-policy 自身 |

---

## 3. 调用点对照表（API × 插件 × 行号 × 严重度）

> `BREAK` = 破坏性；`MECH` = 机械修改；`REN` = 改名；`OK` = 无需改。
> 行号均为本仓库当前源码（`plugins/<pkg>/src|client|tests`）。

### 3.1 `Session.events` 系列（S1）

| API | 变更 | 严重度 | 插件 | 调用点 |
|---|---|---|---|---|
| `Session.events` | 删除 → `snapshotEvents()`/`eventAt(seq)`/`seq`/`ownEvents()` | **BREAK** | dsh-compact-mode | `src/engine.ts:302`、`src/mode.ts:117`、`src/reuse.ts:442`、`src/reuse.ts:501`、`src/reuse.ts:505`、`src/review.ts:141`、`src/review.ts:356`、`src/shake.ts:138`、`src/shake.ts:225` |
| 同上 | 同上 | **BREAK** | dsh-advisor | `src/advisor.ts:431`、`src/delta.ts:79`、`src/delta.ts:115` |
| 同上 | 同上 | **BREAK** | dsh-tool-read-write | `src/read/agent.ts:134`、`src/read/agent.ts:173`、`src/read/index.ts:484` |
| 同上 | 同上 | **BREAK** | dsh-vibe-mode | `src/mode.ts:309`、`src/workers.ts:521`、`src/workers.ts:524` |

（合计 **18 处**。）
逐处改法速查：
- `session.events.length`（advisor.ts:431、delta.ts:115）→ `session.seq`（`SessionLogOffset`）。
- `session.events[seq]`（reuse.ts:505、review.ts:356、shake.ts:138）→ `session.eventAt(SessionSeq(seq))`（返回 `SessionEvent | undefined`，需处理 undefined）。
- 遍历/数组操作（agent.ts:134/173、read/index.ts:484、delta.ts:79、reuse.ts:501）→ `session.snapshotEvents()`。
- 传参给只读函数（`hasOpenTurn(session.events)`、`inspectCompactionEntryState(session.events)`）→ `session.snapshotEvents()`。
- `workers.ts:521/524` 返回 `agent.session.events` → `agent.session.snapshotEvents()`。
- ⚠️ 上游已把这三个读取面标记 `@deprecated` 并禁止新增调用；机械替换只是"先能编译"，中期应把热路径改为 `ctx.on('session/event', …)` 增量维护 + session projection（见 §6 阶段 5）。

### 3.2 seq 品牌化（S2/S3/S4/C1/C3/C4/C5/M5）

| API | 变更 | 严重度 | 插件 | 调用点 |
|---|---|---|---|---|
| `surface.nodes`、`SurfaceOp.replace`、`sourceEventSeqs` | `number[]`/`start,end` → `SessionSeq[]`/`startSeq,endSeq` | **BREAK** | dsh-compact-mode | `src/engine.ts:312-315`、`src/engine.ts:333`、`src/engine.ts:344-346`、`src/reuse.ts:346`、`src/reuse.ts:394`、`src/reuse.ts:427`、`src/reuse.ts:449-483`、`src/reuse.ts:578-580`、`src/review.ts:160-161`、`src/review.ts:192`、`src/shake.ts:118`、`src/shake.ts:198-201`、`src/shake.ts:225` |
| `surface.nodes` 遍历 | `number` → `SessionSeq` | MECH | dsh-advisor | `src/delta.ts:85-87` |
| `CompactionResult` 序号字段 | `number` → `SessionSeq` | **BREAK** | dsh-compact-mode | `src/engine.ts:342-350`、`src/reuse.ts:548-581`、`src/review.ts:63-65`、`src/review.ts:167-180` |
| `compactRequestId`/`compactRegion(start,end)` | 形参品牌化 | MECH | dsh-compact-mode | `src/engine.ts:118-122`、`src/reuse.ts:455-467` |
| `TokenMeasurement` 构造（测试替身） | 新增必填 `heuristicTokens`；`logRevision`/`seq` 品牌化 | MECH | dsh-compact-mode | `tests/helpers.ts:44-60` |
| `CallId` → `ToolCallId` | 改名 | **REN** | dsh-compact-mode | `src/shake.ts:25`（import）、`src/shake.ts:175`（`CallId(...)`） |
| 同上 | 改名 | **REN** | dsh-advisor / dsh-tool-read-write | `dsh-advisor/tests/helpers.ts:8,205,223`；`dsh-tool-read-write/tests/agent-read.test.ts:17,68,78` |

`SessionSeq` 构造器：`import { SessionSeq } from '@deepseek-ai/dsh-session'`（`dsh-v0.2.0-rc.2:packages/core/session/src/types.ts:39`）。**品牌是编译期概念**（`number & {…}`），运行时值不变，因此只需在类型边界处品牌化一次并全程复用。

### 3.3 会话格式 V4 与事件载荷（S6/S7）

| API | 变更 | 严重度 | 插件 | 调用点 |
|---|---|---|---|---|
| `SESSION_FORMAT_VERSION` + 手写 `SessionHeader` | `0` → `4`；必填 `isSeeded`；`seedLength` 会被拒 | **BREAK** | dsh-advisor | `tests/advisor.spec.ts:15`、`tests/advisor.spec.ts:55-59`、`tests/advisor.spec.ts:568-572`、`tests/advisor.spec.ts:579-584` |
| `session.append('assistant/message', …)` | 新增必填 `stream` | **BREAK** | dsh-advisor / dsh-vibe-mode | `dsh-advisor/tests/helpers.ts:199`；`dsh-vibe-mode/tests/harness.ts:271` |
| `'assistant/chunk'` 消费 | 改为 `'assistant/attempt'` | 待确认（本套件仅按 type 分派、未消费 chunk） | dsh-channel-wechat | `src/session-map.ts:65`（只读 `event.data.message`，兼容） |
| `'session/end-seed'` 载荷 | `{}` → `{ inherited?: true }` | OK（只做类型过滤） | dsh-tool-read-write | `src/read/agent.ts:173`、`src/read/index.ts:484` |
| `'tool/call'.callId` | `CallId` → `ToolCallId` | MECH | dsh-tool-read-write / dsh-advisor（测试） | `tests/agent-read.test.ts:63,78`；`tests/helpers.ts:221` |

### 3.4 Agent / subagent 生命周期（A1–A8）

| API | 变更 | 严重度 | 插件 | 调用点 |
|---|---|---|---|---|
| `agent/session-start` | 事件删除 → 合并进 `agent/created` | **BREAK** | dsh-advisor | `src/advisor.ts:171-173`（`source === 'resume'` 判定逻辑须迁到 `agent/created` 的 `source`） |
| 同上 | 同上 | **BREAK** | dsh-compact-mode | `src/mode.ts:83-85`（初始化 `lastNarrated`，可直接迁到 `agent/created`） |
| 同上 | 同上 | **BREAK** | dsh-vibe-mode | `src/mode.ts:260-266`（`applyDirectorScope` + `registry.seed` 必须在首轮前完成；`agent/created` 是 serial，天然满足） |
| `agent/created` 载荷 | 新增 `source`/`signal`，改为 serial | MECH | dsh-advisor | `src/advisor.ts:167`（已存在，需与上一条**合并去重**，避免绑定逻辑跑两次） |
| `Context.agent`（`agentCtx.agent`） | 删除；`setup(agentCtx, agent)` 显式传入 | **BREAK** | dsh-advisor | `src/advisor.ts:591`、`src/advisor.ts:616`、`src/advisor.ts:552-554`（`setup` 签名） |
| `Inbox.hasPending` | 移出公共接口 | **BREAK** | dsh-advisor | `src/advisor.ts:334`、`src/delivery.ts:256` |
| `ctx.subagents.followup` | → `sendMessage(sender, targetId, content, { signal })` | **REN** | dsh-vibe-mode | `src/tools.ts:143` |
| `ctx.subagents.listChildren` | 行结构换代（无 `kind`） | **BREAK** | dsh-vibe-mode | `src/tools.ts:317` |
| `agentPresets` 包名 | `dsh-agent-presets` → `dsh-agent-preset-registry` | **REN** | dsh-advisor | 代码调用 `src/advisor.ts:584` **无需改**；仅 `package.json:43` 依赖改名 |
| `Agent.followup`（agent 而非 subagents 服务） | 未变 | OK | dsh-advisor / dsh-channel-wechat | `dsh-advisor/src/advisor.ts:455,539`；`dsh-channel-wechat/src/session-map.ts:97` |
| `ctx.agents.*`（复数） | 未变 | OK | dsh-advisor / dsh-channel-wechat | `advisor.ts:210,549`；`session-map.ts:84,102,114,123` |
| `AgentRegistry.announce/register` | 签名变更 | MECH | dsh-vibe-mode（测试脚手架） | 见 §6 阶段 2 验收项 |

### 3.5 消息来源与内容块（M1/M2/M3）

| API | 变更 | 严重度 | 插件 | 调用点 |
|---|---|---|---|---|
| `source: { kind:'plugin', plugin: … }` **构造** | 通配 `plugin` kind 删除 → 各包自有 kind | **BREAK** | dsh-compact-mode（6） | `src/engine.ts:263`、`src/mode.ts:155`、`src/reuse.ts:209`、`src/reuse.ts:275`、`src/reuse.ts:279`、`src/shake.ts:198` |
| 同上 | 同上 | **BREAK** | dsh-advisor（2） | `src/advisor.ts:441`、`src/delivery.ts:57` |
| 同上 | 同上 | **BREAK** | dsh-tool-read-write（2） | `src/inspect-image.ts:195`、`src/read-image.ts:203` |
| 同上 | 同上 | **BREAK** | dsh-vibe-mode（1） | `src/mode.ts:368` |
| `source.kind === 'plugin'` **读取** | 需改为自有 kind 判定 | **BREAK** | dsh-advisor | `src/advisor.ts:747`、`src/delta.ts:170` |
| 同上 | 同上 | **BREAK** | dsh-vibe-mode | `src/tools.ts:55`（`source.plugin === 'vibe-mode'`） |
| `block.type === 'tool-result'` | 该块类型删除 | **BREAK** | dsh-advisor | `src/delta.ts:156-162`（同时读 `block.toolCallId`/`block.isError`/`block.content`） |
| 同上 | 同上 | **BREAK** | dsh-compact-mode | `src/review.ts:91`、`src/shake.ts:94` |
| `ToolResultMessage`（`role`/`content`） | `role:'user'` + 单层包裹 → `role:'tool'` + 直接块数组 | **BREAK** | dsh-tool-read-write | 间接：`src/read/agent.ts:101-121`（渲染 tool 角色消息） |
| `createToolResultMessage({callId, content, isError})` | 签名未变，`callId` 现为 `ToolCallId` | MECH | dsh-advisor / dsh-tool-read-write（测试） | `tests/helpers.ts:202-207`；`tests/agent-read.test.ts:68` |
| `kind: 'subagent-settled'` | 仍由 `dsh-subagent` 声明合并提供，字段未变 | OK | dsh-vibe-mode | `src/workers.ts:414-419` |

### 3.6 设置与客户端（P1/W1–W4）

| API | 变更 | 严重度 | 插件 | 调用点 |
|---|---|---|---|---|
| `installSettingsSection` + `settingsNamespace` | 删除 → `.volatile()` Config 字段 | **BREAK** | dsh-vibe-mode | `src/mode.ts:20`（import）、`src/mode.ts:130`（调用） |
| `@deepseek-ai/dsh-client-runtime/client`（`ClientContext`/`SessionId`） | 整包删除 | **BREAK** | dsh-mode-ui | `client/src/index.ts:16` |
| 同上 | 同上 | **BREAK** | dsh-vibe-mode | `client/src/index.ts:18` |
| `SettingsScope`/`SettingsScopeSnapshot` | 改为 `ConfigForm`/`ConfigFormSnapshot` + `ctx.configForms` | **BREAK** | dsh-vibe-mode | `client/src/settings/DirectorSection.tsx:15`；`client/src/index.ts:30`（`inject` 里 `settingsScope`）、`:71`（`ctx.settingsScope.bind`） |
| `ctx.sessions.open(id)` | 删除 → `retain`/`using` 引用保留模型 | **BREAK** | dsh-vibe-mode | `client/src/index.ts:59`；`client/src/dock/WorkerDock.tsx:6`（注释） |
| 客户端 externals 清单 | 移除 `client-runtime` 预载，新增 `client-store`/`ui-dockkit` | MECH | dsh-mode-ui / dsh-vibe-mode | `tsdown.client.ts:68`（两者均为 `RUNTIME_STORE_EXEMPTION`） |
| `dsh.client.inject` 中的失效包名 | `client-runtime` 不存在 | MECH | dsh-vibe-mode | `package.json:53` |
| `ctx.slots.inject/register` + 三个 slot 键 | 未变 | OK | dsh-mode-ui / dsh-vibe-mode | `dsh-mode-ui/src/index.ts`（`conversation.session.header.utilities`）、`dsh-vibe-mode`（`conversation.input.dock`、`settings.section`） |
| `ctx.sessions.subagentAddress(id)` | 保留 | OK | dsh-vibe-mode | `client/src/dock/WorkerDock.tsx`（用 `parentSessionId`；字段清单见 §附录 B） |

### 3.7 sessionProjections（S 组外，独立项）

| API | 变更 | 严重度 | 插件 | 调用点 |
|---|---|---|---|---|
| `ProjectionDefinition.init` | `init(): S` → `init(header: SessionHeader, inheritedEventCount: SessionLogOffset): S` | MECH（现有零参 lambda 仍可编译） | dsh-mode-ui | `src/index.ts:110-113`、`:115-133`（4 个投影单元） |
| 同上 | 同上 | MECH | dsh-vibe-mode | `src/mode.ts:142-152` |
| 注册表读取面 | `snapshot(session)`/`restore`/`restoreFloor` 签名换代 | OK（本套件未直接调用） | — | — |
| `sessionProjections` 服务名 + `register` 契约（`key`/`stateSchema`/`init`/`apply`/`wire{viewSchema,view}`/`stateVersion`） | **字段名全部未变**（不存在 `initial`/`reduce`，两版都没有） | OK | dsh-mode-ui / dsh-vibe-mode | `src/index.ts:89`、`src/mode.ts:26` |

证据：`b150a551b8:packages/session/session-projection/src/index.ts:60-63,300-317` → `dsh-v0.2.0-rc.2:.../index.ts:67-73,341-346,483-505`。

### 3.8 `JsonValue` / `deepFreeze` 迁包

| API | 变更 | 严重度 | 插件 | 调用点 |
|---|---|---|---|---|
| `deepFreeze`（`dsh-llm`） | 迁至 `@deepseek-ai/dsh-util-values` | **BREAK** | dsh-compact-mode | `src/config.ts:11`、`src/reuse.ts:28`（import 列表）、`src/reuse.ts:596`（re-export） |
| `JsonValue`（`dsh-session`） | 迁至 `@deepseek-ai/dsh-util-values` | **BREAK** | dsh-tool-read-write | `src/read/index.ts:20`、`src/read/index.ts:760`（类型用法） |

---

## 4. 严重度判定汇总

| 严重度 | 条目数 | 说明 |
|---|---|---|
| breaking（编译失败） | 14 组 / 约 70 处调用点 | S1、S2/S3（品牌与字段改名）、S6、S7、A1、A3、A4、A6、M1、M2、M3、P1、W1、W3、W4 |
| rename | 4 | `CallId`→`ToolCallId`、`followup`→`sendMessage`、`agent-presets`→`agent-preset-registry`、checkpoint 标记值 |
| mechanical | 10 | `init` 签名、`commands.input.images`、externals 清单、`TokenMeasurement.heuristicTokens`、`announce/register`、V4 测试 header、`AssistantStreamRecord`、`SettingsDescriptor`、`engines.dsh`/peer 迁移 |
| no-op（已核实） | 20+ | 见 §2.8 |
| **受影响插件** | **6 / 7** | `dsh-tree-engine` 完全不受影响（无任何 `@deepseek-ai/*` 依赖） |

**风险排序（按"必须先做/影响面"）**：
1. **装配级 D1/D2**（cordis 4.0.4 + `dsh-*` 迁 `peerDependencies`）——不做这一步，其它改动都会在"新旧两套 dsh 同时在场"的噪声里调试。
2. **S1 + S2**（`Session.events` 与品牌化）——18 处 + 15 处，是本套件的核心数据通路。
3. **M1 + M2 + M3**（消息来源词表与内容块）——影响渲染、投递、压缩三块语义，且 M6 提示"运行期不报错、只静默降级"，最容易漏测。
4. **A1/A3/A4/A5/A6**（生命周期与 subagent）——影响 advisor 与 vibe-mode 的核心功能。
5. **W1/W3/W4 + P1**（客户端与设置）——影响 UI 可用性，但不影响服务端正确性。

---

## 5. 适配计划（可执行工作项，按阶段）

> 目标版本：**`@deepseek-ai/*@0.2.0-rc.2` + `@deepseek-ai/cordis@~4.0.4`**。整个套件必须"一次性整体迁移"——因为 dsh 包之间存在严格的等价版本 peer（例如 `dsh-tools@0.2.0-rc.2` 的 peer 精确要求 `dsh-session@0.2.0-rc.2`），混版本必然双实例。

### 阶段 0：依赖与装配基线（先做，且只做这一件事）

1. 全仓库 37 个 `@deepseek-ai/*` 声明从 `^0.1.1-rc.2` → `^0.2.0-rc.2`（`cordis` → `~4.0.4`）。
2. **把 `@deepseek-ai/dsh*` 从 `dependencies` 迁到 `peerDependencies`**（这是 D2 的要求，不是风格问题）：
   - 原因：`readPeerNames()` 只把 **peer 声明的名字**映射到宿主运行时包（`dsh-v0.2.0-rc.2:packages/boot/app-boot/src/profile-resolution/resolver.ts:211-218,527`）；写在 `dependencies` 的会命中我们自己的 `node_modules/@deepseek-ai/dsh-*@0.1.1-rc.2`。
   - 建议写法：`peerDependencies: { "@deepseek-ai/dsh-session": "0.2.0-rc.2", … }`（精确版本，与上游包间 peer 风格一致），并在 `devDependencies` 保留同名以便本地 typecheck/构建。
   - 注意副作用：一旦写了 dsh 类 peer，就会进入兼容门禁（`plugin-compatibility.ts:75`），运行 `0.2.0-rc.2` 时范围必须能匹配（`semver.satisfies(..., {includePrerelease:true})`）——精确写 `0.2.0-rc.2` 或 `^0.2.0-rc.2` 均可。
   - `@deepseek-ai/cordis` 保持 peer（已在 `peerDependencies`），值升到 `~4.0.4`——但注意 cordis **不在**门禁的名字过滤内（只过滤 `@deepseek-ai/dsh`/`dsh-*`）。
3. 依赖增删：
   - **新增** `@deepseek-ai/dsh-util-values@^0.2.0-rc.2`（`dsh-compact-mode` 用于 `deepFreeze`，`dsh-tool-read-write` 用于 `JsonValue`）。
   - **改名** `dsh-advisor`：`@deepseek-ai/dsh-agent-presets` → `@deepseek-ai/dsh-agent-preset-registry`。
   - **删除** `dsh-mode-ui` / `dsh-vibe-mode` 的 `@deepseek-ai/dsh-client-runtime`（包已不存在），并把 `dsh.client.inject` 中的该名字删除或替换为真实包名（`@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-session` / `@deepseek-ai/dsh-client-ui-renderer`）；`inject` 在新版仅作信息性依赖，不影响激活顺序（`packages/util/package-manifest/src/types.ts:29-58`）。
4. 每个插件补声明式兼容字段：`"engines": { "node": ">=24", "dsh": "^0.2.0-rc.2" }`、`"dsh": { "manifestVersion": 1, … }`（0.2.0-rc.2 的 loader 不强制，但为 0.2.1 之后铺路）。
5. 同步 `tsdown.client.ts` 的 externals 拷贝：删除 `RUNTIME_STORE_EXEMPTION`（`@deepseek-ai/dsh-client-runtime/client`），baseline 加入 `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-dockkit`（依据 `dsh-v0.2.0-rc.2:packages/client/web/src/platform.ts:8,17`）。
6. 同步 profile 组合：确认 `token-meter` 与 `session-projections` 同时挂载（C6，`dsh-v0.2.0-rc.2:packages/llm/token-meter/src/index.ts:107`）。

**验收**：`pnpm install` 后 `node_modules/@deepseek-ai/dsh-session/package.json` 版本为 `0.2.0-rc.2`；`pnpm -r run typecheck` 的报错集合收敛为 §3 表格所列条目（不应出现 "Cannot find module" 之外的意外错误）。

### 阶段 1：机械替换（低风险、可批量、先让编译收敛到语义问题）

1. 品牌化 seq：在边界处用 `SessionSeq(...)` / `SessionLogOffset(...)` 包裹（`@deepseek-ai/dsh-session`）。重点文件见 §3.2。原则：**一次品牌化，全程复用**；不要把品牌值再赋回 `number` 字段（`SessionSeq → number` 合法，反向不合法）。
2. `Session.events` 全部 18 处替换（§3.1 的逐处速查）。
3. `agent/session-start` → `agent/created`（3 处），并与 `dsh-advisor` 已有的 `agent/created` 处理器**合并**（同一事件会调用两次，保证 `maybeBind` 幂等或合并为单处理器）。注意新 `agent/created` 是 **serial 且被 await**：处理器内不要 `await` 自身 owner 的 disposal、不要 `await agent.whenIdle()`；同步逻辑保持同步返回，避免拖住 agent 发布。
4. `CallId` → `ToolCallId`（`dsh-compact-mode/src/shake.ts:25,175`；`dsh-advisor/tests/helpers.ts:8,205,223`；`dsh-tool-read-write/tests/agent-read.test.ts:17,68,78`）。
5. 迁包导入：`deepFreeze` / `JsonValue` / `isJsonValue` / `snapshotJsonValue` → `@deepseek-ai/dsh-util-values`（`dsh-compact-mode/src/{config.ts:11,reuse.ts:28,596}`、`dsh-tool-read-write/src/read/index.ts:20`）。
6. `commands` 的 `input.images` → `input.attachments`（本套件当前只用 `{ hint }`，仅需回归确认）。
7. 测试脚手架：`Session.create(...)` header 补 `isSeeded: false`（fork 场景 `true`）；`session.append('assistant/message', …, { … })` 补 `stream: []`；`agents.announce(agent, 'startup')` 且 `await`。
8. 客户端 externals 清单同步（阶段 0 第 5 步已含）。

### 阶段 2：语义级修复（必须逐个功能回归）

1. **消息来源词表（M1）**：为每个插件在自己的模块（+ 包入口以便被加载）声明自有 kind：
   ```ts
   // 例：dsh-compact-mode/src/index.ts
   import type { ContextFormed } from '@deepseek-ai/dsh-llm'
   declare module '@deepseek-ai/dsh-llm' {
     interface MessageSourceMap {
       'dsh-compact-mode': { kind: 'dsh-compact-mode' } & ContextFormed
     }
   }
   ```
   然后把 11 处构造点改为 `{ kind: 'dsh-compact-mode', form: 'notice', summary }` 等，`kind` 字符串与声明键一致；`form`/`summary`/`sections` 语义不变（`ContextFormed` 仍是同一联合）。同时改 3 处读取点（`dsh-advisor/src/advisor.ts:747`、`delta.ts:170`、`dsh-vibe-mode/src/tools.ts:55`）为自有 kind 判定（`dsh-vibe-mode` 可继续用上游 `'subagent-settled'`，那是 `dsh-subagent` 声明的）。命名建议：`dsh-advisor`、`dsh-compact-mode`、`dsh-tool-read-write`、`vibe-mode`（保持 3.5 表中出现的语义字符串便于比对）。
2. **内容块（M2/M3）**：删除所有 `case 'tool-result'`；工具结果改为 **`role: 'tool'` 的消息**，其 `content` 就是结果块数组：
   - `dsh-advisor/src/delta.ts:145-170`：按 `message.role` 分派，`role === 'tool'` 时把 `message.content` 直接渲染并用 `message.toolCallId` / `message.isError` 生成 `<tool-result …>` 包裹文本（保持现有输出格式不变，避免下游提示词漂移）。
   - `dsh-compact-mode/src/review.ts:80-98`、`src/shake.ts:85-101`：改为从 `message.role === 'tool'` 的消息取 `content` 文本；注意这两处原意是"用户/工具消息的文本"，改造后 `tool` 角色消息不再出现在 `user/message` 事件里。
   - `dsh-tool-read-write/src/read/agent.ts:101-121`：渲染层同步按 `role: 'tool'`。
3. **checkpoint 标记（C2）**：不再手写 `{ kind:'plugin', plugin:'compact' }`，统一走 `compactCheckpointSource(compactionId, sourceCommandId)`；识别侧改用 `isCompactCheckpointSource(source)`。**额外做一次性历史兼容**：旧会话日志里存的是 `kind:'plugin'`，读取路径需同时接受旧标记（或对历史会话执行一次迁移），否则历史压缩点会被当成普通用户消息。
4. **Agent/subagent（A3/A4/A5/A6）**：
   - `dsh-advisor`：`setup: (agentCtx, agent) => …`，`composeReviewer(agentCtx, agent, spec, watchdog)`；把 `agentCtx.agent as Agent` 替换为参数 `agent`（`advisor.ts:591,616`）。
   - `Inbox.hasPending` → 本地 helper：`agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0`（上游同款，`dsh-v0.2.0-rc.2:packages/subagent/subagent/src/inbox.ts:37-39`）；改 `advisor.ts:334` 与 `delivery.ts:256`。注意 `claim` 若被使用需改为 `prepend/append/splice` 组合（本套件当前只用 `hasPending`）。
   - `dsh-vibe-mode/src/tools.ts:143`：`ctx.subagents.followup(director, childId, blocks, { source, signal })` → `ctx.subagents.sendMessage(director, childId, blocks, { signal })`（删除 `source`；语义变为"仅直接父子相邻 + 必须 exact live sender + 需要常驻 continuable Activation"）。
   - `dsh-vibe-mode/src/tools.ts:317`：`listChildren` 返回行无 `kind`，删除 `.filter(e => e.kind === 'child')`；`id`/`label` 仍可用；活性判定继续用 `ctx.get('agents')?.get(id)?.status`。
5. **压缩/计量（C1/C5）**：把 `CompactionResult` 与 `compaction/summary|prune` 负载里的全部序号改为品牌值；测试替身 `dsh-compact-mode/tests/helpers.ts:44-60` 补 `heuristicTokens`。
6. **设置（P1）**：删除 `installSettingsSection(ctx, settingsNamespace('dsh-vibe-mode'), …)`；把需要热改的字段写成插件自身 Config 的 schemastery 字段并加 `.volatile()`（例：`section: z.string().default('').volatile()`），框架按 profile 条目 id 自动生成表单与热更新；宿主侧仍用 `resolveConfig`/Config 引用读取。若需观察变更，用 `ctx.settings.describe()` 或 `settings/document-updated` 事件。
7. **客户端（W1/W3/W4）**：
   - `dsh-mode-ui/client/src/index.ts:16`、`dsh-vibe-mode/client/src/index.ts:18`：`ClientContext` → `import type { Context } from '@deepseek-ai/cordis'`；`SessionId` → `@deepseek-ai/dsh-session/types`。
   - `dsh-vibe-mode/client/src/index.ts:30,71` + `settings/DirectorSection.tsx:15`：`inject` 用 `configForms` 取代 `settingsScope`；`ctx.settingsScope.bind({namespace})` → `ctx.configForms.get<T>(entryId)`；`ConfigFormSnapshot<T>` 取代 `SettingsScopeSnapshot<T>`；写操作 `form.set(...)` 返回 `Promise<boolean>`，必须处理 `false`/冲突。
   - `dsh-vibe-mode/client/src/index.ts:59`（`ctx.sessions.open`）→ `ctx.sessions.retain(sessionId, { source: '<标签>' })`，并为该标签做 `declare module '@deepseek-ai/dsh-api-session-controller/client' { interface SessionReferenceSourceMap { … } }` 合并。⚠️ "一键切到主视图"的等价入口在上游未找到明确 API（见 §附录 B），需要在实现阶段用 `ui-session`/`ui-layout` 的现有导出实测确认。
   - `dsh.client.inject` 与 `tsdown.client.ts` externals 同步（阶段 0）。

### 阶段 3：整体验证

- `pnpm -r run typecheck` → 归零；`pnpm -r run test` → 全绿（重点：`dsh-compact-mode/tests/boundary.spec.ts`、`dsh-advisor/tests/advisor.spec.ts`、`dsh-vibe-mode/tests/harness.ts` 的会话构造已按 V4 更新）。
- 冒烟：新会话 → compact/vibe 模式开关 → `agent://` 读取 → advisor 评审绑定 → wechat 通道绑定 → mode-ui 徽章 → 客户端设置页写值。
- 兼容回归：用一个**旧 0.1.1-rc.2 生成的会话日志**验证 ✅/❌ 挂载（V4 迁移由持久化层做，但 checkpoint 标记与 `assistant/chunk` 的历史读取需实测）。

### 阶段 4：债务登记（不阻塞本次升级）

1. **同步事件读取已弃用**（`eventAt`/`snapshotEvents`/`ownEvents`）：本次只做机械替换。中期应把 `dsh-advisor` 的 delta 观察器、`dsh-compact-mode` 的 reuse/review 扫描改为 `ctx.on('session/event', …)` 增量维护 + session projection（上游 Note 明确禁止新增同步历史读取）。
2. **客户端 `sessionProjections` 的 `init(header, inheritedEventCount)`**：目前零参 lambda 可编译，但 fork 会话会从"零状态"起步；建议改为把 `header.cwd` / `inheritedEventCount` 纳入初始状态。
3. **`TokenMeasurement.surfaceTokens` 语义变化**：由固定启发式改为按当前路由的图片定价；`dsh-compact-mode/src/shake.ts:154` 的 `minShakeSavingsRatio` 判定与保尾预算需重新标定（图片多的会话预估会变大）。

---

## 6. 前瞻：0.2.1-alpha.1 的两项破坏性变更（不阻塞，但要在本次迁移中预留）

| 变更 | 对本套件的影响 | 迁移动作 |
|---|---|---|
| 移除运行时 invariant 插件与 `@deepseek-ai/dsh-invariants`、`InvariantRegistry`/`InvariantInstaller`/`InvariantFailure`/`InvariantError`、以及各包 `./invariant` 子路径 | **命中**：`dsh-channel-wechat/src/invariant.ts:18,27,31`（`InvariantFailure` + `inject:['invariants']` + `ctx.invariants.register`）、`dsh-vibe-mode/src/invariant.ts:15`（`InvariantInstaller`）、以及 profile 里名为 `*-invariant` 的 row | 把这些配置校验改为"在 `apply` 内直接 `throw` 的普通断言"，或迁到自己的诊断通道；同时从 profile/patch 中删除相关 row 与 patch 目标 id（官方 guide：`docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md`，仅存在于 0.2.1-alpha.1） |
| 子路径插件不再读取独立的 `<subpath>/package.json`；显示文本走 `<subpath>/locale/*.json`、图标走 `<subpath>/icon` | **低**：本套件没有嵌套 `package.json`（7 个插件各只有一个根 manifest），但多个插件导出了 `"./package.json"` 自引用子路径 | 无需必改；若将来为子路径提供独立展示信息，按新契约改造（官方 guide：`subpath-plugin-display-manifest/guide.md`） |
| 输入区统计扩展拆为 `activity` / `usage` 两个入口（覆盖旧 `stats` 整行的插件需更新注册 ID） | 本套件未注册 `stats` 行 | 无 |
| 自动化任务改 Web 内置、提醒工具按模式提供 | 本套件不涉及 | 无 |

---

## 附录 A：本套件声明的 37 个 `@deepseek-ai/*` 在 0.2.0-rc.2 的存在性

**不存在（4 个，均已给出替代）**：
| 包 | 0.1.1-rc.2 路径 | 0.2.0-rc.2 | 替代 |
|---|---|---|---|
| `@deepseek-ai/dsh-client-runtime` | `packages/client/runtime` | **缺失** | `dsh-client-store` / `dsh-client-ui-slots` / `dsh-client-ui-renderer` / `dsh-api-session-controller/client` / `dsh-client-ui-settings` |
| `@deepseek-ai/dsh-agent-presets` | `packages/preset/agent-presets` | **缺失** | `@deepseek-ai/dsh-agent-preset-registry` + `@deepseek-ai/dsh-agent-preset` |
| `@deepseek-ai/cordis` | （npm 包） | npm `latest 4.0.4` / `next 4.0.1-rc.4` | 升到 `~4.0.4` |
| `@deepseek-ai/schemastery` | （npm 包） | 上游 0.2.0-rc.2 依赖 `~3.18.4` | 本套件用 `^3.18.1`，对齐到 `~3.18.4` |

**存在但 `exports` 变化（`./invariant` 子路径移除）**：`dsh-sandbox`、`dsh-session-projection`、`dsh-token-meter`（并新增 `./estimate`）、`dsh-invariants`、`dsh-attachment`、`dsh-atomic-write`、`dsh-settings`、`dsh-compaction-basic`、`dsh-agent-instructions`、`dsh-acp`、`dsh-tool-fs`、`dsh-spill`、`dsh-compaction-tool-result-pruner`、`dsh-timeout`、`dsh-subagent-spawn-in-process`。
**存在且 `exports` 不变**：`dsh-agent`、`dsh-tools`、`dsh-fs`、`dsh-commands`、`dsh-compaction`、`dsh-system-prompt`、`dsh-storage-domain`、`dsh-user-approval`、`dsh-sandbox-policy`、`dsh-plan-mode`、`dsh-session`（新增 `./fork`）、`dsh-subagent`（新增 `./internal`/`./typert`/`./remote`）、`dsh-llm`（新增若干子路径）。
**本套件不 import 任何 `*/invariant` 子路径**（已 grep 确认），故 D5 对本套件为 no-op。

## 附录 B：本清单中标注 UNVERIFIED 的项目

1. **客户端"打开到主视图"**：`ctx.sessions.open` 的等价入口未在 `ISessions`/`ui-session`/`ui-layout` 导出面中找到现成 API；已确认可用的是 `retain/using` 引用保留模型（`dsh-v0.2.0-rc.2:packages/api/session-controller/src/client/contract/sessions.ts:58`），"切主视图"需实现阶段实测。
2. **`SubagentAddress` 字段清单**：`ctx.sessions.subagentAddress(id)` 仍存在，但新 tag 中该类型由 `@deepseek-ai/dsh-subagent/client` 重新导出，是否仍带 `parentSessionId` 未逐字段核对。
3. **`0.1.7-alpha.1` 的"仅保存在自定义事件中的附件不再自动读取或导出"**：未能定位其实现文件，仅确认本套件 13 处 attachment 用法都走标准 `saveImage`/`readImage` + `tool/result`/`user/message`，且本套件未把 `ImageAttachmentRef` 放入自有事件负载，故判定为 no-op（该结论属**推断**，建议实现阶段以实际导出行为回归验证）。
4. **`dsh-tools`/`dsh-agent` 的运行期行为差异**（非类型面）未做端到端验证——本报告只覆盖 API/类型与装配契约。

## 附录 C：现场事实（供后续复核复现）

- `git -C C:/Users/Vantage_XLST/Documents/dsh log --oneline -1 origin/master` → `5badb15009 Merge pull request #5648 from deepseek-harness/worktree/release-dsh-0.2.1-alpha.1`
- `npm view @deepseek-ai/dsh dist-tags` → `{alpha: 0.2.1-alpha.1, next: 0.2.0-rc.2, latest: 0.2.0-rc.2}`
- `npm view @deepseek-ai/cordis dist-tags` → `{next: 4.0.1-rc.4, latest: 4.0.4, 'dsh-0-2-1-alpha-1': 4.0.5-alpha.1}`
- `b150a551b8` 与会话事件相关的关键行：`packages/core/session/src/index.ts:559`（`get events`）、`:565`（`get seq`）
- `dsh-v0.2.0-rc.2` 的替代面：`packages/core/session/src/index.ts:635`（`eventAt`）、`:649`（`snapshotEvents`）、`:666`（`ownEvents`）、`:681`（`get seq`）

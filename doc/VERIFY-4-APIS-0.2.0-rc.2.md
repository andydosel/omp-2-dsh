# 4 个 API 对 `dsh-v0.2.0-rc.2` 的核验（只读）

- 新 tag：`dsh-v0.2.0-rc.2` = `639ed015397290b3745d163aafe02ffee4aa3f84`（npm latest/next）
- 旧 tag：`dsh-v0.1.1-rc.2` = `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（插件当前 pin）
- 仓库：`C:/Users/Vantage_XLST/Documents/dsh`；方法：`git show <tag>:<path>` / `git diff <old> <new>` / `git grep -n`（未改动任何代码）
- 行号均指对应 tag 内文件行号。另参考生成物 `packages/extensions/tool-cordis/src/api-catalog.ts`（两 tag 皆有，给出精确声明）。

---

## 1. `ctx.goals` 服务 + `goal-round-driver`（`@deepseek-ai/dsh-goal`）

**存在性：均在，未改名、未迁包。**
- 服务键 `goals`：`packages/goal/goal/src/index.ts:61`（`goals: GoalService`），类 `:240`，`super(ctx, 'goals')` `:251`；包名 `@deepseek-ai/dsh-goal`（`packages/goal/goal/package.json`，version `0.2.0-rc.2`）。
- round driver 包名 `@deepseek-ai/dsh-goal-round-driver`，`packages/goal/goal-round-driver/src/index.ts:19` `inject = ['agents','goals','sessions']`（与旧版同）。

**签名：`create/block/resume/complete`（及全部方法）名字与参数/返回均未变。**
| 方法 | 新版 | 旧版 |
|---|---|---|
| `get(agent)` | `index.ts:277` | `:222` |
| `disarm(agent)` | `:289` | `:236` |
| `create(agent, request: CreateGoalRequest): GoalView` | `:303` | `:251` |
| `edit(agent, ref, request)` | `:329` | `:277` |
| `pause(agent, ref)` | `:352` | `:299` |
| `resume(agent, ref)` | `:364` | `:311` |
| `complete(agent, ref)` | `:391` | `:337` |
| `block(agent, ref, reason: GoalBlockReason)` | `:409` | `:355` |
| `clear(agent, ref): GoalRef` | `:433` | `:377` |

- branded id 未变：`GoalId`/`GoalRef`/`GoalError` 定义在 `runtime.ts`，**两 tag 逐字节相同（diff 为空）**；`fold.ts`、`domain.ts`、`client.ts` 同样无 diff。
- `@Remote` 差异：`get` 新版新增 `@Remote('get')`（`:276`；旧版 `get` 无装饰器）；`create` 仍由 `remoteExportCreate` 走 `@Remote('create')`（`:646`）。其余 remote 名一致。

**goal 事件类型 / round 归属：未变。**
- session 事件 `goal/change`、agent 事件 `goal/changed`（payload `{ agent, change }`）形状未变（`domain.ts` 无 diff）。
- round 仍由「`goal/change` 快照携带 `roundsStarted`」+「`user/message` 且 `source = {kind:'goal', goalId, revision, round}`」共同归属，fold 仅接受 `round === roundsStarted + 1`（`fold.ts:321-330`，两 tag 相同）；driver 侧 `RoundIdentity { goalId, revision, round }` 未变（driver `index.ts:22`）。
- 新版新增 ctx 级事件 `goal/activation-changed`（`index.ts:505`），只用于 UI 通知，非破坏。

**HOW TO ADAPT（均为非破坏，但组合期须动）**
1. `static inject` 由 `['agents']`（旧）+ 可选 `ctx.inject(['sessionProjections'], …)` 变为**硬依赖** `['agents','sessionProjections']`（`index.ts:241`）→ 组合中必须挂载 session-projection 注册表，否则服务不激活。
2. 投影宿主状态变了：wire 值 `GoalProjection` 形状不变，但宿主 fold state 变为 `GoalProjectionState { current, seenGoalIds, failure }`（`types.ts:115+`），`stateVersion` **4 → 6**（`index.ts:168`）。旧持久化行按 stateVersion 自动作废，无需手工迁移。
3. 生命周期事件 `agent/session-start` → `agent/created`（服务构造器与 driver `:252`）。
4. driver 新增行为：host 发起的 `pause` 会中止运行中的 turn（driver `:282`）；接受轮次时返回 `{ ...decision, startsRequestSeries: true }`（driver `:424`）——该字段是 0.2.0-rc.2 新增的可选 `PreStepDecision.startsRequestSeries?: true`（`packages/core/agent/src/runtime-types.ts:118`）。
5. `invariant.ts` 改用 `session.snapshotEvents()`（旧 `session.events` 已弃用）。

---

## 2. `tools/pre-execute` 钩子 + 审批路径

**`tools/pre-execute` 钩子名与签名未变**：`packages/core/tools/src/index.ts:153`（旧 `:152`）：
`'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>`。
listener **仍可 `return { kind: 'ask', … }`** 触发审批（`PreToolDecision`，新版 `:607-611`）。

**`PreToolDecision` 有新增可选成员（源兼容，非破坏）：**
| 变体 | 新版 | 旧版 |
|---|---|---|
| `allow` | `{ kind: 'allow' }` | 同 |
| `deny` | `{ kind:'deny'; reason: string; info?: ToolErrorInfo }` | `{ kind:'deny'; reason }` |
| `cancel` | `{ kind: 'cancel' }`（新增，`:610`） | 无 |
| `ask` | `{ kind:'ask'; reason?; displayReason?: {en, [locale]} }`（`:611`） | `{ kind:'ask'; reason? }`（`:591`） |

**与 `ctx.approval` 的配对未变**：`serviceAsk` 用 `this.ctx.get('approval')`（`:1727`/`:1735`）取服务，命中则 `approval.request({agent, toolName, callId, reason?, displayReason?, signal})`（`:1744`）；无 approval 时 `ask` 降级为 deny（行为未变）。

**三处签名**：
- `ctx.approval`：键未变（`packages/interaction/user-approval/src/index.ts:26`，旧 `:19`）；`ApprovalService.request(req: ApprovalRequest): Promise<ApprovalOutcome>` 签名未变（`:215`）；`setPolicy`/`overrideOf` 同。
- `ApprovalRequest` 字段变化：`callId?: CallId` → **`ToolCallId`**（重命名）；新增可选 `displayReason`（新版拆出 `ApprovalRequestEvent`，`user-approval/src/types.ts:63`，`ApprovalRequest extends ApprovalRequestEvent`）。`approval/request` waterfall 载体由 `Scoped<ApprovalService>` 改为 **`Scoped<Agent>`**，req 类型改为 `ApprovalRequestEvent`（`types.ts:87-95`；旧版在 `index.ts` 的 `interface Events`）。返回 `ApprovalOutcome` 不变。
- `ctx.userQuestions`：键未变（`packages/interaction/user-questions/src/index.ts:24`，旧 `:16`）。**但提供方机制破坏性变更**：旧 `registerProvider(provider)`（旧 `:64`）**已删除**，改为 Agent-scoped waterfall `user-questions/request`（新版 `types.ts` 底部）+ `answer()`（`:165`，`@Remote`）+ `askTimed()`（`:234`）+ `attachWait()`（`:216`，stream）。`ask(request)` 仍在（`:287`，旧 `:92`）；请求新增可选 `wait?: { callId, timed? }`，`AskUserQuestionIntent` 新增可选 `callId`。

**HOW TO ADAPT**：写路径闸的 `tools/pre-execute` 监听器**无需改**（返回 `ask`/`deny` 即可，可选用新 `displayReason`）。若插件用 `ctx.userQuestions.registerProvider(...)` 提供 UI 应答 → 必须改为监听 `user-questions/request`（返回 answer 或 `next()`）；仅 `ctx.userQuestions.ask(...)` 的调用点保持可编译。

---

## 3. `ctx.subagents` — `spawn` / `startContinuable`

- 服务键未变：`subagents: SubagentRuntime`（`packages/subagent/subagent/src/index.ts:139`）。
- **`startContinuable` 存在且签名逐字节相同**：`async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>`（api-catalog 新版与旧版一致）。
  - `ContinuableStartSpec` 声明两 tag 完全相同：`{ provider, label, childId?, request: Omit<SubagentStartRequest,'label'|'signal'|'outputSchema'>, signal }`（新版 `types.ts:32`）。
  - `ContinuableStart { childId; messageId }` 同（新版 `types.ts:53-58`／旧版 `continuation.ts:133-138`）。
  - `SubagentStartRequest` 字段集合相同：`prompt, parent, signal` + 可选 `label/outputSchema/maxDepth/toolFilter/persona/agentOptions` → 文档所述 `request: { prompt, parent, agentOptions, toolFilter, persona, maxDepth }` 成立（旧版文档仅 persona 段落名 `deployment:persona` 改为 `deployment:persona-prefix`，字段未变）。
- **`spawn(...)` 作为 `ctx.subagents` 方法在两版都不存在**（api-catalog 全成员列表中新旧均无 `spawn`；`spawn` 仅是 provider 注册名，见 `types.ts:345` 注释与 `@deepseek-ai/dsh-subagent-spawn-in-process`）。若设计文档写 `ctx.subagents.spawn(...)`，其错误在 0.1.1-rc.2 时就已存在。
- 类形态变（可能影响类型/装配）：`extends Service` → `extends TypertRemoteService`，构造器 `(ctx)` → `(ctx, config)`，新增 `static Config`（`maxDepth`、`maxActiveSubagents`，均 volatile）。
- 已知项确认＋补充：`followup` → `sendMessage`；`listChildren` 返回 `SubagentListEntry[]` → `SubagentCatalogEntry[]`。**另**：新版移除 `reportFrom` 与 `registerContinuableSetup`，新增 `@Remote('prompt')` 与 `@Remote('interruptByParent')`，并删除整包 `packages/subagent/tool-subagent-report`。
- **settle 信号未变**：仍是 `subagent-settled`（`SubagentSettledMessageSource`，字段 `kind/form/summary/senderSessionId`；新版 `continuation-messages.ts:31`／旧版 `continuation.ts:83`），不是 `turn/end`。

**HOW TO ADAPT**：`startContinuable` 调用点零改动；改用 `sendMessage`、`SubagentCatalogEntry`；移除对 `reportFrom`/`registerContinuableSetup`/`tool-subagent-report` 的依赖。

---

## 4. session-projection 注册契约

**`ProjectionDefinition` 精确字段**（`packages/session/session-projection/src/index.ts:48-92`）：
```ts
key: K
stateSchema: ZodType<S>
init(header: SessionHeader, inheritedEventCount: SessionLogOffset): NoInfer<S>
apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>
wire?: K extends keyof SessionProjectionMap
  ? { viewSchema: ZodType<SessionProjectionMap[K]>; view(state: NoInfer<S>): SessionProjectionMap[K] }
  : never
stateVersion: number
```
- **字段名全部未变**：两版都只有 `key`/`stateSchema`/`init`/`apply`/`wire`/`stateVersion`（不存在 `schema`/`initial`/`reduce`）；`wire` 仍是 `{ viewSchema, view }`；`stateVersion` 仍在，注册时校验为非负安全整数（`:270-271`）。
- **唯一签名变化**：`init()`（旧 `:54`）→ `init(header, inheritedEventCount)`（新 `:62`）。零参 lambda 仍可编译（TS 允许忽略参数），但 fork 会话会从零状态起步。
- `register()` 契约（新 `:253`；另有 host-only 重载 `Omit<…,'wire'>` 于 `:247`，以及仅取 `wire` 的重载于 `:238` 之前）：`register<K,S>(definition: ProjectionDefinition<K,S>): () => void`，返回 disposer；同 key 重复注册要求 `stateVersion` 一致否则抛错（`:280`）。
- 另：该包 `./invariant` 子路径导出被移除（compat report D5 已记）。

**HOW TO ADAPT**：现有 `ctx.sessionProjections.register({ … })` 调用零改动（`init` 参数可继续零参）；若宿主投影要正确支持 fork，应读取 `header.cwd` / `inheritedEventCount` 纳入初始状态。

---

## 汇总

| # | API | 存在性 | 破坏性签名变化 | 适配动作 |
|---|---|---|---|---|
| 1 | `ctx.goals` + `goal-round-driver` | 均在、未改名 | 无（方法/事件/round 归属全同） | ①硬依赖 `sessionProjections`；②`stateVersion 4→6`；③`agent/session-start→agent/created` |
| 2 | `tools/pre-execute` | 钩子名/签名同 | 无（`PreToolDecision` 仅加可选 `displayReason`/`info`/`cancel`） | 路径闸监听器零改动 |
| 2b | `ctx.approval` | 键/`request()` 同 | 无（`callId` 类型改名 `ToolCallId`，+`displayReason`；事件载体改 `Scoped<Agent>`） | 类型改名即可 |
| 2c | `ctx.userQuestions` | 键同 | **有**：`registerProvider` 删除 → `user-questions/request` waterfall + `answer()` | 应答方改监听事件；`ask()` 调用点不变 |
| 3 | `ctx.subagents.startContinuable` | 存在、签名逐字节相同 | 无 | 零改动；`spawn` 两版皆非服务方法 |
| 3b | `ctx.subagents` 其余 | `followup→sendMessage`、`listChildren` 行类型改；`reportFrom`/`registerContinuableSetup` 移除 | 有 | 改调用点；弃用 removed 符号 |
| 4 | `ProjectionDefinition` / `register()` | 字段名全同 | 仅 `init()` 增 `(header, inheritedEventCount)` | 零参 lambda 可编译；fork 场景建议读取两参 |

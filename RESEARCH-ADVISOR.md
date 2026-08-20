# dsh ADVISOR 移植研究（只读调研结论）

> 目标：在 dsh monorepo（`C:/Users/Vantage_XLST/Documents/dsh`）中为「advisor 插件」移植 omp 的 ADVISOR 子系统提供事实依据。全部结论均有 `文件:行号` 证据。仅调研，未修改任何源码。

---

## 1. 投递原语映射（nit / concern / blocker → dsh 机制）

### 1.1 三个核心原语（`packages/core/agent/src/runtime-types.ts`）

| dsh 原语 | 语义（源码注释，runtime-types.ts:117-143） | 实现（`agent-loop/src/agent.ts:113-132`） |
|---|---|---|
| `agent.followup(msg)` | 队列普通 **next-turn** 消息并唤醒 driver；成为自己独立 turn 的唯一消息 | `send(msg,'next-turn',true)` → `inbox.splice` + `wakeDriver()` |
| `agent.steer(msg)` | 提交 **next-step** 输入；空闲 driver 立即开 turn，运行中 driver 在**下一个 step 边界**消费 | `send(msg,'next-step',true)` |
| `agent.inject(msg)` | 队列**不唤醒**的 next-step 上下文；空闲 driver 保持 pending 直到被 followup/steer 唤醒；可能错过已 claim 的 pre-step 批次 | `send(msg,'next-step',false)` |

底层统一是 `send(message, target, wakeup)`（agent.ts:113-119）：先 `inbox.splice` 落盘（立即 append `agent/inbox/spliced` 会话事件），再按需 `wakeDriver`。

### 1.2 中途转向（interrupt）约束

- 运行中的 turn 可以在 **step 边界** 消费 steer，**不能**打断正在进行的 model 请求/工具调用：turn 循环在每步结束后检查 `inbox.nextStep.length > 0`，非空则 `target='next-step'` 再 claim 下一步（agent.ts:263-301）；`agent/pre-step`（agent.ts:225-241）先 `inbox.claim`，再走 waterfall 返回 `enter|reject`。
- `agent/pre-step` 是瀑布：监听者可改写消息或 `{kind:'reject'}` 拒绝整步；拒绝后 steer 停留在 inbox 等下次唤醒（README.md「Extension points」；agent.ts:266-268 拒绝 → `turn/end {kind:'blocked'}`）。
- **dsh 没有 plan-mode 对 steer 的硬门禁**：plan-mode 只改变 prompt section（`plan:policy`）和 `exit_plan_mode` 工具（plan-mode/src/index.ts:33-36, 189-195）。「plan mode 下保留为卡片」这类 omp 行为须由插件自行实现投递策略。
- 关闭 turn 前有 `agent/turn-stopping`（serial、无 next）边界：监听者若 `agent.steer(...)`，机器重读 inbox、新 steer 会再跑一步（runtime-types.ts:262-272）。**这是实现「终局回答 → 保留为卡片」策略的挂点**：插件在此时决定 steer（延展 turn）还是 inject（卡片）。

### 1.3 用户可见的 notice/卡片（不占 model turn）

机制：**`UserMessageSource` 的 `form:'notice'`**（`llm/llm/src/message.ts:55-56`「A one-off account of something that just happened; it supersedes nothing.」，带 `summary` 字段 message.ts:88-92）。UI 把 plugin-source 的 user/message 渲染为 `ContextInjectionRow`，`notice` form 渲染为 `NoticeBody` 折叠行（client `ui-conversation/.../ContextBody.tsx:568-573`、`ContextInjectionRow.tsx:31-52`）。

投递与可见性（`host/apiproxy/src/api-proxy.ts:1331-1347`）：

- `next-turn` → placement `'queued'`（队列 dock 显示）。
- `next-step` + `source.kind==='user'` → placement `'steering'` → **立即**渲染为 `PendingSteeringBubble`（ChatView.tsx:404-406，「Host-authoritative pre-admission steering projection」），claim 后转 `'steering'` 行。
- `next-step` + plugin source（`'context'`）→ **claim 之前不可见**（api/events.ts:40-43「context items stay invisible until claimed」），claim 后渲染为 context 注入行（notice 折叠卡片）。

### 1.4 映射表（nit/concern/blocker）

| omp 严重度 | omp 行为 | dsh 投递 | 说明 |
|---|---|---|---|
| `nit`（不打断旁注） | 下一个 step 边界批入主转录 | `agent.inject(createUserMessage({content, source:{kind:'plugin', plugin:'advisor', form:'notice', summary}}))` | 不唤醒；placement `'context'`（claim 前不可见）；下一个 pre-step claim 后落为 `user/message` notice 行；空闲时保持 pending 直到下次唤醒 |
| `concern`（打断 steer） | 打断转向消息 | `agent.steer(...)`（同上 plugin-source 消息，或 user-source 以获得 pending 气泡立即可见性） | 唤醒空闲 driver / 运行中 driver 在 step 边界消费并**在同一 turn 内再跑一步**；被 pre-step 拒绝则停留 |
| `blocker`（打断 steer） | 同上，终局回答也触发 | 同 `concern`；插件自行在 `agent/turn-stopping` 决定强制再跑一步（steer） |
| 保留为可见卡片 | plan mode / 终局回答 / 中断时 | 插件侧策略：改用 `inject` + `form:'notice'`；若需立即可见，可用 user-source steer（pending 气泡），但注意这会以用户角色进入派生历史 | dsh 无平台级门禁 |

参考实现先例：`tool-jobs` 用 `createUserMessage({content, source:{kind:'plugin',plugin:'tool-jobs',form:'notice',summary}})` + busy 时 `owner.inject()`、idle 时 `owner.followup()`（tool-jobs/src/index.ts:279-300）；`repeat-tool-reminder` 用 plugin-source `form:'notice'` 注入（guard/repeat-tool-reminder/src/index.ts:203-207）。`tool-jobs` 的 `maxConsecutiveWakes:3` 连续唤醒预算（index.ts:37-52, 224-227）正是 omp `advisor.immuneTurns` 的 dsh 现成模式。

> 注意：`agent/turn-stopping` 处若 inject 也会让 `nextStep` 非空而延展 turn（agent.ts:295-300 检查 `nextStep.length===0` 才 close），「终局卡片」更稳妥的做法是**等 turn 关闭后再 inject**（监听 `turn/end`），让卡片等下个唤醒进入上下文。

---

## 2. Transcript delta 观察

- 根 ctx 上 `ctx.on('session/event', ...)` 收到**所有会话**的事件（含子/子代理会话），用 `session.id` 过滤。作用域过滤只影响 agent-scoped 监听器：「agent-scoped listeners receive only events from sessions entered through that agent's context」（core/session/src/index.ts:48-49, 69-70, 76）；插件根 ctx 无 agent 作用域 → 全量。子代理会话在同一个 SessionStore（子代理也是 `ctx.agents.create` 产物）。
- **「转录增量」事件类型**：surface 事件 `user/message`、`assistant/message`、`tool/result`（仅这三种可带 `surfaceOp`，compaction/README.md「Surface contract」）；辅助观察 `assistant/chunk`（流式/usage，log-only）、`tool/call`、`turn/start`/`turn/end`、`step/start`/`step/end`。`surface.replaceGeneration` **不是**逐条 delta 信号——它只在 committed rewrite（replace）时变化；log-only 追加或同代 surface 追加不 bump（compaction/README.md「Tool-pairing boundaries」）。
- **序列化 delta 给评审模型**：`session.deriveEventMessage(event)` 是公开的逐事件投影（session/src/index.ts:755-757，「canonical per-event projection used by reconstruction and request checks」）；`session.deriveMessages()` 投影整个 surface（index.ts:726-744，按 `replaceGeneration` 缓存）。任意事件区间：插件按 seq 过滤 `session.events` 后逐条 `deriveEventMessage`。两个方法都在公开 `Session` 类上，可放心用于插件。
- 评审者自维护 cursor（每 session 记录已看 seq），收到 `session/event` 后对新增 surface 事件逐条投影成 Message，拼成 delta prompt。omp 的「自身 advice 不重复评审」= 过滤 source 为 advisor plugin 的消息。

---

## 3. 评审者：subagent vs 普通 agent + 工具授权

### 3.1 两个候选路线

**路线 A：普通 agent（推荐）—— `ctx.agents.create({sessionId, agentOptions, setup})`**

- 公开工厂（core/agent/src/index.ts，`CreateAgentOptions.setup?: AgentSetup`；agent-loop/src/index.ts:606-641：`setup?.(prepared.agent.ctx)` 在发布前合成，失败整体回滚）。
- `setup(agentCtx)` 里完成三件事：
  1. `ctx.agentPresets.composeFrom(agentCtx, primaryAgent.ctx)` —— 必须！有 preset roster 的部署中，未 join 的 agent 的 `tools/system-prompt/skill` 解析为空全局层（agent-presets/src/invariant.ts:46-47、index.ts:166-174「its tools ... resolve against the empty global layer」）；`composeFrom` 是子代理合成用的同一 API（agent-presets/src/index.ts:316-325）。
  2. `agentCtx.tools.restrict({ allow: ['read','grep','glob'] })` —— allow 语义「只保留这些全局工具」，deny 语义「移除这些」（tools/src/index.ts:680-684；README.md:22）。restrict 只作用于**继承的全局工具**，「Restrictions intersect and do not affect scoped registrations」（tools/src/index.ts:679、README.md:22「scope-local tools merge afterwards」）；未知名字/空 filter 抛错（index.ts:1078-1092）。
  3. `agentCtx.tools.register(defineTool(advise))` —— 作用域注册只对该 agent 可见，且**不受 allow 掩码影响** → `advise` 必然保留。注册在 agentCtx 上的工具随 scope 释放而卸载。
- 插件持有 `AgentHandle`，完全掌控生命周期：compaction 重置 = `dispose()` + 重建；`agent.inject/steer/followup` 由插件对主 agent 直接调用。
- 不成为主 agent 的「子代理」：不进 `listChildren`、无 `subagent/start|end`、无结算 notice 噪音；omp「advisor 不是 peer」语义最接近。

**路线 B：continuable 子代理 —— `ctx.subagents.startContinuable(spec)`**

- `ContinuableStartSpec.request: Omit<SubagentStartRequest,'label'|'signal'|'outputSchema'>`，含 `toolFilter`、`persona`、`agentOptions`、`maxDepth`（continuation.ts:111-120；types.ts:118-148）。`toolFilter: ToolRestriction = {allow?, deny?}`，in-process 后端在子代理创建窗口内以 scoped `tools.restrict()` 应用（types.ts:133-140）；`persona` 以 `deployment:persona` section 遮蔽（types.ts:141-148）。
- `ctx.subagents.registerContinuableSetup(contribution)` 可向**每个** continuable 子代理的未发布作用域注入能力（index.ts:286-292；activation-setup-registry.ts 全文）——advise 工具可由此注入，但需自过滤（否则所有 continuable 子代理都带 advise）。
- 优点：continuation manager 自带驻留（running/waiting/settled）、冷恢复（持久 descriptor）、`interrupt()` 授权、结算通知；子代理自动 join 父 preset（applyChildComposition）。
- 缺点：成为主 agent 的持久子代理（listChildren 可见、`subagent/end` 事件、结算时向主 transcript 注入 notice —— 噪音）；跟随/唤醒需要精确 live 父 agent；**对子代理本身无当前 turn 转向**（README.md「Known Limitations」——但 advisor 的 advice 是插件对主 agent steer/inject，不受此限）。

### 3.2 结论

**被动评审者用路线 A（普通 agent）更干净**：工具授权完全自控（advise scoped 注册 + restrict allow 掩码）、与主 agent 无父子关系、compaction 重置/会话切换的销毁重建最简单、结算不污染主 transcript。omp 的 advisor 也是「full agent with its own Agent instance and a distinct ToolSession」。路线 B 的驻留/冷恢复机制对「随主会话生命周期存在的评审者」并不需要，反而引入父子语义。

隔离注意：普通 agent 不自动获得子代理的「approval pin to 'never' + sandbox override」委托策略（subagent README「Delegated policy」），插件需自行用 `captureDelegatedPolicyOverrides`/`appendDelegatedPolicyOverrides`（child-agent.ts 公开导出）或等价手段固定评审者权限。

---

## 4. 压缩/重写时的重置信号

具体信号（可多路监听，任一路触发即重置）：

1. **`compaction/*` 会话事件**（declaration-merge 进 `SessionEventMap`，log-only）：`compaction/start`、`compaction/summary`、`compaction/end`（compaction/README.md「Events」「Surface contract」；`compaction/end` 是锁内最后事件）。
2. **表面重写**：任何 `user/message` 带 `surfaceOp:{op:'replace',start,end}`（compaction checkpoint 或分支历史替换）；`isReplacementSurfaceEvent(event)` 从 `@deepseek-ai/dsh-session/surface` 导出（session/src/index.ts:33）。
3. **`session.surface.replaceGeneration` 变化**（每次 committed rewrite 必 bump；session README「Class: Session」）。
4. **会话切换/恢复**：`agent/session-start` payload `{agent, source: SessionStartSource}`，`'startup'|'resume'`（`'clear'|'compact'` 已保留未发射，agent README「Known Limitations」）；同一 workspace 新 `session/created`（fork）、旧 `session/disposed`。omp 的「/new、resume、branch」分别对应这些。
5. 附带：`agent/disposed`（主 agent 消失）。

重置动作：清空评审者私有转录 cursor、重绕到当前有界表面、清空 emission-guard 去重历史与每更新门（对应 omp emission-guard 重置语义）。

---

## 5. 命令与状态（`/advisor on|off|status`）

- 模式：`ctx.commands.register({name, description, input:{hint}, handler:({agent, rawInput}) => {…}})`，返回 `{kind:'success'|'error', text}`。生命周期在接收 agent 的 session 上记录为 log-only `command/run`（含 `commandId`/`args`/`CommandSource`）与 `command/done`；**结果直接由 adapter 渲染，绝不进入 model 历史**（interaction/commands/README.md「Service contract」「Model Experience」）。可 `recordInput:false` 让 `command/run` 省略 args。
- 现成范例：`/plan` 命令（plan-mode/src/index.ts:200-236），含 `agent.steer(createUserMessage(...))` 显式调度 model 可见工作（commands README 明确允许 producer 通过接收 Agent 调度）。
- `/advisor on|off` 可用 session 级状态（如 plan-mode 的 `plan/mode` 事件 + `foldPlanMode` 折叠模式，plan-mode/src/index.ts:99-110）或插件私有 map；`/advisor status` 读取评审者运行时状态 + usage（见 §6）。

---

## 6. 成本/用量跟踪

- **按会话用量现成可得**：`ctx.tokenMeter` 是 replay-aware 的按会话折叠 —— `measure(session, requestHeader?)` 返回 `{totalTokens, surfaceTokens, nodes[]}`（token-meter/README.md「Measurement contract」）；可选 `sessionProjections` 提供 `tokenUsage`（完整持久日志的 `uncachedInputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`）、`contextPressure`、`contextBreakdown` 三个投影单元（README.md「Session projections」）。评审者作为 agent 有**自己的 session**，其 `assistant/chunk {type:'usage'}` 自然入账 —— `ctx.tokenMeter.measure(reviewerSession)` 即可报「advisor 独立模型用量」。
- 若插件绕过 agent 直接 `ctx.llm.stream()`：流内 `{type:'usage', usage: TokenUsage}` 块 + 终末 `{type:'finish'}`（llm/src/types.ts:291-303；assembler.ts:141-149 `.usage`/`.finish`）。
- **dsh 无 cost 计算器**（只有 token 计量，无按模型定价）；cost 需插件自算（usage × 自有费率表）。

---

## 7. WATCHDOG 发现（discovery）

- **dsh 中不存在 WATCHDOG 机制**（全库 grep `watchdog` 仅命中 LLM 适配器的 idle watchdog 超时，与主题无关）。omp 的 WATCHDOG.md/.yml 需插件自建发现。
- 可复用的现成模式（**不是**现成设施，仅模式）：
  - `agent-instructions`（AGENTS.md 加载）：用户级 `$DSH_HOME/AGENTS.md` + 从 project root（`projectRootMarkers` 默认 `['.git']`）到 `session.header.cwd` 逐目录扫描候选；用可选 `ctx.fs` provider（无则 node:fs 回退）；`streamText()` 限 `maxSourceBytes` 读取；按 SHA-1 digest 去重（context/agent-instructions/README.md「Lifecycle」「Configuration」）。**但它把内容注入主 transcript（system-reminder user/message），WATCHDOG.md 绝不能进主上下文**，所以只能抄发现逻辑、不能复用其注入管线。
  - `skill-filesystem` 的根解析：project root = 最近 `.git` 祖先，无则 cwd；`ctx.fs.listDir/readText`，无 fs 服务回退 node:fs（skill-filesystem/README.md「Discovery」）。
- **建议**：插件自写向上走查（`node:fs` 或 `ctx.fs`）：用户级 `<dshHome|~/.agents>/WATCHDOG.md`，项目级从 cwd 到 git root（或 home）逐目录找 `WATCHDOG.md` 与 `.dsh/WATCHDOG.md`（对应 omp 的 `.omp/`）；`WATCHDOG.yml` 同路径，加载后校验 schema、逐条构造评审者。加载内容追加到评审者 system prompt（`<attention>` 块），不走主上下文。`boundContextSummary`（llm/src/message.ts:119-122）可复用做 notice summary 截断。

---

## 5 条关键结论（Final）

1. **投递映射**：`nit → agent.inject(plugin-source + form:'notice')`（不唤醒、claim 前不可见、下一个 step 边界批入，= omp「aside」）；`concern/blocker → agent.steer(...)`（唤醒空闲、运行中 turn 在**下一个 step 边界**消费并同 turn 再跑一步）；`followup` 另开整 turn。dsh 无 plan-mode 级 steer 门禁，「终局保留为卡片」策略须插件在 `agent/turn-stopping`/`turn/end` 自行实现（steer 会延展 turn，卡片应在 turn 关闭后 inject）。
2. **转录观察**：根 ctx `session/event` 收全部会话（含子代理），`session.id` 过滤；delta = 新增 surface 事件（`user/message`/`assistant/message`/`tool/result`），用公开的 `session.deriveEventMessage(event)` 逐条投影（或 `deriveMessages()` 全表面）；`surface.replaceGeneration` 只随 rewrite 变化，不是逐条信号。
3. **评审者形态**：推荐**普通 agent**（`ctx.agents.create` + `setup`）而非 continuable 子代理 —— setup 内 `agentPresets.composeFrom(agentCtx, primaryCtx)`（必须，否则工具注册表为空）+ `agentCtx.tools.restrict({allow:['read','grep','glob']})`（allow 掩码只管全局工具）+ `agentCtx.tools.register(advise)`（scoped 注册不受掩码影响）；不产生父子/结算噪音，重置=dispose+重建。subagent 路线（`toolFilter`/`persona`/`maxDepth`/`registerContinuableSetup`）可用但引入主代理子关系与结算 notice。
4. **重置信号**：`compaction/end` 等 `compaction/*` 事件、`user/message` 带 `surfaceOp:{op:'replace'}`（`isReplacementSurfaceEvent`）、`session.surface.replaceGeneration` 变化、`agent/session-start {source:'resume'}` / 新 `session/created`（fork）。重置需同时清 cursor 与 emission-guard 去重状态。
5. **命令与用量**：`/advisor on|off|status` 用 `ctx.commands.register`（结果不进 model 历史，`command/run`+`command/done` 落 session 日志）；用量按评审者自身 session 从 `ctx.tokenMeter.measure()` 或 `tokenUsage` 投影读取（dsh 无 cost 计算，费率需插件自理）；WATCHDOG 发现 dsh 无现成设施，按 `agent-instructions` 的向上走查模式（git root 标记 + `ctx.fs`/node:fs + 有界读取）自建，内容只进评审者 prompt。

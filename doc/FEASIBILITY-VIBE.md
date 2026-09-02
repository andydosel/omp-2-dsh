# 可行性研究:vibe 模式(纯插件实现)

> 状态:只读调研完成,未改动任何源码
> 基线:dsh master,`C:/Users/Vantage_XLST/Documents/dsh`
> 目标:把 omp 的 vibe/director 模式以纯插件形式移植到 dsh(见 `DESIGN-SHAKE-REVIEW.md` §附)
> 结论预览:6 项假设全部 **✅ 插件可行**,其中 3 项带条件(⚠️);无需核心改动;规模估计 **中**(约一个典型工具包的 3–5 倍)。

---

## 0. 结论速览

| # | 假设 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 插件可直接调用 subagent 服务(spawn/followup/interrupt/list/持久化) | ✅ | `startContinuable`/`followup`/`interrupt`/`listChildren` 均为 `ctx.subagents` 公开方法,`tool-subagent` 与 `tool-subagent-control` 已在模型面直接调用 |
| 2 | `vibe_wait` 可在插件内实现"阻塞至某 worker turn 结束" | ✅(⚠️ 信号选择) | 干净信号 = 子会话日志 `turn/end`(`session/event`);`ctx.jobs` 与 `subagent/end` 均非按 turn 粒度 |
| 3 | 单 agent 工具集收窄 + 退出恢复,不碰全局 | ✅(⚠️ code 模式) | `agent.ctx.tools.restrict()` 返回 disposer,仅作用于该 agent scope;`tools.presentAs('native')` 兜底 `run_code` 不可收窄问题 |
| 4 | 按 agent 注入 director 指令 section | ✅ | `systemPrompt.section()` 支持 per-agent 覆盖;plan-mode 的"全局注册 + 按 agent 过滤文本"同款模式 |
| 5 | `/vibe` 命令 + `vibe/mode` 事件 + 与 plan 互斥 | ✅ | `ctx.commands.register`、`SessionEventMap` 声明合并(plan-mode 同款)、`ctx.planMode.get(agent)` |
| 6 | fast/good 映射 provider/model | ✅ | 每次 spawn 传 `agentOptions:{provider,model}` 即覆盖父代理路由(`resolveChildAgentOptions`) |

---

## 1. 假设 1:subagent 的 spawn / followup / interrupt / list / 持久化(✅)

### (a) 插件如何编程式 spawn 子代理(不走模型面 `subagent` 工具)

直接调用 `ctx.subagents.startContinuable()` —— 这是服务层公开 API,`tool-subagent`(模型面工具)就是这么干的:

```ts
// packages/subagent/tool-subagent/src/index.ts:307-313 (背景 continuable 路径)
const started = await ctx.subagents.startContinuable({
  provider: config.provider,          // 默认 'spawn' (@deepseek-ai/dsh-subagent-spawn-in-process)
  label: args.description,            // 持久化为子会话的 creation label
  request: { prompt, parent, agentOptions?, persona?, toolFilter?, maxDepth? },
  signal: exec.signal,
})
return { kind: 'continuable', subagentId: started.childId }
```

- `ContinuableStartSpec`:`packages/subagent/subagent/src/continuation.ts:98-119`;`startContinuable` 返回 `{ childId, messageId }`(inbox 接受即返回,不等待 turn 开始)。
- 语义:持久化子会话 + 进程内 Activation,后续可冷恢复、可多轮 followup —— 这正是 vibe worker 需要的"真子会话,full tool surface"。
- 更低层(不推荐但可行):`ctx.agents.create`/`ctx.agents.resume`(`packages/core/agent/src/index.ts:202,213`),spawn 提供方内部即用 `parent.ctx.agents.create(...)` 建子(`packages/subagent/subagent-in-process-driver/src/index.ts:120-139`)。continuable 子代理由 continuation manager 自行组合,提供方只贡献 `prepareContinuable`(spawn 返回 `{}`,即全新子会话)。
- 服务依赖:`ctx.subagents` 需要 agents 服务(`packages/subagent/subagent/src/index.ts:457-463`,缺则 `CONTINUATION_UNAVAILABLE` 报错)。vibe 插件 `inject: ['subagents', 'tools', 'systemPrompt']` 即可(与 tool-subagent 相同)。

### (b) 给运行中的子代理发 follow-up + 得知 turn 结束

- 发送:`ctx.subagents.followup(parent, childId, content, { source, signal })`(`packages/subagent/subagent/src/index.ts:217`;`tool-subagent-control` 的 `send_message` 即此实现,`packages/subagent/tool-subagent-control/src/index.ts:46-58`)。消息进入子代理 inbox,成为其下一个 FIFO turn。
- **得知 turn 结束的信号(按可靠性排序)**:
  1. `ctx.on('session/event', ...)` 上过滤 `session.id === childId && event.type === 'turn/end'`(`packages/core/session/src/index.ts:76`;根 ctx 监听器收到全部会话事件,测试大量佐证,如 `packages/core/agent-loop/tests/agent.spec.ts:60-62`)。`turn/end` 携带 `{ turn, reason }`,是**按 turn 精确粒度**的日志事件。
  2. `agent/status`(`{agent, status:'idle'|'running'}`,`packages/core/agent/src/runtime-types.ts:178`)——但 `running` 覆盖"turn + checkpoint + waking inbox",`idle` ≠ 该 turn 结束,只能作辅助信号。
  3. `subagent/end`(activation 生命周期事件,`packages/subagent/subagent/src/index.ts:166`、`lifecycle.ts:210-215`)——粒度为**整个 residency epoch**(子代理已无后代且静止),不是单 turn。
  4. 父代理会收到 `subagent-settled` 通知消息(带最终输出,见 `tool-subagent` 工具描述 `index.ts:253-259` 与 continuation 文档)——是"该子代理 epoch 结束"的推送,会唤醒父代理。
- **`ctx.jobs` 不适用于 turn 粒度**:continuation 文档明言 "No continuable path creates a Task or an intermediate result-bearing wrapper" —— continuable 子代理**不产生 job**。jobs 只用于 one-shot 后台(`tool-subagent` 的 `run_in_background:true` 路径,`index.ts:407-425`)。

### (c) 中断 / kill / dispose 语义

- `ctx.subagents.interrupt(targetSessionId, authority)`(`packages/subagent/subagent/src/index.ts:241`;`tool-subagent-control` 的 `interrupt_agent` 用 `{ kind:'ancestor', agent: exec.agent }`,`index.ts:96-118`)。语义:**只停当前 turn**,inbox 中排队消息保留、子代理自己启动的后代保留、Activation 保留;之后再 `followup` 即恢复。→ 这就是 vibe 的 `vibe_kill`/park 语义,直接可用。
- 彻底终止整个 worker 森林:`ctx.subagents.drainContinuableDescendants([directorAgent])`(`packages/subagent/subagent/src/index.ts:304`,实现 `continuation.ts:721-780`),子先序释放全部后代 Activation。
  - ⚠️ **关键约束**(见 §6 风险 3):`drainDescendants` 会为该 director 树**永久关闭 continuable admission**,直到 director 离开 agents 注册表(`continuation.ts:736-738,850-852`)。因此 **模式退出默认应 park(interrupt),而非 drain**;drain 只用于 director 会话本身销毁或显式硬销毁命令。

### (d) 列出活体 agent

- `ctx.agents.get(id)` / `ctx.agents.list()` / `ctx.agents.isOwnedBy(id, parent)`(`packages/core/agent/src/index.ts:583-605`)。`vibe_list` 可完全照抄 `list_agents` 工具(`packages/subagent/tool-subagent-control/src/list-agents.ts`):`ctx.subagents.listChildren(directorSessionId)` + `ctx.agents.get(id)` 派生 `running/idle/ready` 状态。

### (e) 子会话持久化

- ✅ 子代理就是 `ctx.sessions` 里的普通会话;持久化后端(JSONL/SQLite)对**每个**会话订阅 `session/created` + `session/event`(`packages/session/session-persistence/src/coordinator.ts:1118-1136`),worker 会话自动落盘,无需任何新 schema。
- continuable 描述符以 `subagent/descriptor` 日志事件持久化,冷恢复时 manager 用其恢复 provider/model/persona/toolFilter(`packages/subagent/subagent/src/descriptor.ts`,文档 §descriptor);`listChildren` 走 live-preferred 合并(live 存储 + 持久化)。

---

## 2. 假设 2:`vibe_wait` = "注册/订阅 + 阻塞至 watched turn 结束"(✅)

- `ctx.jobs` 抽象(`packages/jobs/jobs/src/index.ts`):`start/list/get/read/kill/wait/onJobDone/onJobsChanged/attachController`;`JobKindMap` 可声明合并(types.ts:21-28),插件可注册自有 job kind —— 若想走 job 路由,vibe 可把"一次 spawn 的 turn 生命周期"包成一个 producer(`run()` 返回 hooks,`done` 在 turn/end 时 resolve),`vibe_wait` 即 `jobs.wait(id, timeoutMs, caller, signal)`。`tool-jobs` 已有带超时上限的等待模式(`packages/jobs/tool-jobs/src/index.ts:32-45`,`waitTimeoutMs`/`maxWaitTimeoutMs`)。
- **但最干净的信号是会话事件,零注册成本**:
  ```ts
  // vibe_wait 工具体(伪代码)
  const target = turnCountOf(child) + 1   // spawn/send 时捕获
  await withTimeout(race(
    once('session/event', s => s.id === childId && e.type === 'turn/end' && e.data.turn === target),
    once('agent/disposed', a => a.id === childId),        // worker 被销毁
    once('agent/status', a => a.id === childId && a.status === 'idle'), // 兜底
  ), timeoutMs, exec.signal)
  ```
- 工具体可长时间阻塞(plan-mode 的 `exit_plan_mode` 就阻塞在 `userQuestions.ask`,`packages/plan/plan-mode/src/index.ts:331-360`),平台无单次工具超时墙;`exec.signal` 提供取消。
- 返回内容:从子会话 `turn/end` 之后的事件里取最终 assistant 消息(`finalAssistantOutput`,`packages/subagent/subagent/src/assistant-output.ts`),或直接消费 manager 推送的 `subagent-settled` 通知。
- ⚠️ 注意:`agent/status` idle 不可单独作 turn 结束判据(`continuation.ts:865-873` 明言 "Agent.status alone is insufficient");worker 若自己派生了后代,`turn/end` 后仍可能保持 resident(`waiting`)。

---

## 3. 假设 3:按 agent 收窄工具集(✅,⚠️ code 模式)

### (a) 收窄一个 agent

- `ctx.tools.restrict({ allow: [...] })`(`packages/core/tools/src/index.ts:1071-1098`):
  - **必须**在 scoped context 上调用(`agent.ctx`),否则直接 throw("a context-global restriction would mask every agent")—— 这恰好强制了"不碰全局"。
  - 返回**精确 disposer**,调用即解除限制 → (b) 恢复 = 保存 disposer。
  - 对未知工具名**大声失败**(`:1088-1092`)——allow 列表必须匹配实际全局工具名(`read`、`glob`、`grep`、`read_image`、`todo_write`(`packages/fs/tool-fs/src/read.ts:77`、`tool-fs-search/src/glob.ts:312`、`grep.ts:283`、`packages/todo/tool-todo/src/index.ts:150`)),建议做成插件配置。
  - 限制**只过滤继承层**(global + 祖先链),**不影响 scope 自己层注册的工具**(`view()` 注释 `:1137-1140`,delegation runtime 依赖此豁免)。
- 5 个 vibe 工具因此应注册在 **`director.ctx` 上**(scoped 注册,仅 director 可见、不受 restrict 影响、随 agent 销毁自动卸载):`agent.ctx` 是 `createScope` 产的活 scope(`packages/core/agent-loop/src/agent.ts:94-95`),"scoped registrations live in the agent world and die with the agent"(测试 `packages/core/agent-loop/tests/scope-lifecycle.spec.ts:189-216`)。
- 触发时机:`/vibe on` 命令 handler 拿得到 `agent`(`CommandInvocation.agent`),直接 `agent.ctx.tools.restrict(...)` + `agent.ctx.tools.register(...)` + `agent.ctx.systemPrompt.section(...)`;`/vibe off` 调用各 disposer。当前 turn 已组装的 catalog 不变,下次 request 装配即生效(plan-mode 同款语义)。
- 其他 agent/全局注册表零影响:restrict/presentAs/register 都落在 director 的 scope 层。

### (b) 退出恢复

- `restrict`/`presentAs`/`section` 的 disposer 全部精确可调,`/vibe off` 逐一 dispose;若 agent 先于模式退出销毁,scope 整体 unwind,无需额外清理。

### (c) ⚠️ 条件:code-mode 部署(硬约束,须在实现中处理)

- 保留的 `run_code` 传输(Code Mode)不可被 restrict 移除(`tools/src/index.ts:918-920,1188-1191`):code 模式下 director 仍能看到 `run_code`,并在程序内触达全部工具,绕过收窄。
- 解法:`ctx.tools.presentAs('native')`(`tools/src/index.ts:936-962`)——按 scope 声明展示模式,`modeFor()` 最近 scope 优先(`:900-910`)。vibe 进入时在 director scope 上 `presentAs('native')`,退出时 dispose。⚠️ 若 deployment 强制要求 director 保持 code 模式(不应如此),vibe 收窄在此类部署下不成立,文档须声明。
- 备注:preset 的 `isolate` realm(`packages/preset/agent-presets/src/index.ts:420-427`)是 cordis 服务存储隔离(避免 preset 服务跨会话泄漏),与工具可见性无关,本设计不涉及。

---

## 4. 假设 4:按 agent 注入 director 指令 section(✅)

两种机制都可行:

1. **plan-mode 同款(推荐镜像)**:全局注册一次,文本按 agent 过滤:
   ```ts
   ctx.systemPrompt.section({
     name: 'director:instructions',
     order: 51,                                  // plan:policy 为 50
     text: (context) => context.agent === undefined
       || !foldVibeMode(context.agent.session.events) ? '' : DIRECTIVE,
   })
   ```
   (`packages/plan/plan-mode/src/index.ts:120-131` 原样模式;文本从会话日志折叠模式状态,resume/fork 自动恢复)。
2. **per-agent 覆盖(官方支持)**:`agent.ctx.systemPrompt.section(...)` —— 注册在调用 ctx 的 scope,"for a per-agent override, register through that agent's `agent.ctx` instead"(`packages/core/system-prompt/src/index.ts:307-316`)。scoped section 只对该 agent 的装配可见,随 agent 销毁卸载。比方案 1 更"按 agent",但模式进入/退出需要动态增删,plan-mode 选择方案 1 是因为模式状态本来就存在会话日志里。**推荐方案 1**(与 plan-mode 完全对称,少一套生命周期管理)。

---

## 5. 假设 5:命令 + 模式状态 + 与 plan 互斥(✅)

- `/vibe`:`ctx.commands.register({ name, description, input, handler })`(`packages/interaction/commands/src/index.ts:135-160`;handler 收 `{ agent, rawInput, signal }`;自动落 `command/run` + `command/done` 日志;支持 per-agent scoped 命令变体)。
- `vibe/mode` 事件:`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'vibe/mode': { active: boolean } } }` —— 与 `plan/mode` 声明合并完全同款(`packages/plan/plan-mode/src/index.ts:28-34`);整值替换、log-only、fold 可恢复(`foldPlanMode`,`:67-79`);`session.append('vibe/mode', {active})` 走 `agent/pre-step` 边界提交(`:54-78,393-431` 同款,含 open-turn pending 语义)。
- **与 plan-mode 互斥**:
  - 方式 A(依赖包):`ctx.get('planMode')?.get(agent)` 读 `{ active, pending }`(`packages/plan/plan-mode/src/index.ts:374-383`);plan-mode 已声明 `ctx.planMode` 服务。vibe 用 type-only import + 可选 inject,plan 未装配时静默跳过。
  - 方式 B(零依赖):监听 `session/event` 的 `plan/mode` 事件或直接 fold `agent.session.events`。推荐方式 A(对称、可测),与 future compact-mode 的 `ctx.compactMode` 同构。
- 互斥提交:进入 vibe 前检查 plan 状态,冲突则命令返回错误提示先退出;反之 plan-mode 不需要改 —— 由 vibe 单方面守约即可(也可以双方都检查,需 compact/vibe 之间约定,见 §7)。

---

## 6. 假设 6:fast/good 模型路由(✅)

- 每次 spawn 的 `agentOptions` 可覆盖路由:`resolveChildAgentOptions`(`packages/subagent/subagent/src/child-agent.ts:68-81`)——子代理默认继承父的 `provider/model/maxTokens`,但 `...requested` 展开在父值之后,传 `{ provider, model }` 即覆盖。continuable 描述符会把 provider/model 快照下来供冷恢复。
- `tool-subagent` 已示范把配置里的 `agentOptions` 透传给每次 delegation(`packages/subagent/tool-subagent/src/index.ts:270-278`)。
- 部署默认路由:`ctx.agentDefaultModel.currentSelection()`(`packages/core/agent-default-model/src/index.ts:88-90`)。
- 实现:`config.tiers.fast = { provider, model }`、`config.tiers.good = { provider, model }`,`vibe_spawn` 按 tier 拼 `agentOptions`,空则继承 director 路由。⚠️ 验证点:provider/model 存在性由 provider 侧校验(`expectProvider`/`UNSUPPORTED_CAPABILITY`,`packages/subagent/subagent/src/index.ts:449-455,480-493`),拼错会大声失败,配置校验放插件加载期。

---

## 7. 推荐包结构

**单包 `@deepseek-ai/dsh-vibe-mode`(`packages/vibe/vibe-mode/`,镜像 `packages/plan/plan-mode/` 布局)**:

```
packages/vibe/vibe-mode/
  src/
    index.ts        # apply():声明合并 'vibe/mode' + ctx.vibeMode 服务
    types.ts        # VibeModeConfig、tiers、readOnlyTools、foldVibeMode
    mode.ts         # VibeModeController(plan-mode 同构:set/get/pending/互斥/narration)
    workers.ts      # worker 注册表(per-director:childId→tier/turn 计数)、turn-end promise 表
    tools.ts        # 5 工具:vibe_spawn/send/wait/kill/list(共享 workers.ts 状态)
    director.ts     # 收窄应用:restrict + presentAs('native') + section,统一 disposer 集
    invariant.ts
  tests/            # 模式状态机 / 互斥 / 工具 / 收窄恢复 / 持久化恢复
```

- **为什么不分"工具包 + 服务包"**:`tool-subagent`/`tool-subagent-control` 拆包是因为 provider 机制可复用、控制工具在模式外也有意义;而 5 个 vibe 工具离开 vibe 模式毫无意义,且强依赖模式内部的 worker/turn 簿记(每个 spawn/send 都要登记 turn 计数器供 `vibe_wait` 用),合并单包最自然。若未来有"不装模式只装工具"的诉求再拆。
- **依赖行**(profile `profiles/**/cordis*.yml`):`dsh-subagent`(服务)+ `dsh-subagent-spawn-in-process`(provider,默认名 `spawn`)+ 可选 `dsh-jobs`/`dsh-jobs-local`(若 vibe_wait 走 job 路由)+ 可选 `dsh-plan-mode`(互斥读取,type-only)。**零核心改动、零持久化 schema 改动**(`vibe/mode` 只是日志事件;worker 是普通持久化会话)。
- 与 compact-mode 的互斥契约(forward-looking):三方(plan/vibe/compact)各暴露 `ctx.<mode>Mode` 服务 + `<mode>/mode` 事件;vibe 读 plan 用 `ctx.planMode.get(agent)`,读 compact 用 `ctx.compactMode?.get(agent)`(compact 未建,先留 type-only 占位与文档约定)。

---

## 8. 三个最难点 + 具体机制

1. **`vibe_wait` 的按 turn 结束信号(最难,容易做错)**
   - 陷阱:continuable 子代理不产生 job;`agent/status` idle ≠ turn 结束;`subagent/end` 是 epoch 粒度;`subagent-settled` 通知会唤醒 director(自我唤醒链风险)。
   - 机制:每 worker 维护"已发出消息数 → 期望 turn 号";`vibe_wait` 在根 `ctx` 上注册一次性 `session/event` 监听,匹配 `session.id === childId && type === 'turn/end' && data.turn === target`,与超时、`exec.signal` abort、`agent/disposed`(worker 被销毁)竞速;结果文本从子会话日志取 `finalAssistantOutput`。可选:同步把该 turn 包成自定义 job kind 以便 `jobs.wait` 复用超时/通知基建。

2. **让收窄真正密闭(restrict 的边界)**
   - 陷阱:`run_code`(code 模式传输)不可被 restrict 移除,code 部署下 director 可经程序触达全部工具;allow 列表拼错会大声 throw;restrict 不影响 scope 自身注册 —— 5 个 vibe 工具必须注册在 director scope 而非全局。
   - 机制:进入时 `director.ctx.tools.restrict({ allow: config.readOnlyTools })` + `director.ctx.tools.presentAs('native')` + `director.ctx.tools.register(vibe 5 件)` + `director.ctx.systemPrompt.section(director:instructions)`;四者 disposer 统一存 `director.ts` 的"模式 disposer 集",退出逐一释放。allow 列表插件配置化并在加载期校验名字存在于 `restrictableNames`(实际注册名:`read`/`glob`/`grep`/`read_image`/`todo_write`)。

3. **worker 生命周期与模式退出语义(park vs terminate)**
   - 陷阱:`drainContinuableDescendants([director])` 会永久关闭该 director 树的 continuable admission(直到 director 离开注册表),模式退出后再次进入会 spawn 失败;agent-loop 不会在 director 销毁时自动 drain worker 森林(全仓仅服务定义一处 `drainContinuableDescendants`)。
   - 机制:默认 `vibe_kill`/模式退出 = 对每个活 worker 调 `interrupt(childId, { kind:'ancestor', agent: director })`(park:停当前 turn、保留 inbox/后代/会话,可恢复);显式硬销毁命令(如 `/vibe off --terminate`)或 director 会话销毁时才 `drainContinuableDescendants`;同时监听 `agent/disposed`(director)兜底清理。

---

## 9. 规模估计(对照典型 dsh 工具包)

- 参照系:`tool-subagent` 约 470 行 src + 3 个测试文件;`plan-mode` 约 480 行 src + 多测试。
- vibe 模式 = 服务(模式状态机 + 互斥 + 命令)≈ plan-mode + 5 工具(含 worker/turn 簿记)≈ tool-subagent + tool-subagent-control + 收窄/恢复逻辑。
- 估计:**中(medium)**。单包约 1,500–2,500 行 src + 5–8 个测试文件;无核心/类型/schema 改动;复用全部现成机制(continuation manager、restrict/presentAs、commands、section、持久化)。交付验收可全部走约束/单测,无需 API key(mock provider)。
- 主要工作量集中在 §8 的三点(尤其 1 与 2 的边界测试)与互斥矩阵测试。

---

## 10. 最终结论与 Top-3 风险

**结论:6 项假设全部插件可行,零核心改动;推荐单包 `@deepseek-ai/dsh-vibe-mode`;规模中;可与 compact 插件并行开发。**

Top-3 风险:

1. **turn 粒度信号语义**:worker 可能自派生子代理(保持 resident)、队列里有多条 followup —— `turn/end` 必须与 turn 计数器精确配对;`subagent-settled` 推送会唤醒 director,若 director 不显式 `vibe_wait` 可能形成"完成→唤醒→再派活"的自激链(参考 `tool-jobs` 的 `maxConsecutiveWakes` 限流,`packages/jobs/tool-jobs/src/index.ts:40-45`,vibe 需要同等防护)。
2. **收窄的密闭性**:code 模式部署下 `run_code` 不可 restrict,必须 `presentAs('native')` 才真正收窄;allow 列表与实际全局工具名强耦合,拼错即运行时 throw —— 需要在配置加载期做名字校验 + 文档声明 code 模式限制。
3. **`drainContinuableDescendants` 的 admission 永久关闭**:模式退出若误用 drain,director 树后续无法再 spawn continuable worker;必须 park-by-default、drain-only-on-dispose/显式销毁,并有 `agent/disposed` 兜底清理。

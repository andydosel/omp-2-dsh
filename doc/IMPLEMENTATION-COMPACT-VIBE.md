# 实现文档 v1.0:compact 模式 + vibe 模式(dsh 纯插件)

> 状态:依据设计 v1.1 + 可行性报告(FEASIBILITY-COMPACT.md / FEASIBILITY-VIBE.md)定稿
> 基线:dsh(deepseek-harness)master,本地 clone `C:/Users/Vantage_XLST/Documents/dsh`
> 原则(硬性):一切以插件形式实现;涉及核心改动或非插件实现必须提醒用户(见 §4)

---

## 0. 可行性总结论

| 插件 | 可行性 | 说明 |
|---|---|---|
| `dsh-compact-mode`(shake + compact 模式 + 审阅树) | ✅ 纯插件可行 | 7 项假设 5 ✅ 2 ⚠️;零核心逻辑改动;两处边界见下 |
| `dsh-tree-engine`(通用审阅树引擎) | ✅ 纯 TS 库 | 无 cordis 行,不提供服务;随 compact 插件交付 |
| `dsh-vibe-mode`(DIRECTOR 模式) | ✅ 纯插件可行 | 6 项假设全 ✅(3 带条件);零核心改动 |
| 完整 omp 式会话树 | ❌ 需核心改动 | 见 §4.1,后续独立项目 |

**两处必须正视的边界**:
1. **事件持久化目录是"核心包里的生成数据文件"**:新增 `compact/mode` 事件必须重跑 `pnpm run gen-persistence-catalog`(改动 `packages/core/session/src/known-event-types.ts` + `docs/persistence-catalog.md`),否则 CI `verify-persistence-catalog` 失败且持久化读侧拒绝日志。运行时/逻辑零改动;plan-mode 已开此先例。
2. **审阅期指令截获走 `agent/pre-step` reject**:指令消息被 claim 后**不落会话日志**,插件必须同步捕获并持久化到审阅树;崩溃窗口(claim→persist)会丢指令,需容错(重投/告警)。

## 1. 与 omp 现有能力对比总表

| 功能点 | omp 实现 | 本实现(dsh) | 差距与取舍 |
|---|---|---|---|
| shake 本地削减 | `compaction.strategy: "shake"`:可弃 tool result 与大段 fenced/XML 块 → 可恢复 `artifact://` 引用;保护窗口 + 最小节省阈值;自动 shake 压不进恢复区间则回退上下文全文摘要 | tool result → `ctx.toolResultPruner`;fenced/XML → 占位符 + `ctx.spillStore.saveText` 定位符(自实现,`spill-policy` 行是 tools/post-execute 变换器,与压缩期无关);`keepRecentTokens` + `minShakeSavingsRatio` 防空转;超阈值**进审阅模式**而非自动摘要 | omp 超阈值自动摘要回退;dsh 版把"回退摘要"换成"用户可控审阅"(本设计核心差异);assistant 消息同类替换受限(见 §4.3) |
| 压缩审阅(plan 式) | omp plan 模式:先产计划 → 对话审阅/修改 → 确认后执行 | compact 模式镜像 dsh plan-mode:草稿 → 指令微调(独立辅助调用)→ `/compact_apply` 确认应用 | 交互同构;dsh 版审阅不产生 live 模型上下文(见 §2.5),超限风险消除 |
| 会话树 | omp `/tree`:同文件内导航/分支/标签/搜索/分支摘要;`/branch` 另开会话文件 | 审阅树(`dsh-tree-engine`):指令+草稿节点、分支回溯、独立存储;**非**会话树 | 审阅树是完整会话树的"特化先行版";完整树需核心改动(§4.1) |
| vibe 模式 | `/vibe`:主会话变 DIRECTOR,工具收窄 read+todo+5 vibe 工具;fast/sonic + good/task 两级;worker 转录持久化;退出终止全部 | `/vibe` 同构:收窄 `agent.ctx.tools.restrict()` + `presentAs('native')` + scoped 注册;`vibe_spawn/send/wait/kill/list`;fast/good 映射 `agentOptions`;worker = continuable 子代理(持久化会话);退出 park(interrupt) | omp 退出即 terminate;dsh 版默认 park 可恢复(因 `drainContinuableDescendants` 会永久关闭该树 admission,见 §3.5) |
| 模式互斥 | vibe 与 plan/goal 互斥 | compact/vibe 与 plan 互斥(`ctx.planMode.get(agent)` 单向守约) | 同 |

---

## 2. 插件 A:`dsh-compact-mode` 详细实现

### 2.1 包结构

```
packages/compaction/compact-mode/
  package.json / tsconfig.json / README.md(双语文档)
  src/
    index.ts            # 默认导出 class CompactModeEngine extends CompactionEngine
    config.ts           # static Config(z.object,全部默认值)
    mode.ts             # compact/mode 事件声明合并 + fold + set/get(plan-mode 同款)
    engine.ts           # compactIfNeeded / compactNow / compactRegion 实现
    shake.ts            # 本地削减:pruner + fenced/XML 占位 + 复测
    review.ts           # 审阅状态机:进入/指令/应用/中止;串行修订队列
    commands.ts         # /compact* 命令注册
    tree.ts             # 审阅树接线(dsh-tree-engine 消费)
    invariant.ts
  tests/                # 见 §2.10
```

纯 TS 库 `dsh-tree-engine`(独立包,无 cordis 行):节点(id/parentId/内容/时间戳)、leaf、分支(非破坏)、标签、模糊搜索、存储层抽象。compact 插件为其注册 domain。

### 2.2 引擎实现(替换 `ctx.compaction`)

- **从零实现 `CompactionEngine`**(子类化 `BasicCompactionEngine` 被 `resolveConfig` 严格键校验 + private 监听器挡住);作为**库依赖**复用其导出:`summarizeWithLlm` / `frameSummary` / `selectCompactableRange` / `assertNoActiveCompaction` / `toolPairingBalancedBefore/After` / `compactCheckpointSource`(行禁用 ≠ 包卸载)。
- `static inject = ['llm','tokenMeter','sessions']`;`ctx.plugin(CompactModeEngine, config)` 提供 `ctx.compaction`(单后端/上下文由 cordis `provide` 冲突强制)。
- 监听器(镜像 compaction-basic):`agent/pre-step` 压力 + `agent/request-error` 溢出,全部调 `this.compactIfNeeded`。
- `compactIfNeeded` = shake(§2.3)→ 复测 ≤60% 完成;**>60% → 发 notice 提示**(不直接进入审阅,压力点不能写 owner-null 锁);审阅激活时返回 null。
- `compactNow` = 审阅状态机入口(命令态才合法,写 owner-null `compaction/start` 持锁)。
- `compactRegion`:审阅激活时抛 `ManualCompactionError('busy')`。

### 2.3 Shake 阶段(纯本地)

1. tool result → `ctx.toolResultPruner.pruneSession(session)`(base 行保留,openTurn 即可)。
2. 大段 fenced/XML 块(在 user/tool 消息中)→ `ctx.spillStore.saveText(...)` 存原文,以占位符 `user/message` replace 替换(`CallId()` 自铸 source);`spill-policy` 行不参与(它是 post-execute 变换器)。
3. 保护窗口 `keepRecentTokens`;最小节省 `minShakeSavingsRatio` 防空转。
4. `tokenMeter.measure` 复测;≤60% → 完成;>60% → 提示进入 compact 模式。
5. **assistant 消息 shake 受限**(§4.3):invariant 禁止同类 assistant/message 替换(需 open step),只能 user 占位替换或 v1 跳过。

### 2.4 模式状态(compact/mode)

- `declare module '@deepseek-ai/dsh-session/types'` 加 `'compact/mode': { active: boolean }`,last-wins fold(plan/mode 同款);整值替换、log-only、可恢复。
- **必须重跑 `pnpm run gen-persistence-catalog`**(生成 known-event-types.ts + docs/persistence-catalog.md),否则 CI 失败、持久化读侧拒绝日志。
- 互斥:进入前读 `ctx.planMode?.get(agent)` 与 vibe 状态(`ctx.vibeMode?.get(agent)`,type-only 依赖),冲突则命令报错提示先退出;`/compact` 随时可进入(任意时刻入口)。

### 2.5 审阅循环(独立辅助调用,live 零增长)

- **指令捕获**:`agent/pre-step` payload `{ agent, messages, turn, step, signal }`;compact 激活时**同步**读取 `messages` 文本 → 写入审阅树待处理节点 → 返回 `{ kind: 'reject' }`(turn/end blocked,不写 step/start、不 append user/message、不发模型请求)。**辅助调用绝不在监听器内 await**(driver running 不 latch wake,会吞消息)→ 轮次关闭后由插件自持**串行队列**逐条执行。
- **修订调用**:`ctx.llm.stream()` 一次性调用,`purpose: 'compaction'`;输入 = 当前草稿 + 指令 + 源区域(KV 前缀回放:`session.requestHeader()` + `deriveEventMessage` 逐节点 + 指令/修订提示末位);输出 = 新草稿。有界、不累积 → 微调多少次都不超限。
- 草稿/节点写入审阅树;`/compact view <n>` 观测。
- 崩溃容错:指令同步捕获先落内存队列再持久化;持久化失败时把消息 `steer` 回 inbox 或告警。

### 2.6 应用与中止

- **应用**(`/compact_apply`):apply 前用 `tokenMeter` 复验"草稿 < 被遮蔽内容"(shrink 检查);按 `compactSurfaceRegion` 同款序列 append:`compaction/summary`(可带 `rawOutput`/`llmStreamCall: true`/`usage` 溯源)→ `user/message`(surfaceOp replace,`compactCheckpointSource`)→ `compaction/end`;`sessions.flush`;审阅树销毁;退出模式。
- **中止**(`/compact_abort`):append 带 `error` 的 `compaction/end` 闭合锁;表面零改动;树保留(上下文变动后删除,见 §2.8)。

### 2.7 命令清单(`ctx.commands`,不经模型轮,结果可见)

| 命令 | 行为 |
|---|---|
| `/compact` | 进入 compact 模式(任意时刻);已在模式内则提示当前状态 |
| `/compact_edit <指令>` | 以指令驱动一次修订调用,新草稿入树 |
| `/compact_apply` | 确认并应用当前草稿,退出模式 |
| `/compact_abort` | 退出不应用;树按生命周期规则保留/删除 |
| `/compact tree` | 树列表(无 UI 阶段的观测入口) |
| `/compact view <n>` | 查看第 n 版草稿 |
| `/compact jump <n>` | 回到第 n 版并从此分支(非破坏) |
| `/compact diff <a> <b>` | 可选:两版草稿对比 |

- 60%/硬溢出提示 = notice user message(`form: 'notice'`,plan-mode narration 先例,带冷却 `promptCooldown`;随下一步进模型上下文,v1 接受)。
- 撞名保护:`command-compact` 行必须 `disabled: true`(同名注册抛错)。

### 2.8 审阅树存储与生命周期

- **domain 路线(推荐,拍板点 2a)**:`ctx.storageDomain.open(defineDomain({ name: 'compact-review', version, tables }))`,记录按 sessionId 键控;web profile 已挂 storage-json/storage-domain;文件 `$DSH_HOME/storages/compact-review.json`,与会话日志 `$DSH_HOME/sessions/` **物理分离**;无 storage 行的 profile 退化为插件自有 JSON 文件(2b,dsh-personal-memory 先例)。
- **生命周期**:`/compact_abort` 退出 → 树**保留**;退出后会话表面/日志发生变动(新用户/助手消息、fork、surface replace)→ 树**删除**;`/compact_apply` 后 → 树**销毁**(结果已在日志)。

### 2.9 配置(完整字段)

```yaml
- id: compact-mode
  name: '@deepseek-ai/dsh-compact-mode'
  config:
    thresholdRatio: 0.6            # shake 后 >60% 提示进入 compact 模式
    keepRecentTokens: 20000        # shake 保护窗口
    minShakeSavingsRatio: 0.05     # 防空转
    summarizationProvider: ''      # 空 = 沿用最近请求路由
    summarizationModel: ''
    maxTokens: 8192
    promptOnThreshold: true
    promptCooldown: 0              # 0 = 每会话每阈值一次
    promptOnHardOverflow: true
    reviewTimeoutMs: 0             # 0 = 审阅不超时
    auto: true                     # 注册自动压力/溢出监听
    reviewTree: 'domain'           # 'domain' | 'file'
    readOnlyTools: [...]           # (vibe 插件字段,此处占位示意)
```

profile 补丁(第三层):

```yaml
- id: compaction-basic
  disabled: true
- id: command-compact
  disabled: true
- insert:
    - id: compact-mode
      name: '@deepseek-ai/dsh-compact-mode'
      config: { /* 见上 */ }
```

### 2.10 测试计划(免 API key)

- 树引擎:节点/分支/回溯/标签/搜索
- 模式状态机:进入/退出/互斥/折叠恢复
- pre-step 指令捕获 + reject 后无模型请求、无 user/message append
- 应用前后表面替换 + shrink 复验;中止后表面零改动 + 锁闭合
- 上下文变动删树;提示冷却
- 辅助调用:`llm-replay`/mock provider 假流 → 草稿修订映射
- `--dump-config`:backend 替换与命令行生效

---

## 3. 插件 B:`dsh-vibe-mode` 详细实现

### 3.1 包结构(单包,镜像 plan-mode 布局)

```
packages/vibe/vibe-mode/
  src/
    index.ts        # apply():声明合并 'vibe/mode' + ctx.vibeMode 服务
    types.ts        # VibeModeConfig、tiers、readOnlyTools、foldVibeMode
    mode.ts         # 模式控制器(set/get/pending/互斥/narration)
    workers.ts      # worker 注册表 + turn 计数 + turn-end promise 表
    tools.ts        # 5 工具(vibe_spawn/send/wait/kill/list)
    director.ts     # 收窄应用(restrict + presentAs + section + 统一 disposer 集)
    invariant.ts
  tests/
```

### 3.2 模式与互斥

- `/vibe`:`ctx.commands.register`;`vibe/mode` 事件 = `SessionEventMap` 声明合并(plan-mode 同款),fold 恢复。
- 互斥:读 `ctx.planMode?.get(agent)` / `ctx.compactMode?.get(agent)`,冲突报错提示先退出(单向守约,plan-mode 不需改动)。
- 进入/退出:`/vibe on` 的 handler 拿 `CommandInvocation.agent`,直接 `agent.ctx` 上做 scoped 注册(随 agent 销毁自动卸载)。

### 3.3 五个工具(共享 workers.ts 簿记)

| 工具 | 行为 |
|---|---|
| `vibe_spawn { cli: fast\|good, prompt, name? }` | `ctx.subagents.startContinuable({ provider, label, request: { prompt, parent, agentOptions } })`;登记 turn 计数;返回 `{ subagentId }` |
| `vibe_send { session, message }` | `ctx.subagents.followup(...)`;turn 计数 +1 |
| `vibe_wait { sessions?, timeout? }` | 一次性 `session/event` 监听匹配 `session.id === childId && type === 'turn/end' && data.turn === target`,与超时/`exec.signal`/`agent/disposed` 竞速;结果从子会话日志取 `finalAssistantOutput` |
| `vibe_kill { session }` | `ctx.subagents.interrupt(childId, { kind:'ancestor', agent: director })`(park:停当前 turn,保留 inbox/后代/会话) |
| `vibe_list {}` | `ctx.subagents.listChildren(directorSessionId)` + `ctx.agents.get()` 派生 running/idle |

- 关键信号:continuable 子代理**不产生 job**;`agent/status` idle ≠ turn 结束;`subagent/end` 是 epoch 粒度;**唯一可靠 = turn/end 事件 + turn 计数器配对**。`subagent-settled` 推送会唤醒 director → 需防"完成→唤醒→再派活"自激链(tool-jobs `maxConsecutiveWakes` 同款限流)。
- 工具注册在 **director scope**(`agent.ctx.tools.register`):仅 director 可见、不受 restrict 影响、随 agent 销毁卸载。

### 3.4 收窄(进入/退出)

- 进入:4 个 scoped 注册,disposer 统一存入 director.ts:
  1. `agent.ctx.tools.restrict({ allow: config.readOnlyTools })`(默认 `read/glob/grep/read_image/todo_write`;未知名**大声 throw**,加载期校验)
  2. `agent.ctx.tools.presentAs('native')`(**必须**:code 模式下 `run_code` 不可被 restrict 移除,`presentAs('native')` 才真正收窄)
  3. `agent.ctx.tools.register(vibe 5 件)`
  4. `agent.ctx.systemPrompt.section('director:instructions', order 51, 文本按模式状态折叠,plan-mode 同款)`
- 退出:逐一 dispose;agent 先销毁则 scope 整体 unwind,无需额外清理。

### 3.5 worker 生命周期(park vs terminate)

- **默认 park**:`/vibe off` 与 `vibe_kill` = 对每个活 worker `interrupt(...)`;可恢复。
- **硬销毁**:显式 `/vibe off --terminate` 或 director 会话销毁时 `drainContinuableDescendants([director])`(会**永久关闭**该树 continuable admission 直到 director 离开注册表——误用则无法再次 spawn)。
- 兜底:监听 `agent/disposed`(director)清理。

### 3.6 fast/good 路由与持久化

- 每次 spawn 传 `agentOptions: { provider, model }` 覆盖父路由(`resolveChildAgentOptions` 展开顺序保证);config `tiers.fast/good` 可配,空则继承 director;provider/model 拼错由 provider 侧大声失败,加载期校验。
- worker = 普通持久化会话(continuable 子代理),JSONL/SQLite 后端订阅全部会话自动落盘;描述符 `subagent/descriptor` 持久化,冷恢复自动还原。

### 3.7 测试计划(免 API key,mock provider)

- 模式状态机/互斥/折叠恢复
- 收窄:进入后模型可见工具 = allow 列表(含 code 模式 `presentAs('native')` 场景);退出恢复
- 5 工具:spawn 建子、send 排队、wait 精确配对 turn/end、kill park 语义、list 状态
- 持久化:worker 会话落盘 + 恢复后 listChildren 可见

---

## 4. 不可实现 / 受限部分:原理与困难

### 4.1 完整 omp 式会话树(❌ 需核心改动)

- **原理**:omp 的会话 = append-only 日志但每条记录带 `id/parentId`,`leafId` 为当前位置,分支 = 移动 leaf 指针、从不改写历史;上下文重建走 root→leaf 路径;`/tree` 同文件导航、`/branch` 另开文件、标签/搜索/分支摘要。
- **困难(dsh 为什么不行)**:
  1. dsh 会话是**线性日志**(`SessionEventMap` 按 seq),无 parentId、无 leaf——线性结构装不下"两分支共享前缀";
  2. 模型上下文由 `deriveMessages()` **线性派生**,改路径化 = 动 agent-loop 的消息来源;
  3. 持久化两个后端(JSONL/SQLite)按线性流订阅,树形需新 schema/迁移;
  4. 会话投影(todo/goals/标题)按日志线性折叠,树化全要适配;
  5. 压缩(shadowed 区间/checkpoint)要变成"分支路径内"概念;
  6. UI(树选择器)与 `ctx.sessions.fork`(弱化版分支,复制前缀到子会话)无法覆盖导航场景。
- **结论**:这是独立大项目,动的是 dsh 地基(事件模型 + 派生 + 持久化 + 投影 + 压缩交互)。按插件原则,立项时提醒用户,单独设计评审。审阅树(`dsh-tree-engine`)是其特化先行版,数据模型可复用。

### 4.2 普通消息自动截获为指令(v1.2 增强,⚠️ 有条件)

- **原理**:`agent/pre-step` reject 是唯一插件机制(拦截点比 `agent/request` 早;reject 后不写 step/start、不 append user/message、不发模型请求)。
- **困难**:
  1. reject 后消息**既出 inbox 又不落日志** → 插件必须同步捕获并自持持久化;claim→persist 崩溃窗口丢指令;
  2. driver running 期间 followup **不 latch wake**(reject 提前退出 `hasPending` 复查)→ 辅助调用必须移出轮次、串行队列,期间用户消息会被吞到下次输入;
  3. 每条指令产生 `turn/start`+`turn/end(blocked)` 日志对,`session-stats` 轮次计数失真(观感问题)。
- **v1 决定**:命令式交互(`/compact_edit <指令>`)完全成立;自动截获留 v1.2,验证通过再并入。

### 4.3 assistant 消息的 shake 受限(⚠️)

- **原理**:dsh invariant 要求 `assistant/message` append 必须匹配当前 open step(`requireOpenStep`);压缩期的"同类替换"无法对 assistant 消息执行,只能以 `user/message` 占位替换(角色变 user,与 compaction summary 替换同构)或跳过。
- **影响**:大段 fenced/XML 若在 assistant 消息里,shake 节省量打折;tool result 不受影响(pruner 只需 openTurn)。

### 4.4 "零核心改动"的边界:持久化目录生成文件(⚠️)

- **原理**:`KNOWN_SESSION_EVENT_TYPES`(`packages/core/session/src/known-event-types.ts`)是**生成物**——`gen-persistence-catalog.ts` 扫描全仓 `SessionEventMap` 合并生成,持久化读侧遇到目录外事件类型且未标 `ignorable: true` 会拒绝解读整条日志;CI `verify-persistence-catalog` 强制一致。
- **影响**:in-repo 插件声明 `compact/mode` 必须重跑生成器(改动核心包的**生成数据文件** + docs/persistence-catalog.md)。运行时/逻辑零改动;plan-mode(`plan/mode`)、compaction(`compaction/*`)均在此目录中,先例成立。若要求核心包文件一字不动,则事件需 `ignorable: true` + 插件仓库外置——对 in-repo 插件不现实,建议接受再生成,并在开发时向用户明示。

---

## 5. 开发里程碑

1. **M1 树引擎**:`dsh-tree-engine`(纯 TS 库 + 单测)——零依赖、可独立交付验证。
2. **M2 compact 插件**:`dsh-compact-mode`(引擎 + 模式 + 命令 + 审阅树接线 + 再生成目录 + profile 补丁 + 测试)。
3. **M3 vibe 插件**:`dsh-vibe-mode`(与 M2 并行,独立工作流)。
4. **M4 集成验证**:profiles 组合、`--dump-config`、全量 constraints/typecheck/build。

## 6. 验证方案(全免 API key)

- `pnpm run constraints` / `typecheck` / `build` 全绿。
- 单测见 §2.10 / §3.7(树、模式状态机、命令、收窄、turn 配对、存储生命周期、锁/事件序列)。
- `pnpm dsh --profile web --patch <profile> --dump-config`:验证 compaction-basic/command-compact 被禁用、compact-mode/vibe 行生效。
- `verify-persistence-catalog` 通过(目录再生成后)。

## 7. 变更记录

- **v1.0**(2026-08-17):依据设计 v1.1 + 两份可行性报告,输出详细实现方案(功能点 + omp 对比 + 不可实现项原理)。

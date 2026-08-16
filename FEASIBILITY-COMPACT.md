# 可行性报告:compact 模式(纯插件实现)

> 基线:DeepSeek Harness(dsh)monorepo,本地 clone `C:/Users/Vantage_XLST/Documents/dsh`
> 依据:`DESIGN-SHAKE-REVIEW.md` v1.1 + 实际源码阅读 + `pnpm dsh --profile web --dump-config` 验证
> 结论先行:7 项假设中 5 项 ✅、2 项 ⚠️(条件见下);**无需任何核心逻辑改动**,但有两处需要正视的边界:
> (1) 事件持久化目录是"生成在核心包里的数据文件",新增 in-repo 事件类型必须再生成(plan-mode 同款先例);
> (2) 审阅期指令截获走 `agent/pre-step` reject,消息不落会话日志,插件必须自持指令文本。

---

## 1. 逐项验证结论

| # | 假设 | 结论 | 证据 |
|---|---|---|---|
| 1 | 基础 profile 组合与需替换的行 | ✅ | 见 §2;`--dump-config` 实测 |
| 2 | `ctx.compaction` 替换机制 | ✅(有条件) | 单后端/上下文被 cordis 强制;事务提交顺序硬编码,需自实现"先草稿后应用";见 §3 |
| 3 | 循环暂停 + 消息截获(关键) | ✅(有条件) | pre-step reject 即机制;捕获须同步、辅助调用须放轮次结束后串行;见 §4 |
| 4 | `compact/mode` 纯插件事件 | ⚠️ | 运行时零核心改动(plan-mode 同款);但持久化目录为生成的核心数据文件,必须再生成;见 §5 |
| 5 | 插件注册存储 domain | ✅ | workspace 同款模式;web profile 已挂 storage-json/storage-domain;与日志物理分离;见 §6 |
| 6 | 人类命令 | ✅ | `ctx.commands.register`,不经过模型轮次,结果可见;见 §7 |
| 7 | 辅助 LLM 调用 | ✅ | `summarizeWithLlm` 已导出,`purpose: 'compaction'` 合法,KV 前缀回放有现成实现;见 §8 |

---

## 2. 假设 1:profile 组成与替换行(✅)

`packages/bundle/base/cordis.patch.yml`(base 层,所有 profile 共享)+ `packages/bundle/web-app/cordis.patch.yml`(web 层,按行 id 覆盖/插入)。`pnpm dsh --profile web --dump-config` 实测确认:

| 行 id | 包名 | 层次 | 处置 |
|---|---|---|---|
| `compaction-basic` | `@deepseek-ai/dsh-compaction-basic` | base | **`disabled: true`**(换后端) |
| `command-compact` | `@deepseek-ai/dsh-command-compact` | base | **`disabled: true`**(它注册无参 `/compact`;新插件同名注册会撞名——`commands/src/index.ts` NamedEntries 抛 `command "compact" is already registered`) |
| `token-meter` | `@deepseek-ai/dsh-token-meter` | base | 保留(引擎依赖) |
| `tool-result-pruner` | `@deepseek-ai/dsh-compaction-tool-result-pruner` | base | 保留(shake 第一步) |
| `spill-local` / `spill-policy` | `@deepseek-ai/dsh-spill-local` / `@deepseek-ai/dsh-spill-policy` | base | 保留(shake 占位符存储;policy 行本身是 tools/post-execute 变换器,与压缩期 shake 无关,见 §9) |
| `session-persistence-jsonl` | `@deepseek-ai/dsh-session-persistence-jsonl`(root `dshHomePath('sessions')`) | base | 保留 |
| `storage` / `storage-json` / `storage-domain` | `@deepseek-ai/dsh-storage` / `@deepseek-ai/dsh-storage-json`(root `dshHomePath('storages')`)/ `@deepseek-ai/dsh-storage-domain`(backend `json`) | web-app 插入 | 保留(审阅树存储依赖) |
| — | `@deepseek-ai/dsh-storage-sqlite` | **web profile 未挂载**(实测 dump 无此行) | 设计文档提到的 sqlite 后端默认不可用;domain 走 json 后端,或用 profile 自行插入 sqlite 行 + routes |

补丁机制证据:web-app bundle 对 base 行 `hmr`/`tool-bash` 使用 `- id: …\n  disabled: true` 覆盖,说明"按行 id 禁用/覆盖"是原生语义;用户 profile(第三层)同样可用。

## 3. 假设 2:`ctx.compaction` 替换机制(✅ 有条件)

**Service Definition**(`packages/compaction/compaction/src/index.ts`):
- `abstract class CompactionEngine extends Service`,构造 `super(ctx, 'compaction')`,抽象方法 `compactIfNeeded(agent, trigger: 'pressure'|'context-overflow', signal)`、`compactNow(agent, signal, sourceCommandId?)`、`compactRegion(start, end, agent, signal?)`;文档明确 *"Load one implementation per context as `ctx.compaction`"*。
- 事件:`compaction/start|summary|end`、`compaction/prune`(`types.ts` declare module 扩展 `SessionEventMap`);替换约定:summary 后必须**同步紧邻**一条 `user/message`(surfaceOp `replace`,source 用 `compactCheckpointSource`)。

**(a) 单后端/上下文是否强制:是。** cordis `ctx.provide(name)` 在已提供时抛错("Throws if the name is already provided in this scope",`vendor/cordis/src/reflect.ts`)。同一上下文挂两个引擎 → 第二个 `provide('compaction')` 失败。因此 profile 必须先禁用 `compaction-basic`。

**(b) 子类化 vs 从零实现:推荐从零实现 `CompactionEngine`,复用 compaction-basic 的导出工具。**
- `BasicCompactionEngine` 注册方式:类插件(`static inject = ['llm','tokenMeter','sessions']` + `static Config` + 默认导出;`loader-composition.spec.ts:37-39` 实测 `ctx.plugin(BasicCompactionEngine, config)` 即提供 `ctx.compaction`)。监听器在构造函数 `_registerAutomaticCompaction()` 里注册(`agent/pre-step` 压力 + `agent/request-error` 溢出,`index.ts:97-211`)。
- `summarize()` 是唯一 protected 子类钩子(index.ts:196-216:"Override this sole hook")。
- **锁/事件顺序硬编码在 `compactSurfaceRegion`**(`region.ts:200-292`):`compaction/start` → 快照定价 → `await summarize` → 稳定性校验 → **同步连续** append `compaction/summary` + `user/message`(replace)+ `compaction/end`,中间不 yield。它不接受预计算好的 summary(永远自己调 summarize)——"先草稿、批准后替换"流程无法复用该函数,应用动作必须由插件自己按同一序列 append 四个事件(公开 session API 即可)。
- **子类化的坑**:`resolveConfig` 严格拒绝未知键(`config.ts` `validateKeys` 抛 `BasicCompactionConfig: unknown key`),而新配置(`keepRecentTokens`/`minShakeSavingsRatio`/`promptOnThreshold`/`promptCooldown`/`promptOnHardOverflow`/`reviewTimeoutMs`)必然带进构造函数 → 走 base 构造函数必然抛错;且 `_registerAutomaticCompaction` 是 private。**从零实现更干净**。
- 可复用导出:`summarizeWithLlm`/`frameSummary`/`SummarizationInput`/`SummaryResult`(`compaction-basic/src/summarizer.ts`)、`selectCompactableRange`/`assertNoActiveCompaction`(`region.ts` 导出)、`toolPairingBalancedBefore/After`、`compactCheckpointSource`(`compaction` 根导出)。即使 `compaction-basic` 行被禁用,包仍可作为库依赖(行禁用 ≠ 包卸载)。
- **审阅锁**:进入(命令态,无开轮)→ 可合法写 `compaction/start`(owner `null`,standalone between turns;`compactSurfaceRegion` 对 owner null 要求 `openTurn === null`,`region.ts:245-252`);apply 时写 `compaction/summary`+`user/message` replace+`compaction/end` 闭合,abort 写带 `error` 的 `compaction/end` 闭合。审阅期间未闭合 start 即天然锁,任何并发压缩事务被 `assertCompactionInactive` 拒绝(`region.ts:276-287`)。注意:编号 owner("strictly enclosed by that open turn")不适用于跨轮审阅——**进入审阅只能在命令态(无开轮)**,压力点只提示、不直接进入(设计 v1.1 正是如此)。

## 4. 假设 3:循环暂停 + 消息截获(✅ 有条件,核心问题)

**(a) pre-step 签名**:`agent/pre-step` payload `{ agent, messages: UserMessage[], turn, step, signal }`,waterfall,`next: () => Promise<PreStepDecision>`(`packages/core/agent/src/runtime-types.ts:231`)。`messages` 即本轮已 claim 的用户消息,文本经 `content` 块读取(测试先例 `interception.spec.ts:68-70`)。

**(b) reject 语义**:`{ kind: 'reject' }` → `turnEnds = { kind: 'blocked' }`、`return false`(`agent-loop/src/agent.ts:267-269`)→ **不写 step/start、不 append user/message、不发模型请求**;`turn/end { reason: blocked }` 照常落日志。claim 发生在 waterfall 之前(agent.ts:229),"Claiming already removed the offered messages from the inbox, so rejection does not retain them"(agent README)——**消息既出 inbox 又不落日志**。

**(c) 插件可否实现"active 时每条消息 = 指令 + reject":可以。** 监听器同步读取 `messages` 文本、写入审阅树(待处理节点)、返回 `{ kind: 'reject' }`。条件:
- 捕获必须**同步**完成(先落内存队列,再异步持久化);reject 后消息即消失,崩溃窗口(claim→persist)会丢指令,插件需在持久化失败时把消息重新 `steer` 回 inbox。
- **辅助调用不能 await 在监听器内**:driver running 期间 `send()` 不 latch wake(agent.ts:113-120、172-180;仅 maintenance/aborted latch),且 reject 提前 return 跳过 `hasPending` 复查(agent.ts:324)→ 用户在辅助调用进行中发消息会被"吞"在 inbox 无人唤醒。正确做法:监听器同步捕获+reject,轮次关闭后由插件自持串行队列执行修订调用(每消息一轮、天然串行)。

**(d) 副作用**:每条指令产生 `turn/start`+`turn/end(blocked)` 两个日志事件(log-only,非 surface——**surface 零增长成立**,日志每指令 +2 行);`agent/status` running→idle 抖动;`session-stats` 会多计轮次(观感问题);重复 reject 无累积问题(每条消息开自己的轮次)。`agent/request` 拦截点太晚(step/start 与 user/message 已 append,agent.ts:280-289,surface 会增长);`agent/inbox/*` 仅 emit 无否决权。**结论:pre-step reject 是唯一可行的插件机制;命令式交互(v1)完全成立,消息截获可按 v1.2 增强。**

## 5. 假设 4:`compact/mode` 纯插件事件(⚠️ 有条件)

- 运行时:与 `plan/mode` 完全同款——`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'compact/mode': { active: boolean } } }`(`plan-mode/src/index.ts:38-48`)+ last-wins fold + `session.append`。会话 invariant 对插件自有事件不设约束(invariant.ts default 分支:"Merge-extensible event relations belong to their owning plugin")。**运行时零核心逻辑改动。**
- **条件(唯一硬边界)**:`KNOWN_SESSION_EVENT_TYPES`(`packages/core/session/src/known-event-types.ts`)是**生成物**(`scripts/gen-persistence-catalog.ts` 扫描 `packages/*/*/src/**/*.ts` 里全部 `SessionEventMap` 合并,写出核心包该文件 + `docs/persistence-catalog.md`);持久化**读侧**遇到目录外事件类型且未标 `ignorable: true` 会拒绝解读整条日志(`session-persistence/src/coordinator.ts:1062-1064`;guard 仅在读侧,coordinator.ts:686-690)。`plan/mode`、`compaction/*` 今天都在目录里。**任何 in-repo 插件声明新事件类型都必须重跑生成器**——CI(`verify-persistence-catalog`,doc-sync 一部分)会校验。这是"核心包里被改动的生成数据文件",plan-mode 已开此先例;运行时/逻辑零改动。若坚持核心包文件一字不动,唯一出路是事件带 `ignorable: true` 写入且插件仓库外置——对 in-repo 插件不现实,建议接受再生成。

## 6. 假设 5:插件注册存储 domain(✅)

- API:`ctx.storageDomain.open(defineDomain({ name, version, global?, tables? }))` → `Domain` 句柄(`storage-domain/src/index.ts:98-153`);workspace 先例:`static inject = ['storageDomain', 'sessionPersistence']` + `[Service.init]()` 里 open + `ctx.effect(() => () => domain.close())`(`workspace/src/index.ts:93,119-124`)。
- (a) 注册自有 domain:可,名字唯一(重开抛 `already-open`),`routes` 可按 domain 指定后端。
- (b) 依赖后端行:可——`DomainFacility.open` 按 `routes?.[name] ?? backend` 经 `ctx.storage.backend.get()` 解析,缺失抛 `backend-not-found`;web profile 已挂 `storage-json`(json 后端),**sqlite 未挂**(见 §2)。
- (c) 物理分离:成立——storage-json 每 domain 一个文件 `$DSH_HOME/storages/<name>.json`(`storage-json/src/index.ts:69`),会话日志在 `$DSH_HOME/sessions/`,目录级分离。
- 选项 2b(插件自有 JSON 文件):`dsh-personal-memory` 先例(`packages/personal/dsh-personal-memory/src/store.ts` 原子 rename + maxBytes;profile 行 `config: { path: '.dsh-memory.json' }`)——零组合依赖、任意 profile 可跑、按路径物理分离。
- **推荐:domain 路线(拍板点 2a)**——web profile 已具备全部行;获得 zod 校验、版本化、整文件原子写、`domain/changed` 事件与单开守卫,workspace 是现成模板;记录按 sessionId 键控。**前提**:compact-mode 行所在 profile 必须含 storage/storage-json/storage-domain(web 有;headless 没有——但 compact 模式本就是交互态)。若要求插件在无 storage 行的 profile 也可用,退化为插件自有 JSON 文件同样 ✅。

## 7. 假设 6:人类命令(✅)

- `ctx.commands.register({ name, description, input?, handler: ({ agent, rawInput, signal, commandId }) => CommandResult })`(`commands/src/index.ts:33-47`);plan-mode 经 `ctx.inject(['commands'], …)` 注册 `/plan`(plan-mode/src/index.ts:228-283)。
- **不经过模型轮次**:`commands.execute` 直接 append `command/run`→调 handler→`command/done`(均为 log-only,无 turn 包裹),全程不碰 inbox/loop(commands/src/index.ts:297-349);结果 `{ kind, text }` 对 UI 可见(`command/done` 带 text)。`/compact_edit <text>` 的 rawInput 默认记入 `command/run`。
- 命令名正则 `^[a-z][a-z0-9_-]*$`,`_` 合法;同名注册抛错 → 必须禁用 `command-compact`。

## 8. 假设 7:辅助 LLM 调用(✅)

- `summarizeWithLlm(ctx, config, input, agent, signal)` 已导出(`compaction-basic/src/summarizer.ts:121`):`GenerateOptions` 含 `provider/model/messages/system?/tools?/maxTokens/sessionId/purpose: 'compaction'/signal`;`purpose` 联合类型 `'compaction' | 'session-title'`(`llm/src/types.ts:355`),adapter 对 compaction purpose 打 `x-deepseek-harness-compact` 头(`llm-deepseek/tests/adapter.spec.ts:137-141`)。
- 前缀回放:shadowed 区域按 surface 序经 `session.requestHeader()`(system/tools)+ `session.deriveEventMessage(events[seq])` 重建,压缩指令作为**最后一条 user message**——调用是"最近一次路由请求的真前缀",复用 provider KV 缓存(`region.ts buildSummarizationInput:498` + summarizer.ts 指令注释)。
- 审阅修订调用同构:输入 = 当前草稿 + 指令 + 源区域,`purpose: 'compaction'`;apply 时 `compaction/summary` 可携带 `rawOutput`/`llmStreamCall: true`/`usage` 完整溯源(事件类型已支持)。provider/model 路由:配置项 ?? 最近路由 header ?? agent options(summarizer.ts:150-156);窗口大小经 `ctx.llm.resolveModelInfo(provider, model, signal).context`(`compaction-basic/src/index.ts:251`),未配置 contextWindow 时抛 `TargetPressureConfigError`(配置前提,沿用)。

---

## 9. 推荐实施方案(汇总)

1. **包结构**:`dsh-tree-engine` 作为纯 TS 库(无 cordis 行,不提供服务);`dsh-compact-mode` 作为 cordis 插件包,默认导出 `class CompactModeEngine extends CompactionEngine`(`static inject = ['llm','tokenMeter','sessions']`、自有 `static Config`),从 compaction-basic **库依赖**导入 `summarizeWithLlm/frameSummary/selectCompactableRange/assertNoActiveCompaction`。
2. **引擎内部**:复制 `_registerAutomaticCompaction` 的两个监听器思路(pre-step 压力 + request-error 溢出),全部调 `this.compactIfNeeded`(动态派发);`compactIfNeeded` = shake(pruner → fenced/XML 占位 → `tokenMeter.measure` 复测 ≤60%)→ 超阈值发 notice 提示,审阅激活时返回 null;`compactNow` 走审阅状态机(进入/应用/中止);`compactRegion` 审阅激活时抛 `ManualCompactionError('busy')`。
3. **审阅状态机**:`compact/mode` 事件(fold 恢复)+ 进入时写 `compaction/start`(owner null)持锁;每条指令经 pre-step 同步捕获+reject,插件串行队列执行有界辅助调用,节点写审阅树;apply 时插件按 `commitCompactionBody` 相同序列 append `compaction/summary` + `user/message`(replace,`compactCheckpointSource`,sourceEventSeqs)+ `compaction/end`,再 `sessions.flush`。
4. **命令**:`/compact`(进入/退出提示)、`/compact_edit <text>`、`/compact_apply`、`/compact_abort`、`/compact tree|view <n>|jump <n>`(diff 可选),经 `ctx.inject(['commands'])` 注册;提示经 notice user message(`agent.inject`,plan-mode narration 先例,带冷却)。
5. **profile 补丁**(第三层,如 `profiles/compact/cordis.patch.yml`):

```yaml
# 禁用被替换的 base 行
- id: compaction-basic
  disabled: true
- id: command-compact
  disabled: true

- insert:
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
```

(审阅树 domain 行可省略——storage-domain 已挂 web;若走插件自有 JSON 文件则连 storage 依赖都不需要。)

## 10. 源码提示的设计调整

1. **assistant 消息的 shake 受限**:invariant 要求 `assistant/message` append 必须匹配当前 open step(`session/src/invariant.ts:118-121` requireOpenStep)——任何"同类替换"的 assistant/message replace 都会在校验时失败。**大段 fenced/XML 若在 assistant 消息里,只能以 `user/message` 占位替换(角色变为 user,与 compaction summary 替换同构,compaction/prune 定价先行),或 v1 跳过 assistant shake**;user 消息可同类替换(`user/message` 无约束,invariant.ts:145-146),tool result 交给 pruner(其 replace 只需 openTurn)。
2. **指令截获细节**:同步捕获 + reject;辅助调用放轮次关闭后、插件自持串行队列(见 §4c);指令文本不落会话日志,崩溃窗口需插件容错(重投或告警)。
3. **锁的写点**:审阅进入必须在命令态(无开轮)写 owner-null 的 `compaction/start`;压力点只能提示不能直接进入(否则编号 owner 违反"严格 enclosed"契约)。apply 前对"summary 是否仍小于被遮蔽内容"用 `tokenMeter.estimateMessage` 复验(compaction-basic 的 shrink 检查逻辑)。
4. **提示机制**:60%/硬溢出提示用 notice user message(`form: 'notice'`),非阻塞、带冷却;notice 会随下一次 step 进入模型请求上下文(plan-mode narration 同款取舍),v1 接受。
5. **spill-policy 行 ≠ shake**:它是 tools/post-execute 的未来结果变换器;shake 期的 fenced/XML 占位需插件自实现(`ctx.spillStore.saveText`,`SpillSource.callId` 可用 `CallId()` 工厂自铸,`llm/src/brand.ts:38`)。
6. **持久化目录再生成**:新增 `compact/mode` 声明后运行 `pnpm run gen-persistence-catalog`(改动 `packages/core/session/src/known-event-types.ts` + `docs/persistence-catalog.md`,纯生成数据),否则 `verify-persistence-catalog` CI 失败。

---

## 11. 前三大风险

1. **消息截获的可靠性边界(最高)**:pre-step reject 后指令消息既出 inbox 又不落日志——插件必须同步捕获并持久化到审阅树;且 driver running 期间 followup 不 latch wake(reject 又提前退出 `hasPending` 复查),辅助调用若 await 在监听器内,期间的用户消息会被吞到下次输入。缓解:同步捕获 + reject、辅助调用移出轮次、串行队列;残留窗口为同步区间,可忽略。
2. **持久化目录(核心包生成文件)**:in-repo 声明 `compact/mode` 必然触发 `known-event-types.ts`/`docs/persistence-catalog.md` 再生成(CI 强制),否则读侧拒绝日志。这是"零核心改动"约束下唯一触碰核心包的改动,属生成数据、plan-mode 已开先例,但需向用户明示并纳入变更范围。
3. **assistant 消息 shake 受限 + 审阅期日志噪音**:invariant 禁止同类 assistant/message 表面替换(需 open step),大段 assistant 内容只能 user 占位替换或跳过,直接削弱 shake 节省量;审阅期每条指令产生 `turn/start`+`turn/end(blocked)` 日志对与 session-stats 轮次计数失真(观感问题,非功能问题)。

---

*证据均来自实际源码(文件:行)与 `pnpm dsh --profile web --dump-config` 实测输出;未做任何构建/写操作。*

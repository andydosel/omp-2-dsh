# 实施方案(详细):dsh 0.2.0-rc.2 迁移 + 随行协调者套件

> 状态:**已审批**(按 §7 决策实施)
> 基线:`@deepseek-ai/dsh-*@0.1.1-rc.2` + `cordis@4.0.1`,7 插件
> 目标:`@deepseek-ai/*@0.2.0-rc.2` + `cordis@~4.0.4`
> 依据:`RESEARCH-LATEST-UPSTREAM-COMPAT.md`(破坏性变更 + 逐处调用点)、`VERIFY-4-APIS-0.2.0-rc.2.md`、`DESIGN-COORDINATOR-SUITE-V1.0.md`(v1.6)

---

## 1. 总览(大纲)

三方面合一,分四步:

```
① 升级:dsh 0.1.1-rc.2 → 0.2.0-rc.2(依赖装配基线,唯一前置)
        ↓
② 迁移:现有 5 插件逐处适配 ──┐
                              ├─ 并行(两路不冲突,同时写文件)
③ 新需求:建 6 新插件 ─────────┘
        ↓
④ 收尾:README/release + 设计文档 0.2.0-rc.2 修正(已完成 v1.6)
```

- **vibe-mode 抽核心后删除**;`dsh-tree-engine` 不动。
- **新需求核心机制不受破坏性变更影响**(签名逐字节未变,见 §2.8)。

---

## 2. 升级:dsh 0.1.1-rc.2 → 0.2.0-rc.2(详细步骤)

### 2.1 本地 dsh clone 切 tag

```bash
git -C C:/Users/Vantage_XLST/Documents/dsh fetch --tags
git -C C:/Users/Vantage_XLST/Documents/dsh checkout dsh-v0.2.0-rc.2
```

### 2.2 依赖装配(全仓库 37 个 `@deepseek-ai/*`)

- 所有 `@deepseek-ai/*`:`^0.1.1-rc.2` → `^0.2.0-rc.2`。
- `@deepseek-ai/cordis`:`4.0.1` → `~4.0.4`(已是 peer,保持 peer)。
- `schemastery`:`^3.18.1` → `~3.18.4`。

### 2.3 `dsh-*` 从 dependencies 迁 peerDependencies(硬要求,易漏)

- 36 个 `dsh-*` 从 `dependencies` → `peerDependencies`,值写**精确** `0.2.0-rc.2`;`devDependencies` 保留同名供本地 typecheck/build。
- 原因:新版解析器 `readPeerNames()` 只把 **peer 声明的名字**路由到宿主运行时包;写 dependencies 会命中本地旧 `node_modules`(0.1.1-rc.2),导致静默双实例。
- `cordis` 不在兼容门禁过滤内(门禁只过滤 `@deepseek-ai/dsh`/`dsh-*`)。

### 2.4 依赖增删

| 动作 | 包 | 用途 |
|---|---|---|
| 新增 | `@deepseek-ai/dsh-util-values@0.2.0-rc.2` | `deepFreeze`(compact-mode)、`JsonValue`(tool-read-write)迁入 |
| 改名 | `dsh-agent-presets` → `dsh-agent-preset-registry` | advisor 的 `package.json`;代码 `agentPresets`/`composeFrom` 签名不变 |
| 删除 | `dsh-client-runtime` | 拆为 `dsh-client-store` / `dsh-client-ui-slots` / `dsh-client-ui-renderer` / `dsh-api-session-controller/client` / `dsh-client-ui-settings` |

### 2.5 声明式字段

每个插件补:
- `"engines": { "node": ">=24", "dsh": "^0.2.0-rc.2" }`
- `"dsh": { "manifestVersion": 1 }`(0.2.0 不强制,为 0.2.1 铺路)

### 2.6 客户端 externals 同步(`tsdown.client.ts`)

- 删 `RUNTIME_STORE_EXEMPTION`(`@deepseek-ai/dsh-client-runtime/client`)。
- baseline 加 `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-dockkit`(依 `dsh-v0.2.0-rc.2:packages/client/web/src/platform.ts:8,17`)。
- `dsh.client.inject` 里的失效包名删除/替换;`inject` 在新版仅信息性,不影响激活顺序。

### 2.7 组合确认(profile)

- `token-meter` 与 `session-projections` **必须同时挂载**(token-meter 现 `static inject=['sessionProjections']`;`ctx.goals` 也硬依赖它)。

### 2.8 验收

- `pnpm install` 后 `node_modules/@deepseek-ai/dsh-session/package.json` 版本 = `0.2.0-rc.2`。
- `pnpm -r run typecheck` 报错集合收敛为 §3 所列(不应出现 "Cannot find module" 之外的意外)。

---

## 3. 迁移:现有插件逐处适配(详细)

> 调用点行号取自 `RESEARCH-LATEST-UPSTREAM-COMPAT.md` §3。`BREAK`=编译失败必改;`MECH`=机械改;`REN`=改名。

### 3.1 破坏性变更速查(旧 → 新 → 改法)

| # | 旧 | 新 | 改法 |
|---|---|---|---|
| S1 | `Session.events` | `seq` / `eventAt(seq)` / `snapshotEvents()` | `.length`→`seq`;`[i]`→`eventAt(SessionSeq(i))`(处理 undefined);遍历→`snapshotEvents()` |
| S2 | `number` seq | `SessionSeq`/`SessionLogOffset` | 边界处 `SessionSeq(...)` 包一次,全程复用,不回赋 number |
| S6 | V0 + `seedLength` | V4 + `isSeeded`(seedLength 抛错) | 测试脚手架 header 改 `isSeeded`;`stream:[]` |
| S7 | `assistant/message` 无 stream | 必填 `stream: AssistantStreamRecord[]` | append 补 `stream:[]` |
| A1/A2 | `agent/session-start` | `agent/created`(serial+await) | 3 处迁移;advisor 已有 handler 需合并去重 |
| A3 | `Context.agent` | `setup(agentCtx, agent)` 显式传参 | `agentCtx.agent` → 参数 `agent` |
| A4 | `Inbox.hasPending/claim` | 本地 helper | `agent.inbox.nextTurn.length>0 || nextStep.length>0` |
| A5 | `subagents.followup` | `subagents.sendMessage(sender,target,content,{signal})` | 删 `source` |
| A6 | `listChildren` 有 `kind` | 行结构无 `kind` | 删 `.filter(e=>e.kind==='child')` |
| M1 | 通配 `plugin` kind | 各包 `declare module` 自有 kind | 改 11 构造 + 3 读取 |
| M2/M3 | `tool-result` 块 | `role:'tool'` 消息 | 删 `case 'tool-result'`,改按 `message.role==='tool'` 取 content |
| M5 | `CallId` | `ToolCallId` | 改名 |
| C1/C2 | compaction 序号/checkpoint | 品牌化 / `compactCheckpointSource` | 品牌化 + 旧日志兼容(`kind:'plugin'` 继续识别) |
| C5 | `TokenMeasurement` | +`heuristicTokens` 必填 | 测试替身补字段 |
| P1 | `installSettingsSection` | Config `.volatile()` 字段 | 删注册,改 schemastery volatile |
| W1/W3/W4 | `dsh-client-runtime`/`settingsScope`/`sessions.open` | `cordis Context`/`configForms`/`retain` | 见 3.5 |
| S8 | `deepFreeze`/`JsonValue` | `dsh-util-values` | 迁 import |

### 3.2 `dsh-compact-mode`(最多,9 处 Session.events + 品牌化 + message kind)

1. **Session.events 9 处**:`engine.ts:302`、`mode.ts:117`、`reuse.ts:442/501/505`、`review.ts:141/356`、`shake.ts:138/225`。
   - `reuse.ts:505`/`review.ts:356`/`shake.ts:138`(索引访问)→ `eventAt(SessionSeq(i))`。
   - `reuse.ts:501`(遍历)→ `snapshotEvents()`。
   - 其余传参给只读函数 → `snapshotEvents()`。
2. **seq 品牌化(S2/S3/C1/C3/C4)**:`engine.ts:312-315/333/344-346`、`reuse.ts:346/394/427/449-483/578-580`、`review.ts:160-161/192`、`shake.ts:118/198-201/225`(surface 节点);`engine.ts:342-350`、`reuse.ts:548-581`、`review.ts:63-65/167-180`(CompactionResult);`engine.ts:118-122`、`reuse.ts:455-467`(compactRegion 形参)。
3. **`CallId`→`ToolCallId`**:`shake.ts:25`(import)、`:175`。
4. **`agent/session-start`→`agent/created`**:`mode.ts:83-85`(初始化 `lastNarrated`)。
5. **message kind(M1)**:6 处构造 `engine.ts:263`、`mode.ts:155`、`reuse.ts:209/275/279`、`shake.ts:198` → `declare module` 声明 `'dsh-compact-mode'` kind,改用 `{kind:'dsh-compact-mode', form, summary}`。
6. **tool-result(M2)**:`review.ts:91`、`shake.ts:94` → 按 `role==='tool'` 消息取 content 文本。
7. **checkpoint(C2)**:手写 `{kind:'plugin',plugin:'compact'}` → `compactCheckpointSource(...)` + 识别走 `isCompactCheckpointSource`;**历史日志 `kind:'plugin'` 继续识别**。
8. **deepFreeze(S8)**:`config.ts:11`、`reuse.ts:28/596` → `@deepseek-ai/dsh-util-values`。
9. **TokenMeasurement(C5)**:`tests/helpers.ts:44-60` 补 `heuristicTokens`。

### 3.3 `dsh-advisor`(评审者;迁移 + 抽共享构造)

1. **Session.events 3 处**:`advisor.ts:431`、`delta.ts:79/115` → `.length`→`seq`、遍历→`snapshotEvents()`。
2. **`agent/session-start`→`agent/created`**:`advisor.ts:171-173`(`source==='resume'` 判定);与已有 `advisor.ts:167` 的 `agent/created` handler **合并去重**(幂等)。
3. **`Context.agent`→setup 参数(A3)**:`advisor.ts:552-554`(setup 签名)、`:591/616`(替换 `agentCtx.agent` → 参数 `agent`)。
4. **`Inbox.hasPending`(A4)**:`advisor.ts:334`、`delivery.ts:256` → 本地 helper。
5. **message kind(M1)**:2 构造 `advisor.ts:441`/`delivery.ts:57` + 2 读取 `advisor.ts:747`/`delta.ts:170` → 自有 kind `'dsh-advisor'`。
6. **tool-result(M2/M3)**:`delta.ts:156-162` → 按 `message.role==='tool'` 渲染(`message.content` 直接取,`message.toolCallId`/`isError` 生成包裹文本,保持输出格式不变)。
7. **presets 改名(A8)**:`package.json:43` `dsh-agent-presets`→`dsh-agent-preset-registry`(代码 `agentPresets.composeFrom` 不改)。
8. **V4 脚手架(S6/S7)**:`tests/advisor.spec.ts:15/55-59/568-572/579-584` header 改 `isSeeded`;`tests/helpers.ts:199` 补 `stream:[]`;`tests/helpers.ts:8/205/223` `CallId`→`ToolCallId`。
9. **抽取共享评审者构造**:把 `composeReviewer(agentCtx, agent, spec, watchdog)`(join preset + restrict + advise + 委托策略)抽成**共享 helper**,供新 `dsh-orchestrator` 的一次性干净评审者复用。

### 3.4 `dsh-tool-read-write`

1. **Session.events 3 处**:`read/agent.ts:134/173`、`read/index.ts:484` → `snapshotEvents()`。
2. **message kind(M1)**:2 构造 `inspect-image.ts:195`、`read-image.ts:203` → 自有 kind。
3. **tool 角色渲染(M3)**:`read/agent.ts:101-121` → 按 `role:'tool'` 渲染。
4. **JsonValue(S8)**:`read/index.ts:20/760` → `@deepseek-ai/dsh-util-values`。
5. **测试**:`tests/agent-read.test.ts:17/63/68/78` `CallId`→`ToolCallId`。

### 3.5 `dsh-mode-ui` + `dsh-vibe-mode`(客户端 P1/W1-W4;vibe 抽核心后删)

**mode-ui(迁移 + 加面板投影)**:
1. `client/src/index.ts:16` `ClientContext` → `import type { Context } from '@deepseek-ai/cordis'`;`SessionId` → `@deepseek-ai/dsh-session/types`。
2. `tsdown.client.ts:68` externals 同步(§2.6)。
3. 新增投影单元(任务/问题/org 面板)挂到 mode-ui(或独立 client bundle)。

**vibe-mode(抽取 worker-spawn 核心 → 删除)**:
1. **抽取**:把 `vibe_spawn`/`vibe_send`/`vibe_wait` 背后的 **spawn-in-process provider + WorkerRegistry + `VibeTier=fast/good` 两档 + roster** 抽成新 `dsh-orchestrator` 的内部模块(或共享 util)。这是新 `subtask_parallel` 的底座。
2. **删除 vibe-mode 本体**,连同其未迁移项(`mode.ts:20/130` settings、`mode.ts:309` Session.events、`tools.ts:143/317` followup/listChildren、`tools.ts:55` source.plugin、`workers.ts:521/524`、`client/*`、`mode.ts:260-266` session-start、`mode.ts:368` message kind、`invariant.ts`)。

### 3.6 `dsh-channel-wechat`

1. **invariant(0.2.1 前瞻)**:`src/invariant.ts:18/27/31` `InvariantFailure`/`inject:['invariants']`/`ctx.invariants.register` → 改**普通 throw 断言**(0.2.0 内不变,0.2.1 会移除)。
2. `src/session-map.ts:65` `assistant/chunk` 只按 type 分派读 `event.data.message`,兼容(0.2.0 改 `assistant/attempt`,待实测)。

### 3.7 `dsh-tree-engine` — 不动(零 `@deepseek-ai/*` 依赖)。

---

## 4. 新需求:6 新插件(详细)

> 完整设计见 `DESIGN-COORDINATOR-SUITE-V1.0.md`;此处列每个插件**要建什么 + 关键实现**。工具清单见 §5.10。

### 4.1 `dsh-review-gate`(MVP-1,最先)

- **输入预处理**:监听用户输入边界,识别末尾 `--review`/`--no-review`/`--workers N`,**剥离**后:进入 plan 草稿态 + 本任务标记 `awaiting_approval` + 注入"先方案等你审批"提醒。
- **写路径闸**:`tools/pre-execute` 对 `write`/`edit` 命中"真源码路径"(`protectedPaths`)返回 `{kind:'ask'}` → `ctx.approval`(ask 策略)→ 问题面板"待批方案";`bash` 套 mode 级沙箱(read-only/workspace-write)。
- **批准/驳回**:`exit_plan_mode` 或问题面板批准 → 开闸真源码解锁;驳回 → 返回反馈。
- 0.2.0-rc.2 注意:`ctx.approval` 不变;`ctx.userQuestions.registerProvider()` 已删 → UI 应答走 `user-questions/request` waterfall + `answer()`。

### 4.2 `dsh-question-board`(MVP-2)

- **数据**:durable `question/*` 事件(`QuestionSnapshot`:id/asker/content/options/blocking/status/answer)。
- **模型工具**:`ask_question`(登记收件箱,不打印长文本)。
- **投递**:`blocking`(提问者停、主会话照常,答后 `followup`/`steer` 唤醒)vs `non-blocking`(照常走,随时答)。
- **UI**:Web `ConversationNodeDefinition` + keyed renderer,按 asker 分组、可乱序/一次多答。
- 0.2.0-rc.2 注意:子agent 不能直接 `ctx.userQuestions.ask()`(抛 `DELEGATED_CALLER`),须经父转接。

### 4.3 `dsh-task-board`(MVP-3,独立功能)

- **数据**:durable `task/*` 事件(`TaskSnapshot`:id/revision/subject/status/owner/reviewRound/findings/filteredFindings/inContext)。
- **模型工具**:`task_new/update/close/reopen/list`。
- **工作集注入**:`ctx.systemPrompt.section()` 渲染 `inContext===true` 需求为极短清单(`maxBytes` 有界)。
- **闭环**:监听 `tools/result`,仅明显完成信号(如 test-passed)才 `completed`;手动"关闭/重开"按钮。
- **任务 ≠ todo**:需求级;`todo_write` 是子步骤。

### 4.4 `dsh-rules`

- **提醒型**:`AGENTS.md`/`agent-instructions` + `deployment:persona` 挂载。
- **门禁型**:转成写路径闸/approval 配置(哪些工具、哪些路径)。

### 4.5 `dsh-orchestrator`(评审循环 + subtask_parallel)

- **评审循环 = 定制化 goal**:`ctx.goals` + `goal-round-driver`,由**评审工作子agent(`startContinuable`)**承载(不落秘书/负责人);双跳出(零P0→complete+report;人工决策→`goal.block`→等待→`resume`)。
- **评审者**:`subtask_parallel` 派 N 个一次性干净评审者(复用 3.3 抽取的 `composeReviewer`),只喂代码+方案;负责人过滤误报、判定 P0-P3、累积任务板、count P0。
- **`subtask_parallel`**:显式工具,批量并发派子agent;三个可配闸 `maxDepth`/`maxTotalAgents`/`fanOut`(配置 cordis.yml,调用可覆盖)。
- 0.2.0-rc.2 注意:①`ctx.goals` 硬依赖 `sessionProjections`(组合须挂);②`startContinuable(spec)` 签名未变;③`followup`→`sendMessage`。

### 4.6 `dsh-org` + `dsh-peers`(最难,最后)

- **`dsh-org`**:`ctx.org` 状态(`manager[session]→secretary`、`forbidden[secretary]→Set`、`roles`);`/org on/off` 命令激活角色;负责人 = `ctx.agents.create()`/`resume()`(无父拥有 top-level);会话面板按秘书看,每行"解除+禁止"。
- **`dsh-peers`**:`ctx.peers` 服务 + `peer_send` 工具 + `peer/message` durable 事件 + 自建幂等键(sender+messageId)+ 鉴权。
- 0.2.0-rc.2 注意:①`subagents.followup`→`sendMessage`;②`Session.events`→session-projection + `session/event` 增量;③消息自有 kind;④客户端拆包。

---

## 5. 验证与收尾

- **迁移**:`pnpm -r run typecheck` 归零 + `pnpm -r run test` 全绿 + 全链路 smoke(compact/vibe→删/advisor/wechat/mode-ui)+ 旧 0.1.1-rc.2 日志兼容回归(V4 + checkpoint + assistant-chunk)。
- **新需求**:mock LLM/agent/session 跑通 `--review`→闸→面板→批准 整条、评审循环→零P0→闭合 整条、org 面板解除+禁止 整条。
- **收尾**:README/release 更新。

---

## 6. 风险

- **D2 装配级易漏**:`dsh-*` 不迁 peer 会命中旧副本、静默双实例。
- **M6 静默降级**:消息未知 kind 运行期不报错、只显示/归属异常 → 全链路 smoke 必测。
- **checkpoint 旧日志兼容**:历史 `kind:'plugin'` 需继续识别。
- **客户端"切主视图"等价 API 未找到**(`sessions.open` 删)→ 实现期实测。
- **0.2.1-alpha.1 invariant 移除**:wechat/vibe 改 throw 断言(前瞻)。

---

## 7. 决策(已审批)

1. **vibe-mode**:✅ 抽 worker-spawn 核心后**删除**,不迁移。
2. **时序**:✅ 先升 dsh(§2)→ 之后迁移(§3)与新需求(§4)**并行写文件**。
3. **目标版本**:✅ 锁定 `0.2.0-rc.2`。
4. **文档**:✅ 设计文档已到 v1.6(§12 0.2.0-rc.2 API 对齐 + §5.10 角色工具清单)。

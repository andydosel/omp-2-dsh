# RESEARCH-WEBUI-EXTENSIBILITY：dsh Web UI 树外插件可扩展性调研（模式状态指示器）

> 调研对象：dsh monorepo（`C:/Users/Vantage_XLST/Documents/dsh`，下称 repo）
> 目标：评估我们位于 `dsh-plugin/plugin/` 的树外插件（compact-mode / vibe-mode / advisor / channel-wechat）能在**不改动 monorepo** 的前提下，把「模式状态」显示到 Web UI 的程度。
> 证据一律标注 `文件:行号`；repo 路径相对 monorepo 根，插件路径相对 `dsh-plugin/plugin/`。
> 结论先行：**四种显示方案都不需要改 monorepo**；真正的阻塞点在我们自己的 profile 配置（`file://` 挂载）与插件缺事件两个地方。

---

## 0. 结论速览（5 条核心发现）

1. **会话节点（conversation node）是纯客户端机制，不存在服务端 `ctx.conversationNode.register`。**
   Definition（`ctx.conversationEvents.register(...)`）与 renderer（`conversation.chat.node` keyed slot）全部运行在浏览器端（`packages/client/runtime/src/client/index.ts:169-176`、`packages/client/ui-conversation/README.md:14-15`）。任何 UI 显示方案都必然需要客户端代码随浏览器加载——服务端只能负责把事件写进 session 日志。

2. **客户端渲染是开放注册而非中央 switch，未注册的节点类型有通用 JSON fallback，不会白屏。**
   `ChatNodeSeat` 按 `node.kind` 派发到 `conversation.chat.node` keyed slot，未注册 kind 时渲染 `JsonBlock`（`packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx:47-56`）；renderer 注册表是逐 key 开放注入（`register-node-renderers.ts:15-45`），第三方插件可注册自己的 kind。

3. **树外客户端 bundle 是官方一等机制，`dsh.client` 双面包 + `window.__DSH_BOOT__` 动态图，不需要改 monorepo。**
   host 侧 `ctx.clientModules`（`packages/client/modules/src/index.ts`）增量扫描 loader 条目中声明 `dsh.client: { platform: 'web', ... }` 且 `exports["./client"]` 指向构建产物的包，组合成 `__DSH_BOOT__` 注入 index.html，并以 `/plugins/<id>/client.js` 供浏览器加载。UI 插件（`ui-plan`、`ui-jobs` 等）全部走这条链路，机制对树外包开放。

4. **但有一个硬前提：插件行必须以「包名」从 web profile 目录解析——我们当前用 `file://` 绝对路径挂载，导致 client-modules 永久负缓存，浏览器永远拿不到我们的客户端代码。**
   client-modules 的 `resolveMeta` 用 `createRequire(ctx.baseUrl)`（profile 目录）`require.resolve('<name>/package.json')`，解析失败会写入**永不过期的负缓存**（`packages/client/modules/src/index.ts:55-58,340-375`）。`profile-main/cordis.patch.yml` 里所有插件行都是 `name: 'file:///C:/.../lib/index.js'`——file URL 无法解析为包根 → 永久判定「非 client 包」。这是 dsh-plugin 仓库的配置改动（安装进 `~/.dsh/profiles/web/node_modules` + 行 name 改包名），不是 monorepo 改动。

5. **推荐方案（都不改 monorepo）：**
   - **最小可行**：会话节点状态卡（chat node card）——`compact/mode`、`vibe/mode` 事件已存在，补一个客户端 Definition + 树外客户端 bundle 注册 kind renderer；`advisor`/`wechat` 先补发 whole-value 事件，再同样处理。
   - **完整方案**：host 侧投影单元（`ctx.sessionProjections.register`，与 `plan` 完全同款，`packages/plan/plan-mode/src/index.ts:244-258`）+ 客户端徽章进 `conversation.session.header.utilities`（或 `conversation.input.dock`）槽位，`useProjection` 读取（`ui-plan/PlanModeControl.tsx:19-20` 即此范式）。

---

## 1. 三条与显示相关的数据通路（架构事实）

| 通路 | 机制 | 客户端读法 | 证据 |
|---|---|---|---|
| 全量事件流 | `session/event` mux 帧 + history 分页，把**所有**日志事件（含 log-only）送进客户端 Session 事件窗口 | `useSession(snapshot => ...)`（快照含 chat nodes / locations / projections） | `packages/client/runtime/src/client/sessions/session.ts:468-471`、`contract/session.ts:86-89` |
| 投影推送 | host 侧 `ctx.sessionProjections` 单元纯折叠 → `session/projection` 帧 → 客户端 `ProjectionValueStore`（higher seq wins，客户端零折叠） | `useProjection(key)` | `packages/client/runtime/src/client/sessions/projection-store.ts:1-9`、`manager.ts:696-703` |
| 槽位（seats） | `conversation.session.header.actions/utilities`（list）、`conversation.input.plan/model`（single）、`conversation.input.dock/left/right`、`conversation.composer.dock`（list）——全部开放注入 | 插件客户端 `ctx.slots.inject(...register(...))` | `packages/client/ui-conversation/src/client/apply.ts:198-209,257-263,284-286` |

**log-only 事件对 LLM 不可见 ≠ 对客户端不可见**：`SurfaceEventType` 只有 `user/message`、`assistant/message`、`tool/result` 三种（`packages/core/session/src/surface.ts:16-20`），surface 只决定「模型可见转录」。`compact/mode`、`vibe/mode` 这类 log-only 事件照样进入客户端事件窗口；只是没有匹配的 Definition 时完全惰性（`unknown-surface` fallback 只认 append-surface 事件，`packages/client/ui-conversation/src/client/conversation-nodes/fallback.ts:16-19`），**不会**以 JSON 行污染聊天流。

---

## 2. Q1：会话节点缝——自定义聊天节点的真实形状

### 2.1 没有服务端注册；节点 = 客户端 Definition + 客户端 renderer

repo 全量搜索确认：不存在 `ctx.conversationNode` / `conversation.node` 服务端服务。装配决策文档（`.agents/notes/implemented/architecture/2026-08-09-client-conversation-node-assembly.md`）明确定义：Session 只维护连续事件窗口；「业务 Definition（事件→状态→节点）+ 每会话 View Builder + React renderer」全部在客户端。

- 注册入口：`ctx.conversationEvents.register(definition)`（`packages/client/runtime/src/client/conversation/event-registry.ts:19-58`），`ClientContext` 声明于 `packages/client/runtime/src/client/index.ts:169-176`。
- Definition 契约（`packages/client/runtime/src/client/contract/conversation.ts:171-243`）：

```ts
interface ConversationNodeDefinition<State> {
  kind: string                                   // 全局唯一 kind（也是 keyed slot 的 entryKey）
  target?: 'chat'                                // 声明 view target；与 buildViewNode 成对出现
  match(event: SessionEvent): { id: string; role: 'start' | 'update' } | null
  start(context, match, reader): State            // 唯一 start；reader.previous(kind) 查前驱 Context
  update(context, match): State                   // 按 log seq 升序折叠
  publication?(match): 'none' | 'animation-frame' | 'immediate'
  buildLocationData?(context, scope): ConversationLocationData | null   // step → turn 顺序发布
  buildViewNode?(context): ConversationViewNode | null                  // 产出最终节点（key/anchorSeq/location/visibility/data）
}
```

- 生命周期：`(kind, id)` 唯一 start；update 按事件 seq 升序重放；三种摄入路径（初始 replace / 老页 prepend / 实时 append）共享同一套 Context 不变量；**没有通用 `end()`**——单事件业务（我们的模式事件正是如此）在 `start` 内完成（Inbox 模式：id 用 `event.seq`）。
- 类型接线：业务包通过 declaration merging 扩展 `ChatNodeDataMap`（`@deepseek-ai/dsh-client-ui-conversation/client`）与 `ConversationStepDataMap`（`@deepseek-ai/dsh-client-runtime/client`），纯类型导入，构建期擦除，不产生运行时依赖。
- 官方教程：`docs/cookbook/adding-a-conversation-node.md`（完整示例：`review-job` Definition + `ReviewNodeView` renderer + `apply(ctx)` 注册）。

### 2.2 客户端是否「通用渲染」未知节点类型？

**半通用**：`ChatNodeSeat` 按 kind 派发 keyed slot；该 kind 没有注册 renderer 时渲染通用 JSON 块（label `unknown surface`），有注册则用注册组件——`packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx:47-56`：

```tsx
{renderSlot('conversation.chat.node', routedOwner, {
  entryKey: routedNode.kind,
  hookContext: nodeKey,
  fallback: <JsonBlock label={t('message.unknownSurface', { type: routedNode.kind })} payload={routedNode.data} ... />,
})}
```

结论：**纯服务端事件不够**——节点必须由客户端 Definition 生成；但 Definition 本身很小（match + start + buildViewNode），没有 renderer 也有 JSON 卡兜底，有 renderer 则是精美卡片。内置 renderer 注册是开放注入（`register-node-renderers.ts:15-45` 逐 key `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({...}, View))`），任何客户端插件可以注册任意 kind。

---

## 3. Q2：现有模式指示——plan-mode 与 compaction 的现状

### 3.1 plan-mode：官方「状态徽章」范式 = 投影 + 槽位，不是聊天节点

- `ui-plan`（`packages/client/ui-plan/README.md:5-7`）：**纯浏览器插件**，占 composer 的 `conversation.input.plan` 单座（ui-conversation 声明的命名控制座，`apply.ts:284-286`）。
- 状态来源：host 侧 `plan` 投影单元——`ctx.inject(['sessionProjections'], ...)` + `sessionProjections.register<'plan', PlanUnitState>({ key: 'plan', schema, init, apply, view, stateVersion })`，折叠 `command/run plan`（pending 意向）与 `plan/mode`（提交）事件（`packages/plan/plan-mode/src/index.ts:244-258`）。
- 事件写入：`session.append('plan/mode', { active })` 全量值替换（`plan-mode/src/index.ts:440,456`）。
- 徽章渲染：`PlanChip` 读 `useProjection('plan')`，有效目标为 plan 时渲染 warn 色 "Plan ×"，点击经 `ctx.remote.commands.execute(sessionId, '/plan off')` 退出（`ui-plan/src/client/PlanModeControl.tsx:19-20,57-59`）。有效态 = `pending ? !active : active`（host 折叠值，非客户端乐观）。
- **要点**：客户端读「模式状态」的标准姿势是 `useProjection`（host 计算、客户端零折叠、回放/多标签一致），渲染位置是**槽位组件**而非聊天流。

### 3.2 compaction：只有聊天节点，没有 header 徽章

`compaction` / `manual-compaction` 是内建聊天节点 kind（Definition 在 `ui-conversation/src/client/conversation-nodes/compaction.ts:31-38`、`command.ts:176-179`，renderer 在 `register-node-renderers.ts:32-33`）。会话页头（`conversation.session.header.actions/utilities`）目前由 ui-subagent（order 10）、ui-jobs（order 20）、ui-agent-preset（order -10）等占用，**没有**任何模式/压缩状态徽章。

### 3.3 客户端读会话事件渲染状态徽章的位置

- 徽章组件挂在任意 session 作用域 list 槽位（如 `conversation.session.header.utilities`，`ui-conversation/src/client/skeleton/ConversationSession.tsx:102-108` 渲染该列表）。
- 数据面两条路：`useProjection(key)`（host 折叠，推荐，见 3.1）或 `useSession`（读快照；但快照不含原始事件，需客户端 Definition/投影先行折叠）。
- 事件订阅在客户端 `Session.acceptLiveEvent`（`session.ts:468-471`）——**只要我们发的事件进了日志，客户端就收得到**；显示与否只取决于我们有没有注册 Definition / 投影单元。

---

## 4. Q3：树外客户端 bundle——能否不改 monorepo 带 UI 代码

### 4.1 机制完整可用（官方设计）

**host 侧（node half）** `packages/client/modules/src/index.ts`：
- `ClientModuleRegistry` 扫描 `ctx.loader.entries()`（**全部** loader 条目，含 profile patch 层 `insert` 的行），对每个解析出 `package.json` 且声明 `dsh.client.platform === 'web'` 的包，读取 `exports["./client"]`（`resolveMeta`，index.ts:340-375），组合 `window.__DSH_BOOT__` 图（`graphRow`），注册 `/plugins/<id>/client.js` + `.map` 路由（`serveBundle`），并在 index 渲染时注入 boot manifest（`injectBootManifest`）。
- 包声明契约（package.json）：

```jsonc
{
  "exports": { "./client": "./lib/client.js" },   // 或 { "default": "./lib/client.js" }
  "dsh": { "client": { "platform": "web", "inject": ["conversationEvents", "slots", ...] } }
}
```

**浏览器侧（client half）** `packages/client/modules/src/client/manifest.ts`：
- `__DSH_BOOT__` 解析为模块表 + 插件行；entry id = 包名；`inject` 是权威依赖边（fiber 注入等待）。
- bundle 产物契约：CJS closure-factory，首行调用 `window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })`（`ClientPluginHandoff`，manifest.ts:118-128）；module 体副作用在 factory **物化时**才执行（惰性 CJS）；`require` 只解析平台 seed / 已注册 factory / 图内行。

**构建预设（我们复制即可，MIT）** `packages/client/tsdown.client.ts`：
- `clientConfig`：`format: 'cjs'`、`platform: 'browser'`、`entryFileNames: 'client.js'`、banner/footer 即上述 `__ModuleLoader__.load` 包裹、sourcemap 重映射到仓库源码路径。
- 外置表 `CLIENT_EXTERNALS = PLATFORM_MODULES + '@deepseek-ai/dsh-client-runtime/client'`；`PLATFORM_MODULES` = react 全家桶 + `@deepseek-ai/cordis` + `ui-slots`/`web-react`/`ui-primitives`/`ui-attachment`/`schema-form`（`packages/client/web/src/platform.ts`）。
- **纯度门**：跨插件 value import 是构建错误（`noExternal` + purity plugin）——协作必须走 cordis 服务；类型导入会被擦除，不受限。

**开发热更**：`client-hmr`（web-app patch 恒定挂载）stat-poll **图内全部** bundle 路径（`packages/client/hmr/src/index.ts:130-149` syncWatches + onGraphChanged），重建 `lib/client.js` 后经 `/plugins/events` SSE 触发 `invalidate → prefetch → refresh` 全链路（`hmr/src/client/index.ts:16-33`）。树外 bundle 同样被 watch——改完客户端代码重建即可热更，无需重启。

### 4.2 硬前提：包必须能按「包名」从 profile 目录解析

- 解析锚点：`ctx.baseUrl` = **profile 目录**（`packages/boot/app-boot/src/profile.ts:13-14`；`modules` 构造器注释：「the config-tree's baseUrl … whose package declares every composed plugin as a dependency」）。
- 树外插件进 profile 的官方路径：`dsh plugin --profile web add <path|tarball|git>` → 在 `~/.dsh/profiles/web/` 下跑 pnpm（`apps/cli/src/plugin.ts` runPlugin）→ 包落在 profile 的 `node_modules`（hoisted linker，`profile.ts` initProfile 写入的 pnpm-workspace.yaml；缺的 peer 由 `healProfilesModuleFallback` 的 `~/.dsh/profiles/node_modules` 扁平 fallback 补上）。
- **行 name 必须是包名**（如 `@dsh-plugin/dsh-compact-mode`），不是 file URL：`resolveMeta` 对解析失败的条目写入永不过期负缓存（index.ts:55-58）——当前 `profile-main/cordis.patch.yml` 的 `name: 'file:///C:/.../lib/index.js'` 全部命中该负缓存，等于向浏览器宣告「这些插件没有客户端半」。

### 4.3 精确的 core-change boundary

| 要做的事 | 需不需要改 monorepo | 要改谁 |
|---|---|---|
| 客户端 Definition + 聊天节点 renderer（方案 a） | **不需要** | dsh-plugin 内：插件包加 `dsh.client` 声明 + `exports["./client"]` + 客户端构建脚本（复制 tsdown 预设）；profile 配置：行 name 改包名 + `dsh plugin --profile web add` 安装 |
| 投影单元 + header/composer 徽章（方案 b） | **不需要** | 同上 + 插件 host 半加 `ctx.sessionProjections.register`（plan 同款） |
| 插件补发 whole-value 事件（advisor/wechat 前置） | **不需要** | dsh-plugin 内插件源码（`session.append(...)`，plan-mode 模式） |
| 命令输出（方案 d） | **不需要** | 无（`/advisor status` 已注册） |
| 新增「专用单座」（如再造一个 `conversation.input.plan`） | **需要**（`packages/client/ui-conversation/src/client/apply.ts` 声明 children） | 不必要——现有开放 list 槽位足够 |
| 把我们的包写进 web-app 浏览器名册（`packages/bundle/web-app/cordis.patch.yml` 的 insert 列表） | **需要** | 不必要——client-modules 扫描的是**全部** loader 条目，profile patch 插入的行同样被扫 |

即：**monorepo 零改动可达全部四种方案**；唯一会被视为「改动」的是 dsh-plugin 仓库自身的配置与包结构（这是我们的地盘）。

---

## 5. Q4：显示方案评估与推荐

### 5.1 方案对比

| 方案 | 客户端代码 | host 改动 | 现状阻碍 | 效果 | 成本 |
|---|---|---|---|---|---|
| **(a) 会话节点状态卡**（chat node：模式切换事件→聊天流里一张状态卡） | 需要（Definition + 可选 renderer；无 renderer 时通用 JSON 卡兜底） | 无（事件已有；advisor/wechat 需先补事件） | 无，但需先完成 4.2 的包名化安装 | 状态进入聊天流，随历史回放、可分享；不占 header | 中（一个 Definition + 一个卡片组件 + 构建链） |
| **(b) header / composer 徽章**（投影 + 槽位，plan 同款） | 需要（`useProjection` 徽章组件） | 需要（`ctx.sessionProjections.register` 单元，纯折叠） | 同上 + advisor/wechat 补事件 | 常驻状态指示，一眼可见，多标签一致；plan 徽章已证明 UX | 中高（投影单元 + schema + 徽章组件） |
| **(c) 会话标题/副标题 hack** | — | — | session-title 是内置 seam（`ctx.sessionTitle`），无副标题 API；第三方覆盖会被 title 刷新/重命名覆盖 | 不可靠，污染用户数据 | 高（维护）→ **不推荐** |
| **(d) 命令输出**（`/advisor status`、`/compact status` 风格） | 无 | 无 | 无——`/advisor [on\|off\|status]` 已注册（`dsh-advisor/src/commands.ts:32-33,42-52`），命令执行本身即产生 `command/run`/`command/done` → 客户端 `command` 节点已渲染输出文本 | 立即可用，零 UI 依赖；但无持续状态指示（模式在输出后不可见） | 零 |

### 5.2 推荐路线

**最小可行（本周可落地）＝ (a) 会话节点状态卡 + (d) 兜底：**

1. 插件包化安装（4.2）：`dsh plugin --profile web add` 四个插件（或至少 compact/vibe），`profile-main/cordis.patch.yml` 行 `name` 改为包名；包内加 `dsh.client` 声明 + `exports["./client"]` + 客户端构建脚本（复制 `packages/client/tsdown.client.ts` 的 `clientConfig` 参数：banner/footer/external/entryFileNames）。
2. 新建一个客户端包（如 `@dsh-plugin/dsh-mode-ui`，或并入各插件）：
   - 注册 4 个 Definition（kind 建议）：
     - `compact-mode-status` ← `compact/mode {active}`（事件已存在：`dsh-compact-mode/src/mode.ts:163,179`）
     - `vibe-mode-status` ← `vibe/mode {active}`（事件已存在：`dsh-vibe-mode/src/mode.ts:230,265`）
     - `advisor-status` ← 新增 `advisor/status {enabled, reviewers}`（whole-value；advisor 在启停/审阅者集合变化处 `session.append`）
     - `wechat-channel-status` ← 新增 `wechat/channel {connected, account?}`（whole-value；channel 状态机变化处 `session.append`）
   - 每个 Definition 用「单事件瞬时 Context」（id = `event.seq`，Inbox 模式），`buildViewNode` 产出 `{ kind, key, target: 'chat', anchorSeq: event.seq, location, visibility: 'visible', data }`；renderer 注册到 `conversation.chat.node` 对应 key（小卡片：模式名 + 开/关 + 时间）。**未注册 renderer 也能出 JSON 卡，先跑通再加样式。**
   - 类型接线：`ChatNodeDataMap` / `ConversationStepDataMap` declaration merging；事件类型在插件 `types.ts` 的 `SessionEventMap` augmentation（compact/vibe 已做）。
3. 事件契约补齐：`dsh-advisor`、`dsh-channel-wechat` 目前**不发任何 session 事件**（全仓 grep 无 `session.append`）——状态只在进程内/命令输出里。这是它们进 (a)/(b) 方案的唯一前置，属插件自身改动。

**完整方案（后续迭代）＝ (b)：** 各插件 host 半加 `ctx.inject(['sessionProjections'], ...)` 注册 `compactMode` / `vibeMode` / `advisorStatus` / `wechatChannel` 投影单元（照抄 `plan-mode/src/index.ts:244-258` 的 `key/schema/init/apply/view/stateVersion` 五件套），客户端徽章组件挂 `conversation.session.header.utilities`（右缘，不动 actions 顺序）或 `conversation.input.dock`，`useProjection` 读取；点击可 `ctx.remote.commands.execute(sessionId, '/compact off')` 退出（plan 徽章同款交互）。

### 5.3 成本/收益总表

| 项 | (a) 节点卡 | (b) 徽章 | (c) 标题 hack | (d) 命令 |
|---|---|---|---|---|
| monorepo 改动 | 0 | 0 | 0 | 0 |
| 插件改动 | 中（客户端包 + 构建链；advisor/wechat 补事件） | 高（同 (a) + 投影单元） | 低但无效 | 零 |
| 用户可见性 | 聊天流内卡片（历史回放） | 常驻 header/composer 徽章 | 不稳定 | 仅命令时 |
| 多标签一致性 | 依赖客户端折叠（回放保证一致） | host 折叠（最强） | — | 命令即时 |
| 交互（一键退出） | 可加（renderer 内 remote.commands） | 可加（plan 同款） | — | 手动命令 |
| 维护面 | 每插件一个 Definition+卡 | 每插件一个单元+徽章 | 对抗内置 title | 无 |

---

## 6. 风险与注意点

1. **负缓存**：client-modules 对「解析失败/无 `dsh.client`」的包缓存永不过期，插件集变化要重启（index.ts:55-58 注释）。包名化 + 安装必须发生在启动前；中途改名/加声明需重启。
2. **client bundle 必须在启动时已构建**：缺失时报 `MissingClientBundleError`（「run `pnpm run build` before launch」，index.ts:36-49,86-91）——我们的客户端构建要进 profile/启动脚本（`profile-main/run.ps1` 类似的 build 前置）。
3. **纯度门**：客户端代码只能 import 平台模块 / 内联安全 wire 层；跨插件共享必须走 cordis 服务（type-only 导入安全）。
4. **类型出口**：客户端 TS 程序经包名解析类型（`@dsh-plugin/xxx/client` / `/types`）——包内必须带 `.d.ts`（tsc 产出 `lib/types`）。
5. **`session/event` 帧仅对已订阅/已打开会话生效**；徽章是 session 作用域槽位，天然绑定当前会话，无需额外处理。
6. **web 的 `hmr`（模块级热重载）行被禁用**（`packages/bundle/web-app/cordis.patch.yml`：「TODO: Re-enable shared HMR for Web」），但 `client-hmr` 的 bundle stat-poll 链独立工作（4.1），客户端开发热更不受影响；host 侧改动（投影单元）仍要重启。

---

## 附：证据索引（file:line）

| 主题 | 位置 |
|---|---|
| Definition 契约 | `packages/client/runtime/src/client/contract/conversation.ts:171-243` |
| 客户端注册 API | `packages/client/runtime/src/client/conversation/event-registry.ts:19-58`；`runtime/src/client/index.ts:169-176` |
| 官方教程 | `docs/cookbook/adding-a-conversation-node.md`（§2 apply 示例） |
| keyed slot + JSON fallback | `packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx:47-56` |
| renderer 开放注册 | `packages/client/ui-conversation/src/client/chat/register-node-renderers.ts:15-45` |
| header/输入槽位声明 | `packages/client/ui-conversation/src/client/apply.ts:198-209,257-263,284-286`；`skeleton/ConversationSession.tsx:102-108` |
| plan 徽章范式 | `packages/client/ui-plan/README.md:5-7`；`src/client/PlanModeControl.tsx:19-20,57-59` |
| plan 投影单元 | `packages/plan/plan-mode/src/index.ts:244-258`（register）、`:440,456`（append plan/mode） |
| 投影推送/读取 | `packages/client/runtime/src/client/sessions/projection-store.ts:1-9`；`sessions/manager.ts:696-703` |
| 事件流进客户端 | `packages/client/runtime/src/client/sessions/session.ts:468-471` |
| surface 门 | `packages/core/session/src/surface.ts:16-20`；fallback Definition `ui-conversation/src/client/conversation-nodes/fallback.ts:16-19` |
| client-modules host 半 | `packages/client/modules/src/index.ts`（负缓存 :55-58；resolveMeta :340-375；serveBundle） |
| client-modules 浏览器契约 | `packages/client/modules/src/client/manifest.ts`（WebBootEntry / ClientPluginHandoff :118-128） |
| 客户端构建预设/外置表/纯度门 | `packages/client/tsdown.client.ts`（clientConfig）；`packages/client/web/src/platform.ts` |
| profile 机制/包解析 | `packages/boot/app-boot/src/profile.ts:13-14,38-40,74-92,152-189`；`apps/cli/src/plugin.ts` |
| 客户端热更 | `packages/client/hmr/src/index.ts:130-149`；`hmr/src/client/index.ts:16-33` |
| web 浏览器名册（写死列表） | `packages/bundle/web-app/cordis.patch.yml`（`- id: modules` 起 browser roster 段） |
| 我们的事件 | `dsh-compact-mode/src/mode.ts:163,179`；`dsh-vibe-mode/src/mode.ts:230,265` |
| 我们缺事件 | `dsh-advisor/src/commands.ts:32-33,42-52`（仅命令）；`dsh-channel-wechat/src/*`（无 session 事件） |
| 我们当前挂载方式（file:// 阻塞点） | `profile-main/cordis.patch.yml`（全部 `name: 'file:///...'` 行） |

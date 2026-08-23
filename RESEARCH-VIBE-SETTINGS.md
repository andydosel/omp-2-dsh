# RESEARCH: DIRECTOR 指令的运行时编辑设置页（vibe-mode × dsh settings seam）

> 目标：让用户在 Web UI 的「设置」页里编辑 vibe-mode 的 DIRECTOR 指令文本，运行时生效、持久化、按请求解析，无需改文件、无需重启。
> 证据路径约定：`dsh/…` = `C:/Users/Vantage_XLST/Documents/dsh`，`plugin/…` = `C:/Users/Vantage_XLST/Documents/dsh-plugin/plugin`。行号均以 2026-08-23 工作区为准。

---

## 1. 宿主 settings seam：声明 / 读取 / 通知

设置能力包是 `dsh/packages/settings/settings/`（npm 名 `@deepseek-ai/dsh-settings`，README 明确标注「Product — stable API」，`dsh/packages/README.md:47`）。文件型 provider 是 `dsh/packages/settings/settings-file/`（`@deepseek-ai/dsh-settings-file`），挂载在 base bundle 中（`dsh/packages/bundle/base/cordis.patch.yml:78-79`），即 web profile 一定存在 `ctx.settings`。

### 1.1 声明一个 namespace

- `settingsNamespace('dsh-vibe-mode')` —— 品牌化 namespace 字符串，要求小写 kebab-case（`dsh/packages/settings/settings/src/index.ts:26-31`，正则 `^[a-z][a-z0-9-]*$`）。
- 注册：`ctx.settings.register(ns, schema, options)`（`index.ts:435-475`）→ 返回 `SettingsScope<T>`。`options` 支持 `base`（组合层默认值）、`applies: 'live' | 'restart'`（默认 `live`）、`validate`（跨字段约束，`index.ts:60-90`）。
- **推荐的规范接线**：`installSettingsSection(ctx, ns, schema, entry, hooks)`（`index.ts:863-899`）—— 它会 `ctx.inject(['settings'], …)`，在 settings 服务存在时用组合 entry 作 `base` 注册 namespace，把 source 指针切到 live scope；settings 服务消失（dispose/provider 重载）时自动回退到组合 entry。这是 llm-deepseek 用的同一入口。

### 1.2 读取当前值（按请求解析）

- `SettingsScope.get(): T`（`index.ts:104-105`）—— 解析顺序：**schema 默认值 → 注册时 `base`（= 组合配置）→ 用户层（settings.yaml 的 section）**（模块头注释 `index.ts:1-6`，resolve 实现 `index.ts:734-745`）。
- 服务级 `ctx.settings.get(ns)`（`index.ts:519-521`）读注册过的 namespace 解析值。
- `installSettingsSection` 的 `hooks.setSource(current: () => T)`（`index.ts:829-845`）让消费者持有一个指向「当前权威值」的 thunk：settings 存在时指向 `scope.get()`，不存在时指向组合 entry。llm-deepseek 的做法（见 §1.4）是每请求调用 `current()`，即**运行时读取，天然按请求解析**。

### 1.3 变更通知

三个渠道，全部在 `dsh/packages/settings/settings/src/types.ts` 里声明了 cordis 事件类型：

| 渠道 | 触发时机 | 载荷 | 定位 |
|---|---|---|---|
| `SettingsScope.watch(cb)` | 提交后、解析值发生变化（deep-equal 门控），按提交序串行 | `(next, prev)` | `index.ts:106-113` |
| `settings/updated`（emit） | 同上，宿主侧广播 | `(ns, next, prev, source)`，`source: 'update' \| 'provider'` | `index.ts:778`，types.ts |
| `settings/document-updated`（emit） | **原始 section** 变化（含解析值不变、仅从继承变覆盖的情况） | `(ns, revision)` | `index.ts:728`，types.ts |

- Web 客户端只能收到 `settings/document-updated`（转发白名单 `dsh/packages/api/remotes/src/remote-events.ts:28`），据此刷新自己绑定的 scope（`dsh/packages/client/ui-settings/src/client/settings-scope.ts:257-262`）。
- `installSettingsSection` 的 `hooks.onChange()` 在 attach / detach / 每次提交后触发（`index.ts:863-899`），用于重判派生事实。

### 1.4 llm-deepseek 接线模板（逐行）

`dsh/packages/llm/llm-deepseek/src/index.ts`：

- `const NS = settingsNamespace('llm-deepseek')` —— `:44`。
- **Config 即设置 section 形状**：`export interface Config`（`:61-97`）与 `export const Config: z<Config>`（`:99-112`）——同一个 schemastery schema 既做插件配置校验、又做设置 section 的解析 schema。
- `apply(ctx, config)`（`:200`）：
  - `let current: () => Config = () => config`（`:201`）—— 初始指向组合 entry；
  - `const options = () => …`（`:204-222`）—— 每次请求（adapter 每请求调用）读 `current()`，`lastRaw/lastGood` 记忆化：快照不变直接返回，非法快照保留上次好值并告警（`:213-221`）。**这就是「per-request 解析」的机制**。
  - `ctx.llm.registerConfigurableProviders([{ provider, displayName, settingsNs: NS, settingsPath: [] }])`（`:251-253`）—— 把 namespace 挂到 llm 提供方注册表，是 api-proxy 把该 namespace 暴露给 Web 的通道之一（见 §2.4）。
  - `installSettingsSection(ctx, NS, Config, config, { setSource: s => { current = s }, onChange: ensureRegistrationFacts })`（`:270-274`）—— settings 存在时把 `current` 切到 `scope.get()`；`onChange` 只重注册「注册期固化、按请求无法刷新」的重试策略事实（`:256-268`）。
- 文档级说明：头部注释 `:1-8` ——「changed base URL, catalog, or key reaches the very next request without restarting anything」。

---

## 2. Web 设置页：插件能否贡献 section？

**能。** 设置页是槽位（slot）拼装架构，插件通过 `settings.section` 槽注册一整页。但注意：**渲染是插件自带的 React 组件，不是从宿主 schema 自动生成的表单**；schema 只是下发到客户端供校验/布局辅助。

### 2.1 槽位契约（设置域基座）

`dsh/packages/client/ui-settings/src/client/contract/slots.ts`（由 `dsh/packages/client/ui-settings/` 声明，README 说明它「declares the settings slot types registrants fill」）：

| 槽位 | kind | 用途 | 行 |
|---|---|---|---|
| `settings.trigger` | single | 侧边栏底部触发按钮内容 | `:23` |
| `settings.header` / `settings.close` / `settings.action` | single/list | 面板标题、关闭按钮、头部动作 | `:29/:41/:35` |
| **`settings.section`** | **list** | **每个注册项 = 一个设置页**（导航里一项）；options 带 `id`（section key，驱动 `only` 过滤）、`order`（导航顺序）、`label`（本地化文本） | **`:53`**，注释 `:43-52` |
| `settings.plugins.tab` | list | 「插件」页内的一个 tab | `:62` |
| `settings.onboarding` | list | 引导步骤 | `:73` |
| `settings.general.item` | list | 「通用」页内的一行偏好 | `:88` |

`SettingsSectionOwnerProps` 只给 `close: () => void`（`:116-122`）——section 的数据自己通过 inject face 和 `ctx.settingsScope` 拿。

### 2.2 外壳如何拼装 section

`dsh/packages/client/ui-settings-general/src/client/`：

- 外壳占用 `sidebar.settings` 槽并**声明** settings 各槽（`index.ts:147-155` 的 `children`），注册 General section（`index.ts:170-178`：`id: 'general', order: 0`）。
- 导航行 = `settings.section` 账本按 `order` 排序投影（`index.ts:97-119`，`getSnapshot` 缓存键含账本版本 + locale revision）。
- 内容列渲染：`renderSlot('settings.section', { close: onClose }, { only: active })`（`SettingsRoot.tsx:91`）——**只渲染当前激活的 section**，`only` 按注册时的 `id` 过滤。

### 2.3 现有 section 全部是自定义组件

- `ui-settings-models`：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'models', order: 10, label: () => t('nav') }, ModelsSection))`（`dsh/packages/client/ui-settings-models/src/client/index.ts:118-122`）。
- `ui-settings-plugins`：`id: 'plugins', order: 15`（`dsh/packages/client/ui-settings-plugins/src/client/index.ts:111-115`），其内部再投影 `settings.plugins.tab` tab 账本（`:121-129`），并贡献三张「可配置插件卡片」（bash / agent-loop / web-search，`:131-140`）——**每张卡片各自绑定一个 settings namespace**：`new BashCardController(ctx.settingsScope.bind({ namespace: SHELL_NS }))` 等（`:66-68`）。这正是「插件面板 + 运行时设置」的现成先例。
- `ui-agent-preset`：`id: 'agent-presets', order: 20`（`dsh/packages/client/ui-agent-preset/src/client/index.ts:216-220`）。

**没有「从宿主 schema 自动渲染设置表单」的通用渲染器。** schema 下发到客户端（`settings.describe` 返回 `schema.toJSON()`），辅助库 `dsh-client-schema-form`（`rehydrateSchema` / `validateDraft` / `nodeAtPath` / `getPath` …，`dsh/packages/client/schema-form/src/index.ts:7-13`）用于校验草稿和按路径取节点；页面布局仍是手写（Models 页的 `ProviderEditor` 用 `rehydrateSchema(namespace.schema)` 校验、手绘表单并 `settings.mutate` 落盘，`dsh/packages/client/ui-settings-models/src/client/ProviderEditor.tsx:159-161,271`；`schema-form` 模块注释明说「Editors render their own controls (the Models page hand-writes its layout)」）。`ui-settings-plugins` 的 `fields.tsx` 提供手写 `ValueField`/`SecretField` 控件，供卡片复用（`dsh/packages/client/ui-settings-plugins/src/client/fields.tsx:14-45`）。

**结论**：我们的 DIRECTOR 面板应注册 `settings.section`（独立设置页），自写一个 textarea 组件；`settings.general.item` 是「一行偏好」不适合大段文本，`settings.plugins.tab` 也行但藏在插件页里。

### 2.4 关键门控：namespace 必须先被 `exposedNamespaces()` 放行

客户端读写的 namespace 不是「注册即暴露」。api-proxy 有三层白名单（`dsh/packages/host/apiproxy/src/api-proxy.ts`）：

- `modelProviderNamespaces()` = `ctx.llm.listConfigurableProviders()` 的 `settingsNs` 集合（`:1943-1945`）——llm-deepseek 的 `llm-deepseek` 就是走这条。
- `WEB_SETTINGS_NAMESPACES` 硬编码列表（`:126-131`）：`['agent-loop', 'shell', 'locale', 'permission', 'ui-conversation', 'ui-theme', 'web-search-deepseek']`。
- `PRODUCT_SETTINGS_NAMESPACES`（`:256`）：`ui-onboarding`、agent-preset。
- `exposedNamespaces()` 并集（`:1953-1958`）；不在集合内的 namespace，`settings.describe` 不返回、写操作拒绝 `settings-not-exposed`（`:1961-1966`）。

注释明说（`:119-123`）：「a namespace absent here answers `settings-not-exposed` even when its owner registered it, so adding a section to that page is a decision made here rather than by the registering plugin. **Moving that declaration to `settings.register()`, so a plugin can expose its own configuration without a change in this package, is deferred work.**」

**→ 我们的 `dsh-vibe-mode` namespace 需要改 dsh 仓库一行：加进 `WEB_SETTINGS_NAMESPACES`（api-proxy.ts:126）。** 这是目前唯一正式的暴露途径（vibe-mode 不是 model provider，走不了 `registerConfigurableProviders`）。这是本方案里唯一需要在 dsh monorepo 落地的改动。

---

## 3. 设置保存 RPC

RPC 面在 `dsh/packages/host/apiproxy/src/api/settings.ts:53-106`（`SettingsApi`），方法名即 wire 方法名（`rpc-map.ts:66-70`，fetch 分发 `dsh/packages/host/apiproxy/src/fetch/handler.ts:132-136`）：

| 方法 | 请求 | 说明 |
|---|---|---|
| `settings.describe` | `{}` | 返回 `{ writable, hasDocument, namespaces: SettingsNamespaceView[] }`；每个 view 含 `ns`、序列化 `schema`、`value`/`base`/`user`（三层）、`applies`、`secrets`、`revision`（api/settings.ts:61-90）。**已脱敏**（`redactSecrets: true` 语义，api/settings.ts:3-7） |
| `settings.update` | `{ ns, patch, expectedRevision? }` | 合并式写用户层，validate → persist → commit |
| `settings.replace` | `{ ns, section, expectedRevision? }` | 整层替换（`{}` = 重置回组合默认） |
| `settings.mutate` | `{ ns, ops: [{op:'set'\|'unset', path, value}], expectedRevision? }` | **路径寻址编辑**（对持有脱敏视图的客户端是安全的删除路径，不会误删没见过的 secret 字段） |
| `settings.openDocument` | `{}` | 宿主打开本地 settings 文档 |

- 客户端侧统一入口：`ctx.settingsScope.bind(spec)`（`dsh/packages/client/ui-settings/src/client/settings-scope.ts:245`）→ `SettingsScope`，提供 `getSnapshot()`、`subscribe()`、**`set(field, value)`**（`:100-102`，底层 `api.settings.mutate({ ns, ops:[{op:'set',path:[field],value}] })`，带 `expectedRevision`，`:121-124`）、`unset(field)`（`:110-112`）、`load()`。冲突/失败自动重读最新快照（`:128-133`）。
- 变更通知到客户端：宿主 `settings/document-updated`（ns, revision）经 `ctx.remote.$on` 转发（`settings-scope.ts:257-262`，白名单 `dsh/packages/api/remotes/src/remote-events.ts:28`），只刷新自己的 namespace。
- 安全门：整个 settings/credential 平面是 loopback-only 特权方法（`dsh/packages/client/connection/src/index.ts:89,110-114`）。
- 持久化：`settings-file` provider 默认写 `$DSH_HOME`（或 `~/.dsh`）下的 `settings.yaml`（`dsh/packages/settings/settings-file/src/index.ts:55-56`），外部文件编辑会 chokidar 热发布（`watch: true` 默认，`:31-34`），写时跨进程文件锁 + 注释保留的叶子级 diff（文件头注释 `:1-10`）。

**→ 我们的面板保存动作 = `scope.set('section', text)`（即一次 `settings.mutate` path op），save on blur/按钮；成功响应自带新 revision，`settings-conflict` 时重读重放。**

---

## 4. vibe-mode 当前流程与精确改点

### 4.1 现状（config → systemPrompt.section）

- `VibeModeConfig.section: string` 是部署级 DIRECTOR 指令（`plugin/dsh-vibe-mode/src/types.ts:27`；`ResolvedVibeModeConfig.section` `:74`）；`resolveConfig` 在组合期校验非空字符串（`:107-112`，空会 throw）。
- `VibeModeController` 构造器接收 `config: VibeModeConfig = { section: '' }`，`this.config = resolveConfig(config)`（`plugin/dsh-vibe-mode/src/mode.ts:85-87`），冻结在构造时。
- 进入 / 恢复 vibe 时 `applyDirectorScope(ctx, agent, this.config)`（`mode.ts:154` `/vibe` 命令，`:177` `agent/session-start` 恢复）。
- `applyDirectorScope` 第 4 步挂 DIRECTOR 指令段（`plugin/dsh-vibe-mode/src/director.ts:84-90`）：

```ts
disposers.push(agent.ctx.systemPrompt.section({
  name: DIRECTOR_SECTION_NAME,            // 'director:instructions'，director.ts:22-23
  order: DIRECTOR_SECTION_ORDER,          // 51（plan:policy 用 50）
  text: (context) => {
    const subject = context.agent ?? agent
    return foldVibeMode(subject.session.events) ? config.section : ''
  },
}))
```

- 文本源：`config.section`（构造时冻结的 `ResolvedVibeModeConfig`）。`text` 是 thunk，**每次 prompt 组装（每次请求）都会重新求值**（system-prompt 服务的 section 文本按 assembly 求值，`dsh/packages/core/system-prompt/` README:20、tests 里动态 text 每 assemble 调用），所以「运行时改、下一请求生效」只需要让 thunk 改读 live 值，无需改 systemPrompt 机制。

### 4.2 精确改点（切换文本源：settings 优先、config 兜底）

1. **依赖**：`plugin/dsh-vibe-mode/package.json` 增加 `"@deepseek-ai/dsh-settings": "next"`（与现有 dsh 依赖同源解析，lock 里均为 `0.1.0-rc.6` npm 版；`dsh-settings` 与宿主的 `dsh-settings-file` 同族同版，cordis 按服务名 `settings` 派发，无运行时名冲突）。
2. **schema**：`types.ts` 增加 schemastery schema（vibe-mode 已依赖 `@deepseek-ai/schemastery`），形状 = `VibeModeConfig`（`section: z.string().default('')`，其余字段可选）——照 llm-deepseek `Config` 双重身份（配置即 section 形状）的先例。
3. **构造器接线**（`mode.ts:85-87` 附近）：`const NS = settingsNamespace('dsh-vibe-mode')`；`installSettingsSection(ctx, NS, VibeModeConfigSchema, config, { setSource: s => { sectionSource = () => s().section }, onChange })` —— `sectionSource: () => string` 初值 `() => config.section`（组合入口），settings 挂载后被 setSource 切到 `() => scope.get().section`（settings 用户层 > base=组合配置 > schema 默认）。
4. **director.ts**：`applyDirectorScope(ctx, agent, config, sectionSource = () => config.section)`（`:47` 签名处），`text` thunk 第 89 行改为 `return foldVibeMode(subject.session.events) ? sectionSource() : ''`。**这是唯一的行为改点**：文本源从冻结 config 变成每请求求值的 live 源。
5. **dsh 仓库一行**：`dsh/packages/host/apiproxy/src/api-proxy.ts:126` 的 `WEB_SETTINGS_NAMESPACES` 加入 `'dsh-vibe-mode'`（§2.4 的正式暴露决策点）。
6. 注意：`resolveConfig` 的「空 section 拒绝」只对组合入口生效；settings 用户层把 section 清空时 schema 接受（`z.string().default('')`），运行时 thunk 返回 `''` = 无指令，语义安全（也可用 `SettingsRegisterOptions.validate` 表达约束，但没必要）。

### 4.3 客户端面板（新 client face）

- 照 `dsh-mode-ui` 的 client-face 模式（`plugin/dsh-mode-ui/package.json`：`dsh.client` manifest + `exports["./client"]` + `tsdown --env.DSH_BUILD_FACE client`）：给 vibe-mode（或新建 `dsh-vibe-mode-ui`）加 `./client` face。
- client apply：`inject: ['slots','locale','connection','remote','settingsScope']`（照 `ui-settings-plugins/src/client/index.ts:59`），然后 `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'vibe-director', order: 25, label: () => t('nav') }, DirectorSection))`（照 `ui-settings-models/src/client/index.ts:118-122`）。
- `DirectorSection` 组件：`const scope = ctx.settingsScope.bind({ namespace: 'dsh-vibe-mode' })`；textarea 草稿 + 保存按钮（或 blur 保存）→ `await scope.set('section', text)`；展示 snapshot 的 `writable`/`status`（namespace 未暴露时 `status: 'unavailable'`，settings-scope.ts:175-178）、revision、`settings-conflict` 重读重放。
- profile-main 的 `cordis.patch.yml` 中 vibe-mode 行（`:65-73`）已有 config；面板保存后写入 `~/.dsh/settings.yaml` 的 `dsh-vibe-mode:` 节，provider 热发布 → `installSettingsSection.onChange` → 下一请求的 `sectionSource()` 读到新文本。

---

## 5. 泛化说明

- **同一个 namespace 容纳多种文本**：`dsh-vibe-mode` section 形状可以加 `directorSection`、`workerInstructions` 等字段，一张设置页一个字段一个 textarea；改动只在一个 namespace 内。llm-deepseek 证明「一个插件一个 namespace、Config 即形状」是惯例。
- **compact-mode / advisor / personal-persona 的可复用性**：
  - `dsh-compact-mode`：提示文本硬编码在代码里（`plugin/dsh-compact-mode/src/reuse.ts:77-81`），没有 config 文本字段 —— 若要可编辑需先引入字段。
  - `dsh-advisor`：有 `instructions` config 字段（`plugin/dsh-advisor/src/advisor.ts:42`），reviewer 角色段在 `advisor.ts:601-613` 拼装 —— 同机制（settings section 字段 → 段文本 thunk）可直接套用。
  - `dsh-personal-persona`（dsh 仓库内）：`identity/style/extra` 配置字段在 apply 时静态拼段（README「text is built at apply time」）—— 若改 settings，需把静态文本改成 per-assembly 求值（同 vibe 的 thunk 改法）。
- **共享 namespace vs 每插件一个**：dsh 惯例是**每插件一个**（`llm-deepseek`、`llm-pi-ai`、`agent-loop`、`bash`、`web-search-deepseek`、`locale`、`ui-conversation`、`ui-theme`、`ui-onboarding` 各自独立）。若未来多插件共享一套「模式文本」，也可用一个共享 namespace（如 `dsh-mode-texts`），但需注意 owner 语义（`register` 属调用 fiber，谁注册谁拥有；一个 namespace 只能被注册一次，`index.ts:436-437`），跨插件共享要约定唯一注册方。**推荐保持每插件一个 namespace**。
- 暴露门控（§2.4）随 namespace 数量线性增加：每加一个需在 api-proxy.ts:126 加一行（或等 dsh 侧「`settings.register()` 自带暴露」的 deferred work 落地）。

---

## 结论：5 条关键发现 + 推荐架构

### 5 条关键发现

1. **宿主 seam 完备且稳定**：`@deepseek-ai/dsh-settings` 提供 `settingsNamespace` + `installSettingsSection`（含 `base`=组合配置兜底、`setSource` live 源切换、`onChange` 通知、`scope.watch`/`settings/updated`/`settings/document-updated` 三级通知）；llm-deepseek 的 `apply()`（`index.ts:200-274`）是「config-as-defaults + settings-override、每请求 `current()` 解析」的现成模板。
2. **Web 设置页支持插件贡献整页**：`settings.section` list 槽（`ui-settings/src/client/contract/slots.ts:53`），注册即导航项，外壳按 `id` 只渲染激活项（`SettingsRoot.tsx:91`）。渲染是插件自写 React 组件；schema 下发客户端但**不自动生成表单**（schema-form 只是校验/取节点辅助库）。
3. **保存 RPC 即 `settings.mutate`**（`{ns, ops:[{op:'set',path:[field],value}], expectedRevision}`，`host/apiproxy/src/api/settings.ts:103-105`）；客户端封装 `ctx.settingsScope.bind(ns).set(field, value)`，冲突自动重读（`settings-scope.ts:100-102,245`）。持久化到 `~/.dsh/settings.yaml`，外部编辑也热发布。
4. **唯一硬门控**：namespace 必须进 `exposedNamespaces()`（api-proxy.ts:126 的 `WEB_SETTINGS_NAMESPACES` 或 model-provider 通道），否则 `settings-not-exposed` —— 这是本方案唯一需要在 dsh monorepo 落地的改动（一行），注释也明说这是当前正式决策点。
5. **vibe-mode 改点极小且是热插拔**：`director.ts:89` 的 `config.section` 换成 live thunk（`sectionSource()`），`text` 段本就在每次 prompt 组装时求值 —— 改完设置、**下一个请求**即生效，无需重启、无需重进 vibe 模式。

### 推荐架构

**宿主 settings section（`dsh-vibe-mode` namespace）+ 客户端 `settings.section` 面板**，完全对齐 llm-deepseek 先例：

1. **host**（`plugin/dsh-vibe-mode`）：加 `@deepseek-ai/dsh-settings` 依赖；`types.ts` 加 schemastery schema（形状 = `VibeModeConfig`）；`mode.ts` 构造器 `installSettingsSection(ctx, NS, schema, config, { setSource: s => { sectionSource = () => s().section }, onChange })`；`director.ts` `applyDirectorScope(..., sectionSource)`，text thunk 读 `sectionSource()`；`package.json` 加 `dsh.client` face。
2. **dsh 仓库一行**：`api-proxy.ts:126` `WEB_SETTINGS_NAMESPACES` 加 `'dsh-vibe-mode'`。
3. **client**（vibe-mode 的 `./client` face）：`ctx.slots.inject('settings.section', …register({ id: 'vibe-director', order: 25, label })…)` 注册独立设置页；组件 `ctx.settingsScope.bind({ namespace: 'dsh-vibe-mode' })` + textarea + `set('section', text)` 保存（blur 或按钮），处理 `writable`/`unavailable`/`settings-conflict` 状态。
4. **兜底方案（不需要时别用）**：若完全不动 dsh 仓库，则改走插件自有持久化（plugin-owned JSON 文件 + 自己的 RPC/工具），丢失 settings 生态（无统一 `settings.yaml`、无 describe 脱敏、无 conflict 协议、无法复用 `settingsScope` 传输）——不推荐；`settings.general.item` 单行或 `settings.plugins.tab` tab 是「更小的入口」但都绕不开暴露门控，且不适合大段文本。**正式方案就是 1-3。**

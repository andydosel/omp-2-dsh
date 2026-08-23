# 设计文档 v1.0:vibe DIRECTOR 指令设置页

> 状态:设计草案,等待拍板点确认后开发
> 依据:`RESEARCH-VIBE-SETTINGS.md`(证据 file:line);dsh settings seam 调研
> 原则:一切以插件形式实现;涉及核心改动或非插件实现先提醒用户(本方案含 **monorepo +1 行**,已明示)

---

## 1. 需求

- 在 Web 设置页里**随时调整** DIRECTOR 指令文本,**热生效**(下个请求即用),无需改配置、无需重启、无需重进 vibe 模式。
- 设置持久化(`settings.yaml`),config 只做默认值。
- omp 不允许自定义 DIRECTOR 指令;本方案让 dsh 优于 omp。

## 2. 调研结论(事实)

1. **宿主 settings seam 完备**:`@deepseek-ai/dsh-settings` 提供 `settingsNamespace()` / `installSettingsSection(ctx, ns, schema, entry, hooks)`(entry 作 base、`setSource` 切 live 源、`onChange` 通知)。**llm-deepseek 的 apply() 就是现成模板**:config-as-defaults + settings-override、per-request `current()` 解析(index.ts:200-274)。
2. **web 设置页支持插件贡献整页**:`settings.section` list 槽(ui-settings/src/client/contract/slots.ts:53),注册即导航项;渲染是**插件自写 React 组件**(无通用 schema 自动表单);ui-settings-plugins 的卡片即"插件面板绑定 settingsScope namespace"先例(client/index.ts:66-68,131-140)。
3. **保存 RPC**:`settings.mutate`({ns, ops:[{op:'set',path,value}], expectedRevision});客户端封装 `ctx.settingsScope.bind(ns).set(field, value)`(冲突自动重读);持久化 `~/.dsh/settings.yaml`。
4. **唯一硬门控**:客户端只能读写 `exposedNamespaces()` 白名单——`WEB_SETTINGS_NAMESPACES` 硬编码于 `packages/host/apiproxy/src/api-proxy.ts:126-131`;vibe-mode 非 model provider,**必须把 `'dsh-vibe-mode'` 加进白名单**(api-proxy.ts:126),否则 `settings-not-exposed`。这是本方案**唯一 monorepo 改动**(注释 :119-123 明说这是正式决策点,`settings.register()` 自带暴露是 deferred work)。
5. **vibe-mode 改点极小且热插拔**:`director.ts:89` 的 systemPrompt.section text thunk 每请求重求值——把读 `config.section` 换成读 live thunk(`sectionSource()`),改完设置下个请求即生效。

## 3. 架构

### 3.1 host(dsh-vibe-mode 插件)
- 加依赖 `@deepseek-ai/dsh-settings`。
- `types.ts`:schemastery schema(形状 = VibeModeConfig,含 `section`)。
- `mode.ts`:构造器 `installSettingsSection(ctx, 'dsh-vibe-mode', schema, config, { setSource: s => { sectionSource = () => s().section }, onChange })`。
- `director.ts`:`applyDirectorScope(..., sectionSource)`,section text thunk 读 `sectionSource()`(config 兜底;未改设置 = 用配置默认)。

### 3.2 monorepo +1 行(插件原则边界,已明示)
- `packages/host/apiproxy/src/api-proxy.ts:126` `WEB_SETTINGS_NAMESPACES` 追加 `'dsh-vibe-mode'`。

### 3.3 client(dsh-vibe-mode 加 `dsh.client` face,照 dsh-mode-ui 先例)
- 复制 dsh-mode-ui 的 client 构建链(exports["./client"] + tsdown client 预设 + dsh.client 声明)。
- `ctx.slots.inject('settings.section', register({ id: 'vibe-director', order: 25, label: 'Vibe 指令' }, DirectorSection))`(照 ui-settings-models:118-122)。
- 组件:`ctx.settingsScope.bind({ namespace: 'dsh-vibe-mode' })` + textarea + 保存按钮(`set('section', text)`);处理 writable / unavailable / settings-conflict 三态。

### 3.4 泛化(后续)
- 每插件一个 namespace 是 dsh 惯例;advisor 有 `instructions` 字段可同机制套用;compact-mode 文本目前硬编码(先加字段再套用)。

## 4. 拍板点(待确认)

1. **monorepo +1 行**(api-proxy.ts 白名单加 `'dsh-vibe-mode'`):A1 annex 同类的极小核心文件改动——确认?(推荐确认,无此改客户端无法读写设置)
2. **面板入口**:设置页左侧导航项(推荐,`settings.section` 槽)vs VIBE 徽章点击弹窗。
3. **保存语义**:textarea + 保存按钮 + 冲突提示(推荐)vs 自动保存(每击键 debounce)。
4. **默认值回退**:设置未修改时用 config 的 `section`(推荐);修改后热生效,config 不再覆盖。

## 5. 风险

- 白名单改动需重启生效(一次性的);客户端面板需 client face 构建链(已有 mode-ui 先例,成本低)。
- settings.yaml 持久化;外部编辑热发布(settings-file 机制)。
- 面板与宿主设置页主题/槽位兼容需实现时验证。

## 6. 验证(免 API key + 真实浏览器)

- typecheck/build(host + client 双面)。
- 热生效测试:改设置 → 下个请求的组装 prompt 含新指令(无需重启、无需重进模式)。
- 页面保存 → `~/.dsh/settings.yaml` 落盘 → 重启后仍在。
- 真实浏览器:设置页出现 "Vibe 指令" 面板,编辑保存生效。

## 7. 变更记录

- **v1.0**(2026-08-21):初始设计,等待拍板点确认。

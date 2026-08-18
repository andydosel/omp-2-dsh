# 设计文档 v1.0:模式状态 Web UI(compact / vibe / advisor / wechat)

> 状态:设计草案,等待拍板点确认后开发
> 依据:`RESEARCH-WEBUI-EXTENSIBILITY.md`(证据 file:line;monorepo 零改动可达全部方案)
> 原则:一切以插件形式实现;涉及核心改动或非插件实现先提醒用户

---

## 1. 需求

Web UI 上**常驻显示**当前会话的模式状态:compact 模式、vibe 模式、advisor(启用/审阅者数)、wechat 通道(连接状态)——用户一打开页面就能看出"现在处于什么状态",而不是靠记忆或命令查询。

## 2. 调研结论(事实)

1. 会话节点是**纯客户端**机制(Definition + renderer 都在浏览器;无服务端注册);未知 kind 有通用 JSON fallback(`ChatNodeSeat.tsx:47-56`),renderer 开放注册。
2. **树外客户端 bundle 是官方一等机制**:包声明 `dsh.client.platform='web'` + `exports["./client"]` → client-modules 扫描全部 loader 条目 → `__DSH_BOOT__` 注入 + `/plugins/<id>/client.js` 路由。**不需要改 monorepo**。
3. **硬前提**:插件行必须以**包名**从 profile 目录解析——`client-modules` 对解析失败的条目写入**永不过期负缓存**(`modules/src/index.ts:55-58`)。我们当前 `profile-main` 全是 `file://` URL → 浏览器永远拿不到客户端代码。这是 dsh-plugin 仓库的配置改动。
4. **模式徽章标准范式 = host 投影单元 + 槽位组件**:`ctx.sessionProjections.register({key, schema, init, apply, view, stateVersion})`(plan 同款,`plan-mode/src/index.ts:244-258`)+ 客户端 `useProjection(key)` 徽章挂 `conversation.session.header.utilities`(`PlanModeControl.tsx:19-20`)。
5. `compact/mode`、`vibe/mode` 事件**已存在**(log-only,客户端可见);**advisor/wechat 目前不发任何 session 事件**——需补发 whole-value 状态事件(插件自身改动)。
6. 客户端开发热更:client-hmr bundle stat-poll 覆盖树外 bundle;host 侧(投影单元)改动需重启。

## 3. 插件结构(新建 `dsh-mode-ui` 独立项目 + 两插件补事件)

```
plugin/dsh-mode-ui/               # 新包:@dsh-plugin/dsh-mode-ui
  package.json                    # dsh.client.platform=web + exports["./client"] + 双面构建脚本
  tsdown.client.ts                # 复制 packages/client/tsdown.client.ts 的 clientConfig 预设
  src/                            # host 半
    index.ts                      # ctx.inject(['sessionProjections']):注册 4 个投影单元
    projections/compact.ts        #   compactMode ← compact/mode {active}
    projections/vibe.ts           #   vibeMode ← vibe/mode {active}
    projections/advisor.ts        #   advisorStatus ← advisor/status {enabled, reviewers}
    projections/wechat.ts         #   wechatChannel ← wechat/channel {connected, account?}
  client/src/                     # client 半
    index.ts                      # apply(ctx):注册徽章组件到 conversation.session.header.utilities
    badges/CompactBadge.tsx       #   useProjection('compactMode') + 点击 /compact /compact_abort
    badges/VibeBadge.tsx          #   useProjection('vibeMode') + 点击 /vibe
    badges/AdvisorBadge.tsx       #   useProjection('advisorStatus') + 点击 /advisor
    badges/WechatBadge.tsx        #   useProjection('wechatChannel') + 点击 /wechat status
    node-cards/                   # v1.2 可选:chat 节点状态卡(Definition + renderer)
  tests/

plugin/dsh-advisor/               # 补事件(小改)
  src/advisor.ts                  # 启停/审阅者集合变化处 session.append('advisor/status', {enabled, reviewers})
plugin/dsh-channel-wechat/        # 补事件(小改)
  src/adapter.ts                  # 连接/断开/账号切换处 session.append('wechat/channel', {connected, account?})
```

- 徽章数据 = host 投影折叠(多标签一致、回放一致、客户端零折叠)。
- 徽章交互(plan 同款):点击执行对应命令(`/compact`、`/vibe`、`/advisor`、`/wechat status`)。
- 客户端类型接线:`ChatNodeDataMap`/`ConversationStepDataMap` declaration merging(type-only);事件类型在插件 `types.ts` 的 `SessionEventMap` augmentation(compact/vibe 已做)。
- 纯度门:客户端只 import 平台模块(`PLATFORM_MODULES`);跨插件协作走 cordis 服务。

## 4. profile 加载方式切换(前置,影响全部插件行)

- `profile-main/cordis.patch.yml` 行 `name:` 从 `file:///C:/.../lib/index.js` **改为包名**(`@dsh-plugin/dsh-compact-mode` 等)。
- 安装:在 `~/.dsh/profiles/web/`(或 `main` profile 目录)以 pnpm 安装我们的包(`dsh plugin --profile <p> add <path>` 机制;hoisted linker),使包名可从 profile 目录解析。
- `run.ps1`/README 更新:build 全部插件(含 client bundle)后再启动;client bundle 缺失会 `MissingClientBundleError`。
- 影响:host 加载机制从 file:// 改为包名解析——**改完后需重跑 e2e 验证** host 行为不变(compact 审阅/vibe/advisor 三场景)。
- 负缓存注意:包改名/加声明需重启;启动前确保 bundle 已构建。

## 5. 配置(全默认即可,无需新增配置项)

```yaml
- id: mode-ui
  name: '@dsh-plugin/dsh-mode-ui'
  config: {}
```

投影 schema:`compactMode {active:boolean}`、`vibeMode {active:boolean}`、`advisorStatus {enabled:boolean, reviewers:number}`、`wechatChannel {connected:boolean, account?:string}`。

## 6. 拍板点(待确认)

1. **方案**:常驻 **header 徽章**(方案 b,plan 同款)为主;聊天流状态卡(方案 a)作为 v1.2——确认?(推荐 b)
2. **包结构**:新建独立 `dsh-mode-ui`(host 投影 + client 徽章一体)vs 内嵌进各插件——推荐独立包。
3. **profile 加载切换**:file:// → 包名 + 安装进 profile 目录,影响全部插件行,改后重跑 e2e——确认接受?
4. **徽章交互**:点击徽章执行对应命令(plan 同款)——确认?
5. **补事件**:advisor/wechat 补发 whole-value 状态事件——确认?
6. **徽章集**:compact/vibe/advisor/wechat 四个(wechat 未激活时显示"离线"或隐藏,可配)——确认?

## 7. 风险

- 加载方式切换(file:// → 包名)是机制级改动,重跑 e2e 兜底;负缓存需重启。
- 客户端构建链首次搭建(tsdown.client 预设复制),purity gate 约束 import。
- advisor/wechat 补事件是插件改动,需回归测试。
- host 投影改动需重启生效(客户端热更覆盖 bundle,不覆盖 host)。

## 8. 验证(免 API key + 真实浏览器)

- 各插件单测回归(advisor/wechat 补事件后)+ dsh-mode-ui 单测(投影折叠)。
- typecheck/build(双面:host + client bundle)。
- `--dump-config` 显示 mode-ui 行;包名解析成功(无负缓存警告)。
- 真实浏览器(同 extend-profile 的 live-browser 法):切 compact/vibe/advisor 模式 → header 徽章出现/变化;advisor 启用后显示审阅者数;wechat 未激活显示离线。
- 改后重跑 e2e 三场景(compact 审阅/vibe/advisor)确认 host 行为不变。

## 9. 变更记录

- **v1.0**(2026-08-18):初始设计,等待拍板点确认。
END

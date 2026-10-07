# dsh profile-main — 插件集成 Profile(compact-mode + read/write + advisor + wechat + mode-ui + 协调套件)

把 13 个插件(dsh-compact-mode、dsh-tool-read-write、dsh-advisor、dsh-channel-wechat、
dsh-mode-ui,以及协调套件 dsh-orchestrator、dsh-review-gate、dsh-question-board、
dsh-task-board、dsh-rules、dsh-peers、dsh-org;压缩审阅树 dsh-tree-engine 作为 compact-mode
的依赖)接入 DeepSeek Harness(dsh)的可运行 profile 补丁层。基于 `dsh-base` + `dsh-web-app`
两个 bundle 层,禁用其自带的 `compaction-basic` / `command-compact` / `tool-fs`,插入 **12 个
插件行**(tree-engine 作为 compact-mode 的 `workspace:*` 依赖,不经 profile 单独挂行)。
共享库 `dsh-worker-spawn`(`@dsh-plugin/dsh-worker-spawn`)是 `dsh-orchestrator` 的运行时
依赖,随套件安装进 profile node_modules,但**不作为 profile 行挂载**。

## 插件清单

| 插件 | 状态 | 说明 |
|---|---|---|
| dsh-tree-engine | ✅ 依赖 | 压缩审阅树引擎;包名是 `@dsh-plugin/tree-engine`,由 dsh-compact-mode 以该包名引入,**不经 profile 单独挂行** |
| dsh-compact-mode | ✅ 启用 | `ctx.compaction` 后端 + `/compact*` 命令族(依赖 dsh-tree-engine) |
| dsh-tool-read-write | ✅ 启用 | **替换** `@deepseek-ai/dsh-tool-fs` 全家:同名 `read`/`write`/`edit`/`read_image` + 新增 `inspect_image`(omp 风格选择器/归档/SQLite/URL 等) |
| dsh-advisor | ✅ 启用 | 会话顾问:reviewer 子代理(read/grep/glob + `advise`),immuneTurns=3,syncBacklog=off |
| dsh-mode-ui | ✅ 启用 | **模式状态 Web UI**:host 投影单元(fold `compact/mode`/`advisor/status`/`wechat/channel`)+ 会话头部徽章(COMPACT/ADVISOR/WECHAT) |
| dsh-orchestrator | ✅ 启用 | 编排器:review 循环 + `subtask_parallel` 递归扇出(经 dsh-worker-spawn 派发 worker;reviewer 复用 dsh-advisor 的 helper) |
| dsh-review-gate | ✅ 启用 | 复核门(`--review`):计划审批期间只围写路径(protectedPaths),状态走 `review-gate/state` 事件 + `reviewGate` 投影 |
| dsh-question-board | ✅ 启用 | 异步问题收件箱:持久化 `question/*` 事件 → `questionBoard` 投影 + 全局 `ask_question` 工具 + `ctx.questionBoard` |
| dsh-task-board | ✅ 启用 | 任务板:持久化 `task/*` 事件 → `taskBoard` 投影 + `task_new/update/close/reopen/list` 工具 + `ctx.taskBoard` |
| dsh-rules | ✅ 启用 | 规则层:advisory 文件注入 `rules:advisory` 提示段 + `gateRules` 逐调用审批门(`ctx.rules`) |
| dsh-peers | ✅ 启用 | 会话对等通道:持久化 `peer/message` 事件 + `ctx.peers` 服务 + 全局 `peer_send` 工具 |
| dsh-org | ✅ 启用 | 会话组织:角色模型(`org/*` 事件 → `ctx.org` + `org` 投影)+ `/org` 命令族 + 角色能力包络(**须在 `peers` 之后挂载**);客户端面:`conversation.input.dock` 组织面板(`lib/client.js`,接管会话列表 + 解除/禁止) |
| dsh-channel-wechat | ⛔ 停用 | 微信(iLink)渠道,`enabled: false` 挂载但不轮询。**hermes 仍持有账号**,激活步骤见下文 |
| dsh-worker-spawn | 📦 库 | 纯库包(`@dsh-plugin/dsh-worker-spawn`):worker 派发基座,无插件入口、无 Context key,不作为 profile 行;仅作为 dsh-orchestrator 的运行时依赖安装 |

> `cordis.patch.yml` 实际插入 **12 个插件行**(上表 13 个插件里 tree-engine 不挂行、worker-spawn
> 是纯库),再挂一行 `agent-preset-registry` 选 web 默认 preset。

## 目录结构

- `cordis.patch.yml` — 补丁层:禁用基座行 + 插入 12 个插件行(含完整配置)+ web 默认 preset 选择
  + **`standard-rw` preset 声明行**(`@deepseek-ai/dsh-agent-preset`,见下「web 面的 read/write 替换」)
- `run.ps1` — Windows PowerShell 一键脚本:按依赖序构建 14 个包,再启动 dsh web
- `package.json` / `pnpm-workspace.yaml` — 作为独立 profile 安装到
  `~/.dsh/profiles/main/` 时所需(与官方 profile 目录结构一致)

## 前置条件

1. dsh monorepo 已 clone、已 `pnpm install`(参考仓库
   `C:\Users\Vantage_XLST\Documents\dsh`),Node ≥ 22。
2. 插件工作区已 `pnpm install`(见下「tree-engine 如何被解析」)。
3. **14 个包必须先构建**,顺序:worker-spawn → tree-engine → compact-mode →
   tool-read-write → advisor → channel-wechat → mode-ui → review-gate →
   question-board → rules → peers → org → task-board → orchestrator:

   ```powershell
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-worker-spawn run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-tree-engine run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-compact-mode run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-tool-read-write run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-advisor run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-channel-wechat run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-mode-ui run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-review-gate run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-question-board run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-rules run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-peers run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-org run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-task-board run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-orchestrator run build
   ```

   `run.ps1` 会自动按该顺序构建再启动,不必手动执行上面十四条。

4. **把插件按包名安装进 web profile**(一次性;`cordis.patch.yml` 的行现在用
   **包名**而非 `file://` URL 引用插件 —— 包名解析基于 profile 目录的
   `node_modules`,`dsh plugin --profile web add <abs path>` 会在
   `~/.dsh/profiles/web/package.json` 写入 `link:` 依赖并安装):

   ```powershell
   cd C:\Users\Vantage_XLST\Documents\dsh
   $plugins = 'dsh-worker-spawn','dsh-tree-engine','dsh-compact-mode','dsh-tool-read-write','dsh-advisor','dsh-channel-wechat','dsh-mode-ui','dsh-review-gate','dsh-question-board','dsh-task-board','dsh-rules','dsh-orchestrator','dsh-peers','dsh-org'
   foreach ($p in $plugins) { pnpm dsh plugin --profile web add "C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\$p" }
   ```

   包名形式是浏览器拿到我们的 client bundle 的前提(client-modules 按包名从
   profile 目录解析每个 loader entry;`dsh-mode-ui`、`dsh-org`、`dsh-task-board` 声明
   `dsh.client` + `exports["./client"]`,所以它们的行同时成为 web boot 入口,且构建
   需产出 `lib/client.js`)。
   **重启规则**:Loader 对解析失败的包名会缓存负面结论(negative cache)。新增/
   改名插件后第一次启动若报 `Cannot find module`/加载失败,必须**完整重启**
   (旧进程的负面缓存不会自己失效),且任何声明变更都需要重启后才会生效。
5. **无需安装 preset**:`standard-rw` 是 `cordis.patch.yml` 里的声明行,随补丁一起
   生效,见下「web 面的 read/write 替换」一节。patch 把 web 默认 preset 指向
   `standard-rw`,声明缺失/插件名或 config 对不上时,新建会话会响亮失败(报告可用
   preset 列表或不可用的行)——这是刻意的 fail-loud 行为。

## 验证(无需 API key)

在 dsh monorepo 目录下执行(把 `<abs>` 换成本文件绝对路径):

```powershell
cd C:\Users\Vantage_XLST\Documents\dsh
pnpm dsh --profile web --patch C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\cordis.patch.yml --dump-config
```

`--dump-config` 只做离线配置组合,**不导入任何插件模块**,无需 API key。输出应包含:

- 被禁用的行:`compaction-basic`、`command-compact`、`tool-fs`(均带 `name:` 守卫 +
  `disabled: true`);
- 新插入的行(12 个插件行):`compact-mode`、`tool-read-write`、`advisor`(enabled +
  defaultTools/immuneTurns/syncBacklog)、`orchestrator`(reviewersPerRound/fanOut 等)、
  `mode-ui`(config 空)、`review-gate`(protectedPaths 等)、
  `channel-wechat`(`enabled: false`)、`question-board`、`rules`、`task-board`、
  `peers`、`org`;
- preset 行:`agent-preset-registry`(`default: standard-rw`)+ 声明行 `preset-standard-rw`
  (`name: '@deepseek-ai/dsh-agent-preset'`,`config.id: standard-rw`,`config.order: 5`,
  `config.plugins` = 原 `agent.cordis.yml` 的行逐行照搬)。
- 注意:dump 是离线组合,**不导入插件模块**,所以它只证明声明行结构合规;preset 能否真
  激活(插件名可解析、每份 config 过各自 schema)要由真实启动后的新建会话来证明——
  那一步会挂载整棵 preset 树并审计每一行。

## 真实运行

```powershell
cd C:\Users\Vantage_XLST\Documents\dsh
pnpm dsh web --patch C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\cordis.patch.yml
```

- **真实模型请求需要 API key**:启动前设置 `$env:DEEPSEEK_API_KEY = 'sk-...'`
  (或 dsh 支持的其他凭据方式)。
- 无 key 也能启动:插件照常**加载并 apply**(compact 后端、`/compact*`、read/write/edit/
  read_image/inspect_image 工具、advisor 运行时、orchestrator 编排、mode-ui 徽章、
  wechat 行 `enabled:false` 不轮询、question-board/task-board/rules/peers/org),Web 服务监听 `http://127.0.0.1:3080`;
  只有发起模型请求时才会失败(无凭据)。
- 也可用 `run.ps1` 一键完成构建 + 启动:

  ```powershell
  powershell -ExecutionPolicy Bypass -File C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\run.ps1
  ```

## web 面的 read/write 替换(为什么需要 preset + 怎么做)

**机制事实**(详见 `doc/RESEARCH-FS-TOOLS.md` §3-§4、§6 与 dsh 源码):
- web profile 的**宿主层 `tool-fs` 已被 web-app bundle 禁用**;模型可见的 fs 工具
  来自 **agent preset**(`standard`/`ptc`/`minimal`/`cordis` 等,每个 preset 在 agent
  作用域挂一行 `tool-fs`)。同 scope 内同名注册会直接抛错,preset 的 `read` 会 shadow
  全局的 `read` —— 所以只改宿主层对 web 无效。
- **0.2.0-rc.2 起 preset 是声明行,不是目录**:`@deepseek-ai/dsh-agent-preset` 的一行
  (`config: {id, name, description, order, plugins}`)挂在 bundle 或 patch 层里,和随
  包自带的 `standard`/`ptc`/`minimal`/`cordis` 四行同形;`plugins` 就是原先
  `agent.cordis.yml` 的整份行列表。旧的 roster 目录机制(`.agent-presets/<id>/`,
  以及 `profile-boot.ts` 把 `roots` 钉到部署自带 `config/agent-presets/`)已被移除,
  `$DSH_HOME/.agent-presets/` 不再被任何代码读取。
- 因此实现的是 **选项 (b)**:本 profile 在补丁层里**自带成品 preset 声明行**
  (`standard` 去掉 `tool-fs` 行与 compaction 两行,其余逐行原样),同时 patch 把 web
  默认 preset 设为 `standard-rw`。这是机制允许的做法:声明行与选中它的
  `default` 同处一层,不再有任何安装步骤。
- **CLI/TUI(仅 base bundle 的 profile,如 `--profile tui`)不需要 preset
  步骤**:同一 patch 在宿主层禁用 `tool-fs` + 以 host 行注册 tool-read-write,
  直接完成替换(选项 c 自动满足)。

**声明行(一次,写在 `cordis.patch.yml` 里,无安装步骤)**:

```yaml
- insert:
    - id: preset-standard-rw
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard-rw
        name: standard-rw
        description: >-            # 原 preset.yml 的 description
          ...
        order: 5                    # 排在官方四行(1-4)之后
        plugins:                    # 原 agent.cordis.yml 的行,逐行照搬
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            ...
```

之后新会话默认就用 `standard-rw`(patch 已设 `default: standard-rw`)。临时想用
官方 preset:web 设置 → Agent presets 选择器切回 `standard`/`ptc`/`minimal`/`cordis`
即可。`standard-rw` 与 `standard` 的区别只有两处:**不挂 `tool-fs` 行**(宿主层的
read/write 套件因此不被 shadow)、**不挂 `compaction-basic` + `command-compact` 两行**
(宿主层 compact-mode 提供 `ctx.compaction` 与 `/compact*` 命令族);
`tool-fs-search`(glob/grep)、`fs` 服务与 `fs-observation-policy` 保持部署原样。

> **迁移时的两处 0.2.0-rc.2 修正**(原 roster 在旧版 dsh 上写的键/包名已失效):
> 1. `dsh-persona` 不再接受 `config.text`,改为**必填 `prefix`** + `suffix`
>    (原一句 "…{{model}} model. Your working directory is {{cwd}}." 拆成
>    `prefix` + `suffix`,与官方 `standard` 行同形;空的 `suffix` 会把部署级 cwd 段
>    shadow 掉,所以必须显式写上);
> 2. `@deepseek-ai/dsh-workflow-worker-thread` 在 0.2.0-rc.2 已更名/取代为
>    `@deepseek-ai/dsh-workflow-ptc`(行 id 随官方 `standard` 用 `workflow-ptc`,
>    `config.provider: spawn` 不变)。
>
> 其余 21 个叶子行的包名与 config 键都通过了 0.2.0-rc.2 核对(逐个对
> `packages/*/*/package.json` 的 `name` 与插件各自 `Config` schema),
> **任何一个对不上都会让 preset 挂载失败**(不是静默回退)。

## wechat 激活步骤(当前保持禁用)

hermes 持有当前 iLink 账号;同一 bot 账号**互斥**(后启动者 403 掉消息),所以
激活前必须先停 hermes:

1. **停掉 hermes gateway**(确保不再轮询 `getupdates`):
   ```powershell
   # 具体方式按 hermes 部署(如 systemd/任务计划/`hermes stop`);确认 `weixin/accounts` 下账号文件存在
   Get-ChildItem $env:LOCALAPPDATA\hermes\weixin\accounts
   ```
2. 把 `cordis.patch.yml` 中 `channel-wechat` 行的 `enabled` 改为 `true`,并补上
   hermes 的账号凭据:
   ```yaml
   config:
     enabled: true
     accountId: '<hermes .env 的 WEIXIN_ACCOUNT_ID>'   # 形如 c5610f3ce386@im.bot
     token: '<hermes .env 的 WEIXIN_TOKEN>'             # 形如 {account_id}:{secret}
     stateDir: 'C:/Users/Vantage_XLST/AppData/Local/hermes/weixin'
   ```
   `stateDir` 已指向 hermes 的 `weixin/` 目录 —— 插件按 hermes 同款文件格式
   读写 `accounts/`、`pairing/`,直接接管同一账号的凭据/会话续传/审批数据。
   字段集见 `dsh-channel-wechat/src/config.ts`(严格校验,未知键会响亮失败)。
3. 启动 dsh(见「真实运行」),用 `/wechat status` 确认账号/轮询/会话状态;
   入站 DM 按 `dmPolicy`(默认 `pairing`)走 8 位配对码审批。

## 安装为独立 profile(可选)

把本目录复制到 dsh 的 profile 目录,之后 `pnpm dsh --profile main` 即可直接使用:

```powershell
Copy-Item -Recurse C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main $env:USERPROFILE\.dsh\profiles\main
pnpm dsh --profile main          # 或 pnpm dsh --profile main --dump-config 验证
```

注意:复制后 `cordis.patch.yml` 内插件的 `name:` 是**包名**,解析基于目标 profile
目录的 `node_modules` —— 用 `--profile main` 前需先在 `~/.dsh/profiles/main` 下
执行与 web 相同的 `dsh plugin --profile main add <abs path>` 安装循环(见
「前置条件」第 4 条),否则 Loader 找不到包。web 默认 preset 行同样有效
(`standard-rw` 的声明行就在同一份 patch 里,无需额外安装)。

## 关键机制说明

### Loader 如何解析 `name:`(包名 + profile node_modules)

dsh 的 Cordis Loader 对插入行执行 `import(name, baseUrl)`:

- **包名**(`@dsh-plugin/*` 等)从 **profile 目录的 `node_modules`** 解析
  (安装闭包):`pnpm dsh plugin --profile web add <abs path>` 会把插件以
  `link:` 依赖写进 `~/.dsh/profiles/web/package.json` 并安装,包名即命中。
- `@deepseek-ai/*` 包名从 dsh 安装自身解析。
- **相对路径**以 profile 目录(如 `~/.dsh/profiles/web`)为基准,而非 patch 文件目录;
- **Windows 绝对路径**必须写成 `file:///C:/...` 形式(旧版 patch 用过,现已全部
  改为包名,不再需要)。

Loader 对 ESM 模块取 `exports.default ?? exports`:类默认导出
(compact-mode/advisor/orchestrator)与命名导出 `apply`+`Config`(read-write/wechat)
两种形态都能直接作为插件。

### 插件入口文件位置

各插件 `package.json` 的 `main`/`exports` 均指向构建产物真实的宿主入口:带 client
半的插件用两种布局之一——`dsh-mode-ui`、`dsh-task-board` 把宿主与 client 面放进同一
个 `rootDir: "."` 程序(宿主入口 `lib/src/index.js`,与 `lib/client.js` 并列);
`dsh-org` 保持宿主 `lib/index.js` 不动,client 面单独由 `tsconfig.client.json`
输出到 `lib/client/`——其余插件均为 `lib/index.js`。因此 `release.ps1` /
`setup.ps1` 用包 `exports["."]`/`main` 解析真实入口来校验,而不是假设扁平的
`lib/index.js`。

### dsh-org 的组织面板(client 面)

`dsh-org` 的浏览器半边挂在 `conversation.input.dock`(会话级 list 座位,队列/待办
dock 同座),渲染宿主已折叠的 `org` 投影:本会话接管的会话逐行列出,每行带 `解除`
(`/org relinquish <id>`)与 `禁止`(`/org forbid <id>`);被 forbid 的会话不出现为可
操作行(主机的 `forbid` 本身会同时释放接管边),其 id 落在面板底部的只读 forbidden
行,`/org list` 仍是全局视图。面板本身不做任何客户端折叠,动作全部走会话自己的
`/org` 命令(`ctx.remote.commands.execute(sessionId, line)`),因此无需新增 host 侧
API。

构建:宿主入口仍是 `lib/index.js`;client 面由 `tsconfig.client.json` 输出到
`lib/client/`(js + d.ts),再由 `tsdown.client.ts`(与 dsh-mode-ui 同一 preset,
仅 `PACKAGE_ID` 不同)打成 `lib/client.js`。`pnpm --filter @dsh-plugin/dsh-org run
build` 三步全做;`$clientPlugins` 列表(release/setup/run.ps1)已含 `dsh-org`,构建
产物缺失时会响亮失败。

### mode-ui 与 resume(持久化目录 annex)

三个模式/渠道事件(`compact/mode`、`advisor/status`、
`wechat/channel`)由 out-of-tree 插件写入会话日志,dsh-mode-ui 的投影单元
按会话折叠它们并驱动头部徽章。**2026-08-21 起**这些事件已通过 monorepo 的
`packages/mode/mode-events`(类型专用 annex 包)注册进 harness 的持久化目录
(`KNOWN_SESSION_EVENT_TYPES` + `docs/persistence-catalog.md`,由
`pnpm run gen-persistence-catalog` 生成)——因此使用过这些模式的会话现在可以
**从磁盘 resume**,不再抛 `SessionFormatUnsupportedError`。前提:monorepo 侧
已合入 annex 提交并重新构建(参考仓库 `C:\Users\Vantage_XLST\Documents\dsh`,
提交 `6ad885bb22`),插件侧无需改动。

### tree-engine 如何被解析

compact-mode 的 `lib/index.js` 通过 `import('@dsh-plugin/tree-engine')` 使用树引擎。
当 dsh 从 profile 目录的包链接(`node_modules/@dsh-plugin/dsh-compact-mode`)加载它时,
Node 的 ESM 解析从 compact-mode 自己的 `node_modules` 向上查找,命中 pnpm workspace 软链
`dsh-compact-mode/node_modules/@dsh-plugin/tree-engine -> ../../dsh-tree-engine`。
因此前提是**在插件工作区(`dsh-plugin/plugin`)执行过 `pnpm install`**——这会创建
workspace 软链;若未安装,在该目录执行 `pnpm install` 即可。read-write/advisor/wechat
是独立 workspace(各自 `node_modules` 自带 `@deepseek-ai/*` 运行时依赖)。

### 为什么必须禁用 compaction-basic / command-compact / tool-fs

- `ctx.compaction` 是**单后端服务**:compact-mode 与 compaction-basic 同时提供会硬冲突;
- `/compact` 命令族:compact-mode 注册 `compact/compact_edit/compact_apply/compact_abort`
  等,与 `command-compact` 重复注册会报错;
- `tool-fs`:tool-read-write 注册同名 `read`/`write`/`edit`/`read_image`,同一
  scope 内同名注册**立即抛错**(无 last-wins),必须先让基座行消失。`name:` 守卫
  使其在任何基座上都能幂等、且基座变更时响亮失败。
  (web profile 的 web-app bundle 层已默认禁用 host 层 tool-fs,本 patch 的禁用行
  在其上为幂等 no-op;CLI/TUI profile 上才是真正的替换开关。)

### preset 的同名 shadow 规则(web 面为什么这样设计)

dsh 工具注册表按 scope 分层(agent → preset → global,最近者胜):
- 官方 `standard`/`ptc` preset 在 preset 层挂 `tool-fs` 的 `read` 等 → **shadow 掉**
  宿主层 tool-read-write 的同名工具(合法,不同层),所以不改 preset 时 web 面行为
  不变;
- `standard-rw` 不挂 `tool-fs` → agent 直接看到宿主层的 omp 风格
  read/write/edit/read_image/inspect_image;
- 同一层内重复注册则抛错——因此 host 行与 preset 行不会同时以同名共存于一层。

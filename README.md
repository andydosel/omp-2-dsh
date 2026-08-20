# dsh profile-main — 插件集成 Profile(compact-mode + vibe-mode + read/write + advisor + wechat + mode-ui)

把六个独立插件(dsh-compact-mode、dsh-vibe-mode、dsh-tool-read-write、
dsh-advisor、dsh-channel-wechat、dsh-mode-ui)接入 DeepSeek Harness(dsh)的可运行 profile
补丁层。基于 `dsh-base` + `dsh-web-app` 两个 bundle 层,禁用其自带的
`compaction-basic` / `command-compact` / `tool-fs`,插入六个插件。

## 插件清单

| 插件 | 状态 | 说明 |
|---|---|---|
| dsh-compact-mode | ✅ 启用 | `ctx.compaction` 后端 + `/compact*` 命令族(依赖 dsh-tree-engine) |
| dsh-vibe-mode | ✅ 启用 | DIRECTOR 调度模式 + `/vibe` 命令族 |
| dsh-tool-read-write | ✅ 启用 | **替换** `@deepseek-ai/dsh-tool-fs` 全家:同名 `read`/`write`/`edit`/`read_image` + 新增 `inspect_image`(omp 风格选择器/归档/SQLite/URL 等) |
| dsh-advisor | ✅ 启用 | 会话顾问:reviewer 子代理(read/grep/glob + `advise`),immuneTurns=3,syncBacklog=off |
| dsh-mode-ui | ✅ 启用 | **模式状态 Web UI**:host 投影单元(fold `compact/mode`/`vibe/mode`/`advisor/status`/`wechat/channel`)+ 会话头部徽章(COMPACT/VIBE/ADVISOR/WECHAT) |
| dsh-channel-wechat | ⛔ 停用 | 微信(iLink)渠道,`enabled: false` 挂载但不轮询。**hermes 仍持有账号**,激活步骤见下文 |

## 目录结构

- `cordis.patch.yml` — 补丁层:禁用基座行 + 插入六个插件(含完整配置)+ web 默认 preset 选择
- `agent-presets/standard-rw/agent.cordis.yml` — **web 面 read/write 替换用的 preset 成品**(`standard` 去掉 `tool-fs` 行,见下)
- `run.ps1` — Windows PowerShell 一键脚本:按依赖序构建七个项目,再启动 dsh web
- `package.json` / `pnpm-workspace.yaml` — 作为独立 profile 安装到
  `~/.dsh/profiles/main/` 时所需(与官方 profile 目录结构一致)

## 前置条件

1. dsh monorepo 已 clone、已 `pnpm install`(参考仓库
   `C:\Users\Vantage_XLST\Documents\dsh`),Node ≥ 22。
2. 插件工作区已 `pnpm install`(见下「tree-engine 如何被解析」)。
3. **七个插件项目必须先构建**,顺序:tree-engine → compact-mode → vibe-mode
   → tool-read-write → advisor → channel-wechat → mode-ui:

   ```powershell
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-tree-engine run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-compact-mode run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-vibe-mode run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-tool-read-write run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-advisor run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-channel-wechat run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-mode-ui run build
   ```

   `run.ps1` 会自动按该顺序构建再启动,不必手动执行上面七条。

4. **把插件按包名安装进 web profile**(一次性;`cordis.patch.yml` 的行现在用
   **包名**而非 `file://` URL 引用插件 —— 包名解析基于 profile 目录的
   `node_modules`,`dsh plugin --profile web add <abs path>` 会在
   `~/.dsh/profiles/web/package.json` 写入 `link:` 依赖并安装):

   ```powershell
   cd C:\Users\Vantage_XLST\Documents\dsh
   $plugins = 'dsh-tree-engine','dsh-compact-mode','dsh-vibe-mode','dsh-tool-read-write','dsh-advisor','dsh-channel-wechat','dsh-mode-ui'
   foreach ($p in $plugins) { pnpm dsh plugin --profile web add "C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\$p" }
   ```

   包名形式是浏览器拿到我们的 client bundle 的前提(client-modules 按包名从
   profile 目录解析每个 loader entry;`dsh-mode-ui` 声明 `dsh.client` +
   `exports["./client"]`,所以它的行同时成为 web boot 入口)。
   **重启规则**:Loader 对解析失败的包名会缓存负面结论(negative cache)。新增/
   改名插件后第一次启动若报 `Cannot find module`/加载失败,必须**完整重启**
   (旧进程的负面缓存不会自己失效),且任何声明变更都需要重启后才会生效。
5. **(仅 web 面 read/write 替换)安装 `standard-rw` preset**,见下「web 面的
   read/write 替换」一节。patch 已把 web 默认 preset 指向 `standard-rw`,未安装
   时新建会话会响亮失败(报告可用 preset 列表)——这是刻意的 fail-loud 行为。

## 验证(无需 API key)

在 dsh monorepo 目录下执行(把 `<abs>` 换成本文件绝对路径):

```powershell
cd C:\Users\Vantage_XLST\Documents\dsh
pnpm dsh --profile web --patch C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\cordis.patch.yml --dump-config
```

`--dump-config` 只做离线配置组合,**不导入任何插件模块**,无需 API key。输出应包含:

- 被禁用的行:`compaction-basic`、`command-compact`、`tool-fs`(均带 `name:` 守卫 +
  `disabled: true`);
- 新插入的行:`compact-mode`、`vibe-mode`、`tool-read-write`、`advisor`(enabled +
  defaultTools/immuneTurns/syncBacklog)、`mode-ui`(config 空)、
  `channel-wechat`(`enabled: false` + `stateDir` 指向 hermes 的 `weixin/`)、
  `agent-presets`(`default: standard-rw`)。
- 注意:dump 是离线组合,不含 `apps/cli/src/profile-boot.ts` 注入的 agent-presets
  `roots`(真实启动时该层会把 roster 钉到部署自带的 `config/agent-presets/`)。

## 真实运行

```powershell
cd C:\Users\Vantage_XLST\Documents\dsh
pnpm dsh web --patch C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\cordis.patch.yml
```

- **真实模型请求需要 API key**:启动前设置 `$env:DEEPSEEK_API_KEY = 'sk-...'`
  (或 dsh 支持的其他凭据方式)。
- 无 key 也能启动:插件照常**加载并 apply**(compact 后端、`/compact*`、vibeMode
  服务、`/vibe`、read/write/edit/read_image/inspect_image 工具、advisor 运行时、
  wechat 行 `enabled:false` 不启动轮询),Web 服务监听 `http://127.0.0.1:3080`;
  只有发起模型请求时才会失败(无凭据)。
- 也可用 `run.ps1` 一键完成构建 + 启动:

  ```powershell
  powershell -ExecutionPolicy Bypass -File C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\run.ps1
  ```

## web 面的 read/write 替换(为什么需要 preset 步骤 + 怎么做)

**机制事实**(详见 `doc/RESEARCH-FS-TOOLS.md` §3-§4、§6 与 dsh 源码):
- web profile 的**宿主层 `tool-fs` 已被 web-app bundle 禁用**;模型可见的 fs 工具
  来自 **agent preset**(`standard`/`code` 等,每个 preset 在 agent 作用域挂一行
  `tool-fs`)。同 scope 内同名注册会直接抛错,preset 的 `read` 会 shadow 全局的
  `read` —— 所以只改宿主层对 web 无效。
- **profile 无法自带 preset 目录**:`apps/cli/src/profile-boot.ts` 在组合时把
  agent-presets 行的 `roots` 无条件钉死为部署自带的 `config/agent-presets/`
  (只读),patch 里写的 `roots` 会被覆盖;可写的 roster 根只有
  `$DSH_HOME/.agent-presets`。patch 唯一能动的键是 `default`。
- 因此实现的是 **选项 (b)**:profile 仓库**自带成品 preset**(`standard` 去掉
  `tool-fs` 行,其余原样),用户把目录拷进 `~/.dsh/.agent-presets/` 即可;同时
  patch 把 web 默认 preset 设为 `standard-rw` —— 这是机制允许的、最接近
  选项 (a) 的「profile 的 preset 解析自动拾取」。
- **CLI/TUI(仅 base bundle 的 profile,如 `--profile tui`)不需要 preset
  步骤**:同一 patch 在宿主层禁用 `tool-fs` + 以 host 行注册 tool-read-write,
  直接完成替换(选项 c 自动满足)。

**安装 preset(一次,仅 web 面需要)**:

```powershell
Copy-Item -Recurse C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\agent-presets\standard-rw $env:USERPROFILE\.dsh\.agent-presets\standard-rw
```

之后新会话默认就用 `standard-rw`(patch 已设 `default: standard-rw`)。临时想用
官方 preset:web 设置 → Agent presets 选择器切回 `standard`/`code`/`minimal` 即可。
`standard-rw` 与 `standard` 的唯一区别就是**不挂 `tool-fs` 行** —— 宿主层的
read/write 套件因此不被 shadow;`tool-fs-search`(glob/grep)、`fs` 服务与
`fs-observation-policy` 保持部署原样。

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
(`standard-rw` 仍需按上文装进 `~/.dsh/.agent-presets/`)。

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
(compact-mode/vibe-mode/advisor)与命名导出 `apply`+`Config`(read-write/wechat)
两种形态都能直接作为插件。

### vibe-mode 的入口文件位置

vibe-mode 的 tsconfig 把构建产物输出到 `lib/types/`(tsc -b),package.json 的
`main`/`exports` 已指向 `lib/types/index.js`(已修正,与构建产物一致;默认导出
`VibeModeController`)。其余插件均确认存在 `lib/index.js` 且与 package.json
`main` 一致。

### mode-ui 与 resume(持久化目录 annex)

四个模式/渠道事件(`compact/mode`、`vibe/mode`、`advisor/status`、
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
- `standard`/`code` preset 在 preset 层挂 `tool-fs` 的 `read` 等 → **shadow 掉**
  宿主层 tool-read-write 的同名工具(合法,不同层),所以不改 preset 时 web 面行为
  不变;
- `standard-rw` 不挂 `tool-fs` → agent 直接看到宿主层的 omp 风格
  read/write/edit/read_image/inspect_image;
- 同一层内重复注册则抛错——因此 host 行与 preset 行不会同时以同名共存于一层。

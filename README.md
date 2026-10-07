# omp-2-dsh — DeepSeek Harness 插件套件(omp 移植)

纯插件套件:把 13 个可运行插件(压缩审阅树、compact 模式、omp 风格读写工具、会话顾问、
微信渠道、模式状态 UI、复核门、问题板、任务板、规则层、编排器、会话对等通道、会话组织)
作为**独立 `@dsh-plugin/*` 包**附加到 DeepSeek Harness(dsh),**不改动 dsh 核心**。
所有插件在启动时经由 cordis 覆盖层(`--patch`)加载,按**包名**从 dsh profile 目录解析。

- **对齐 dsh 版本:`0.2.0-rc.2`**(所有 `@deepseek-ai/dsh-*` 依赖与 `cordis@4.0.4` 已按该版本
  reconcile)。**不要**装成 `0.2.1-alpha.1`(alpha 预览),见「dsh 版本对齐说明」。
- 每个插件的 git 历史通过 `git subtree` 完整保留(见各 `plugins/*` 目录)。
- 除 13 个插件外还有一个**纯库包** `@dsh-plugin/dsh-worker-spawn`(目录 `plugins/dsh-worker-spawn`):
  无插件入口、无 Context key,**不进 profile 挂载**;它是 `orchestrator`(`subtask_parallel`)
  的 worker 派发基座,随套件一起构建/分发。
- 构建产物 `lib/` 不进 git;可运行插件以 GitHub Release 的 `dsh-suite-<version>.zip` 资产分发
  (dsh 按包名加载,`lib/` 必须随包附带)。

## 插件清单

| 插件 | 包名 | 客户端面 |
|---|---|---|
| tree-engine | `@dsh-plugin/tree-engine` | — |
| compact-mode | `@dsh-plugin/dsh-compact-mode` | — |
| tool-read-write | `@dsh-plugin/dsh-tool-read-write` | — |
| advisor | `@dsh-plugin/dsh-advisor` | — |
| channel-wechat | `@dsh-plugin/dsh-channel-wechat` | — |
| mode-ui | `@dsh-plugin/dsh-mode-ui` | 浏览器 bundle(`lib/client.js`) |
| review-gate | `@dsh-plugin/dsh-review-gate` | — |
| question-board | `@dsh-plugin/dsh-question-board` | — |
| task-board | `@dsh-plugin/dsh-task-board` | — |
| rules | `@dsh-plugin/dsh-rules` | — |
| orchestrator | `@dsh-plugin/dsh-orchestrator` | — |
| peers | `@dsh-plugin/dsh-peers` | — |
| org | `@dsh-plugin/dsh-org` | 浏览器 bundle(`lib/client.js`):组织面板(`conversation.input.dock`,接管会话列表 + 解除/禁止) |

> 上表 13 个插件之外,还有共享库 **`dsh-worker-spawn`**(`@dsh-plugin/dsh-worker-spawn`):
> 纯库包,无插件入口、无 Context key,不作为 profile 行挂载,仅作为 `orchestrator` 的运行时依赖
> 随套件构建/分发。合计 **14 个包(13 插件 + 1 共享库)**。

> **`channel-wechat` 默认停用**。微信渠道需要**一个 WeChat iLink bot 账号**,且与 hermes 网关
> 共用同一账号(互斥,后启动者 403)。启用方法见「channel-wechat 激活(可选)」。

---

## 前置条件

1. **Node ≥ 24**。注意:dsh 自身 `engines` 是 `^22.19.0 || >=24.0.0`,但本套件
   (`tool-read-write`、`channel-wechat`)要求 **≥24**,所以请装 Node 24+。
2. **dsh CLI(版本钉住)**:
   ```powershell
   npm i -g @deepseek-ai/dsh@0.2.0-rc.2
   ```
   > 本套件对齐 `0.2.0-rc.2`(当前 npm `latest`),`npm i -g @deepseek-ai/dsh` 默认装的即是它。
   > **不要**装 `0.2.1-alpha.1`(alpha 预览,与本套件不兼容),见「dsh 版本对齐说明」。
   > 也可以用本地 dsh monorepo(见「给开发者/贡献者」),但**终端用户推荐装已发布 CLI**。
3. **`DEEPSEEK_API_KEY` 环境变量**(发起真实模型请求必需):
   ```powershell
   # PowerShell
   $env:DEEPSEEK_API_KEY = 'sk-...'
   ```
   ```bash
   # macOS / Linux
   export DEEPSEEK_API_KEY='sk-...'
   ```
   > **没有 key 也能启动**:插件照常加载并 apply(compact 后端、`/compact*`、read/write 工具、
   > advisor 运行时、orchestrator 编排、mode-ui 徽章、wechat 行 `enabled:false` 不轮询),Web 服务监听
   > `http://127.0.0.1:3080`;只有发起模型请求时才会因无凭据失败。
4. **pnpm 11 仅「构建/开发」路径需要**,从 Release 安装**不需要** pnpm
   (见下方「从 Release 安装」,它只复制文件 + 跑 `dsh web`,不跑 pnpm)。

`dsh web` 首次启动会自动初始化 `web` profile;插件的 `@deepseek-ai/*` 运行时依赖由**已安装的
dsh CLI 自动满足**(见「从 Release 安装」第 3 步末的依赖说明)。

---

## 从 Release 安装(终端用户,一次性)

> **这是终端用户路径**:从 GitHub Release 拿到预构建 zip,**不需要** clone 仓库、**不需要**源码构建。
> 想改源码/打包的开发者走「给开发者/贡献者」。

### 1. 下载并解压

从 GitHub Release 下载 `dsh-suite-<version>.zip`,解压到**任意位置**。解压得到自包含目录
`dsh-suite-0.1.0/`。

### 2. 解压后目录(即 zip 里的布局)

```
dsh-suite-0.1.0/
├── @dsh-plugin/              # 14 个预构建包(13 插件 + 共享库 dsh-worker-spawn;
│   │                         #  每个目录名 = 包名去掉 @dsh-plugin/ 前缀,loader 据此按包名解析)
│   ├── tree-engine/          ├── dsh-compact-mode/
│   ├── dsh-tool-read-write/  ├── dsh-advisor/
│   ├── dsh-channel-wechat/   ├── dsh-mode-ui/          # 客户端面插件带 lib/client.js
│   ├── dsh-review-gate/      ├── dsh-question-board/
│   ├── dsh-task-board/       ├── dsh-rules/
│   ├── dsh-orchestrator/     ├── dsh-peers/
│   ├── dsh-org/              └── dsh-worker-spawn/     # 纯库(无插件入口)
├── agent-presets/
│   └── standard-rw/          # preset.yml + agent.cordis.yml(web 面 read/write 替换所需)
├── cordis.patch.yml          # 覆盖层(zip 根)
├── setup.ps1                 # Windows 一次性安装
├── start.ps1                 # Windows 日常启动
├── README.md
└── VERSION
```

> 注意:上面的目录是 **zip 解压后的样子**,跟仓库源码树(`plugins/`、`scripts/`、`profiles/` 等)**无关**。

### 3. 安装

#### Windows(PowerShell)

在解压出的 `dsh-suite-0.1.0/` 目录里运行:

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

它会一次性完成三件事(幂等,可重复运行):

- 把 14 个预构建包(13 插件 + 共享库 `dsh-worker-spawn`)复制到
  `~/.dsh/profiles/web/node_modules/@dsh-plugin/`
  (cordis Loader 与 client-modules 据此**按包名**解析每一行,含 `mode-ui`/`dsh-org` 的 `lib/client.js`);
- 把 `standard-rw` preset 复制到 `~/.dsh/.agent-presets/standard-rw/`
  (web 面 read/write 替换所必需,见「web 面的 read/write 替换」);
- 把覆盖层落到 `~/.dsh/dsh-suite/cordis.patch.yml`(供 `start.ps1` / 手动命令引用);
- 逐个校验每个包的可运行入口与 `lib/`。

#### macOS / Linux(手动等价——zip 里只有 `.ps1`,没有 `.sh`)

`setup.ps1` / `start.ps1` 是 **Windows-only PowerShell**。在 macOS/Linux 上手动执行
(以下以 `~/.dsh` 为 dsh home,`$DSH_HOME` 已另行设置时请替换):

```bash
cd ~/dsh-suite-0.1.0
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

# 1) 14 个预构建包 → web profile node_modules
mkdir -p "$DSH_HOME/profiles/web/node_modules/@dsh-plugin"
cp -R @dsh-plugin/* "$DSH_HOME/profiles/web/node_modules/@dsh-plugin/"

# 2) standard-rw preset
mkdir -p "$DSH_HOME/.agent-presets"
cp -R agent-presets/standard-rw "$DSH_HOME/.agent-presets/"

# 3) 覆盖层(供 dsh web --patch 引用)
mkdir -p "$DSH_HOME/dsh-suite"
cp cordis.patch.yml "$DSH_HOME/dsh-suite/cordis.patch.yml"
```

> 若用的是本地 dsh monorepo,更规范的做法是逐包 `dsh plugin --profile web add <abs path>`
> (会把包写进 profile 的 `package.json` 并以 `link:` 依赖安装)。但**从 Release 安装时不需要**。

#### 插件的 `@deepseek-ai/*` 依赖(自动满足,无需单独 install)

zip 里的插件只带 `package.json + lib/**`,**不带 `node_modules`**;它们 import 的
`@deepseek-ai/dsh-*` 等运行时依赖如何解析?—— dsh 每次启动都会维护
`$DSH_HOME/profiles/node_modules/` 的**依赖闭包**(对称链接已安装 dsh 的所有
`dependencies`/`peerDependencies`),Node 从任何 profile 向上查找会命中该目录。所以
**只要装的是对齐版本的 dsh CLI(`0.2.0-rc.2`),这些依赖就自动满足,不需要 pnpm install。**

> **排错**:若启动报 `Cannot find module '@deepseek-ai/dsh-*'`,几乎总是**dsh 版本不匹配**
> (装成了 `0.2.1-alpha.1`)。请重装:PowerShell `npm i -g @deepseek-ai/dsh@0.2.0-rc.2`;
> 然后**完整重启 dsh**(Loader 对解析失败的包名会缓存负面结论,旧进程不会自愈)。

---

## 启动

Windows 一键脚本(等价于下面的手动命令,**无构建、无安装**):

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1
```

or 手动/跨平台(推荐理解这一条):

```powershell
dsh web --patch "$HOME\.dsh\dsh-suite\cordis.patch.yml"
```

```bash
# macOS / Linux
dsh web --patch "$HOME/.dsh/dsh-suite/cordis.patch.yml"
```

> **`--patch` 的含义**:它接收**一个补丁文件的路径**——即那条 cordis 覆盖层
> (`cordis.patch.yml`)。`start.ps1`(Windows)内部就是用
> `dsh web --patch ~/.dsh/dsh-suite/cordis.patch.yml`。额外参数(如 `--dump-config`)
> 追加在 `--patch ...` 之后透传给 dsh。也可以直接指向解压目录里的
> `cordis.patch.yml` 而不跑 setup(只要 14 个预构建包与 preset 已就位)。

---

## 首次使用 / 验证插件已激活

### 离线验证(无需 API key)

在 dsh 侧组合配置、**不导入任何插件模块**:

```powershell
dsh web --patch "$HOME\.dsh\dsh-suite\cordis.patch.yml" --dump-config
```

输出应包含:

- 被禁用:`compaction-basic`、`command-compact`、`tool-fs`(均 `disabled: true`);
- 新插入(12 个插件行):`compact-mode`、`tool-read-write`、`advisor`(enabled +
  defaultTools/immuneTurns/syncBacklog)、`orchestrator`(reviewersPerRound/fanOut 等)、
  `mode-ui`(config 空)、`review-gate`(protectedPaths 等)、`channel-wechat`(`enabled: false`)、
  `question-board`、`rules`、`task-board`、`peers`、`org`(均默认 config);
- preset 选择行:`agent-preset-registry`(`default: standard-rw`)。

### 在线验证(需 API key)

1. 打开 `dsh web`(浏览器,`http://127.0.0.1:3080`),**新建并打开一个会话(conversation)**。
   - 头部工具栏会出现 **COMPACT / ADVISOR / WECHAT** 三个徽章;
   - 这些徽章渲染在**已打开的会话里,不是首页(home)**。
2. 命令可用性:
   - `/advisor on` 开会话顾问;`/compact` 触发 compact 模式(及 `/compact restore` 一键重放运行时状态);
   - `/org on|off|claim|relinquish|forbid|list` 管理会话组织;`/wechat status` 查微信渠道状态(未激活时报告未启用);
   - read 工具走 omp 风格 selector:`read package.json:1-20`、`read agent://<workerId>`、
     归档/SQLite/URL 读取(来自 `dsh-tool-read-write`)。
3. **关于 WECHAT**:徽章默认显示**未启用**(channel-wechat `enabled: false`)。它需要
   **WeChat iLink bot 账号**才可用,见「channel-wechat 激活(可选)」。

---

## dsh 版本对齐说明

- 本套件所有 `@deepseek-ai/dsh-*` 依赖与 `cordis@4.0.4` 按 **`0.2.0-rc.2`** reconcile。
- npm 上 `@deepseek-ai/dsh` 的 `latest`/`next` 目前是 **`0.2.0-rc.2`**(本套件已对齐);更新的 `0.2.1-alpha.1` 挂在 `alpha` 标签(0.2.1 的早期预览,含 invariant 移除等变更),本套件**未对齐它**。
- 因此 `npm i -g @deepseek-ai/dsh`(latest)即可;若要钉住版本:`npm i -g @deepseek-ai/dsh@0.2.0-rc.2`。**不要**装 `0.2.1-alpha.1`。
- 模式状态(mode 开关、worker roster、advisor/wechat 状态)是**插件自有状态**,持久化为
  `$DSH_HOME/storages/*-state.json`,重启后 UI 仍可读。

---

## channel-wechat 激活(可选)

`channel-wechat` **默认停用**。启用需:一个 WeChat iLink bot 账号;先停掉与它共用同一
iLink 账号的 **hermes** 网关(同账号互斥,后启动者 403);再把补丁里 `channel-wechat` 行的
`enabled` 改为 `true` 并补上账号凭据。补丁在安装后位于 `~/.dsh/dsh-suite/cordis.patch.yml`
(改完**完整重启** dsh)。字段集见插件 `src/config.ts`(严格校验,未知键会响亮失败)。

---

## 给开发者 / 贡献者

> 下面的构建 / 发布 / 开发只针对**要改源码或重新打包**的人;终端用户跳过本节。

### 构建(一次性)

从源码构建全部 14 个包(依赖序:worker-spawn → tree-engine → compact-mode →
tool-read-write → advisor → channel-wechat → mode-ui → review-gate →
question-board → rules → peers → org → task-board → orchestrator):

```powershell
pnpm install      # 根工作区一次安装,解析全部 14 包(compact-mode 经 workspace:* 拉 tree-engine)
pnpm run build    # 按依赖序构建(产生各包 lib/;客户端面插件 mode-ui、dsh-org 额外产出 lib/client.js)
pnpm run typecheck
```

> `release.ps1` 内部按同一依赖序自动构建;`profiles/main/run.ps1` 也是。

### 发布

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release.ps1            # 读 VERSION
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.1.0
```

产物 `release/dsh-suite-<version>.zip`;脚本只构建 + 打包,不推送 tag/创建 Release,末尾打印需
手动执行的 `git tag` / `gh release create` 命令。CI(`.github/workflows/release.yml`)在推送
`v*` tag 时自动完成同样构建 + 上传资产。

### 开发

- 单根工作区管理全部插件;改客户端面插件(mode-ui、dsh-org)源码后必须重建 `lib/client.js`,
  浏览器加载的是磁盘上的 bundle。
- 覆盖层(`profiles/main/cordis.patch.yml`)会禁用 `compaction-basic` / `command-compact` /
  `tool-fs`;web profile 上 stock `tool-fs` 行是幂等 no-op,具体理由见文件内注释。
- 更细的机制(Loader 如何按包名解析、为何禁用基座行、`standard-rw` preset 的同名 shadow 规则、
  web 面 read/write 替换、wechat 激活步骤等)见仓库内 `profiles/main/README.md`
  (仅源码仓库有,不在 Release zip 里)。

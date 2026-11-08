# omp-2-dsh — DeepSeek Harness 插件套件(omp 移植)

纯插件套件:把 11 个可运行插件(omp 风格读写工具、会话顾问、微信渠道、模式状态 UI、复核门、
问题板、任务板、规则层、编排器、会话对等通道、会话组织)与 2 个纯库包(worker 派发基座
`dsh-worker-spawn`、共享原语 `dsh-util`)作为**独立 `@dsh-plugin/*` 包**附加到
DeepSeek Harness(dsh),**不改动 dsh 核心**。11 个可运行插件在启动时经由 cordis 覆盖层
(`--patch`)加载,按**包名**从 dsh profile 目录解析;2 个纯库由各自的依赖方 import。

> **压缩能力已移除**:本套件不再实现 compaction(原 `compact-mode` 与 `tree-engine` 已删除)。
> 上下文压缩交给外部 bundle(billion-context 等),套件里的 `compaction-basic` /
> `command-compact` 行仍保持禁用,由那个 bundle 提供 `ctx.compaction` 与 `/compact*`。
>
> **advisor / org / 微信通道各自可独立安装**(不必装整套):见「独立安装」一节。

- **对齐 dsh 版本:`0.2.1-rc.2`**(所有 `@deepseek-ai/dsh-*` 依赖按 `^0.2.1-rc.2` 声明,
  仅支持 0.2.1-rc.2,不再兼容 0.2.0-rc.2;`cordis@~4.0.5`)。见「dsh 版本对齐说明」。
- 每个插件的 git 历史通过 `git subtree` 完整保留(见各 `plugins/*` 目录)。
- 另有 **2 个纯库包**(均无插件入口、无 Context key、**不进 profile 挂载**):
  `@dsh-plugin/dsh-worker-spawn`(目录 `plugins/dsh-worker-spawn`)是 `orchestrator`
  (`subtask_parallel`)的 worker 派发基座,
  `@dsh-plugin/dsh-util`(目录 `plugins/dsh-util`)是规则层/复核门/任务板等共用的 glob 匹配器
  与 XML 转义、session-id 归一化;两者随套件一起构建/分发。
  (`dsh-advisor`、`dsh-org`、`dsh-peers` 已不依赖 `dsh-util`:它们各自内联了所需原语,以便单独安装。)
- 构建产物 `lib/` 不进 git;可运行插件以 GitHub Release 的 `dsh-suite-<version>.zip` 资产分发
  (dsh 按包名加载,`lib/` 必须随包附带)。

## 插件清单

| 插件 | 包名 | 客户端面 |
|---|---|---|
| tool-read-write | `@dsh-plugin/dsh-tool-read-write` | — |
| advisor | `@dsh-plugin/dsh-advisor` | 浏览器 bundle(`lib/client.js`):会话顾问建议卡片(`conversation.chat.node` 键控座位,按严重度 nit/concern/blocker 分级着色);header 的 `ADVISOR · N` 徽标(点开是设置面板:开关 + 审查模型选择器,`conversation.session.header.utilities`) |
| channel-wechat | `@dsh-plugin/dsh-channel-wechat` | 浏览器 bundle(`lib/client.js`):header 的 `WECHAT on/off` 徽标(`conversation.session.header.utilities`,点击执行 `/wechat status`);host 侧同名包注册 `wechatChannel` 投影(独立安装也自带) |
| mode-ui | `@dsh-plugin/dsh-mode-ui` | 浏览器 bundle(`lib/client.js`) |
| review-gate | `@dsh-plugin/dsh-review-gate` | — |
| question-board | `@dsh-plugin/dsh-question-board` | 浏览器 bundle(`lib/client.js`):问题面板(按提问者分组的待答问题) |
| task-board | `@dsh-plugin/dsh-task-board` | 浏览器 bundle(`lib/client.js`):任务面板(需求清单/工作集,行内闭环与重开);header 的 `任务 N` chip(`conversation.session.header.utilities`,点击定位面板) |
| rules | `@dsh-plugin/dsh-rules` | — |
| orchestrator | `@dsh-plugin/dsh-orchestrator` | — |
| peers | `@dsh-plugin/dsh-peers` | — |
| org | `@dsh-plugin/dsh-org` | 浏览器 bundle(`lib/client.js`):组织面板(`conversation.input.dock`:org 开关、按标题/角色/工作区搜索的接管目标选择器、逐行解除/禁止);header 的 `ORG · role` 徽标与复制会话 ID(`conversation.session.header.utilities`);侧栏全局会话行标"归 X 管/孤儿"(`sidebar.session.row.leading` + `hover`)与接管按钮(`sidebar.workspaces.session.row.action`,先自动开启当前会话的 org 模式再 `/org claim`) |

`rules` / `review-gate` / 路径门共用)、XML 转义与 session-id 归一化。
> 合计 **13 个包(11 个可运行插件 + 2 个共享库)**。

> **`channel-wechat` 默认停用**。微信渠道需要**一个 WeChat iLink bot 账号**,且与 hermes 网关
> 共用同一账号(互斥,后启动者 403)。启用方法见「channel-wechat 激活(可选)」。

---

## 独立安装(advisor / 三层组织架构 / 微信通道)

这三个包**自带 `dsh.bundle` 声明和 `cordis.patch.yml`**,因此可以像任何第三方插件一样单独装进
任意 profile,**不需要**本套件其余任何包:

| 你想单独要的能力 | 装这个包 | 包内自带的行 |
|---|---|---|
| 会话顾问(host + 建议卡片 + header `ADVISOR · N` 徽标) | `dsh-advisor` | `advisor` |
| 秘书 / 负责人 / worker 三层组织(面板 + `ORG · role` 徽标 + 侧栏归属标记 + 会话间投递) | `dsh-org` | `peers` + `org` |
| 微信通道(host 长轮询 + `/wechat` 命令 + header `WECHAT` 徽标) | `dsh-channel-wechat` | `channel-wechat` |

> **ADVISOR 徽标是设置面板**:点开后可以开关顾问,并从模型目录里选审查者模型(首项「跟随主会话模型」)。
> 选择持久化在 `$DSH_HOME/storages/advisor-state.json`,重启后仍生效;命令行等价:`/advisor model`(报告当前)、
> `/advisor model <provider/model>`(设置)、`/advisor model follow`(恢复跟随)。改模型时若顾问已开启,
> 正在跑的审查者会被重建以套用新模型。

```powershell
# 装进已有的 web profile:之后直接 `dsh web` 就带着它启动
dsh plugin --profile web add C:\path\to\dsh-suite-0.2.1\@dsh-plugin\dsh-advisor
dsh plugin --profile web add C:\path\to\dsh-suite-0.2.1\@dsh-plugin\dsh-org
dsh plugin --profile web add C:\path\to\dsh-suite-0.2.1\@dsh-plugin\dsh-channel-wechat

# 也可以直接指向源码目录(git 仓库里就是可安装单元)
dsh plugin --profile web add C:\Users\me\Documents\omp-2-dsh\plugins\dsh-advisor
dsh plugin --profile web add C:\Users\me\Documents\omp-2-dsh\plugins\dsh-channel-wechat
```

> 全局 `dsh` 低于 0.2.1-rc.2 时(0.2.0-rc.2 会禁用插件行),改用 dsh monorepo 的本仓 CLI:
> `node <dsh仓库>\apps\cli\lib\bin.js plugin --profile web add <包路径>`(本机 dsh 仓库为
> `C:\Users\Vantage_XLST\Documents\dsh`)。

要点:

- `dsh plugin add` 把包写成该 profile 的 `dependencies`(本地目录用 `link:`),再把 bundle 追加到
  该 profile `package.json` 的 `dsh.profile.bundles`;首次使用会自动初始化 profile(含
  `@deepseek-ai/dsh-base`)。
- **新 profile 需要 web 面**:自动初始化出来的 profile 只含 `dsh-base`,没有浏览器界面。要么装进
  已有的 `web` profile(推荐),要么手动把 `@deepseek-ai/dsh-web-app` 加到该 profile 的
  `dsh.profile.bundles` 里。
- **org 不需要另装 `dsh-peers`**:`peers` 的编译产物已 vendor 进
  `@dsh-plugin/dsh-org/lib/peers`,由包内 `cordis.patch.yml` 的 `@dsh-plugin/dsh-org/peers` 行加载;
  `dsh-peers` 仍是唯一源码,构建脚本会校验 vendor 出来的代码没有 `@dsh-plugin/*` 运行时依赖。
- **三个包都不依赖 `dsh-util`**:顾问的 XML 转义、org/peers 的 glob/转义/session-id 归一化都已内联,
  所以单装一个包不会有"缺 `@dsh-plugin/dsh-util`"的死链。
- **微信通道的徽标与 `wechatChannel` 投影随包发布**(`lib/client.js` + host 侧投影注册),
  单装 `dsh-channel-wechat` 就有 `WECHAT` 徽标,不需要 `dsh-mode-ui`;套件里 mode-ui 的旧副本
  暂时保留(槽位 id 不同,可共存),收尾时移除。
- **微信通道默认 `enabled: true` 但没有凭证不轮询**:`accountId`/`token` 留空时插件照常加载、
  徽标显示 `WECHAT off`,`/wechat` 回答「配置未通过启动检查」;填好凭证(见包内 README
  「连接微信」)后重启即可。同一 iLink 账号与 hermes 互斥,先用 `hermes gateway stop` 停掉
  hermes 网关(或把 `stateDir` 指向 hermes 的 `weixin/` 目录接管状态)。
- 想调配置:在该 profile 的 `cordis.patch.yml`(或 `--patch` 覆盖层)里写同名行,后层按 id 整体替换;
  也可以直接改 `node_modules/@dsh-plugin/<name>/cordis.patch.yml` 的默认值。
- 验证:
  ```powershell
  dsh --profile web --dump-config | Select-String -Context 0,6 'dsh-advisor'
  ```
  末尾应出现 `# == @dsh-plugin/dsh-advisor` 段与 `- id: advisor` 行;启动后浏览器页面
  `__DSH_BOOT__` 里会出现 `@dsh-plugin/dsh-advisor/client.js` 条目(org 同理,会带 `peers` + `org` 两行;
  微信为 `- id: channel-wechat` 与 `@dsh-plugin/dsh-channel-wechat/client.js`)。
- 卸载:`dsh plugin --profile web remove @dsh-plugin/dsh-advisor`(org、channel-wechat 同理)。

---

## 前置条件

1. **Node ≥ 24**。注意:dsh 自身 `engines` 是 `^22.19.0 || >=24.0.0`,但本套件
   (`tool-read-write`、`channel-wechat`)要求 **≥24**,所以请装 Node 24+。
2. **dsh CLI(版本钉住)**:
   ```powershell
   npm i -g @deepseek-ai/dsh@0.2.1-rc.2
   ```
   > 本套件对齐 `0.2.1-rc.2`;`npm i -g @deepseek-ai/dsh` 默认装 `latest`,若不是 0.2.1-rc.2
   > 请按上面的命令钉住版本(插件依赖为 `^0.2.1-rc.2`,0.2.0-rc.2 不再支持)。
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
   > **没有 key 也能启动**:插件照常加载并 apply(read/write 工具、advisor 运行时、orchestrator
   > 编排、mode-ui 徽章、wechat 行 `enabled:false` 不轮询),Web 服务监听
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
`dsh-suite-0.2.1/`。

### 2. 解压后目录(即 zip 里的布局)

```
dsh-suite-0.2.1/
├── @dsh-plugin/              # 13 个预构建包(11 插件 + 2 共享库:dsh-worker-spawn、dsh-util;
│   │                         #  每个目录名 = 包名去掉 @dsh-plugin/ 前缀,loader 据此按包名解析)
│   ├── dsh-tool-read-write/  ├── dsh-advisor/       # dsh-advisor / dsh-org 也可单独安装
│   ├── dsh-channel-wechat/   ├── dsh-mode-ui/          # 客户端面插件(带 lib/client.js):
│   ├── dsh-review-gate/      ├── dsh-question-board/   #   dsh-advisor、mode-ui、question-board、
│   ├── dsh-task-board/       ├── dsh-rules/            #   task-board、dsh-org
│   ├── dsh-orchestrator/     ├── dsh-peers/
│   ├── dsh-org/              ├── dsh-worker-spawn/     # 纯库(无插件入口)
│   └── dsh-util/             # 纯库(无插件入口:共享 glob/XML/session-id)
├── cordis.patch.yml          # 覆盖层(zip 根;内含 standard-rw preset 声明行)
├── setup.ps1                 # Windows 一次性安装
├── start.ps1                 # Windows 日常启动
├── README.md
└── VERSION
```

> 注意:上面的目录是 **zip 解压后的样子**,跟仓库源码树(`plugins/`、`scripts/`、`profiles/` 等)**无关**。

### 3. 安装

#### Windows(PowerShell)

在解压出的 `dsh-suite-0.2.1/` 目录里运行:

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

它会一次性完成三件事(幂等,可重复运行):

- 把 13 个预构建包(11 插件 + 2 共享库 `dsh-worker-spawn`、`dsh-util`)复制到
  `~/.dsh/profiles/web/node_modules/@dsh-plugin/`
  (cordis Loader 与 client-modules 据此**按包名**解析每一行,含 `dsh-advisor`/`mode-ui`/`question-board`/`task-board`/`dsh-org` 的 `lib/client.js`);
- 把覆盖层落到 `~/.dsh/dsh-suite/cordis.patch.yml`(供 `start.ps1` / 手动命令引用);
- 逐个校验每个包的可运行入口与 `lib/`。

> **preset 不再有安装步骤**:`standard-rw` 现在是覆盖层里的**声明行**
> (`@deepseek-ai/dsh-agent-preset`,`config.plugins` = 原 `agent.cordis.yml` 的行)。
> 0.2.0-rc.2 已废弃 preset 目录机制,`~/.dsh/.agent-presets/` 不再被任何代码读取。

#### macOS / Linux(手动等价——zip 里只有 `.ps1`,没有 `.sh`)

`setup.ps1` / `start.ps1` 是 **Windows-only PowerShell**。在 macOS/Linux 上手动执行
(以下以 `~/.dsh` 为 dsh home,`$DSH_HOME` 已另行设置时请替换):

```bash
cd ~/dsh-suite-0.2.1
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

# 1) 15 个预构建包 → web profile node_modules
mkdir -p "$DSH_HOME/profiles/web/node_modules/@dsh-plugin"
cp -R @dsh-plugin/* "$DSH_HOME/profiles/web/node_modules/@dsh-plugin/"

# 2) 覆盖层(供 dsh web --patch 引用;standard-rw preset 随此行一起就位)
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
**只要装的是对齐版本的 dsh CLI(`0.2.1-rc.2`),这些依赖就自动满足,不需要 pnpm install。**

> **排错**:若启动报 `Cannot find module '@deepseek-ai/dsh-*'`,几乎总是**dsh 版本不匹配**。
> 请重装:PowerShell `npm i -g @deepseek-ai/dsh@0.2.1-rc.2`;
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
> `cordis.patch.yml` 而不跑 setup(只要 15 个预构建包已就位——preset 随覆盖层一起来)。

---

## 首次使用 / 验证插件已激活

### 离线验证(无需 API key)

在 dsh 侧组合配置、**不导入任何插件模块**:

```powershell
dsh web --patch "$HOME\.dsh\dsh-suite\cordis.patch.yml" --dump-config
```

输出应包含:

- 被禁用:`compaction-basic`、`command-compact`、`tool-fs`(均 `disabled: true`);
- 新插入(11 个插件行):`tool-read-write`、`advisor`(enabled +
  defaultTools/immuneTurns/syncBacklog)、`orchestrator`(reviewersPerRound/fanOut 等)、
  `mode-ui`(config 空)、`review-gate`(protectedPaths 等)、`channel-wechat`(`enabled: false`)、
  `question-board`、`rules`、`task-board`、`peers`、`org`(均默认 config);
- preset 行:`agent-preset-registry`(`default: standard-rw`)+ 紧随其后的声明行
  `preset-standard-rw`(`@deepseek-ai/dsh-agent-preset`,`config.id: standard-rw`,`order: 5`,
  `config.plugins` = 24 个叶子行 + 3 个 `cordis:group`)。

> 离线 `--dump-config` **不导入插件模块**,因此它只证明声明行结构正确;preset 是否真能激活
> (每个插件名可解析、每份 config 通过各自 schema)由在线新建会话验证——那一步会挂载并审计整棵
> preset 树,失败即响亮报错。

### 在线验证(需 API key)

1. 打开 `dsh web`(浏览器,`http://127.0.0.1:3080`),**新建并打开一个会话(conversation)**。
   - 头部工具栏会出现 **ADVISOR**(来自 `dsh-advisor`)与 **WECHAT**(来自 `dsh-channel-wechat`;
    套件内 `mode-ui` 仍保留旧副本,收尾后移除)两个徽章
  (COMPACT 徽章随压缩能力一起移除了);
   - 这些徽章渲染在**已打开的会话里,不是首页(home)**。
2. 命令可用性:
   - `/advisor on` 开会话顾问;
   - `/org on|off|claim|relinquish|forbid|list` 管理会话组织;`/wechat status` 查微信渠道状态(未激活时报告未启用);
   - read 工具走 omp 风格 selector:`read package.json:1-20`、`read agent://<workerId>`、
     归档/SQLite/URL 读取(来自 `dsh-tool-read-write`)。
3. **关于 WECHAT**:套件 profile-main 里 `channel-wechat` 默认 `enabled: false`,徽章显示**未启用**;
   独立安装的包默认 `enabled: true` 但没有凭证不轮询(仍是 `WECHAT off`)。两种方式都需要
   **WeChat iLink bot 账号**才可用,见「channel-wechat 激活(可选)」与包内 README「连接微信」。

---

## dsh 版本对齐说明

- 本套件所有 `@deepseek-ai/dsh-*` 依赖按 **`^0.2.1-rc.2`** 声明,目标版本 **`0.2.1-rc.2`**;`cordis@~4.0.5`。
- npm 上 `@deepseek-ai/dsh` 的 `latest`/`next` 目前是 **`0.2.1-rc.2`**(本套件已对齐);**0.2.0-rc.2 不再兼容**——插件实现无条件依赖 0.2.1 的 `ctx.subagents.startActivation`。
- 钉住版本:`npm i -g @deepseek-ai/dsh@0.2.1-rc.2`。
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

从源码构建全部 13 个包(依赖序:dsh-util → worker-spawn → tool-read-write → advisor →
channel-wechat → mode-ui → review-gate → question-board → rules → peers → org →
task-board → orchestrator):

```powershell
pnpm install      # 根工作区一次安装,解析全部 13 包
pnpm run build    # 按依赖序构建(产生各包 lib/;客户端面插件 dsh-advisor、mode-ui、question-board、task-board、dsh-org 额外产出 lib/client.js)
pnpm run typecheck
```

> `release.ps1` 内部按同一依赖序自动构建;`profiles/main/run.ps1` 也是。

### 发布

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release.ps1            # 读 VERSION
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.2.1
```

产物 `release/dsh-suite-<version>.zip`;脚本只构建 + 打包,不推送 tag/创建 Release,末尾打印需
手动执行的 `git tag` / `gh release create` 命令。CI(`.github/workflows/release.yml`)在推送
`v*` tag 时自动完成同样构建 + 上传资产。

### 开发

- 单根工作区管理全部插件;改客户端面插件(dsh-advisor、mode-ui、question-board、task-board、dsh-org)源码后必须重建 `lib/client.js`,
  浏览器加载的是磁盘上的 bundle。
- 覆盖层(`profiles/main/cordis.patch.yml`)会禁用 `compaction-basic` / `command-compact` /
  `tool-fs`;前两者让位给外部压缩 bundle(billion-context 等),如果你不跑这类 bundle,
  删掉那两行即可恢复 stock 压缩;web profile 上 stock `tool-fs` 行是幂等 no-op。
  具体理由见文件内注释。
- 更细的机制(Loader 如何按包名解析、为何禁用基座行、`standard-rw` preset 声明行与它的同名
  shadow 规则、web 面 read/write 替换、wechat 激活步骤等)见仓库内 `profiles/main/README.md`
  (仅源码仓库有,不在 Release zip 里)。

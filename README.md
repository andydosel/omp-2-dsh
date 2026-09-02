# omp-2-dsh — DeepSeek Harness 插件套件(omp 移植)

`omp` 风格插件套件的 DeepSeek Harness(dsh)移植:把 7 个可运行插件(压缩审阅树、
compact 模式、DIRECTOR(vibe)调度、读写工具、会话顾问、微信渠道、模式状态 UI)
连同发布/Profile/文档工具链收进**单一 git 仓库、单一 pnpm 工作区**。

- 每个插件的 git 历史已通过 `git subtree` 完整保留(见各 `plugins/*` 目录的提交)。
- 构建产物 `lib/` 不进 git;可运行插件以 GitHub Release 的 zip 资产形式分发
  (dsh 按包名加载,`lib/` 必须随包附带)。

## 目录结构

```
omp-2-dsh/
├── plugins/             # 7 个插件源码(单 pnpm 工作区,依赖序构建)
│   ├── dsh-tree-engine/      # 只读/追加树引擎(compact 审阅树的语义核心)
│   ├── dsh-compact-mode/     # shake-first 局部省略后端(ctx.compaction + /compact*)
│   ├── dsh-vibe-mode/        # DIRECTOR 调度模式 + 工作子代理(带浏览器 client 面)
│   ├── dsh-tool-read-write/  # 统一 read/write/edit/read_image/inspect_image
│   ├── dsh-advisor/          # 会话顾问(reviewer 子代理,severity 分级建议)
│   ├── dsh-channel-wechat/   # 微信(iLink)渠道(默认停用)
│   └── dsh-mode-ui/          # 模式状态 Web UI(头部徽章 + 投影单元,带 client 面)
├── scripts/             # 发布/安装/启动工具链
│   ├── release.ps1      # 按依赖序构建 7 插件并打包 dsh-suite-<version>.zip
│   ├── setup.ps1        # 把预构建 zip 安装进 ~/.dsh(一次性)
│   └── start.ps1        # 日常启动:单条 dsh web --patch 命令(无构建/无安装)
├── profiles/main/       # 可运行 profile 补丁层(cordis.patch.yml + agent-presets + run.ps1)
├── doc/                 # 设计/研究/可行性/E2E 文档
├── .github/workflows/   # release.yml:打 tag 时构建并上传 zip 资产
├── package.json         # 根工作区(workspaces: plugins/*;build/typecheck/test 便利脚本)
├── pnpm-workspace.yaml  # 单工作区根(packages: plugins/*,nodeLinker: hoisted)
├── VERSION              # 套件版本唯一来源
└── README.md
```

## 插件清单

| 插件 | 包名 | 客户端面 |
|---|---|---|
| tree-engine | `@dsh-plugin/tree-engine` | — |
| compact-mode | `@dsh-plugin/dsh-compact-mode` | — |
| vibe-mode | `@dsh-plugin/dsh-vibe-mode` | 浏览器 bundle(`lib/client.js`) |
| tool-read-write | `@dsh-plugin/dsh-tool-read-write` | — |
| advisor | `@dsh-plugin/dsh-advisor` | — |
| channel-wechat | `@dsh-plugin/dsh-channel-wechat` | — |
| mode-ui | `@dsh-plugin/dsh-mode-ui` | 浏览器 bundle(`lib/client.js`) |

> **`channel-wechat` 默认停用**。它与 hermes 网关共用同一个 iLink bot 账号
> (互斥,后启动者 403)。启用需先在 `profiles/main/cordis.patch.yml` 把该行
> `enabled` 改为 `true`、补上账号凭据,并先停掉 hermes(详见该文件注释)。

## 前置条件

- **Node ≥ 24**(`tool-read-write`、`channel-wechat` 要求)。
- **pnpm 11**(仓库根 `packageManager` 已钉 `pnpm@11.7.0`)。
- **dsh 已发布的 CLI**:`npm i -g @deepseek-ai/dsh`(`dsh web` 首次启动会自动
  初始化 `web` profile);或用本地 dsh monorepo 构建(`start.ps1 -DshRoot <path>`)。
- **`DEEPSEEK_API_KEY`** 环境变量,启动前设置。

## 构建(一次性)

从源码构建全部 7 个插件(依赖序:tree-engine → compact-mode → vibe-mode →
tool-read-write → advisor → channel-wechat → mode-ui):

```powershell
pnpm install      # 根工作区一次安装,解析全部 7 插件(compact-mode 经 workspace:* 拉 tree-engine)
pnpm run build    # 按依赖序构建(产生各插件 lib/;vibe-mode / mode-ui 额外产出 lib/client.js)
pnpm run typecheck
```

> `release.ps1` 内部按同一依赖序自动构建;`run.ps1`(profiles/main/)也是。

## 安装(一次性)

1. 从 GitHub Release 下载 `dsh-suite-<version>.zip` 并解压(任意位置)。
2. 在解压出的 `dsh-suite-<version>/` 目录里运行:

   ```powershell
   powershell -ExecutionPolicy Bypass -File setup.ps1
   ```

   它把 7 个包复制到 `~/.dsh/profiles/web/node_modules/@dsh-plugin/`,把
   `standard-rw` preset 装进 `~/.dsh/.agent-presets/`,把覆盖层落到
   `~/.dsh/dsh-suite/cordis.patch.yml`,并逐个校验 `lib/`。可重复运行(幂等)。

## 日常启动

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1
```

或用本地 monorepo:

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1 -DshRoot C:\Users\you\dsh
```

等价于 `dsh web --patch ~/.dsh/dsh-suite/cordis.patch.yml` —— **无构建、无安装**。
额外参数(如 `--dump-config`)加在脚本名之后透传。

## 发布

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release.ps1            # 读 VERSION
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.1.0
```

产物 `release/dsh-suite-<version>.zip`;脚本只构建 + 打包,不推送 tag/创建 Release,
末尾打印需手动执行的 `git tag` / `gh release create` 命令。CI(`.github/workflows/release.yml`)
在推送 `v*` tag 时自动完成同样的构建 + 上传资产。

## 开发

- 单根工作区管理全部插件;改客户端面插件(vibe-mode / mode-ui)源码后必须重建
  `lib/client.js`,浏览器加载的是磁盘上的 bundle。
- 覆盖层(`profiles/main/cordis.patch.yml`)会禁用 `compaction-basic` /
  `command-compact` / `tool-fs`;web profile 上 stock `tool-fs` 行是幂等 no-op,
  具体理由见文件内注释。
- 更细的机制说明(Loader 如何按包名解析、为何禁用基座行、`standard-rw` preset 的
  同名 shadow 规则、wechat 激活步骤等)见 `profiles/main/README.md`。

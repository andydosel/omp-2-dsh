# dsh-advisor

DeepSeek Harness 的**独立顾问插件**：给一个会话挂一个（或多个）只读审查者模型，它盯着主会话的增量，发现风险就往对话里投递卡片。

一个包自带全部能力，装完即可用，不依赖套件里的其它插件：

| 能力 | 实现 |
|---|---|
| 审查者运行时（挂载 / 增量投递 / 严重度分级 / 免疫轮次 / WATCHDOG） | `src/`，host 侧 |
| 建议事件 `advisor/advice`（持久化在会话日志里，刷新页面不丢） | `src/types.ts` |
| 对话中的建议卡片（severity 颜色 + 折叠） | `client/src/advisor-advice-node.tsx`、`AdvisorAdviceCard.tsx` |
| 会话右上角的 **ADVISOR** 徽标 + 设置弹窗（开关 / 审查模型选择） | `client/src/badge/` |
| `/advisor` 命令 | `src/commands.ts` |

安装单元 = 本目录一个包（`dsh.bundle.patch` + `dsh.client`），**不要**把它和套件仓库里其它插件混装。

---

## 0. 前置条件

| 项 | 要求 |
|---|---|
| dsh | `>= 0.2.1-rc.2`（全局 `dsh` 0.2.0-rc.x 会禁用所有插件行，不要用） |
| Node | `>= 24` |
| pnpm | `11.x`（dsh 的插件安装走 pnpm） |
| 系统 | Windows / macOS / Linux |

命令里的 `dsh` 指你的 dsh 启动器。在 monorepo 开发检出里就是 `node apps/cli/lib/bin.js`，两者参数相同。

---

## 1. 安装（三选一）

### 路线 A：从 `.tgz` 安装（**其它机器推荐**）

装的是一个自带 `lib/` 的压缩包，不绑定源码目录，删掉源码也不影响运行。

1. 先在**任意一台**已检出分支的机器上构建并打包：

   ```powershell
   git clone -b standalone-advisor https://github.com/andydosel/omp-2-dsh.git
   cd omp-2-dsh
   pnpm install
   pnpm --filter @dsh-plugin/dsh-advisor run build
   cd plugins/dsh-advisor
   pnpm pack --pack-destination C:\dsh-vendor
   ```

   产物：`dsh-plugin-dsh-advisor-<version>.tgz`（约 95 KB，内含 `lib/`、`cordis.patch.yml`、本文件）。

2. 把 tgz 复制到目标机器上的**固定位置**（例如 `~/.dsh/vendor/advisor/`），然后：

   ```powershell
   dsh plugin --profile web add "$env:USERPROFILE\.dsh\vendor\advisor\dsh-plugin-dsh-advisor-0.2.1.tgz" --config.confirmModulesPurge=false
   ```

> ⚠️ **profile 名要用 `web`**。profile 首次创建时按名字套模板（`web` = `dsh-base` + `dsh-web-app`），自定义名字只会拿到 `dsh-base`，**没有浏览器界面**，徽标和卡片也就无从显示。
>
> ⚠️ profile 的 `package.json` 会记录 **tgz 的绝对路径**（`"file:C:/.../dsh-plugin-dsh-advisor-0.2.1.tgz"`）。tgz 被移动或删除后，该 profile 后续任何 `pnpm install` 都会失败。要换位置，先 `dsh plugin --profile web remove @dsh-plugin/dsh-advisor`，再从新路径重新 `add`。

### 路线 B：直接装源码目录（**只有持有本仓库的那台机器**）

适合边改边用：改完 `pnpm run build` + 重启即生效，无需重装。

```powershell
git clone -b standalone-advisor https://github.com/andydosel/omp-2-dsh.git
cd omp-2-dsh
pnpm install
pnpm --filter @dsh-plugin/dsh-advisor run build
dsh plugin --profile web add "$PWD\plugins\dsh-advisor" --config.confirmModulesPurge=false
```

> ⚠️ 这条路线记录的是 `link:C:/.../plugins/dsh-advisor`（符号链接）。**源码目录不能移动或删除**，否则插件加载即失败。只在你打算长期保留该检出时使用。
>
> pnpm 会警告 "The linked in dependency will not resolve the peer dependencies…"——这是预期的：`@deepseek-ai/dsh-*` 这些 peer 由 dsh 运行时本身提供，不需要装进 profile。

### 路线 C：Web 界面

启动 Web GUI → 设置 → **插件** → **Add plugin**，填 tgz 的绝对路径、本地目录绝对路径，或（发布后的）包名。规则与路线 A/B 相同：tgz 是拷贝，目录是链接。

---

## 2. 重启并验证

插件在启动时加载，**装完必须重启** dsh 进程：

```powershell
Get-NetTCPConnection -LocalPort 3080 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
dsh web --port 3080 --no-open
```

四项验证，缺一说明没装上：

1. **组合里有这一行**
   ```powershell
   dsh --profile web --dump-config | Select-String -Pattern 'dsh-advisor' -Context 0,6
   ```
   应看到 `id: advisor` / `name: '@dsh-plugin/dsh-advisor'` / `disabled: false`。
2. **客户端 bundle 被下发**：打开页面源码，`__DSH_BOOT__` 的 entries 里应有 `@dsh-plugin/dsh-advisor`，其 URL 形如 `plugins/??@dsh-plugin/dsh-advisor/client.js&rev=...`（约 28 KB）。
3. **右上角出现 ADVISOR 徽标**，点开是设置弹窗（开关 + 审查模型）。
4. **命令可用**：在会话里发 `/advisor status`，应回复当前开关、审查者数量、模型路由。

### 确认装到的是「PTC 修复版」

从 `52566b4` 起，PTC 预设下的建议投递才正常。快速自检：

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-plugin\dsh-advisor\lib\advisor.js" -Pattern 'ptc-dispatch' -SimpleMatch
```

命中 ≥ 1 行即含修复。若为 0 行，说明装的是旧包：PTC 预设下审查者会说「已提交建议」但对话里永远没有卡片。

---

## 3. 配置

配置写在 profile 的 `cordis.patch.yml`（或任意 `--patch` 覆盖层）里，按行 id `advisor` 覆盖：

```yaml
- id: advisor
  config:
    enabled: true
    defaultTools: [read, grep, glob]
    immuneTurns: 3
    syncBacklog: 0
    model: ''
    maxPromptTokens: 8192
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 加载时挂上顾问；UI 里的开关会覆盖它并持久化 |
| `defaultTools` | `['read','grep','glob']` | 审查者允许调用的全局工具（`advise` 由插件自己注册，不受此限制）。必须与预设实际提供的工具求交集后非空，否则审查者创建失败并报错 |
| `immuneTurns` | `3` | 成功投递一次 concern/blocker 后，后续同级建议降级为 aside 的主会话轮数 |
| `syncBacklog` | `0` | 主会话轮末的有界追赶等待：`0` 关闭，或 `1/3/5`（≤30s） |
| `model` | `''` | 审查模型 `provider/model`；空 = 跟随主会话。UI 弹窗可改，覆盖此值 |
| `maxPromptTokens` | `8192` | 单次增量/基线提示的 token 上限（≥256） |
| `watchdog.userDir` | `''` | 用户级 WATCHDOG 检索目录，空 = `$DSH_HOME` |
| `watchdog.projectMarkers` | `['.git']` | 判定项目根的目录标记 |
| `costTable` | `{}` | 按 `provider/model`、`provider` 或 `model` 计价（每 1M token），仅用于 `/advisor status` |
| `agentId` | `''` | 指定挂载的 agent；空 = 第一个非审查者 agent |

## 4. 命令

```
/advisor                 # 同 /advisor status
/advisor on|off
/advisor status          # 开关、审查者数量、模型、token 计数
/advisor model <provider/model>   # 指定审查模型
/advisor model follow             # 跟随主会话模型（也可用 default / -）
```

UI 侧的弹窗做的也是同样的事（开关 → `/advisor on|off`，选择器 → `/advisor model <route>`）。

## 5. 行为要点

- **审查者只读**：`composeReviewer` 用 `tools.restrict({ allow })` 收敛工具面，再注册 `advise`（不受 allow 掩码影响），并把审批钉为 `never`。
- **两种预设都支持**：标准预设下审查者调原生 `advise`（日志是 `tool/call` + `tool/result`）；PTC 预设下审查者只有 `run_code`，`advise` 是被桥接的子调用（日志是 `tool/ptc-dispatch`）。插件两条路都监听，**不需要改预设**。
- **状态文件**：设置了 `DSH_HOME` 时写 `$DSH_HOME/storages/advisor-state.json`，否则写服务器进程的当前工作目录下的 `./.advisor-state.json`；记录开关 / 审查者数 / 模型。
- **数据边界**：主会话的增量（用户消息、助手消息）会作为提示发给审查者模型；只在本机 dsh 进程内传递，不额外上报。

## 6. 升级 / 卸载

```powershell
# 升级（tgz 路线）：换新包后重装 + 重启
dsh plugin --profile web remove @dsh-plugin/dsh-advisor
dsh plugin --profile web add "$env:USERPROFILE\.dsh\vendor\advisor\dsh-plugin-dsh-advisor-<新版本>.tgz" --config.confirmModulesPurge=false

# 升级（源码路线）
cd omp-2-dsh && git pull && pnpm --filter @dsh-plugin/dsh-advisor run build

# 卸载
dsh plugin --profile web remove @dsh-plugin/dsh-advisor
```

## 7. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | 非交互终端。加 `--config.confirmModulesPurge=false` |
| `ERR_PNPM_UNEXPECTED_STORE` | 与 dsh 用的 store 不一致。加 `--config.store-dir=<dsh 的 pnpm store>` |
| `incompatible with dsh 0.2.1-rc.2` | 误装了注册表上的老版本（`0.0.1-rc.1`）。改用 `.tgz` 或本地目录，不要 `add @deepseek-ai/dsh-web-app` |
| 页面没有 UI / 只有 API | profile 不是 `web` 模板，缺 `dsh-web-app`。重建 profile 或手工把 `@deepseek-ai/dsh-web-app` 加进 `dsh.profile.bundles` |
| 徽标显示 `ADVISOR off` | 顾问被关。点徽标打开开关，或 `/advisor on` |
| 审查者说「已提交建议」，对话无卡片 | 旧包在 PTC 预设下丢了投递（见 §2 自检）。升级到含 `ptc-dispatch` 的构建 |
| `顾问审查者 "…" 在 agent 工具集中没有可用工具` | `defaultTools` 与当前预设求交集为空。改 `defaultTools` 或换预设 |
| 卡片不随页面刷新 | 卡片渲染自 `advisor/advice` 会话事件；确认插件 host 行已加载（§2 第 1 项） |

## 8. 开发

```powershell
cd plugins/dsh-advisor
pnpm run typecheck   # host + client 的 tsc --noEmit
pnpm test            # vitest
pnpm run build       # tsc host + tsc client + tsdown（产出 lib/index.js 与 lib/client.js）
```

`lib/` 不进版本库：任何「从 git 安装」的机器都必须先本地构建。

# 研究：dsh 启动成本、最快日启动流、git 上手（onboarding）

> 只读调研，未改任何代码、未发布。基线：`dsh` monorepo `C:/Users/Vantage_XLST/Documents/dsh`；插件 `dsh-plugin/plugin/`；profile-main `plugin/profile-main/run.ps1` + `cordis.patch.yml`；家目录 `~/.dsh/`（profiles/web、.agent-presets/standard-rw）。所有结论附源码 `file:line` 证据。标 `[INFERENCE]` 为合理推断（无直接源码），其余为源码/实测依据。

---

## 0. 结论先行（TL;DR）

1. **run.ps1 慢不是因为 tsx，也不是因为启动本身慢。** tsx 源码启动只多 ~0.28s（实测 `0.349s` vs 内置 `0.068s`），启动配置组合仅 ~1.1s。真正慢的是 run.ps1 在**每次运行都重建 7 个插件 + 重装 7 次**（第 41–57 行 build 循环、第 65–76 行 add 循环），这一步与源码是否改动无关，每次都全量做。
2. **最快的日启动 = 只 boot，不 build、不 install。** 插件已 build + 已 link: 装进 web profile 后，一条命令即可：
   `pnpm dsh web --patch "<dsh-plugin/plugin/profile-main/cordis.patch.yml>"`。
3. **dsh 需要 build + install 是因为 cordis 插件是「包名 → 已构建 ESM `lib/index.js`」，客户端面是「包名 → 已构建浏览器 bundle `lib/client.js`」**，二者都必须按包名从 profile 目录解析（`client-modules` 用 `createRequire(profileDir)` 解析，且对解析失败做**永不过期**负缓存）。omp 的 extension-dir 模型是运行时直接载源码（TS source = 可运行），所以没有 build/publish 这一步。
4. **git 上手推荐 "clone + 一次性 setup 脚本 + 日启动 boot"**，而不是预编译 tarball。因为 `lib/` 在两处都被 `.gitignore` 忽略（`dsh@.gitignore:4`、每个插件 `lib/`），git 只会给源码，不能给 `lib/`；"clone → 拖进目录 → 直接 start" 在 dsh 上不成立。对第三方最省事的是 **`npm i -g @deepseek-ai/dsh`（发布 CLI，自带 `lib/`，免 tsx、免建 monorepo）+ 只 build/install 自己的插件**。

---

## 1. 启动成本分解：tsx 是不是大头？（Q1）

### 1.1 两种启动方式

- **源码启动（monorepo 开发用）**：根 `package.json:136`
  ```json
  "dsh": "node --import tsx/esm apps/cli/src/bin.ts"
  ```
  `node --import tsx/esm` 挂 ESM-only hook，运行时把 `.ts` 转译后再导入。
- **发布 CLI（npm 安装用）**：`apps/cli/package.json:14-15`
  ```json
  "bin": { "dsh": "lib/bin.js" }
  ```
  发布的 `@deepseek-ai/dsh` 跑的是 **tsdown 打包好的 `lib/bin.js`**（`apps/cli/lib/bin.js`，内含 `args/profile-boot/plugin/dump-config` 分块，`//#region lib/types/args.js` 内联），纯 JS，无 tsx。

### 1.2 tsx 到底转译了多少源码？→ 很少，不是大头

源码启动 `apps/cli/src/bin.ts` 只 import 了 4 个本地 `.ts` 文件：
- `apps/cli/src/bin.ts:14` `import { parseDshArgs } from './args.ts'`
- `apps/cli/src/bin.ts:31,41,46` 动态 `import('./profile-boot.ts')` / `import('./plugin.ts')` / `import('./dump-config.ts')`

而 bin.ts/profile-boot.ts 里所有 `@deepseek-ai/*` 包导入（如 `@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-home-paths`）都**按包名解析到各包的 `main: lib/index.js`（已构建 ESM）**，tsx 不会去转译 `.js`。所以 tsx 只负责 `apps/cli/src/*.ts` 这 5–6 个文件，**不是整仓重转译**。

**实测**（无副作用，`:version` 在 `parseDshArgs` 内提前退出，不碰 profile）：
```
node --import tsx/esm apps/cli/src/bin.ts --version   0.349s
node apps/cli/lib/bin.js --version                   0.068s
```
→ tsx 源码启动比内置多 ~0.28s。`--version` 能在 0.35s 内完成，本身就证明 tsx **没有**在启动时重转译整个 monorepo（否则会是几十秒）。整仓 js→js 转译/打包的成本在 `pnpm run build`（`PLUGIN_DEV_PLAYBOOK.md:498`：`build 16.3s`），属于**一次性/增量构建，不是每次 boot 都做**。

### 1.3 启动真正的重活（而且是每次 boot 都做、无跨进程缓存）

`runProfile`（`apps/cli/src/profile-boot.ts`）→ `boot()`（`packages/boot/app-boot/src/index.ts:757`）→ `ctx.plugin(Loader)` + `mountRootInclude` → 对**每一条 entry row** `loader.create()`：

| 步骤 | 位置 | 成本量级 | 是否每次 redo |
|---|---|---|---|
| profile discovery：`loadProfile` + `healProfilesModuleFallback`（BFS 依赖闭包 + 建符号链接） | `app-boot/src/profile.ts:104,223,371` | 轻（文件读 + 闭包遍历） | 每次 |
| patch 叠加：`loadOptionalPatches`/`loadOverlayPatches`（YAML 解析）+ `composeEntries` | `profile-boot.ts:142`；`profile.ts:413` | 轻 | 每次 |
| **插件按行 `import()`**：`entry.ts:280` `tree.import(options.name,…)` → `tree.ts:155` `internal.import(name, ctx.baseUrl, {})`（Node 真实 ESM loader，从 profile 目录按**包名**解析 → `lib/index.js`） | `vendor/loader/src/config/entry.ts:280`；`tree.ts:145-159` | **中**（每条插件一次模块加载） | 每次（node 模块缓存仅进程内，进程退出即失效） |
| client-modules 扫描：`createRequire(ctx.baseUrl)` 读各 `dsh.client` 包 package.json + 哈希 `lib/client.js` | `packages/client/modules/src/index.ts:212,332,394` | 轻（fs 读 + hash），但**缺 `lib/client.js` 就抛 `MissingClientBundleError`**（`:65`） | 每次 |
| 插件 `apply()`（compact-mode/vibe-mode/advisor/wechat/mode-ui 注册） | 各插件 `src/index.ts` | 轻（进程内注册） | 每次 |
| web 服务器启动（`dsh-web-app` bundle） | `bundle/web-app/` | 中 | 每次 |
| `assertEntriesActivated`（fail-loud：任一条激活失败即抛） | `index.ts:784` | 轻 | 每次 |

**跨进程能保留的只有**：构建产物 `lib/`（gitignored，`dsh@.gitignore:4`）、`~/.dsh/profiles/web/node_modules/@dsh-plugin/*` link 符号链接、`healProfilesModuleFallback` 建出的 `~/.dsh/profiles/node_modules` 符号链接、以及 `*.tsbuildinfo`（`dsh@.gitignore:5`）。**插件模块缓存、config compose、client 扫描、服务器启动都随每次进程重建**。

`PLUGIN_DEV_PLAYBOOK.md:499` 给出基准：`pnpm dsh --profile web --dump-config` = **1.1s**（配置组合 + 层叠加），说明「profile discovery + patch compose」在源码启动下也不慢。注意 `--dump-config` **不 import 插件 ESM、不起服务器**，所以完整 boot = 1.1s(compose) + N 条插件模块加载 + client 扫描 + 服务器启动 ≈ 数秒级。

### 1.4 所以 run.ps1 为什么慢？

`plugin/profile-main/run.ps1` 每次运行都做三段：
1. **build 全部 7 个插件**（第 41–57 行，依赖顺序 foreach）——7 次 `pnpm run build`。里面 `dsh-vibe-mode` 是三段式 `tsc -b && tsc -p tsconfig.client.json && tsdown`，`dsh-mode-ui` 是 `tsc -p && tsdown`（多一步 bundling），其余是单步 `tsc -p`。**与源码是否改动无关，每次都全量执行。**
2. **add 全部 7 次**（第 65–76 行，`pnpm dsh plugin --profile web add $dir`）——幂等（第 61 行注释明言 "Already up to date"），但每次仍要各 spawn 一次 pnpm 解析。
3. **boot**（第 81 行 `pnpm dsh web --patch $patchFile @args`）——真实启动，~秒级。

慢 = **第 1 步（7 次 build）+ 第 2 步（7 次 add）**，不是第 3 步。tsx 只是第三步里的一个 ~0.28s 小项。

---

## 2. 最快日启动（build+install 一次，之后只 boot）（Q2）

### 2.1 前提：插件已 build + 已装进 web profile

`~/.dsh/profiles/web/package.json` 已含全部 7 个插件的 `link:` 依赖：
```json
"@dsh-plugin/dsh-advisor": "link:C://Users//Vantage_XLST//Documents//dsh-plugin//plugin//dsh-advisor",
"@dsh-plugin/dsh-mode-ui":  "link:...//plugin//dsh-mode-ui",
...
```
`~/.dsh/profiles/web/node_modules/@dsh-plugin/*` 里的 7 个符号链接都已存在。`plugin/profile-main/cordis.patch.yml` 的行 `name` 全部是包名（`@dsh-plugin/...`），cordis loader 会从 profile 目录按包名解析。

### 2.2 确认：加一个最小的 `start.ps1` / 一行命令，跳过 build/install

在 `dsh` monorepo 下（默认 `C:\Users\Vantage_XLST\Documents\dsh`），只 boot：

```powershell
# start.ps1（日启动，免 build/install）
param([string]$DshRoot = 'C:\Users\Vantage_XLST\Documents\dsh')
$patch = 'C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\cordis.patch.yml'
Push-Location $DshRoot
try { pnpm dsh web --patch $patch @args; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
finally { Pop-Location }
```

即 `pnpm dsh web --patch "<patch 绝对路径>"`。**不需要** `pnpm run build`、**不需要** `dsh plugin --profile web add`。

- **插件按包名从 `~/.dsh/profiles/web` 解析** → 已装，无需再装（`node_modules/@dsh-plugin/*` 符号链接在 → "no re-install needed"）。
- **`dsh plugin --profile web add` 是否幂等？** 是。`run.ps1:61` 注释明言重跑是 "Already up to date"（重新 add 同一 link: 依赖）；`profile.ts` 的 `reconcilePlugins`（`apps/cli/src/plugin.ts`）按「已安装状态」而非「依赖 diff」做对账。
- **monorepo 自身要不要先 build？** 要一次。因为 `pnpm dsh web`（源码启动）import `@deepseek-ai/*` → `lib/index.js`。但这是**一次性/增量**（`dsh@.gitignore:4` 的 `lib/` 已存在、`tsconfig.host.tsbuildinfo`/`tsconfig.client.tsbuildinfo` 已存在、monorepo lib 字节码今天 13:05 生成过），且 run.ps1 本来**不 build monorepo**（只 build 插件）。

### 2.3 跳过 build/install 会退化的前置条件（必须知道的坑）

1. **客户端 bundle 必须是构建产物**：`dsh-mode-ui`、`dsh-vibe-mode` 声明 `dsh.client` + `exports["./client"]`，启动时 client-modules 读 `lib/client.js` 并哈希（`index.ts:62,65`）。**改了这两个插件的客户端源码（尤其 mode-ui）而不重建 `lib/client.js`** → 浏览器拿到**旧 bundle**（启动即 serve 当时磁盘上的 `lib/client.js`）；缺失时抛 `MissingClientBundleError`（"run `pnpm run build` before launch"，`index.ts:62-77`）。→ 只有这两个插件需要客户端重建。
   - 好消息：`client-hmr`（`packages/client/hmr`）对图内全部 bundle 路径做 stat-poll（`hmr/src/index.ts:130-149`），**在线**改客户端源码重建 `lib/client.js` 即可热更，无需重启；但 host 侧（投影单元等）改动仍要重启。
2. **负缓存规则**：client-modules 对「解析失败 / 无 `dsh.client`」的条目缓存**永不过期**（`index.ts:16,54`）。所以**新增 `dsh.client` 插件、改插件包名、加/删 `dsh.client` 声明**时，必须**重启**（每次 boot 是新进程，天然满足）并在启动前重跑 `add` 更新 profile manifest + 重建 client bundle。仅改 config（不动声明）不需重建。
3. **新增/移除插件本身**：要改 `cordis.patch.yml` + `dsh plugin --profile web add/remove`（更新 `~/.dsh/profiles/web/package.json` + link 目录）。

**结论：日启动命令就一条 boot；只有当你改了插件源码（尤其 mode-ui/vibe-mode 的客户端面）或动了插件清单/声明时才需要 rebuild/readd。**

---

## 3. dsh 与 omp 的加载模型对比 + 为什么（Q3）

| 维度 | omp（extension-dir 模型） | dsh（cordis 包行模型） |
|---|---|---|
| 插件形态 | `extension/` 目录下的源码 | cordis 行，`name` 是**包名**（`@dsh-plugin/...`） |
| 载入方式 | 运行时直接加载目录源码（TS source = 可运行）[INFERENCE：omp 运行时/Bun 载源码或自带转译] | loader `import()` **已构建 ESM** `lib/index.js`（`tree.ts:155` 从 profile 目录按包名解析） |
| 客户端面 | 无独立预构建 bundle [INFERENCE] | `dsh.client` 双面包，浏览器需要**预构建 bundle** `lib/client.js`（`index.ts:332,394`），按**包名**从 profile 目录解析（`index.ts:212` `createRequire(ctx.baseUrl)`），失败负缓存永不过期（`:16,54`） |
| 需要 build？ | 否（源码即运行） | **是**（TS→JS host `lib/index.js`；TS/CSS→browser `lib/client.js`） |
| 需要 install？ | 否（目录即发现） | **是**（`dsh plugin --profile web add` 把包装进 `~/.dsh/profiles/web/node_modules` 并按包名解析） |

**为什么 dsh 必须 build + install，omp 不用**：
- dsh 的 cordis loader 消费的是 `main: lib/index.js` 的 **已构建 ESM**（每个 dsh 包 `type: module`、`main: lib/index.js`，见 `PLUGIN_DEV_PLAYBOOK.md:191`）；它不跑 TS 源。浏览器端更无法跑 TS——必须有一个预构建的 `lib/client.js`（CJS closure-factory，首个 `__ModuleLoader__.load({ id, factory })`，`manifest.ts:118-128`）。所以「build」把 TS 变成宿主要的 `lib/index.js` + 浏览器要的 `lib/client.js`。
- client-modules 扫描的是**全部 loader 条目里的 `dsh.client` 包**，且**按包名**从 profile 目录 `createRequire` 解析（`index.ts:212`），对解析失败**永不过期**负缓存（`:16,54`）。这要求包真实存在于 profile 目录的 node_modules（或 fallback），所以必须「install」（`dsh plugin --profile web add`）。而 omp 用目录发现，天然免 install。

**最接近 "clone → 拖进目录 → start" 的 dsh 等效**：
- (a) **git pull + 一次性 setup 脚本（build 7 插件 + add 到 web profile），然后 `pnpm dsh web --patch`** ← 推荐。
- (b) **预编译 profile tarball**（`lib/` 含在其中，用户解压到 `~/.dsh/profiles/web`）：省掉 build/install，但 (i) `lib/` 是 gitignored（`dsh@.gitignore:4`、每个插件 `.gitignore` 的 `lib/`，git 里 0 个 `lib/` 文件），所以**不能从 git 得到**，只能另发 tarball；(ii) profile 目录是用户所有的（manifest + node_modules + link），tarball 要随每次插件改动重发；(iii) 插件开发者本地仍要重建。**不是 repo 派生、易漂移**，不推荐作为主路径。

**推荐：方案 (a)**——repo 是源码唯一来源，`lib/` 不提交，所以「clone 后 build 一次、改时再 build」是确定性的；一条 daily boot 命令。

---

## 4. 推荐的 git 上手流（clone → setup 脚本 → 日启动 boot）（Q4）

### 4.1 为什么 "clone → drop folder → start" 不成立

`lib/` 在两处都被 `.gitignore` 忽略（`dsh@.gitignore:4` `lib/`；插件仓库每个 `.gitignore` 的 `lib/`、`node_modules/`、`*.tsbuildinfo`），git 里**没有 `lib/`**（实测 `git ls-files lib` 计 0 个文件）。`PLUGIN_DEV_PLAYBOOK.md:292` 明确：**"git 装的是源码不是构建产物"**（并提示作者要用 `prepare` 脚本自包含构建，或直接发 npm 预构建产物/tarball）。

### 4.2 命令分档（一次性的 vs 每次的）

#### 一次性 setup（拿到 git 仓库后跑一次；改了插件源码后按需再跑）
```powershell
# ① dsh 本体二选一
#    (A) 快速路：发布 CLI（自带 lib/，免建 monorepo、免 tsx）  ← 第三方推荐
npm i -g @deepseek-ai/dsh
#    (B) 贡献/开发路：clone + 建 monorepo（clone≈16s, install≈22.6s, build≈16.3s, typecheck≈62.8s，见 PLUGIN_DEV_PLAYBOOK.md:494-498）
git clone https://github.com/deepseek-ai/deepseek-harness.git dsh
cd dsh && pnpm install && pnpm run build

# ② clone 插件仓库
git clone <dsh-plugin-repo> dsh-plugin

# ③ 一次性 build 全部插件（依赖顺序；vibe-mode/mode-ui 含客户 bundle）
cd dsh-plugin/plugin
foreach ($p in @('dsh-tree-engine','dsh-compact-mode','dsh-vibe-mode','dsh-tool-read-write','dsh-advisor','dsh-channel-wechat','dsh-mode-ui')) {
  Push-Location "$p"; pnpm run build; Pop-Location
}

# ④ 一次性 install 进 web profile（按包名解析 → client-modules 需要）
cd <dsh 根>
foreach ($p in @('dsh-tree-engine','dsh-compact-mode','dsh-vibe-mode','dsh-tool-read-write','dsh-advisor','dsh-channel-wechat','dsh-mode-ui')) {
  pnpm dsh plugin --profile web add "C:\...\dsh-plugin\plugin\$p"
}

# ⑤ web 前置：把标准 read/write 预设拷进用户 preset 根（patch 里 default: standard-rw 指向它）
Copy-Item -Recurse "dsh-plugin\plugin\profile-main\agent-presets\standard-rw" "$HOME\.dsh\.agent-presets\standard-rw"
```
（用发布 CLI 时 ③④ 里的 `pnpm dsh` 换成全局 `dsh`；但 `dsh` 仍从 monorepo 跑也无妨——它 import 的是已构建的 monorepo `lib/`。）

#### 日启动（每天/每次开会，一行）
```powershell
# 源码启动（monorepo 内）
pnpm dsh web --patch "C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\cordis.patch.yml"
# 发布 CLI 时等价
dsh web --patch "C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\cordis.patch.yml"
```
可封装成 `start.ps1`（见 §2.2），或加 `-DshRoot` 覆盖。

#### 改了插件源码时（按需，不是每次）
- 改**宿主面**插件（tree-engine/compact/vibe/read-write/advisor/wechat）：重 build **该插件**即可；若新增/删插件行或改 `dsh.client` 声明，还要 `dsh plugin --profile web add/remove` + 重启。
- 改**客户端面**（mode-ui / vibe-mode）：重 build **该插件**（重新生成 `lib/client.js`）+ 重启；或依赖 `client-hmr` 在线热更（改客户端 bundle 即可热更，不用重启 host）。

---

## 5. 还能更快吗（Q5）

1. **发布 CLI 替代源码启动**：`npm i -g @deepseek-ai/dsh` → 跑 `lib/bin.js`，省掉 tsx（~0.28s）与「必须 clone+build 整仓 dsh」的成本。对第三方最省事。**量级上这是主要收益**（省 monorepo 构建），tsx 那 0.28s 只是小头。标 `[INFERENCE]`：tsx 节约值来自 §1.2 实测；monorepo 构建省掉来自「发布包自带 `lib/`」。
2. **skip-rebuild 守卫**：把 daily 脚本从「无脑 build」改成「build 当且仅当 dirty」——每个插件比较 `src/**` / `tsconfig.json` 的 mtime 是否比 `lib/index.js`（宿主）或 `lib/client.js`（客户端）新，或维护一个 build-stamp；未变更就不 build。常见「没改源码」情形 = 直接 boot，秒起。
3. **tsc 增量**：`dsh-vibe-mode` 已用 `tsc -b`（走 `.tsbuildinfo`），其余插件用 `tsc -p`（每次都全量 emit）。改成 `tsc -b` 可让「没改」时的 build 更快（这是插件仓库的改动，非本调研范围，仅提示）。
4. **分离客户端构建**：只有 `dsh-mode-ui`、`dsh-vibe-mode` 需要 `lib/client.js`；guard 只在「这些插件变了」时才强制重建 client，宿主插件变化不需触发 client 重建。
5. **避免不必要的 `--dump-config` 成为 boot 前置**：`--dump-config` 只组合 config 不 import 插件，适合 CI/离线验证，不应出现在日启动里。
6. **无跨进程缓存可用**：Node 模块缓存随进程结束消失；真正能省的是**别在没改代码时重新 build**（依赖 skip-rebuild guard），以及**别把 monorepo 克隆+构建当成每日工作流**（用发布 CLI 或一次性构建 monorepo）。

---

## 6. 最终一句话回答

- **为什么 run.ps1 慢**：`run.ps1` 每次运行都**全量重建 7 个插件（第 41–57 行）+ 全量重装 7 次（第 65–76 行）**，与源码是否改动无关；真正的 boot（第 81 行）只 ~秒级。tsx 源码启动只比内置多 ~0.28s，不是瓶颈，更不是「tsx 每次重转译整个 monorepo」。
- **一次性 + 日启动命令**：
  - 一次性：`npm i -g @deepseek-ai/dsh`（或 `git clone dsh && pnpm install && pnpm run build`）+ `git clone dsh-plugin` + 逐个 `pnpm run build`（7 插件）+ `dsh plugin --profile web add <dir>`（7 次）+ `Copy-Item standard-rw 到 ~/.dsh/.agent-presets`。
  - 日启动：`pnpm dsh web --patch "<dsh-plugin/plugin/profile-main/cordis.patch.yml>"`。
- **git 消费者跑什么**：`clone`（dsh 用发布 CLI 或 monorepo、dsh-plugin 仓库）→ 一次 setup 脚本（build 插件 + add 到 web profile + 拷 preset）→ 每天一条 `dsh web --patch <patch>`。因为 `lib/` 被 gitignore、cordis 用「包名 → 已构建 ESM/browser bundle」模型，git 只能给源码不能给 `lib/`，所以没有「clone 即 start」；最省事的是发布 CLI + 只 build/install 自己的插件。

---

## 附：证据一览（file:line）

| 论断 | 证据 |
|---|---|
| 源码启动走 tsx | `dsh/package.json:136` `"dsh": "node --import tsx/esm apps/cli/src/bin.ts"` |
| 发布 CLI 跑打包产物 | `dsh/apps/cli/package.json:14-15` `"bin":{"dsh":"lib/bin.js"}` |
| tsx 只转译 CLI 本地 .ts | `dsh/apps/cli/src/bin.ts:14,31,41,46` |
| 启动主流程 | `dsh/apps/cli/src/profile-boot.ts:98,142,208,248` |
| boot()/fail-loud | `dsh/packages/boot/app-boot/src/index.ts:757,784` |
| profile discovery/heal/patch | `dsh/packages/boot/app-boot/src/profile.ts:104,152,223,371,413` |
| 插件按包名 import（真实 ESM loader） | `dsh/vendor/loader/src/config/entry.ts:217,280`；`tree.ts:145-159` |
| client-modules 负缓存 + createRequire + bundle | `dsh/packages/client/modules/src/index.ts:16,54,62,65,212,332,394` |
| 构建产物/缓存 gitignored | `dsh/.gitignore:4,5`；`dsh-plugin/plugin/*/.gitignore` 的 `lib/`；git 0 个 `lib/` 文件 |
| run.ps1 三段 | `dsh-plugin/plugin/profile-main/run.ps1:41-57,65-76,81`（:61 "Already up to date"） |
| 整仓构建/启动实测 | `dsh-plugin/doc/PLUGIN_DEV_PLAYBOOK.md:494-499`（clone 16s / install 22.6s / typecheck 62.8s / build 16.3s / dump-config 1.1s）；:282 源码启动说明；:292 "git 装的是源码" |
| profile/bundle/patch 层叠机制 | `dsh-plugin/doc/PLUGIN_DEV_PLAYBOOK.md:31-34` |
| web profile 已 install link: 依赖 | `~/.dsh/profiles/web/package.json`；`~/.dsh/profiles/web/node_modules/@dsh-plugin/*` |
| 插件 build 脚本差异 | `dsh-plugin/plugin/<p>/package.json`（vibe-mode 三段、mode-ui tsc+tsdown 出 lib/client.js） |
| tsx vs 内置实测 | 本机 `node --import tsx/esm ... --version` 0.349s vs `node lib/bin.js --version` 0.068s |

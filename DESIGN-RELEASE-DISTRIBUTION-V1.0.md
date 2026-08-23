# dsh 插件套件 GitHub Release 分发方案设计（V1.0）

> 目标：让 `@dsh-plugin/*` 这套插件（tree-engine / compact-mode / vibe-mode /
> tool-read-write / advisor / channel-wechat / mode-ui）通过 **GitHub Release
> 预构建 zip** 分发给外部用户，消费者**零 build、零 registry、零 token**，
> 用最少的步骤下载、安装、每日启动。
> 范围：设计方案 + 配套脚本（`plugin/release.ps1` / `setup.ps1` / `start.ps1`）
> + 仓库内 `run.ps1 -Fast` 镜像 + `plugin/.github/workflows/release.yml` 骨架。
> 未执行任何发布/推 tag。Windows 11。

---

## 0. 结论先行（TL;DR）

1. **用 GitHub Release 预构建 zip 绕开「`lib/` 被 gitignore」的硬阻塞。**
   dsh 的 cordis loader 按**包名**从 profile 目录 `import()` 已构建的
   `lib/index.js`（`dsh` `vendor/loader/src/config/tree.ts:155`），客户端面更要
   `lib/client.js`（`packages/client/modules/src/index.ts:212,332`，解析失败负缓
   存**永不过期**：`:16,54`）。而 `lib/` 在两处都被 `.gitignore` 忽略
   （`dsh@.gitignore:4`；每个插件 `.gitignore` 的 `lib/`），**git 仓库里 0 个
   `lib/` 文件**，所以「clone 即 start」在 dsh 上不成立。`lib/` 只能靠 git 之外
   的通道分发 —— Release 资产是最省事的那个。
2. **一次构建，打成一个 zip**，里面每个插件都是**自包含可解析包**
   `@dsh-plugin/<name>/{package.json, lib/**}`，再带上 profile 覆盖层
   `cordis.patch.yml`、代理预设 `agent-presets/standard-rw/`、消费者
   `setup.ps1` / `start.ps1` / `README.md`。
3. **消费者流程极简**：下载 Release 资产 → 解压 → 跑一次 `setup.ps1` →
   每天一条 `start.ps1`（就是 `dsh web --patch <staged patch>`，**不 build、
   不 install**）。
4. **为什么不走 npm**（对照 `RESEARCH-PUBLISH-PLAN`）：npm 路径需要 `@dsh-plugin`
   scope 归属、`npm login`、删 `private:true`、改 `workspace:*`、把 `-rc.x`
   抬到稳定版、加 `prepack` 等一堆字段改动（§7 阻塞清单），且 scoped 包默认私有
   需 `publishConfig.access:"public"`。Release 路径**无 registry / scope / auth**，
   版本直接绑 `tag = v<version>`，天然免这些前置。
5. **可选的 CI 自动化**：`plugin/.github/workflows/release.yml` 骨架，打 tag
   `v*` → 构建 7 插件 → `gh release create` 上传 `dsh-suite-<version>.zip`。
   骨架，未在 CI 实测（见 §6 待验证项）。

---

## 1. 背景与问题

### 1.1 dsh 的插件加载模型

- cordis 插件行 `name` 是**包名**（`@dsh-plugin/...`，见
  `plugin/profile-main/cordis.patch.yml` 的 `insert` 行）。loader 从 profile 目录
  按包名 `import()` 已构建 ESM `lib/index.js`（`tree.ts:155`；包 `type: module`、
  `main: lib/index.js`，见 `doc/PLUGIN_DEV_PLAYBOOK.md:191`）。
- 客户端面：`dsh-mode-ui` / `dsh-vibe-mode` 声明 `dsh.client` +
  `exports["./client"]`，client-modules 按包名从 profile 目录
  `createRequire(ctx.baseUrl)` 解析并哈希 `lib/client.js`
  （`packages/client/modules/src/index.ts:212,332,394`）；**缺 bundle 抛
  `MissingClientBundleError`**（`:65`），且对解析失败做**永不过期**的负缓存
  （`:16,54`）。
- 因此每个插件**必须是已构建的**（宿主 JS + 两个客户面插件的浏览器 bundle），
  并且**必须能按包名从 `~/.dsh/profiles/web` 解析**（在
  `node_modules/@dsh-plugin/<name>` 里）。

### 1.2 为什么 git 给不了构建产物

`lib/` 被忽略：`dsh@.gitignore:4`、以及 `dsh-plugin/plugin/<pkg>/.gitignore`
各自忽略 `lib/`（还有 `node_modules/`、`*.tsbuildinfo`）。整仓 `git ls-files lib`
= 0 个文件。`doc/PLUGIN_DEV_PLAYBOOK.md:292` 也写明「git 装的是源码不是构建产物」。

### 1.3 为什么 npm 路径卡（对照 RESEARCH-PUBLISH-PLAN §4/§7）

| 阻塞项 | 说明 |
|---|---|
| **scope 归属** | `@dsh-plugin` scope 需要存在同名 npm 用户/组织，且发布者是其成员/拥有者（`docs.npmjs.com scope` 规定）。当前无人占用但**无法匿名确认归属**。 |
| **`private:true`** | 除 vibe-mode 外其余 7 包都 `private:true`，直接 `pnpm publish` 被拒。 |
| **`workspace:*`** | `dsh-compact-mode` 依赖 `tree-engine: workspace:*`（`package.json:56`），外部消费者无法解析，须改成 `^0.1.0`。 |
| **`-rc.x` 不占 `latest`** | compact/vibe/advisor 是 `0.1.0-rc.x`，裸 `add` 装不到，要 bump 稳定版。 |
| **发布不自动构建** | 只有 `build` 无 `prepack`，`pnpm publish` 不会先跑 build。 |
| **scoped 默认私有** | 需 `publishConfig.access:"public"`。 |
| **client 依赖声明不全** | mode-ui/vibe-mode 的 `dsh.client.inject` 依赖只在 `devDependencies`。 |

这些都要改每个包的 `package.json`（任务约束：不改插件 `package.json`/源码），
且要 npm 账户/组织/token。**GitHub Release 完全绕开这一切。**

---

## 2. 分发模型：Release 预构建 zip

### 2.1 原理

构建时把每个插件 `lib/`（构建产物）+ `package.json` 打包进 zip，消费者解压后
`setup.ps1` 把每个 `@dsh-plugin/<name>` **拷贝**进
`~/.dsh/profiles/web/node_modules/@dsh-plugin/`。这样：

- cordis 按包名从 profile 目录 `import()` → 命中 `node_modules/@dsh-plugin/<name>/package.json` + 已构建 `lib/…`；
- client-modules 按包名解析 `lib/client.js` → 命中已构建浏览器 bundle；
- **不依赖 git，不依赖 npm registry，不依赖消费者本地的构建工具链。**

### 2.2 zip 布局（精确树）

`plugin/release.ps1` 生成的 `dsh-suite-<version>.zip`（顶层文件夹叫
`dsh-suite-<version>`，解压即得到同名目录）：

```
dsh-suite-<version>/
├── VERSION                          # 裸版本号，如 0.1.0
├── README.md                        # 安装/使用说明
├── setup.ps1                        # 消费者一次性安装脚本（幂等）
├── start.ps1                        # 每日启动脚本
├── cordis.patch.yml                 # profile 覆盖层（disables + 插件行 + agent-presets 选择）
├── agent-presets/
│   └── standard-rw/
│       ├── preset.yml
│       └── agent.cordis.yml
└── @dsh-plugin/                     # 直接映射 → ~/.dsh/profiles/web/node_modules/@dsh-plugin/
    ├── tree-engine/                 {package.json, lib/**}
    ├── dsh-compact-mode/            {package.json, lib/**}
    ├── dsh-vibe-mode/               {package.json, lib/**, lib/client.js + lib/client/**}   # 客户面
    ├── dsh-tool-read-write/         {package.json, lib/**}
    ├── dsh-advisor/                 {package.json, lib/**}
    ├── dsh-channel-wechat/          {package.json, lib/**}
    └── dsh-mode-ui/                 {package.json, lib/**, lib/client.js + lib/client/**}   # 客户面
```

要点：

- 每个插件只带 `package.json` + `lib/**`，**不带** `src/`、`tests/`、
  `node_modules/`、`tsconfig*`、`*.tsbuildinfo`、`pnpm-lock.yaml`。`release.ps1`
  显式只拷这两样，并删掉拷进来的 `*.tsbuildinfo` 构建缓存。
- `@dsh-plugin/` 这个目录名与 profile 的 `node_modules/@dsh-plugin/` **同名**，
  所以 `setup.ps1` 用一条 `Copy-Item` 就能把 plugins 拷到位，无需改名。
- `cordis.patch.yml`、`agent-presets/standard-rw/`、`setup.ps1`、`start.ps1`、
  `README.md` 都放在 zip 根，与 `@dsh-plugin/` 平级。

### 2.3 为什么用「拷贝到 node_modules」而不是「`dsh plugin add`」

- 消费者可能没有 `dsh-plugin` 源码仓库，`dsh plugin --profile web add <path>`
  需要 `link:` 到消费者本地路径；而拷贝是**自包含**的，不依赖解压目录长期存在，
  升级/卸载也简单。
- 已确认 loader / client-modules 都按**包名**从 profile 目录的 `node_modules`
  解析（`tree.ts:155` / `client-modules` `createRequire(ctx.baseUrl)`），**不要求**
  插件必须写进 profile `package.json` 的 `dependencies`。所以拷贝进
  `node_modules/@dsh-plugin/` 即可被解析。

> 权衡/注意：如果消费者**先**用过 `dsh plugin add`（生成了 `link:` 符号链接），
> 再跑 `setup.ps1`，`Copy-Item -Recurse -Force` 会在符号链接所在目录**就地合并**，
> 不会删除链接本身（`setup.ps1` 用的是「逐文件合并」而非「先删后拷」）。对
> Release 目标场景（全新配置）无影响；见 §9。

---

## 3. 消费者流程（精确步骤）

### 3.1 一次性安装（setup.ps1）

```
1) 从 GitHub Release 页面下载 dsh-suite-<version>.zip
2) 解压（得到 dsh-suite-<version>/ 目录）
3) 在解压目录里执行：
     powershell -ExecutionPolicy Bypass -File setup.ps1
```

`setup.ps1` 做（幂等，可重复跑）：

1. 把 zip 里每个 `@dsh-plugin/<name>` **合并拷贝**到
   `~/.dsh/profiles/web/node_modules/@dsh-plugin/<name>`（自动建目录）。
2. 把 `agent-presets/standard-rw` → `~/.dsh/.agent-presets/standard-rw`。
3. 把 `cordis.patch.yml` → `~/.dsh/dsh-suite/cordis.patch.yml`（给 start.ps1 一个
   稳定的 `--patch` 路径）。
4. 校验每个插件的 `package.json` **解析出的宿主入口**存在，且两个客户面插件
   （vibe-mode / mode-ui）的 `lib/client.js` 存在。校验用的是包 `exports["."]
   / main` 解析出的真实入口（vibe-mode 是 `lib/types/index.js`，mode-ui 是
   `lib/src/index.js`，不是扁平 `lib/index.js`）。

> `setup.ps1` 默认目标 `$HOME\.dsh`，可用 `-DshHome <path>` 覆盖（供测试/多
> profile）。它**不会**初始化 web profile —— `dsh web` 首次启动时自动
> `initProfile` 出 `web`（`packages/boot/app-boot/src/profile.ts:376-384`，
> `PROFILE_TEMPLATES.web = [dsh-base, dsh-web-app]`），也不会清掉
> `node_modules/` 里的内容。

### 3.2 每日启动（start.ps1）

```
powershell -ExecutionPolicy Bypass -File start.ps1
# 本地 monorepo 时：
powershell -ExecutionPolicy Bypass -File start.ps1 -DshRoot C:\Users\you\dsh
```

`start.ps1` 只是：

```powershell
dsh web --patch "$HOME\.dsh\dsh-suite\cordis.patch.yml"   # 或 pnpm dsh web ...（-DshRoot）
```

**没有 build、没有 install**。插件已预构建并已被 `setup.ps1` 拷入 profile，
所以每天一条命令即可。剩余参数（如 `--dump-config`）原样转发给 `dsh`。

---

## 4. 为什么 Release 比 npm 更适合这个场景

| 维度 | GitHub Release（本方案） | npm 公开（RESEARCH-PUBLISH-PLAN） |
|---|---|---|
| registry / scope | 不需要 | 需要 `@dsh-plugin` scope 归属（npm 用户或组织） |
| 认证 | 无需（下载即得） | 需要 `npm login` / 组织 token + `publishConfig.access:"public"` |
| 包字段改动 | 不改插件 `package.json` 任何字段 | 删 `private`、改 `workspace:*`、bump 稳定版、加 `prepack`、补 `peerDependencies` |
| 版本控制 | tag = `v<version>`，release 资产绑死 | dist-tag（`-rc.x` 不占 `latest`）+ 语义化版本 |
| 消费者工具链 | 零（zip 自带构建产物） | 需 pnpm（`dsh plugin add <pkg>` 转发给 pnpm） |
| 授权/私享 | 仓库公开即可；私有仓库可加 Release 私享 | public 无门禁；private/GH Packages 要 token |
| 缺点 | 需手动/CI 每次构建；`lib/` 不随 git；升级要重下 zip | 生态习惯，`dsh plugin add <pkg>` 一条命令；但前置阻塞多 |

**结论**：对这个 out-of-tree 插件套件（无公开 scope、`private:true`、`-rc.x`
版本），npm 的**前置成本 / scope 归属 / 账户认证**是硬门槛；而 Release 只是
「打一个 zip 挂到 tag」—— 开发者自己 push 即可，消费者零门槛。代价是
`lib/` 不随 git（源码仍走 git，构建产物走 Release），因此这是一条**dev = git /
consumer = Release** 的双轨。

---

## 5. 版本与发布命令

- **单源版本**：`plugin/VERSION`（当前 `0.1.0`）。
  `release.ps1` 优先读 `-Version`，否则读 `VERSION`；zip 名 = `dsh-suite-<version>.zip`；
  GitHub Release **tag = `v<version>`**。
- `release.ps1` 只构建 + 打包，**不**执行发布。结尾打印（且仅打印）文档化的命令：

  ```powershell
  git add -A && git commit -m "chore: release dsh-suite 0.1.0"
  git tag v0.1.0
  git push origin v0.1.0
  gh release create v0.1.0 ".\release\dsh-suite-0.1.0.zip" --title "dsh-suite 0.1.0" --notes "See plugin/README.md for install/usage."
  ```

  实际运行时看到的输出：

  ```
  Next steps (documented; not run here):
    git tag v0.1.0
    git push origin v0.1.0
    gh release create v0.1.0 "C:\...\plugin\release\dsh-suite-0.1.0.zip" --title "dsh-suite 0.1.0" --notes "See plugin/README.md for install/usage."
  ```

> 任务约束：本方案**未执行** `git tag` / `gh release create`（不发布）。

---

## 6. GitHub Actions 流水线（骨架）

文件：`plugin/.github/workflows/release.yml`（任务指定放在 `plugin/` 下；
实际仓库通常放根 `.github/`，若移动请同步改路径）。

触发：`push` 到 `v*` tag → `windows-latest`：

```yaml
name: release-suite
on:
  push: { tags: ['v*'] }
permissions: { contents: write }
jobs:
  build-release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4  (version: 10)
      - uses: actions/setup-node@v4 (node-version: 24, cache: pnpm)
      - name: Install
        run: |
          cd plugin
          pnpm install --frozen-lockfile
          foreach ($p in @('dsh-tool-read-write','dsh-advisor','dsh-channel-wechat','dsh-mode-ui')) {
            Push-Location $p; pnpm install --frozen-lockfile; Pop-Location
          }
      - name: Build and package
        run: |
          $ver = "${{ github.ref_name }}"; if ($ver.StartsWith('v')) { $ver = $ver.Substring(1) }
          & "${{ github.workspace }}/plugin/release.ps1" -Version $ver -OutputDir "${{ github.workspace }}/plugin/release"
      - name: Attach asset to Release
        uses: softprops/action-gh-release@v2
        with: { files: plugin/release/dsh-suite-*.zip, generate_release_notes: true }
```

**骨架，未在 CI 实测**。启用前须确认：

- 仓库是 dsh-plugin 根；workflow 位于 `plugin/` 下（若移至根 `.github/` 需改
  checkout/`release.ps1` 路径）。
- **安装拓扑**：根 workspace（`plugin/pnpm-workspace.yaml`）只管理
  tree-engine / compact-mode / vibe-mode；tool-read-write / advisor /
  channel-wechat / mode-ui 各自带独立 install。上面 Install 步骤因此「根装一次
  + 4 个独立包各装一次」。仓库收敛成单一 workspace 可简化该步。
- `softprops/action-gh-release` 需要仓库写权限（`contents: write`）与可用的
  `GITHUB_TOKEN`（默认提供）。

---

## 7. 与 npm 路径的对比（来自 RESEARCH-PUBLISH-PLAN）

- npm 方案的最终形态是：先把 5 个纯后端包发布，再发 2 个带客户面的包，最后发一个
  套件 bundle `@dsh-plugin/dsh-suite`（`dsh.bundle.patch` + dependencies 引用 7 插件），
  用户 `dsh plugin --profile web add @dsh-plugin/dsh-suite` 一键激活。
- 它**可行但门槛多**：见 §1.3 的 7 项前置改动 + scope 归属 + token。而且
  `profile-main` / `profile-personal` 作为 profile 目录**不能**作为 npm 包发布
  （`dsh.profile` 只会被 loadProfile 从 profile 目录自身读取，
  `packages/boot/app-boot/src/profile.ts:375-392`），仍需走 git/tarball 分发。
- Release 方案把「套件」直接做成 zip，**连套件 bundle 都不必 npm 化**：插件 + 覆盖层
  + 预设 + 脚本一起发。对「一个人维护、自己 push、少量外部用户」的用例，成本最低。

---

## 8. 本地 monorepo 的镜像：`run.ps1 -Fast`

`plugin/profile-main/run.ps1`（原「build + install + boot」全量脚本）**保留**，新增
`-Fast` 开关（每日/瘦身路径）：

- **build**：对每个插件，若 `package.json` 解析出的宿主入口（+ 客户面插件的
  `lib/client.js`）**已存在且不旧于** `src/`、`client/`、`tsconfig*.json`、
  `tsdown*.ts`、`package.json` 的最新 mtime，则跳过该插件 build；否则 build。
- **install**：对每个插件，若其**包名**（`@dsh-plugin/<name>` 的 `<name>`，注意
  tree-engine 的包名是 `tree-engine`，不是目录名 `dsh-tree-engine`）已能从
  `~/.dsh/profiles/web/node_modules/@dsh-plugin/<name>` 解析到，则跳过
  `dsh plugin --profile web add`；否则仅补 add 缺失的那几个。
- 全 fresh 时输出 `-Fast: all plugins fresh, skipping build` /
  `-Fast: all plugins already installed, skipping install`，然后直接 boot ——
  与消费者 `start.ps1` 的「不 build、不 install」一致（镜像）。

已实测：`powershell -ExecutionPolicy Bypass -File run.ps1 -Fast --dump-config`
在 lib 全 fresh、插件已 link 时，正确跳过 build 与 install，直接出配置组合。

---

## 9. 风险与注意事项

1. **Node ≥ 24**：`dsh-tool-read-write` / `dsh-channel-wechat` 声明
   `engines.node: ">=24"`。消费者 Node <24 时这两插件可能报错，需在 README/设计里注明。
2. **`DEEPSEEK_API_KEY`**：启动 web profile 需要该环境变量（README 已提醒）。
3. **wechat 默认 disabled**：`cordis.patch.yml` 里 `channel-wechat` 是
   `enabled: false`；且 `stateDir` 是**机器特定默认路径**
   （`C:/Users/Vantage_XLST/AppData/Local/hermes/weixin`）——对其它机器只是占位，
   只在启用才用到。启用需：`enabled: true` + 先停 hermes（同 iLink bot 账号互斥）。
4. **`setup.ps1` 默认写真实 `~/.dsh`**：会把插件拷进真实
   `~/.dsh/profiles/web/node_modules/@dsh-plugin/`。若该处已有 `dsh plugin add`
   的 `link:` 符号链接，`Copy-Item -Recurse -Force` 是**就地合并**（不删链接），
   行为安全但仍会写入真实 profile —— 因此**测试用 `-DshHome <temp>`**，正式由
   消费者本人执行。
5. **客户面改源码要重建 `lib/client.js`**：`dsh-vibe-mode` / `dsh-mode-ui` 改动
   客户端源码后必须重跑其 `build` 重新生成 `lib/client.js`，浏览器拿的是启动时
   `lib/client.js` 的产物；缺 bundle 时 `MissingClientBundleError`。靠
   `client-hmr` 在线热更可免重启 host，但 host 面改动仍需重启。
6. **负缓存与声明变化**：新增/改名插件、加/删 `dsh.client` 声明、改包名，必须
   重启（每次 boot 是新进程）并在启动前更新 profile manifest + 重建 client
   面。仅改 config 不需重建。
7. **zip 是「构建产物」而非源码**：发布前必须先在源码分支 build；`lib/` 不随 git，
   Release 资产与源码 tag **可能漂移**（先 build 再 tag 或 CI 兜底）。为此提供
   `release.ps1`（本地）与 workflow 骨架（CI）两道防线。
8. **`release.ps1` 里 `lib/client.js` 的校验**基于包 `exports["."] / main` 解析
   出的真实入口，而不是假设扁平 `lib/index.js`（vibe-mode 是 `lib/types/index.js`，
   mode-ui 是 `lib/src/index.js`），否则会误报缺文件。

---

## 10. 交付物清单

| 文件 | 作用 |
|---|---|
| `plugin/release.ps1` | 依赖顺序 build 7 插件 → 打 `dsh-suite-<version>.zip` → 打印（非执行）tag+Release 命令 |
| `plugin/setup.ps1` | 消费者一次性安装：拷 7 插件进 profile node_modules + 拷 preset + 暂存 patch + 校验入口/bundle（幂等） |
| `plugin/start.ps1` | 每日启动：`dsh web --patch <staged patch>`（不 build/install） |
| `plugin/README.md` | 随 zip 的安装/使用说明 |
| `plugin/VERSION` | 单源版本号（`0.1.0`） |
| `plugin/profile-main/run.ps1` | 本地 monorepo 全量脚本 + 新增 `-Fast` 瘦身开关 |
| `plugin/.github/workflows/release.yml` | CI 骨架：tag `v*` → build → 上传 Release 资产 |
| `doc/DESIGN-RELEASE-DISTRIBUTION-V1.0.md` | 本设计文档 |

## 附：关键证据索引

- `vendor/loader/src/config/tree.ts:155` — 按包名 `import()`（`tree.import(name, baseUrl)`）
- `vendor/loader/src/config/entry.ts:280` — loader 行 `import()` 入口
- `packages/client/modules/src/index.ts:16,54,62,65,212,332,394` — client-modules 负缓存（永不过期）、缺 bundle 抛错、按包名 `createRequire`
- `packages/boot/app-boot/src/profile.ts:376-384` — `dsh web` 对 `web` 首启自动 `initProfile`（`PROFILE_TEMPLATES.web`）
- `packages/boot/app-boot/src/profile.ts:113-125,344-405` — profile/bundle 概念、resolveBundleDir 先安装锚点后 profile 目录
- `dsh@.gitignore:4`；`dsh-plugin/plugin/*/.gitignore` — `lib/` / `node_modules/` / `*.tsbuildinfo` 被忽略；git 0 个 `lib/`
- `doc/PLUGIN_DEV_PLAYBOOK.md:191,292,494-499` — 插件 `main: lib/index.js`；「git 装的是源码」；整仓构建/启动实测
- `doc/RESEARCH-BOOT-WORKFLOW.md` — 启动成本分解、最快日启动、git 上手流
- `doc/RESEARCH-PUBLISH-PLAN.md` — npm 发布调研/阻塞/对比（§4、§5、§7）
- 本机实测：`plugin/release.ps1` 全量 build 7 插件并产出 `release/dsh-suite-0.1.0.zip`（zip 内 0 个 `*.tsbuildinfo`）；解压后 `setup.ps1` 对 `-DshHome <temp>` 跑两次（幂等），7 插件入口/2 个 client bundle/preset/staged patch 全部校验通过；`run.ps1 -Fast --dump-config` 正确跳过 build 与 install。

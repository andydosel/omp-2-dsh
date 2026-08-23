# dsh 插件套件发布方案研究（RESEARCH-PUBLISH-PLAN）

> 目标：让 `@dsh-plugin/*` 这套插件（tree-engine / compact-mode / vibe-mode / tool-read-write / advisor / channel-wechat / mode-ui）能被外部用户**快速安装**。
> 范围：仅调研，不发布、不修改任何代码。Windows 11。

---

## 0. 结论速览

**推荐蓝图（recommended publish blueprint）**

1. 先把 5 个纯后端/无客户端插件发布到 npm public：`@dsh-plugin/tree-engine` → `@dsh-plugin/dsh-compact-mode` → `@dsh-plugin/dsh-tool-read-write` / `@dsh-plugin/dsh-advisor` / `@dsh-plugin/dsh-channel-wechat`。
2. 再发布 2 个带 web 客户端面的插件：`@dsh-plugin/dsh-mode-ui`、`@dsh-plugin/dsh-vibe-mode`（二者已有 `exports["./client"]` + `dsh.client` 声明）。
3. **最后发布一个"套件"组合包** `@dsh-plugin/dsh-suite`（声明 `dsh.bundle.patch`，`dependencies` 引用上面 7 个插件，`files: ["cordis.patch.yml"]`）。
4. 终端用户**一条命令**完成安装并激活：

   ```sh
   dsh plugin --profile web add @dsh-plugin/dsh-suite
   dsh --profile web
   ```

   （更准确地说，`dsh plugin --profile web add @dsh-plugin/dsh-suite` 内部就是 `pnpm add @dsh-plugin/dsh-suite`，套件包声明 `dsh.bundle`，因此 `reconcilePlugins` 会把它追加进 `dsh.profile.bundles`，其 `cordis.patch.yml` 层随即生效。）

**阻塞清单（blockers）**

- **命名空间可用性**：`@dsh-plugin/*` 全部 `npm view` 返回 `404`（未发布）。但 npm scope 采用"用户/组织拥有"绑定 —— 要发布到 `@dsh-plugin`，必须先存在一个名为 `dsh-plugin` 的 npm **用户或组织账户**，且发布者是其成员/拥有者（见下文 §4.1）。这是**需要登录后验证**的阻塞项。
- **registry 登录/权限**：公开发布 scoped 包需 `npm login`（或组织 token）+ `publishConfig.access: "public"`（scoped 包默认私有）。当前所有 `@dsh-plugin/*` 的包**都没有** `publishConfig`；只有 `dsh-vibe-mode` 有 `access: public`。
- **`workspace:*` 指针**：`dsh-compact-mode` 依赖 `@dsh-plugin/tree-engine: "workspace:*"`（`package.json:56`）。`workspace:*` 对外部消费者无法解析，必须改成真实版本 `^0.1.0`，且 **tree-engine 必须先发布**（见 §2）。
- **`private: true`**：除 vibe-mode 外，其余 7 个包的 `package.json` 都是 `private: true`，直接 `pnpm publish` 会被拒绝（见 §1 表格）。
- **`latest` dist-tag / 预发布版本**：compact-mode（`0.1.0-rc.6`）、vibe-mode（`0.1.0-rc.6`）、advisor（`0.1.0-rc.7`）是**预发布版本**，不会自动占 `latest` dist-tag，裸 `add @dsh-plugin/dsh-compact-mode`（不带版本号）会装不到。建议首次公开发布统一 bump 到稳定 `0.1.0`。
- **构建时序**：各包目前只有 `build` 脚本，`pnpm publish` 不会自动跑 `build`。需要补 `prepack: pnpm run build`（或先在发布前手动 `pnpm run build`），否则 `lib/` 是旧的或缺失。
- **依赖对齐风险（低）**：插件依赖 `@deepseek-ai/dsh-*` 的 `^0.1.0-rc.6` / `^0.1.0-rc.7` / 精确 `0.1.0-rc.8`。已实测这些版本在 npm public 上**全部存在**（引用了 `0.1.0-rc.8`），且 caret 预发布范围解析到 `0.1.0-rc.8`（不会落到不完整的 `0.1.1-rc.2`）。低风险，但插件 pin 的 `@deepseek-ai/dsh-*` 版本需与用户安装的 dsh 版本匹配（见 §7）。

---

## 1. 各插件 package.json 现状（Q1）

> 证据路径：`plugin/<pkg>/package.json`（行号为 grep/read 实测；`—` 表示字段不存在）。

| 包 | name | version | `private` | `exports["./client"]` | `dsh.client` | main / types | `files` | `publishConfig` | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| dsh-tree-engine | `@dsh-plugin/tree-engine` | `0.1.0` | **true**（l6） | ✗ | ✗ | `lib/index.js` / `lib/index.d.ts` | `["lib"]` | — | 无客户端、无 bundle 声明 |
| dsh-compact-mode | `@dsh-plugin/dsh-compact-mode` | `0.1.0-rc.6` | **true**（l5） | ✗ | ✗ | `lib/index.js` / `lib/types/index.d.ts` | `["lib"]` | — | **依赖 `@dsh-plugin/tree-engine: workspace:*`（l56）** |
| dsh-vibe-mode | `@dsh-plugin/dsh-vibe-mode` | `0.1.0-rc.6` | ✗（无字段） | **✓**（l24） | **✓**（l50-59） | `lib/types/index.js` / `lib/types/index.d.ts` | 显式列表（含 `lib/client.js`, `lib/client/**`） | **✓ `access: public`（l5-7）** | **唯一已就绪**；有 web 客户端面；依赖已 pin 到精确 `0.1.0-rc.8` |
| dsh-tool-read-write | `@dsh-plugin/dsh-tool-read-write` | `0.1.0` | **true**（l6） | ✗ | ✗ | `lib/index.js` / `lib/index.d.ts` | `["lib"]` | — | `engines: node>=24` |
| dsh-advisor | `@dsh-plugin/dsh-advisor` | `0.1.0-rc.7` | **true**（l5） | ✗ | ✗ | `lib/index.js` / `lib/index.d.ts` | `["lib"]` | — | — |
| dsh-channel-wechat | `@dsh-plugin/dsh-channel-wechat` | `0.1.0` | **true**（l6） | ✗ | ✗ | `lib/index.js` / `lib/index.d.ts` | `["lib"]` | — | `engines: node>=24`；默认 `enabled:false` |
| dsh-mode-ui | `@dsh-plugin/dsh-mode-ui` | `0.1.0` | **true**（l5） | **✓**（l15） | **✓**（l24-33） | `lib/src/index.js` / `lib/src/index.d.ts` | `["lib"]` | — | 有 web 客户端面 |
| profile-main | `dsh-profile-main` | —（无） | **true**（l3） | n/a | n/a | — | — | — | **profile 目录**，非可发布 npm 包（`dsh.profile.bundles: [dsh-base, dsh-web-app]`，l7-9） |
| profile-personal | `dsh-profile-personal` | —（无） | **true**（l3） | n/a | n/a | — | — | — | **profile 目录**，同上 |

**关键判断**

- **阻塞发布的是 `private: true`**：tree-engine、compact-mode、tool-read-write、advisor、channel-wechat、mode-ui、profile-main、profile-personal 共 8 个；仅 vibe-mode 可发布。
- **谁有 web 客户端面**：只有 `dsh-mode-ui` 和 `dsh-vibe-mode` 同时声明了 `exports["./client"]` 和 `dsh.client`（`platform: "web"`）。`dsh-mode-ui` 的 client 需要 `@deepseek-ai/dsh-api-remotes`、`dsh-client-locale`、`dsh-client-ui-conversation`；`dsh-vibe-mode` 需要 `dsh-client-runtime`、`dsh-client-ui-conversation`、`dsh-client-ui-settings`。这两个包必须把 `lib/client.js`（及 `lib/client/**`）打进去（mode-ui `files:["lib"]` 已包含；vibe-mode 显式列入）。
- **其余 5 个包**是"库/插件模块"（无 `dsh.bundle`、无客户端）——它们可以被安装为普通依赖，但**本身不会自动成为 profile 层**（见 §3 的 `reconcilePlugins` 行为）；"启动行"由外层 patch（即套件 bundle 的 `cordis.patch.yml`）按包名引用。
- **profile-main / profile-personal 不可作为 npm 包发布**。它们的 `dsh.profile` manifest 只会被 `loadProfile` 从 profile 目录自己的 `package.json` 读取（`packages/boot/app-boot/src/profile.ts:375-392`），不会从一个"依赖包"读取。所以它们应作为 profile 目录分发（tarball/git），或干脆由 `dsh plugin --profile web add @dsh-plugin/dsh-suite` 取代（推荐后者）。

---

## 2. 跨包依赖修复（Q2）：`workspace:*`

- **现状**：`dsh-compact-mode/package.json:56` = `"@dsh-plugin/tree-engine": "workspace:*"`。
- **问题**：`workspace:*` 是 pnpm workspace 内部链接语法。发布到 npm 后，外部消费者执行 `pnpm add @dsh-plugin/dsh-compact-mode` 时，pnpm 无法用 `workspace:*` 从 registry 解析这个依赖 → 安装失败（`ERR_PNPM_... unsupported` / 无法找到该版本）。
- **修复**：改为真实版本范围。tree-engine 当前是稳定 `0.1.0`，所以改成

  ```json
  "@dsh-plugin/tree-engine": "^0.1.0"
  ```

- **顺序约束**：tree-engine 必须**先**发布到 npm，compact-mode 才能对外发布（发布本身不校验依赖是否存在，但消费者安装时若不先发 tree-engine，`^0.1.0` 解析不到）。
- **其他依赖都已是真实范围**：compact-mode 的其余依赖（`@deepseek-ai/dsh-*`）是 `^0.1.0-rc.6`；vibe-mode 是精确 `0.1.0-rc.8`；advisor / mode-ui / tool-read-write / channel-wechat 多为 `^0.1.0-rc.7`/`^0.1.0-rc.8`。这些均可被外部解析。

> 补充：仓库根 `plugin/package.json` 的 `pnpm.overrides: {"@deepseek-ai/dsh-*": "0.1.0-rc.6"}` 与 `plugin/pnpm-workspace.yaml` 的 `overrides: {"@deepseek-ai/dsh-*": "0.1.0-rc.8"}` 只是**开发 workspace 内部**用来把散落的 `@deepseek-ai` 版本钉住（避免浮动到不完整的 `0.1.1-rc.2`），**不会**带进发布内容，无需修改（发布时 package.json 的字段才是生效的）。

---

## 3. `dsh plugin add` 是否接受 npm 包名（Q3）

**结论：接受 —— `dsh plugin --profile <name> add <package>` 就是 `pnpm add <package>`，因此可以传 npm 包名（从 registry 解析）、本地路径、tarball、git URL。**

证据：

- `apps/cli/src/plugin.ts:120-158`（`runPlugin`）：先 `initProfile`，然后 `spawnSync('pnpm', args.map(anchorPathSpec), { cwd: dir, shell: win32 })` —— **把 argv 原封不动转发给 pnpm**。
- `apps/cli/src/plugin.ts:99-117`（`anchorPathSpec`）：**只**改写形如 `.` / `..` 开头的**相对路径**（含 `file:`/`link:` 前缀）为绝对路径；注释明确写"Absolute specs, registry names, and every other pnpm argument pass through untouched." —— **registry 包名、绝对路径、tarball、git URL 全部原样透传**。
- `docs/user/develop/basic/publish.zh.md`：
  - `dsh plugin --profile demo add ./hello-plugin`（本地 checkout）
  - `dsh plugin --profile demo add github:you/hello-plugin`（git）
  - "**发布到 npm**，在 `pnpm publish` 时构建好 `lib/`；`dsh plugin add your-package` 安装的就是预构建代码。"（直接写明 `add a-package-name`）
  - "**交付 tarball**：用 `pnpm pack` 打包；用户执行 `dsh plugin add ./hello-plugin-0.1.0.tgz`。"
- `apps/cli/reference/README.md`："Install external plugin bundles through `dsh plugin --profile <name> add <package-or-git-spec>`."

**对安装体验的意义**：外部用户不需要拿源码/patch 文件，直接 `dsh plugin --profile web add @dsh-plugin/dsh-suite` 即可，pnpm 从 registry 解析、安装、并把声明 `dsh.bundle` 的套件包挂入 profile 层。

**唯一注意点**：`dsh plugin` 只是 pnpm 转发器，**不做源码编译**。若从 git 安装（`add github:...`），拿到的是源码、不会跑 `build`，需要 `prepare` 脚本 + 用户在 `pnpm-workspace.yaml` 里 `allowBuilds` 授权（publish.zh.md"从 GitHub 安装：构建脚本这道坎"）。**发布到 npm / 交付 tarball 则无此障碍**，因为是预构建产物。

---

## 4. 发布目标对比（Q4）

> 前提结论：`@dsh-plugin/*` 目前全部 `npm view` → `404`（`npm view @dsh-plugin/dsh-tree-engine` / `dsh-compact-mode` / `dsh-vibe-mode` / `dsh-tool-read-write` / `dsh-advisor` / `dsh-channel-wechat` / `dsh-mode-ui` / `dsh-suite` / `dsh-profile-main` 全部 `E404`）。这些包名当前**无人使用**。
> 对照：`@deepseek-ai/dsh-base` 已在 npm public 发布（`dist.tarball=https://registry.npmjs.org/@deepseek-ai/dsh-base/-/dsh-base-0.0.1-rc.1.tgz`），说明 harness 全家桶走 public npm。

### 4.1 公开 npm（`@dsh-plugin/` scope）— **推荐**

- **要求**：
  - **scope 归属**：npm 规定"每个用户/组织拥有自己的 scope，只有你（或你作为成员的 org）能在其中发布包"。对 `@dsh-plugin`，必须**先存在名为 `dsh-plugin` 的 npm 账户（user）或组织（org）**：若是 org，发布前要在 npmjs.com 创建该组织，或先被加入已有组织并获得相应权限。证据：`https://docs.npmjs.com/cli/v10/using-npm/scope` → "Each npm user/organization has their own scope, and only you can add packages in your scope." / "you must first either create an organization with the name of the scope... or be added to an existing organization with the appropriate permissions."
  - **`access`**：scoped 包**默认私有**，首次 `npm publish` 必须给 `--access public`（或 `publishConfig.access: "public"`，后续版本无需再给）。证据同上文档。
  - **登录**：`npm login`（或 CI token）。
  - **包名唯一性**：`@dsh-plugin/dsh-*` 全部未占用（404）→ 可用。
- **优点**：`dsh plugin add @dsh-plugin/dsh-suite` 直接可用；第三方可公开安装；配合 `npm publish` 预构建 `lib/`，用户零构建授权。与 harness 官方通道一致（`@deepseek-ai/*` 也在 public npm）。
- **缺点**：需先解决 scope 归属（npm 账户/组织）；无私有 gate；发布 `0.1.0-rc.x` 预发布版本不会自动成为 `latest`（需 bump 到稳定版）。
- **建议**：**首选**。如果拿不到 `@dsh-plugin` scope，退而求其次用发布者自己的用户名 scope（如 `@<你>/dsh-suite`），但需要在套件 patch 里把 `name` 改成对应 scope 的包名。

### 4.2 GitHub Packages — 备选

- **要求**：GitHub PAT（需 `packages:write` 权限）；在 `package.json` 加 `"publishConfig": { "registry": "https://npm.pkg.github.com", "access": "public" }`（或 `https://npm.pkg.github.com/@<owner>`）；scope 即 GitHub 的 user/org（`@<gh-owner>/dsh-suite`）；`.npmrc` 里配 `@<owner>:registry=https://npm.pkg.github.com` 与 token。
- **优点**：与 GitHub 仓库天然绑定；token 已在手；适合私享。
- **缺点**：@deepseek-ai 的依赖在**公有 npm**，而 GH Packages 上的包默认**私有**（除非 `--access public`，GB 的 public 包也要求 token 才能匿名可用性）；`dsh plugin add` 需要用户在 profile 里能解析到 GH registry（要配 `.npmrc`），**开箱体验不如 public npm**。且对外发布需要仓库公开 + package 设置 public，仍有 token 前置。
- **结论**：可选，但作为"对外快速安装"体验较差。

### 4.3 私有 registry（Verdaccio 等）— 备选/内部

- **要求**：自建 registry + 登录配置；`publishConfig.registry` 指向该服务；消费者需配置 `.npmrc`/scope→registry 映射。
- **优点**：完全私有、可控。
- **缺点**：外部用户装不了，无法"快速对外集成"。仅适合团队内部。

**发布目标结论**：优先 **public npm `@dsh-plugin/*`**；仅当 scope 拿不到或需要私享时，退到 GitHub Packages / Verdaccio。

---

## 5. 一键安装 UX 研究（Q5）：bundle 还是 profile？

### 5.1 dsh 的 bundle / profile 两种概念（证据：publish.zh.md、app-boot README）

- **bundle（组合包）**：一个 npm 包，其 manifest 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，回答"这个包贡献什么"——一个插入/覆盖插件行的 patch 文件。官方 `dsh-base` / `dsh-web-app` / `dsh-headless` 都是这种声明（`packages/bundle/*/package.json`：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`、`"publishConfig": { "access": "public" }`、`files` 含 `cordis.patch.yml` + `lib/...`）。
- **profile（档案）**：位于 `$DSH_HOME/profiles/<name>/` 的目录，`package.json` 的 `dsh.profile.bundles` 是**有序的 bundle 层列表**（官方模板 `web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`、`headless: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]`，`DEFAULT_PROFILE_BUNDLES: ["@deepseek-ai/dsh-base"]`，见 app-boot `profile.ts:113-125`）。
- **"Nothing is both"**：一个包不能同时是 bundle 和 profile。`dsh.profile` 只会被 `loadProfile` 从 **profile 目录自身** 的 `package.json` 读取，**从不**读取某个依赖包里的 `dsh.profile`（故"发布一个带 `dsh.profile.bundles` 的 meta 包"这种方式并**不会**被 dsh 当作 profile）。

### 5.2 官方 bundle 如何声明 + 第三方 profile 能否列多个 npm bundle

- 官方 `dsh-base`（`packages/bundle/base/package.json`）：`dsh.bundle.patch` + `files` 含 `cordis.patch.yml`、`lib/index.js` 等；`dependencies`/`peerDependencies` 用 `workspace:^`（发布时 pnpm 替换为真实版本）。其 `cordis.patch.yml` 插入的插件行 `name` 是 `@deepseek-ai/dsh-*` 包名。
- **`loadProfile`** 会解析 profile 的 `dsh.profile.bundles` 每一项到其 patch 层（`packages/boot/app-boot/src/profile.ts:388-405`）：每个 bundle 必须声明 `dsh.bundle.patch`，否则抛 "declares no dsh.bundle"。**因此 profile 可以列任意多个 npm bundle**（官方 `web` 模板就列了 2 个：dsh-base + dsh-web-app）。第三方 bundle 只要被 pnpm 装进 profile 的 `node_modules`，`resolveBundleDir` 就从 profile 目录解析到它（`profile.ts:344-355`，先 dsh 安装锚点、后 profile 目录）。
- **内置 bundle 优先从 dsh 安装目录解析**（`loadProfile`/`resolveBundleDir` 先查 INSTALL_ANCHOR），所以 `@deepseek-ai/dsh-base` 等永远来自当前安装；**out-of-tree bundle 来自 profile 的 pnpm-managed `node_modules`**。

### 5.3 关键机制：`nodeLinker: hoisted` 让"bundle 装插件"可行

这是一个决定"套件 bundle 是否可行"的**关键实证**：

- `initProfile` 写入的 profile `pnpm-workspace.yaml` 内容为：
  ```yaml
  packages:
    - .
  nodeLinker: hoisted
  autoInstallPeers: false
  ```
  （`packages/boot/app-boot/src/profile.ts:130-136`）注释明确："**The hoisted linker gives out-of-tree plugins a flat node_modules** whose missing peers (cordis and friends) fall through to the healed profiles/node_modules installation fallback..."
- **实测**：我建了两个本地包 `@dsh-plugin/dsh-suite`（`dependencies` 含 `@dsh-plugin/dsh-compact-mode`）和 `@dsh-plugin/dsh-compact-mode`，在一个 consumer 里安装 suite：
  - 默认 pnpm（非 hoisted）：consumer 顶级 `node_modules/@dsh-plugin/` **只有** `dsh-suite`，`require.resolve('@dsh-plugin/dsh-compact-mode')` → `MODULE_NOT_FOUND`。
  - 写入 `nodeLinker: hoisted` 后：consumer 顶级 `node_modules/@dsh-plugin/` 同时出现 `dsh-suite` 和 `dsh-compact-mode`，`require.resolve(...)` → 命中 `node_modules/@dsh-plugin/dsh-compact-mode/index.js` ✅。
- **含义**：**套件 bundle 可以"SHIP"插件集**（把插件放进它自己的 `dependencies`），因为 dsh profile 用 hoisted linker，这些传递依赖会被**平铺**到 profile 的顶级 `node_modules`，于是 bundle `cordis.patch.yml` 里按包名 `name: @dsh-plugin/dsh-compact-mode` 的插件行**能被 Loader 解析**。它**不需要**把每个插件复制进包里，只要声名为依赖即可。

### 5.4 一键安装产物结论

- **"只引用不 ship"（一个 meta 包只靠 `dsh.profile.bundles` 列很多 bundle）不可行**：`dsh.profile` 只读 profile 目录自身；依赖包无关。
- **"这个 profile 要能列多个 add-able 包"可行**：profile 的 `dsh.profile.bundles` 本来就是有序的 bundle 名列表（`loadProfile` 逐个解析其 patch 层），`web` 模板就是例子。
- **最小可用的一键安装产物 = 一个 bundle 套件包 `@dsh-plugin/dsh-suite`**：
  - `dsh: { bundle: { patch: "./cordis.patch.yml" } }`
  - `dependencies` = 7 个 `@dsh-plugin/*` 插件（真实版本）
  - `files: ["lib", "cordis.patch.yml"]`（若 patch 引用的行需要 `lib/` 则带上；本例 patch 只引用插件包名，`files` 其实只要 `cordis.patch.yml`）
  - `cordis.patch.yml` = 把 `profile-main/cordis.patch.yml` 的"disables + plugins 插入行"搬过来，`name` 用发布后的包名。
  - 用户执行 `dsh plugin --profile web add @dsh-plugin/dsh-suite` → pnpm 装套件 + 平铺插件 → `reconcilePlugins` 因套件声明 `dsh.bundle` 而塞进 `dsh.profile.bundles` → 层生效。

> 说明：现有 `profile-main`/`profile-personal` 的工作原理就是"profile 目录 + 各插件作为直接 `link:` 依赖 + 用户层 `cordis.patch.yml` 引用包名"（见 `profile-main/cordis.patch.yml:41-46`：`dsh plugin --profile web add <path>` 把每个插件装成 hoisted `link:` 依赖。这正是"插件必须位于 profile 顶层 node_modules 才能被 Loader 解析"的手动版）。发布方案等于把它**自动化**成：插件经 npm 装进 profile（hoisted 平铺）+ 由套件 bundle 统一贡献 patch 层。

---

## 6. 推荐发布计划（步骤 / 顺序 / 版本 / 字段改动）

### 6.1 发布顺序（依赖拓扑）

```
1. @dsh-plugin/tree-engine        (0.1.0, 无依赖)
        │
2. @dsh-plugin/dsh-compact-mode   (依赖 tree-engine ^0.1.0)
3. @dsh-plugin/dsh-tool-read-write (独立)
4. @dsh-plugin/dsh-advisor         (独立)
5. @dsh-plugin/dsh-channel-wechat  (独立)
      │
6. @dsh-plugin/dsh-mode-ui         (独立, 带 client)
7. @dsh-plugin/dsh-vibe-mode       (独立, 带 client)
      │
8. @dsh-plugin/dsh-suite           (dependencies = 上面 7 个)
```

tree-engine 必须先于 compact-mode；其余相互独立；suite 最后（引用全部）。

### 6.2 每个包发布前必须做的字段改动（各包通用 + 特异）

**通用改动（作用于除 vibe-mode 外的所有要发布插件）**：

1. 删除 `"private": true`。
2. 增加 `"publishConfig": { "access": "public" }`（scoped 公开包必需）。
3. 增加 `"prepack": "pnpm run build"`（保证 `pnpm publish` 时先构建 `lib/`；否则 `lib/` 可能是旧产物）。已有 `build` 脚本，但 publish 不会自动跑它。
4. 建议统一版本为**稳定** `0.1.0`（去掉 `-rc.x`），使 `latest` dist-tag 生效，裸 `add @dsh-plugin/<name>` 能装到。
5. 校验 `files` 已包含运行时所需文件：
   - 纯后端包（tree-engine/compact-mode/tool-read-write/advisor/channel-wechat）：`["lib"]` 即可。
   - 客户端包（mode-ui/vibe-mode）：必须含 `lib/client.js` 与 `lib/client/**`（mode-ui `files:["lib"]` 已覆盖；vibe-mode 显式列入，已满足）。
6. `@dsh-plugin/dsh-compact-mode` 额外：`"@dsh-plugin/tree-engine": "workspace:*"` → `"^0.1.0"`（`package.json:56`）。

**特异点**：

- `dsh-tree-engine`：无需改 deps；`files:["lib"]` OK。version 已是 `0.1.0`。
- `dsh-tool-read-write` / `dsh-channel-wechat`：`engines.node: ">=24"` —— 依赖用户 Node ≥24，需在 README/patch 级说明，或放宽。
- `dsh-vibe-mode`：`main: lib/types/index.js` 与 `exports["."]/["./types"]` 指向 `lib/types/`，`./client` 指向 `lib/client.js`；已有 `publishConfig.access`.
- 所有包补 `license`（多数已有 `MIT`；tree-engine/tool-read-write/channel-wechat/compact-mode 未显式声明 license —— 发布时 npm 会警告，建议补 `"license": "MIT"`）。
- 建议补 `description`/`repository`（`repository` 指向源码仓库，便于审计）。

### 6.3 套件包 `@dsh-plugin/dsh-suite` 的 package.json 草稿

```json
{
  "name": "@dsh-plugin/dsh-suite",
  "version": "0.1.0",
  "description": "One-shot bundle composing the dsh plugin suite (compact-mode + vibe-mode + tool-read-write + advisor + mode-ui + channel-wechat) for the web profile.",
  "type": "module",
  "license": "MIT",
  "files": ["cordis.patch.yml"],
  "publishConfig": { "access": "public" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {
    "@dsh-plugin/dsh-tree-engine": "^0.1.0",
    "@dsh-plugin/dsh-compact-mode": "^0.1.0",
    "@dsh-plugin/dsh-vibe-mode": "^0.1.0",
    "@dsh-plugin/dsh-tool-read-write": "^0.1.0",
    "@dsh-plugin/dsh-advisor": "^0.1.0",
    "@dsh-plugin/dsh-channel-wechat": "^0.1.0",
    "@dsh-plugin/dsh-mode-ui": "^0.1.0"
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" }
}
```

`cordis.patch.yml`：把 `profile-main/cordis.patch.yml` 中"disables（compaction-basic / command-compact / tool-fs）+ 各插件 `insert` 行（compact-mode / vibe-mode / tool-read-write / advisor / mode-ui / channel-wechat）+ agent-presets(standard-rw)"原样迁移，`name` 用发布后的包名。若对 web profile 使用，`- id: tool-fs disabled` 在 web-app bundle 下是幂等 no-op，可保留。

> 注意：`dsh-mode-ui` 的 client face 要求 `@deepseek-ai/dsh-client-*` 这些 `devDependencies` 在发布时也在运行环境（`dsh.client.inject` 声明对 `dsh/client-modules` 是权威）。它们作为 **peer/依赖** 最好随包声明，否则浏览器端 `client-modules` 按包名解析 `@deepseek-ai/dsh-client-runtime` 等可能失败 —— 这点需在发布前把 `mode-ui` / `vibe-mode` 的 `dsh.client.inject` 依赖同时放进 `peerDependencies`（或明确的 `dependencies`），因为 `dsh.client` 的 inject 边是客户端入口 loader 的解析依据。

### 6.4 端到端安装 UX

```sh
# 需已安装 dsh（pnpm/npm 全局）且 pnpm 在 PATH
dsh plugin --profile web add @dsh-plugin/dsh-suite   # 首次自动初始化 web profile（dsh-base + dsh-web-app），再装套件
dsh --profile web                                    # 启动
```

或（若用户想要一个**非模板**的独立 profile）：

```sh
dsh plugin --profile mysuite add @dsh-plugin/dsh-suite
dsh --profile mysuite
```

（自定义 profile 名会用 `DEFAULT_PROFILE_BUNDLES=["@deepseek-ai/dsh-base"]` 初始化；若套件 patch 需要 web-app 的行，建议仍用 `web`。）

---

## 7. 风险与阻塞清单

| # | 风险/阻塞 | 等级 | 说明 / 证据 | 处理 |
|---|---|---|---|---|
| 1 | **`@dsh-plugin` scope 归属未知** | 高 | npm 要求 scope 归属用户/组织；`@dsh-plugin/*` 全 404（未发布）但**无法匿名判断 scope 是否已被占用**。 | `npm login` 后 `npm org ls dsh-plugin` / `npm access ls-packages` 确认；若未创建，先在 npmjs.com 建 `dsh-plugin` 组织并加入；否则改用 `@<你的用户>/dsh-*`。 |
| 2 | **`private: true` 阻塞发布** | 高 | 8 个包 `private:true`（§1）。 | 删 `private`，加 `publishConfig.access`。 |
| 3 | **`workspace:*` 不可外部解析** | 高 | compact-mode `package.json:56`。 | 改 `^0.1.0`；tree-engine 先发。 |
| 4 | **预发布版本不占 `latest`** | 中 | compact/vibe/advisor 为 `0.1.0-rc.x`。 | 统一 bump 到 `0.1.0`。 |
| 5 | **发布不自动构建 `lib/`** | 中 | 只有 `build` 脚本，无 `prepack`。 | 加 `prepack: pnpm run build`。 |
| 6 | **客户端依赖声明不全** | 中 | `mode-ui`/`vibe-mode` 的 `dsh.client.inject` 需要 `@deepseek-ai/dsh-client-*`，目前这些只在 `devDependencies`。 | 把 inject 边依赖补进 `peerDependencies`/`dependencies`。 |
| 7 | **Node 版本门槛** | 低 | tool-read-write/channel-wechat `engines.node>=24`。 | 文档注明；或放宽。 |
| 8 | **与用户 dsh 版本的依赖对齐** | 中 | 插件 pin `@deepseek-ai/dsh-*` 到 `rc.6-rc.8`；`cordis` peer；需与用户安装的 dsh 一致。 | 已实测这些版本在 public npm 存在且 caret 解析到 `0.1.0-rc.8`；在 README 里标注"匹配 dsh 0.1.0-rc.x"。 |
| 9 | **profile-main/personal 不可作为 npm 包** | 中 | 它们声明 `dsh.profile`，只会被直接当 profile 目录读取。 | 保留为仓库内的 profile 目录/分发；对外一键安装用套件 bundle 取代。 |
| 10 | **wechat 默认 disabled** | 低 | `channel-wechat` 默认 `enabled:false`（与 hermes 互斥）。 | 套件 patch 里保留 `enabled:false`，作为配置开关。 |

---

## 8. 附：关键证据索引

- `plugin/dsh-compact-mode/package.json:56` — `@dsh-plugin/tree-engine: workspace:*`
- `plugin/dsh-vibe-mode/package.json:5-7` — `publishConfig.access: public`（唯一已就绪）
- `plugin/dsh-vibe-mode/package.json:24-27` / `50-59` — `exports["./client"]` + `dsh.client`(inject, platform web)
- `plugin/dsh-mode-ui/package.json:15-18` / `24-33` — `exports["./client"]` + `dsh.client`
- `plugin/dsh-mode-ui/package.json:5` / `plugin/dsh-tree-engine/package.json:6` 等 — `private: true`
- `plugin/profile-main/cordis.patch.yml:41-46` — 现有工作模型：`dsh plugin --profile web add <path>` 把插件装成 hoisted `link:` 依赖；包名引用是浏览器 client 解析前提
- `apps/cli/src/plugin.ts:99-117` — `anchorPathSpec` 只改写相对路径，registry 包名透传
- `apps/cli/src/plugin.ts:120-158` — `runPlugin` 原样转发 `pnpm <args>`
- `docs/user/develop/basic/publish.zh.md` — bundle/profile 概念、`dsh plugin add <package|path|tarball|git>`、npm 发布即预构建
- `packages/boot/app-boot/src/profile.ts:113-125` — `PROFILE_TEMPLATES` / `DEFAULT_PROFILE_BUNDLES`
- `packages/boot/app-boot/src/profile.ts:130-136` — profile `pnpm-workspace.yaml`：`nodeLinker: hoisted`
- `packages/boot/app-boot/src/profile.ts:344-405` — `resolveBundleDir` 先安装锚点后 profile 目录；`loadProfile` 逐 bundle 解析 patch 层
- `packages/bundle/base/package.json` / `web-app/package.json` / `headless/package.json` — 官方 bundle 的 `dsh.bundle.patch` + `publishConfig.access` + `files`(含 `cordis.patch.yml`)
- `https://docs.npmjs.com/cli/v10/using-npm/scope` — scope 用户/组织归属、scoped 默认私有需 `--access public`
- npm registry 实测 — `npm view @dsh-plugin/*` 全 `E404`；`@deepseek-ai/dsh-base` 以 `@deepseek-ai/dsh-base@0.0.1-rc.1` 公开存在；`@deepseek-ai/dsh-agent@0.1.0-rc.8`、`dsh-session@0.1.0-rc.8`、`dsh-plan-mode@0.1.0-rc.8`、`dsh-client-runtime@0.1.0-rc.8`、`dsh-compaction@^0.1.0-rc.6→0.1.0-rc.8`、`cordis@^4.0.1→4.0.1` 均可解析
- 实验（临时目录 pnpm `nodeLinker: hoisted`）—— 套件传递依赖被平铺到顶级 `node_modules`，`require.resolve` 命中，证明"bundle 以 dependencies ship 插件集"可行

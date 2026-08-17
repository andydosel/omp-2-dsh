# dsh profile-main — compact-mode + vibe-mode 集成 Profile

把两个独立插件(dsh-compact-mode、dsh-vibe-mode)接入 DeepSeek Harness(dsh)的可运行
profile 补丁层。基于 `dsh-base` + `dsh-web-app` 两个 bundle 层,禁用其自带的
`compaction-basic` / `command-compact`,插入 compact-mode 与 vibe-mode。

## 目录结构

- `cordis.patch.yml` — 补丁层:禁用基座行 + 插入两个插件(含完整配置)
- `run.ps1` — Windows PowerShell 一键脚本:按依赖序构建三个项目,再启动 dsh web
- `package.json` / `pnpm-workspace.yaml` — 作为独立 profile 安装到
  `~/.dsh/profiles/main/` 时所需(与官方 profile 目录结构一致)

## 前置条件

1. dsh monorepo 已 clone、已 `pnpm install`(参考仓库
   `C:\Users\Vantage_XLST\Documents\dsh`),Node ≥ 22。
2. 插件工作区已 `pnpm install`(见下「tree-engine 如何被解析」)。
3. **三个插件项目必须先构建**,顺序:tree-engine → compact-mode → vibe-mode:

   ```powershell
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-tree-engine run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-compact-mode run build
   pnpm --dir C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\dsh-vibe-mode run build
   ```

   `run.ps1` 会自动按该顺序构建再启动,不必手动执行上面三条。

## 验证(无需 API key)

在 dsh monorepo 目录下执行(把 `<abs>` 换成本文件绝对路径):

```powershell
cd C:\Users\Vantage_XLST\Documents\dsh
pnpm dsh --profile web --patch C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\cordis.patch.yml --dump-config
```

`--dump-config` 只做离线配置组合,**不导入任何插件模块**,无需 API key。输出应包含:

- 被禁用的行:`compaction-basic`(`@deepseek-ai/dsh-compaction-basic`)、
  `command-compact`(`@deepseek-ai/dsh-command-compact`)均带 `disabled: true`;
- 新插入的行:`compact-mode`(指向 compact-mode 的 `lib/index.js`,带 §10 默认配置)、
  `vibe-mode`(指向 vibe-mode 的 `lib/types/index.js`,带 DIRECTOR section 等配置)。

## 真实运行

```powershell
cd C:\Users\Vantage_XLST\Documents\dsh
pnpm dsh web --patch C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\cordis.patch.yml
```

- **真实模型请求需要 API key**:启动前设置 `$env:DEEPSEEK_API_KEY = 'sk-...'`
  (或 dsh 支持的其他凭据方式)。
- 无 key 也能启动:插件照常**加载并 apply**(`ctx.compaction` 后端、`/compact*` 命令、
  vibeMode 服务、`/vibe` 命令全部注册),Web 服务监听 `http://127.0.0.1:3080`;
  只有发起模型请求时才会失败(无凭据)。
- 也可用 `run.ps1` 一键完成构建 + 启动:

  ```powershell
  powershell -ExecutionPolicy Bypass -File C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main\run.ps1
  ```

## 安装为独立 profile(可选)

把本目录复制到 dsh 的 profile 目录,之后 `pnpm dsh --profile main` 即可直接使用:

```powershell
Copy-Item -Recurse C:\Users\Vantage_XLST\Documents\dsh-plugin\plugin\profile-main $env:USERPROFILE\.dsh\profiles\main
pnpm dsh --profile main          # 或 pnpm dsh --profile main --dump-config 验证
```

注意:复制后 `cordis.patch.yml` 内插件的 `file:///C:/Users/Vantage_XLST/...` 绝对路径
仍然有效(它们指向插件项目的构建产物,与 profile 位置无关);若插件项目换过路径,需
同步修改 patch 中的 `name:`。

## 关键机制说明

### Loader 如何解析 `name:`(Windows 必须用 file:// URL)

dsh 的 Cordis Loader 对插入行执行 `import(name, baseUrl)`:

- `@deepseek-ai/*` 等**包名**只从 dsh 安装自身与 `~/.dsh/profiles/node_modules`
  解析(安装闭包),`@dsh-plugin/*` 不在此列 → 包名形式会失败;
- **相对路径**以 profile 目录(如 `~/.dsh/profiles/web`)为基准,而非 patch 文件目录;
- **Windows 绝对路径**必须写成 `file:///C:/...` 形式:裸 `C:/...` 会被 Node 拒绝
  (`ERR_UNSUPPORTED_ESM_URL_SCHEME: On Windows, absolute paths must be valid file:// URLs`)。

因此本 patch 的 `name:` 使用指向构建产物 `lib/*.js` 的 `file:///` 绝对 URL
(与官方教程「绝对路径挂载本地插件」一致的原理,Windows 下需要 URL 形式)。

### vibe-mode 的入口文件位置

vibe-mode 的 tsconfig 把构建产物输出到 `lib/types/`(tsc -b),而 package.json 的
`main`/`exports` 仍写着 `lib/index.js`(上游不一致)。因此 patch 指向实际的
`lib/types/index.js`(构建后确认存在,默认导出 `VibeModeController`)。

### tree-engine 如何被解析

compact-mode 的 `lib/index.js` 通过 `import('@dsh-plugin/tree-engine')` 使用树引擎。
当 dsh 从 `file:///.../dsh-compact-mode/lib/index.js` 加载它时,Node 的 ESM 解析
从 compact-mode 自己的 `node_modules` 向上查找,命中 pnpm workspace 软链
`dsh-compact-mode/node_modules/@dsh-plugin/tree-engine -> ../../dsh-tree-engine`。
因此前提是**在插件工作区(`dsh-plugin/plugin`)执行过 `pnpm install`**——这会创建
workspace 软链;若未安装,在该目录执行 `pnpm install` 即可。

### 为什么必须禁用 compaction-basic / command-compact

- `ctx.compaction` 是**单后端服务**:compact-mode 与 compaction-basic 同时提供会硬冲突;
- `/compact` 命令族:compact-mode 注册 `compact/compact_edit/compact_apply/compact_abort`
  等,与 `command-compact` 重复注册会报错。
  (web profile 的 web-app bundle 层已默认禁用这两行,本 patch 的 `name:` 守卫
  使其在任何基座上都能幂等、且基座变更时响亮失败。)

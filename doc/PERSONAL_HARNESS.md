# 个人 Harness（Personal Profile）使用手册

本手册说明三个个人插件与随附 `personal` profile 的用途、安装、配置与验证方法。全部内容在 Windows 11（Node v24、pnpm 11.7.0）实测通过；开发流程详见 [`PLUGIN_DEV_PLAYBOOK.md`](./PLUGIN_DEV_PLAYBOOK.md)。

## 1. 这些插件做什么：能力缝一览

| 包 | 插件名 | 行使的能力缝 | 作用 |
|---|---|---|---|
| `packages/personal/dsh-personal-persona` | `dsh-personal-persona` | `ctx.systemPrompt`（提示词 section） | 以唯一 section 名 `personal:identity` 注册一段个人身份/风格提示词，与内置 `deployment:persona` 并存不冲突 |
| `packages/personal/dsh-personal-memory` | `dsh-personal-memory` | `ctx.tools`（模型可见工具） | 注册 `memory_set` / `memory_get` / `memory_list` / `memory_delete`，把跨会话的持久事实（名字、偏好、项目决策）存进一个 JSON 文件 |
| `packages/personal/dsh-personal-title-zh` | `dsh-personal-title-zh` | `ctx.sessionTitle`（会话标题 provider） | 注册唯一的中文标题 provider（id `session-title-zh`），用中文系统提示词为会话生成简洁自然的中文标题 |

三者分别对应 dsh 三大扩展点：提示词组装、工具注册表、会话标题缝。插件通过 `inject` 声明依赖，注册都是可逆 effect，HMR 热重载自动清理。

### 为什么标题插件要“禁用”内置行

`ctx.sessionTitle` 缝**只允许一个 provider**（重复注册会抛 `session-title provider "<id>" is already registered`）。`dsh-base` bundle 默认挂载英文 first-prompt 标题 provider（行 id `session-title-llm`），所以 personal profile 的 patch 先把它 `disabled: true`，再 `insert:` 中文 provider。patch 语义里 `name:` 是**匹配守卫**而不是覆盖字段——因此不能改行名，只能禁用后插入。

## 2. 目录结构

```
packages/personal/
  dsh-personal-persona/      # 个人身份提示词 section
  dsh-personal-memory/       # 持久记忆工具
  dsh-personal-title-zh/     # 中文会话标题 provider
profiles/personal/           # personal profile 模板（package.json + cordis.patch.yml + pnpm-workspace.yaml）
```

## 3. 运行 personal harness

### 3.1 复制 profile 到 Harness home（Windows PowerShell）

```powershell
# 1) 创建 profiles 目录并把模板复制过去
New-Item -ItemType Directory -Force "$HOME\.dsh\profiles" | Out-Null
Copy-Item -Recurse -Force .\profiles\personal "$HOME\.dsh\profiles\personal"

# 2) 把三个插件装进 profile 的 node_modules（开发 checkout 用 file: 链接）
cd "$HOME\.dsh\profiles\personal"
pnpm add "file:C:\Users\Vantage_XLST\Documents\dsh\packages\personal\dsh-personal-persona" `
        "file:C:\Users\Vantage_XLST\Documents\dsh\packages\personal\dsh-personal-memory" `
        "file:C:\Users\Vantage_XLST\Documents\dsh\packages\personal\dsh-personal-title-zh"
```

> 为什么需要第 2 步：profile 目录在 Harness home 里，Node 解析裸包名时会从 profile 目录逐级向上找 `node_modules`。三个插件不在 `apps/cli` 的依赖闭包里，不会出现在 dsh 自动维护的安装后备目录（`$DSH_HOME/profiles/node_modules`）；它们的 peer 依赖（`cordis`、`dsh-tools`、`dsh-session-title` 等）则在后备目录里解析（启动时 `healProfilesModuleFallback` 自动建立）。

### 3.2 启动

```powershell
# 回到仓库根目录
cd C:\Users\Vantage_XLST\Documents\dsh
pnpm dsh --profile personal web
```

打开 http://127.0.0.1:3080 即可使用。真正跑模型需要 `DEEPSEEK_API_KEY`（或 settings 里的凭据）。

### 3.3 `$DSH_HOME` 替代方案

不想往 `~/.dsh` 里写东西时，可以用 `$DSH_HOME` 指到任意目录（包括仓库内的临时目录）：

```powershell
$env:DSH_HOME = "C:\Users\Vantage_XLST\Documents\dsh\.dsh-home"
New-Item -ItemType Directory -Force "$env:DSH_HOME\profiles" | Out-Null
Copy-Item -Recurse -Force .\profiles\personal "$env:DSH_HOME\profiles\personal"
# 同样执行 3.1 第 2 步的 pnpm add（cd 到 $env:DSH_HOME\profiles\personal）
pnpm dsh --profile personal web
```

> 注意：`$DSH_HOME` 同时是 sessions / settings / credentials 的存放处，别把它指到 git 仓库根目录，否则启动会往仓库里写数据。

### 3.4 开发期快速体验（不复制、不安装）

在仓库 checkout 内，`--patch` 覆盖层从仓库解析插件（仓库根 `node_modules` 有全部 workspace 链接）：

```powershell
# 免 key 验证组合树（推荐先做这个）
pnpm dsh --profile web --patch ./profiles/personal/cordis.patch.yml --dump-config

# 真启动（需要 API key）
pnpm dsh --profile web --patch ./profiles/personal/cordis.patch.yml
```

## 4. 免 API key 验证

`--dump-config` 只离线组合配置层（不启动、不求值 `!!js`、不需要任何 key）：

```powershell
pnpm dsh --profile web --patch ./profiles/personal/cordis.patch.yml --dump-config
```

输出里应能看到（`# == C:\...\profiles\personal\cordis.patch.yml` 层标记之下）：

```yaml
- id: session-title-llm
  name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
  ...
  disabled: true          # 内置英文标题 provider 已被禁用
- id: personal:persona
  name: '@deepseek-ai/dsh-personal-persona'
  config: { identity: ..., style: ..., order: 0 }
- id: personal:memory
  name: '@deepseek-ai/dsh-personal-memory'
  config: { path: .dsh-memory.json, maxBytes: 1048576 }
- id: personal:title-zh
  name: '@deepseek-ai/dsh-personal-title-zh'
  config: { automatic: first-prompt, targetCjkCharacters: 12, maxOutputTokens: 64, timeoutMs: 10000 }
```

仓库级验证（本 checkout 实测全部通过）：

```powershell
pnpm run constraints          # workspace 不变量
pnpm run typecheck            # 全仓类型检查 + Host 构建
pnpm run build                # 全仓构建
pnpm vitest run packages/personal/dsh-personal-memory packages/personal/dsh-personal-title-zh
```

## 5. 配置编辑

每个插件的配置都在 patch 行（id 定位）的 `config:` 里，全部有 schemastery 默认值，HMR 改配置即热替换。

### 5.1 在 profile patch 里改

编辑 `~/.dsh/profiles/personal/cordis.patch.yml`，按行 id 覆盖（**整行替换 config，不深合并——要重述所有保留字段**）：

```yaml
- id: personal:memory
  config:
    path: D:\data\.dsh-memory.json
    maxBytes: 2097152
```

### 5.2 在 home 级 patch 里改（不动 profile）

编辑 `~/.dsh/cordis.patch.yml`（所有 profile 共享，最后应用）：

```yaml
- id: personal:persona
  config:
    identity: '一个冷静、严谨的代码审查助手'
    style: '先指出风险，再给修复建议；中文回答。'
    order: 10          # 渲染在部署 persona 之后
```

### 5.3 各插件配置项

| 行 id | 字段 | 默认值 | 说明 |
|---|---|---|---|
| `personal:persona` | `identity` | `一个乐于助人、注重细节的个人编程助手` | 身份描述 |
| | `style` | `用简洁、准确的中文回答；先给结论，再给理由和示例。` | 语言风格 |
| | `extra` | `''` | 额外常驻指令（空则不产生内容） |
| | `order` | `0` | section 顺序（部署 persona 惯例为 0） |
| `personal:memory` | `path` | `.dsh-memory.json` | 记忆文件路径（相对路径按进程 cwd 解析） |
| | `maxBytes` | `1048576` | 序列化文件大小上限；超限写入被大声拒绝 |
| `personal:title-zh` | `automatic` | `first-prompt` | `first-prompt` / `all-prompts` |
| | `targetCjkCharacters` | `12` | 中文标题目标字数 |
| | `maxOutputTokens` | `64` | 输出 token 上限 |
| | `timeoutMs` | `10000` | 辅助请求截止时间（毫秒） |
| | `provider` / `model` | 未设置 | 显式路由；两者必须成对，缺省时用会话主请求路由 |
| | `prompt` | 未设置 | 自定义系统提示词覆盖 |

## 6. 把同样三个插件加入现有 profile

把下面的块追加到目标 profile 的 `cordis.patch.yml`（或任一 `--patch` 覆盖层）即可；`name:` 裸包名需要能被该目录解析（profile 的 `node_modules` 或安装后备目录）：

```yaml
# 1) 禁用内置英文标题 provider（不这么做会与中文 provider 撞车）
- id: session-title-llm
  name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
  disabled: true

# 2) 插入三个插件
- insert:
    - id: personal:persona
      name: '@deepseek-ai/dsh-personal-persona'
      config:
        identity: '一个注重深度思考、乐于动手实现的个人编程助手'
        style: '简洁、准确，先结论后细节；中文回答。'
        extra: ''
        order: 0
    - id: personal:memory
      name: '@deepseek-ai/dsh-personal-memory'
      config:
        path: '.dsh-memory.json'
        maxBytes: 1048576
    - id: personal:title-zh
      name: '@deepseek-ai/dsh-personal-title-zh'
      config:
        automatic: first-prompt
        targetCjkCharacters: 12
        maxOutputTokens: 64
        timeoutMs: 10000
```

## 7. 已知限制

- **标题缝单 provider**：`session-title-zh` 是唯一标题 provider；不先禁用内置行会启动失败（这是设计，不是 bug）。
- **`memory_get` 区分不了“缺失”和“存的 JSON null”**：两者都返回 `value: null`；需要区分就存对象哨兵。
- **记忆不是崩溃持久、不防外部写者**：内存变更到 rename 提交之间崩溃可能丢最近一次写；不持有跨进程写锁，harness 运行期间手工编辑文件可能被覆盖。
- **中文标题 prompt 只面向 CJK**：非中文场景用内置 `dsh-session-title-*`。
- **profile 复制后必须安装插件**（3.1 第 2 步）：`--dump-config` 不解析包名所以无需安装；真启动需要。
- **免 key 只能验证组合**：`--dump-config` 不启动插件；跑真实标题生成/对话需要 API key。
- **persona section 是静态文本**：不含 `{{变量}}`，需要动态内容请改用 `ctx.systemPrompt.context(...)`。

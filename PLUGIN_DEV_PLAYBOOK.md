# DeepSeek Harness (dsh) 插件开发手册

> 本手册基于 2026-08-17 在 Windows 11 上从零 clone 的 `deepseek-harness` master(HEAD `47f943859b`、`pnpm@11.7.0`、Node v24.15.0)实测编写。所有代码片段均来自本仓库源码(`PLUGIN_DEV_PLAYBOOK.md` 例外,它是本手册自身)。源文档权威入口:`docs/architecture.md`、`docs/capability-seams.md`、`docs/cordis-primer.md`、`docs/cookbook/*`、`docs/development.md`。

---

## 1. dsh 是什么:核心架构一页速览

### 1.1 everything-is-a-plugin(一切皆插件)

dsh 是 DeepSeek 开源的、构建在 **vendored Cordis** 之上的插件式 agent harness(见 `docs/architecture.md`)。核心主张:

- **产品的每一部分都是插件**:模型适配器、工具注册表、会话日志、agent 循环本身、权限策略……全部是插件,因此全部可以从配置层面替换。
- **没有特权核心需要打补丁**:扩展 dsh = 在旁边挂一个插件;注册都是可逆的 effect(registration),插件卸载时自动撤销。
- 工具注册表、提示词 section、适配器、provider、事件监听都通过 `ctx.effect()` / `ctx.on()` 安装,所以 vendored 的 HMR 热重载天然可用(改配置即热替换,旧实例的注册自动清掉)。

### 1.2 Cordis 的五个概念(详见 `docs/cordis-primer.md`)

| 概念 | 含义 |
|---|---|
| **插件** | 实现 Service 的对象:函数形式(导出 `name`/`inject`/`apply`)、对象形式、`Service` 子类形式。函数形式最常用 |
| **Context** | 服务仓库。服务占据稳定的 `ctx.<key>`(`ctx.tools`、`ctx.llm`、`ctx.sessions`…),其他插件按 key 找服务,而不是 import 具体实现 |
| **inject** | 声明服务依赖。插件声明所需服务,等它们存在后才 `apply`;加载顺序由服务依赖表达,而非手工排 boot 顺序 |
| **类型化事件** | 通过 TypeScript declaration merging 声明事件名,再以 `emit`(观察)/ `waterfall`(可改写、必须 `next()` 放行)/ `parallel`(并行)/ `serial`(串行有返回值)派发 |
| **可逆 effect** | 注册 = `ctx.effect()` / `ctx.on()`;每个注册都有 disposer,卸载时按序回卷 |

waterfall 语义(写钩子插件必读):`ctx.waterfall` 是"around 中间件",监听器收到 `(...args, next)`,调用 `next()` 委托(可返回改写后的结果),不调用则短路(单决策事件如权限门就是靠短路做决策)。

### 1.3 Profile / Bundle / patch 层叠机制

- **profile** = 一个命名组合,存放在 Harness home(默认 `~/.dsh`,可用 `$DSH_HOME` 覆盖)的 `profiles/<name>/` 目录,包含:`package.json`(声明 `dsh.profile.bundles` 有序列表 + 树外插件依赖)和用户自己的 `cordis.patch.yml`。`web` 与 `headless` 作为模板随发布内置。
- **bundle** = 配置层的分发格式:一个 npm 包,`package.json` 里 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 指向它的 patch 文件;bundle 的 patch 层可被上层按行 id 覆盖。`@deepseek-ai/dsh-base` 是每个 profile 的第一层(模型适配器、工具、持久化、sandbox/审批策略、settings、credentials、telemetry);`dsh-web-app` 加浏览器应用;`dsh-headless` 加一次性 runner(无服务器)。
- **层叠顺序**(自底向上):空 entry 列表 → profile `dsh.profile.bundles` 里每个 bundle 的 patch(按列表顺序)→ profile 自己的 `cordis.patch.yml` → home 级 `~/.dsh/cordis.patch.yml` → 每个 `--patch <file>` overlay(argv 顺序)。**后层按行 id 覆盖,且是整行替换 `config`(不深合并)**——所以覆盖别人行时要重述所有保留字段。
- patch 文件是 YAML 数组:按 id 覆盖某行 config、`insert:` 插入新行、`!!js` 表达式在挂载时求值(`dsh --dump-config` 不执行 `!!js`,原样打印)。

### 1.4 Capability seams(能力缝)

一个可替换能力 = 三角色(见 `docs/capability-seams.md`):

1. **Service Definition** —— 声明接口(如 `ctx.llm`、`ctx.fs`、`ctx.shell` 的服务声明);
2. **Service Provider** —— 实现它(如 `dsh-llm-deepseek`、`dsh-fs-local`、`dsh-bash-local`);
3. **Consumer** —— 消费它,通常是一个模型可见工具(如 `dsh-tool-bash`)。

换 provider = 整个产品跟着换:例如 fs 与 subprocess provider 共享一个执行世界,把它们指向远端 sandbox,则 bash / PTY / LSP 一起迁移,不需要 fork 任何 provider。**只做一角不算一个完整的 seam**;新增能力要三角色一起设计。

### 1.5 核心 ctx 服务(摘自 `docs/architecture.md` 与 capability-seams 表)

| `ctx` key | 负责 | 拥有包 |
|---|---|---|
| `ctx.sessions` | append-only `SessionEvent` 日志 + 内存 store | `core/session` |
| `ctx.systemPrompt` | 提示词 section 与工具 schema 组装 | `core/system-prompt` |
| `ctx.tools` | 作用域工具注册表 + 守卫执行管线 | `core/tools` |
| `ctx.agents` | `Agent` 接口、live 注册表、`agent/*` 事件 | `core/agent` |
| `ctx.agentLoop` | 默认驱动(唯一具体 loop 插件) | `core/agent-loop` |
| `ctx.llm` | 消息/流词汇 + 适配器缝(`registerAdapter`) | `llm/llm` |

其余 seam:`ctx.sessionPersistence`、`ctx.settings`、`ctx.credentials`、`ctx.subprocess`、`ctx.shell`、`ctx.shellEnv`、`ctx.terminals`、`ctx.sandbox`、`ctx.sandboxPolicy`、`ctx.approval`、`ctx.fs`、`ctx.compaction`、`ctx.subagents`、`ctx.jobs`、`ctx.web`、`ctx.spillStore`、`ctx.directoryPicker`、`ctx.lsp`、`ctx.workflowEngine`、`ctx.sessionTitle`、`ctx.skills`、`ctx.sessionQuery`、`ctx.userQuestions`、`ctx.codeRuntime` 等(完整图见 capability-seams.md)。

### 1.6 扩展点速查(新行为放哪里)

| 目标 | 机制 |
|---|---|
| 加模型 provider | `ctx.llm` 上注册适配器 |
| 加模型可见能力 | `ctx.tools` 上注册;schema 自动进提示词组装 |
| 加 shell 执行 | 注册 `ctx.shell` backend(local 的经 `ctx.subprocess` 派生) |
| 加持久终端 | `ctx.terminals` backend + `dsh-tool-terminal` |
| 加人类命令 | `ctx.commands`(不走模型轮) |
| 加后台工作 | `ctx.jobs`;`job_*` 工具收集/停止 |
| 加文件系统/策略 | `ctx.fs` provider 或监听 `fs/*` 事件 |
| 限制子进程 | `ctx.sandbox` backend(consumer 在 spawn 前包装 argv) |
| 拦截请求/工具/turn | `agent/*`、`tools/*` 事件;`agent/turn-stopping` 停 turn |
| 加模型可见上下文 | `agent.inject()`(下一请求可见,不唤醒 idle agent) |
| 加 UI/编辑器集成 | 驱动 `ctx.agents`,从 `session/event` 渲染 |
| 加 Web Chat 业务节点 | 注册 `ConversationNodeDefinition` + keyed renderer |
| 加持久会话状态 | 扩展 `SessionEventMap`,从日志渲染/重放 |
| 生成会话标题 | 注册唯一 `ctx.sessionTitle` provider |
| 给某 agent 局部能力集 | 用 agent preset;preset 内的服务行要 `isolate` realm |
| 作用域注册到单 agent | 用该 agent 的 `agent.ctx` |

**Model-visible ⟺ logged**:任何进入模型请求的东西必须能从会话日志重建;新的模型可见输入必须新增 session event(扩展 `SessionEventMap`),这是 dsh 的运行时不变量。

---

## 2. 插件开发完整流程(从零到挂载)

### 2.0 两条路径

- **路径 A(最快)**:在 repo 根下建 scratch 目录,写一个 `.ts` 插件 + 一个 `cordis.yml` overlay,用 `--patch` 挂进 `web` profile 直接跑。不打包、不进 workspace。适合试写与教学(官方教程 `docs/user/develop/basic/` 就是这么走的)。
- **路径 B(正式)**:加入 repo 成为 `packages/<group>/<pkg>` workspace 包(`@deepseek-ai/dsh-<name>`,遵守 `docs/cookbook/adding-a-package.md` 清单),或独立成 npm 包以 **bundle** 形式分发(见 `docs/user/develop/basic/publish.md`)。

### 2.1 路径 A:scratch 插件(最小闭环)

1. 建目录与源码(`docs/user/develop/basic/index.md` 教程原文):

```ts
// scratch-plugin/src/my-plugin.ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  // Required dependencies are ready before apply runs.
  console.log('[hello-plugin] plugin loaded!')
}
```

2. 写 overlay(注意:**插件路径必须是绝对路径**,patch 不改变 profile 目录、模块解析基于 config 目录):

```yaml
# scratch-plugin/cordis.yml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

3. 启动 Web UI 并验证:

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml   # web 是 --profile web 的硬编码别名
# 打开 http://127.0.0.1:3080,终端应打印 [hello-plugin] plugin loaded!
```

4. 依赖注入:要消费 `ctx.tools` 等服务,加 `inject`:

```ts
export const name = 'my-tool-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)
}
```

5. 需要显式清理的资源(网络连接等)用 `ctx.effect()` 返回 disposer:

```ts
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => console.log('heartbeat'), 5000)
    return () => clearInterval(timer)   // 插件卸载时执行
  })
}
```

### 2.2 配置(Config):同名类型 + Schemastery schema

`docs/user/develop/basic/config.md`:导出 `Config` 类型和同名的 Schemastery `z` 对象,**默认值直接写在 schema 字段上**;`cordis.yml` 里该行的 `config:` 覆盖之。不要导出普通对象当 Config(不实现 Standard Schema 接口,加载会失败)。

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: z<Config> = z.object({
  greeting: z.string().default('Hello'),
  maxRetries: z.number().default(3),
  verbose: z.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)  // 用户值或 schema 默认值
}
```

设计铁律(仓库 AGENTS.md + config 教程):
- **不做硬编码可调参数**:两个部署会设成不同值的东西都必须是 `Config` 字段(cordis.yml 不改代码即可改);
- **误配置要 loud fail**:自包含约束放 schema 里,加载期报错;引用服务/已注册资源用 DI;
- 加载时 schema 校验+填默认,HMR 改配置即热替换。

### 2.3 路径 B:repo 内 workspace 包(adding-a-package 清单要点)

```
packages/<group>/<pkg>/
  package.json     # 复制自 packages/core/tools,改 name/description/deps
  tsconfig.json    # extends ../../../tsconfig.base.json, rootDir src, outDir lib/types,
                   # references: vendor/cosmokit、vendor/cordis(+ vendor/schemastery 若用 Config)、
                   # 每个 dsh 依赖包(如 ../../<group>/<dep>)
  src/index.ts     # 服务默认导出 或 插件(name/inject/apply/Config)
  README.md        # 服务 API、事件、扩展点、Model Experience、Known Limitations
```

package.json 不变量(由 `pnpm run constraints` 强制,`scripts/check-workspace-constraints.ts`):
- `private: true`;`version` 与根一致(`0.1.0-rc.5`);`"type": "module"`(全仓 ESM)
- `main: "lib/index.js"`、`types: "lib/types/index.d.ts"`、`exports["."].types/.default` 指向同上
- `@deepseek-ai/cordis` **同时**进 `peerDependencies` 与 `devDependencies`(同 range);每个 dsh peer 依赖镜像到 devDependencies
- `@deepseek-ai/schemastery` 进 `dependencies`(运行时校验器)
- 包内相对导入用显式 `.ts` 后缀(编译期重写为 `.js`)

根配置注册:普通包加入 `tsconfig.host.json`(Host 面)或 `tsconfig.client.json`(Client 面)的 `references`——**只进一个**,不要两个;新 group 才需要动 `tsconfig.base.json` 的 `@deepseek-ai/dsh-*` 通配。`knip.json` 一般不用动。

验证:`pnpm install` → `pnpm run constraints && pnpm run typecheck && pnpm run lint` → `pnpm run build && pnpm run hygiene`。

### 2.4 主要注册模式(直接抄)

**模型可见工具**(`defineTool` 来自 `@deepseek-ai/dsh-tools`;args 由 schema 推断并自动校验):

```ts
export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',          // 模型看到的就是它
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },                     // 默认可选
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
    },
  }))
}
```

执行契约要点(详见 `docs/cookbook/adding-a-tool.md`):args 由注册表统一校验;返回**一个规范 JSON 值**(`output.schema`),人类可读文案走 `output.render`;抛错/无效返回值 = `isError`;尊重 `exec.signal`;`exec.agent` 用于异步通知(`agent.inject`);长任务用 `ctx.jobs.start` + `run_in_background`;UI 卡片走纯函数 `presentCall`/`presentResult`(`generic`/`terminal`/`diff`/`search`/`web`)。注册是 effect 的,插件卸载即注销,`schemas()` 自动流进系统提示词。

**LLM 适配器**(详见 `docs/cookbook/adding-an-llm-adapter.md`):

```ts
class MyAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> { … }
}

export const name = 'llm-myprovider'
export const inject = ['llm']

export function apply(ctx: Context, config: Config) {
  ctx.llm.registerAdapter(['my-provider'], new MyAdapter(…))
}
```

协议义务:先 `usage` 后 `finish`、`finish` 后不再发任何东西;工具调用 `arguments` 全程是原始 JSON 字符串(`argumentsDelta` 流式拼接);块 `index` 按首见顺序分配;错误只有两条路——从 `stream()` throw(`LlmError` + 稳定 code)或以 `finish {kind: 'error'|'aborted'}` 结束流;尊重 `options.signal`。

**系统提示词 section**(见 `packages/preset/persona`):

```ts
export const inject = ['systemPrompt']

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SECTION,     // 'deployment:persona'
    order: PERSONA_ORDER,
    text: config.text,
    ...(config.complete ? { complete: true } : {}),
  }), 'persona.section()')
}
```

**事件/钩子**(权限门示例,`docs/cookbook/extension-cookbook.md`):

```ts
export const name = 'permission-gate'
export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!(await isAllowed(exec))) {
      return { kind: 'deny', reason: 'Denied by policy.' }
    }
    return next()   // waterfall 必须 next() 放行
  })
}
```

### 2.5 构建与类型检查

```sh
pnpm run build        # build:lib:host = tsc -b tsconfig.host.json + tsdown;build:lib:client 同;再 vite 构建 web 前端
pnpm run typecheck    # build:lib:host + tsc -b tsconfig.client.json(typecheck:contracts-ready)
```

源码启动走 `node --import tsx/esm apps/cli/src/bin.ts`(根 `package.json` 的 `"dsh"` script),所有被它 import 的模块必须是纯 ESM。

### 2.6 挂进 profile / patch / bundle

- **开发期 overlay**:`pnpm dsh web --patch ./scratch-plugin/cordis.yml`(见 2.1)。
- **用户长期 patch**:profile 目录的 `cordis.patch.yml`(或 home 级 `~/.dsh/cordis.patch.yml`)。按行 id 覆盖 bundle 行时**整行替换 config,重述保留字段**;`insert:` 加新行。
- **分发成 bundle**(`docs/user/develop/basic/publish.md`):
  - 包结构:`package.json`(`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`)+ `cordis.patch.yml`(行里的 `name:` 写包名而非相对路径)+ `index.js`。
  - 安装:`dsh plugin --profile demo add ./hello-plugin`(首次使用会初始化 profile,自动把 `@deepseek-ai/dsh-base` 加为第一个 bundle;`dsh plugin` 维护 `dsh.profile.bundles` 与依赖)。
  - 校验/启动:`dsh --profile demo --dump-config`(应看到 `# == dsh-hello-plugin` 层)→ `dsh --profile demo`。
  - GitHub 直装注意:git 装的是源码不是构建产物 → 作者要提供 `prepare` 脚本自包含构建;用户首次 `add` 失败时把 pnpm 提示的 package key 加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds:`(等于信任该包代码在装包时执行),或直接发 npm 预构建产物/tarball。

### 2.7 验证

```sh
pnpm dsh --profile web --dump-config    # 不启动即可看组合树(不需要 API key)
pnpm dsh web                            # 真启动 UI:http://127.0.0.1:3080(需要 DEEPSEEK_API_KEY 才能跑模型)
pnpm dsh --profile headless "task"      # 一次性任务(需要 DEEPSEEK_API_KEY)
pnpm run test / pnpm run test:e2e       # 单元/e2e(后者无 key 自动跳过)
```

---

## 3. 现有工具清单摘要(避免重复造轮子)

来自 `docs/tool-catalog.md` 的 Tool Package Map(工具包 → 模型可见工具名 → 作用)。**动手写新工具前先查这张表**:dsh 已内置文件系统、shell、web、子代理、任务调度等绝大多数通用能力,新插件优先做"组合/策略/领域逻辑"而不是重造轮子。

| 工具包 | 模型可见工具 | 用途 |
|---|---|---|
| `@deepseek-ai/dsh-tools` | `run_code` | Code Mode:跑一段 TypeScript 程序直接调其他工具 |
| `@deepseek-ai/dsh-tool-bash` | `bash` | 一次性 bash(`bash -c`,无状态,`$DSH_*` 环境事实,可后台) |
| `@deepseek-ai/dsh-tool-pwsh` | `pwsh` | 一次性 PowerShell(Windows 组合) |
| `@deepseek-ai/dsh-tool-bash-persistent` | `bash` | 持久 bash shell(有状态,owner 隔离) |
| `@deepseek-ai/dsh-tool-fs` | `read` / `write` / `edit` / `read_image` | 文件读写编辑(与 fs-observation-policy 的读后写策略配合) |
| `@deepseek-ai/dsh-tool-fs-search` | `grep` / `glob` | ripgrep 内容搜索与 glob 发现(内置 @vscode/ripgrep) |
| `@deepseek-ai/dsh-tool-str-replace-editor` | `str_replace_editor` | 独立 view/create/replace 编辑器工具 |
| `@deepseek-ai/dsh-tool-terminal` | `terminal_open/read/send/signal/list/close` | 持久 PTY 终端会话 |
| `@deepseek-ai/dsh-tool-web` | `web_search` / `web_fetch` | 网页搜索与抓取(provider 在 `ctx.web` 后面可换) |
| `@deepseek-ai/dsh-tool-subagent` | `subagent`(别名 `subagent_fork`) | 委托子代理(后台可续聊) |
| `@deepseek-ai/dsh-tool-subagent-control` | `send_message` / `interrupt_agent` / `list_agents` | 后台子代理控制 |
| `@deepseek-ai/dsh-tool-subagent-report` | `report` | 子代理向父代理汇报(仅持续型子代理内可见) |
| `@deepseek-ai/dsh-tool-jobs` | `job_list` / `job_output` / `job_kill` | 通用后台任务控制 |
| `@deepseek-ai/dsh-tool-todo` | `todo_write` | 结构化任务清单(会话日志事件驱动) |
| `@deepseek-ai/dsh-tool-goal` | `create_goal` / `get_goal` / `update_goal` | 同会话长期目标 |
| `@deepseek-ai/dsh-tool-ask-user` | `ask_user_question` | 向人类提问等答案 |
| `@deepseek-ai/dsh-tool-skill` | `skill` | 加载 skill 全文 |
| `@deepseek-ai/dsh-tool-session-query` | `session_event_read/search/trace`、`session_search`、`session_trace` | 会话历史只读查询/搜索/血缘 |
| `@deepseek-ai/dsh-tool-workflow` | `workflow` | JS 工作流脚本编排子代理 |
| `@deepseek-ai/dsh-tool-ralph` | `ralph` | 固定 Ralph 循环(每轮全新子代理) |
| `@deepseek-ai/dsh-tool-lsp` | `lsp` | 语言服务器导航(goToDefinition/findReferences/…四操作) |
| `@deepseek-ai/dsh-tool-cordis` | `cordis_define/run/stop/undefine/inspect_*` | 动态 Cordis 插件生命周期(默认不在任何 shipped 树,opt-in) |
| `@deepseek-ai/dsh-schedule` | `schedule_create` / `schedule_list` / `schedule_delete` | 会话内定时提醒 |
| `@deepseek-ai/dsh-plan-mode` | `exit_plan_mode` | 计划模式退出 |
| `@deepseek-ai/dsh-tool-goal` 之外的命令 | `ctx.commands`(如 `/goal`、`/loop`、`/compact`) | 人类命令,不经模型 |

**配置行概览**(`docs/config-catalog.md`,共 100+ 包有 config 块;按域归纳):
- **核心/循环**:`dsh-agent-loop`(并发上限等)、`dsh-tools`(呈现 mode)、`dsh-system-prompt`(persona/toolOrder)、`dsh-agent-default-model`(provider/model)、`dsh-tool-todo`(`allowParallelInProgress` 必填)
- **LLM**:`dsh-llm-deepseek`(`apiKeyEnv`/`baseURL`/`thinking`/`reasoningEffort`/`maxTokens`/`defaultContextWindow`/`models`/`streamIdleTimeoutMs`/`retryPolicy`)、`dsh-llm-pi-ai`(多 provider 字典)、`dsh-llm-retry`、`dsh-token-meter`
- **执行**:`dsh-bash-local`(`timeoutMs`)、`dsh-bash-sandbox`/`dsh-pwsh-sandbox`、`dsh-sandbox-policy`(`mode`/`workspaceRoot`)、`dsh-user-approval`、`dsh-permission-presets`、`dsh-code-runtime-worker-thread`(各执行上限)、`dsh-subprocess-local`
- **持久化/存储**:`dsh-session-persistence-jsonl`(`root`/`compression`)、`dsh-session-persistence-sqlite`、`dsh-storage-json`/`-sqlite`、`dsh-session-query-sqlite`(`path`/`openAt`)、`dsh-session-projection-cache`、`dsh-attachment-local`
- **能力缝 provider**:`dsh-fs-local`(`cwd`)、`dsh-fs-sandbox`、`dsh-terminal-bash`、`dsh-lsp-stdio`、`dsh-web-search-deepseek/exa/perplexity`、`dsh-web-fetch-http`、`dsh-subagent-*` 六个 backend(`providerName`/transport 参数)、`dsh-workflow-worker-thread`、`dsh-jobs-local`、`dsh-credentials-local`、`dsh-settings-file`、`dsh-skill`/`dsh-skill-filesystem`、`dsh-spill-local`/`-policy`
- **交互/上下文**:`dsh-plan-mode`(plan 策略 section)、`dsh-goal`、`dsh-time-context`、`dsh-tmux-context`、`dsh-agent-instructions`(`maxBytes`)、`dsh-session-title-*`(`targetWords`/`targetCjkCharacters`/`maxInputBytes`/`maxOutputTokens`/`timeoutMs`/`provider`/`model`)、`dsh-repeat-tool-reminder`、`dsh-compaction-basic`(`thresholdRatio`/`retainRatio`/…)、`dsh-compaction-tool-result-pruner`
- **宿主/API**:`dsh-host-webserver`(监听地址)、`dsh-host-directory-picker-browse`、`dsh-apiproxy`、`dsh-acp`(`provider`/`model`)、`dsh-sdk-jsonrpc-server`
- **bundle/演示**:`dsh-base`(默认行)、`dsh-web-app`、`dsh-headless`、`dsh-agent-spine-demo`、`dsh-acp-demo`

---

## 4. 真实示例插件(已读源码,附文件路径与写法要点)

### 4.1 `packages/todo/tool-todo/` —— 标准模型可见工具(首选模板)

读过的文件:`package.json`、`src/index.ts`(9.2KB)、`src/types.ts`、`tsconfig.json`、`tests/*`。

写法要点:
- 声明:`export const name = 'tool-todo'` + `export const inject = ['tools']` + `export function apply(ctx: Context, config: Config)`。**工具插件没有 `dsh` 字段**——`dsh` 字段只属于 bundle/profile(`dsh.bundle.patch` / `dsh.profile.bundles`),普通插件包靠 cordis.yml 行引用。
- 配置:同名 `Config` 接口 + `Config: z<Config>` schemastery schema,必填字段直接 `.required()`(`allowParallelInProgress` 是必填部署选择)。
- 注册:`ctx.tools.register(defineTool({ name: 'todo_write', description, parameters, output: { schema, render }, execute, presentCall }))`。description 随配置变化(并行策略不同,模型看到的措辞不同)。
- execute 里用 `exec.agent.session.append('todo/write', { todos })` 写会话日志(事件溯源);非 agent 调用者 throw 拒绝。
- 附带的投影单元:`ctx.inject(['sessionProjections'], …)` 里 `sessionProjections.register<'todos', TodoItem[] | null>({ key, schema, init, apply, view, stateVersion })` —— 服务存在才注册(HMR/组合安全)。

真实片段(节选自 `src/index.ts`):

```ts
export const name = 'tool-todo'
export const inject = ['tools']

export interface Config {
  allowParallelInProgress: boolean
}
export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),
})

export function apply(ctx: Context, config: Config): void {
  const allowParallel = config.allowParallelInProgress
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task list, replacing any previous list.',
        items: { /* … status enum, additionalProperties: false … */ },
      },
    },
    output: {
      schema: { /* object: todos + counts */ },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
      }],
    },
    execute(args, exec) {
      const todos = toTodoList(args.todos, allowParallel)
      if (!exec.agent) throw new Error('todo_write requires an owning agent session')
      exec.agent.session.append('todo/write', { todos })
      return Promise.resolve({ todos: /* … */, counts: /* … */ })
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }),
  }))
}
```

### 4.2 `packages/session/session-title-first-prompt-llm/` —— 最小 LLM 驱动的 seam provider

读过的文件:`package.json`、`src/index.ts`(仅 1.7KB,极好的最小样例)、`tsconfig.json`、共享逻辑 `../session-title-llm/src/index.ts`。

写法要点:
- 声明 `inject = ['sessionTitle', 'llm', 'sessions']`,通过共享助手 `registerSessionTitleLlmProvider(ctx, config, name, 'first-prompt', selector)` 注册为 `ctx.sessionTitle` 的**唯一**模型 provider(`session-title` seam 只允许一个 provider,重复注册抛错)。
- Config 复用 `SessionTitleLlmConfig` 类型与共享字段 schema(每个插件要导出自己的静态可遍历 schema,所以 `Config` 用 `SessionTitleLlmConfigFields.*` 组装,不重复定义校验)。
- 载荷选择器是个纯函数:`(messages) => [messages[0]]`(只取第一条人类消息做标题),主逻辑(路由、超时、组装、错误翻译)全在共享包里。

真实片段(全文件):

```ts
export const name = 'session-title-first-prompt-llm'
export const inject = ['sessionTitle', 'llm', 'sessions']

export type Config = SessionTitleLlmConfig
export const Config: z<Config> = z.object({
  targetWords: SessionTitleLlmConfigFields.targetWords,
  targetCjkCharacters: SessionTitleLlmConfigFields.targetCjkCharacters,
  maxInputBytes: SessionTitleLlmConfigFields.maxInputBytes,
  maxOutputTokens: SessionTitleLlmConfigFields.maxOutputTokens,
  timeoutMs: SessionTitleLlmConfigFields.timeoutMs,
  provider: SessionTitleLlmConfigFields.provider,
  model: SessionTitleLlmConfigFields.model,
})

export function apply(ctx: Context, config: Config): void {
  registerSessionTitleLlmProvider(ctx, config, name, 'first-prompt', (messages) => {
    const first = messages[0]
    if (first === undefined) throw new Error('first-prompt title provider requires one human message')
    return [first]
  })
}
```

### 4.3 `packages/llm/llm-deepseek/` —— LLM 适配器(注册 `ctx.llm`)

读过的文件:`package.json`、`src/index.ts`(12.6KB)、`src/adapter.ts`、`src/serialize.ts`、`src/sse.ts`、`src/types.ts`。

写法要点:
- `export const name = 'llm-deepseek'`、`inject = ['llm']`;适配器类 `DeepSeekAdapter extends LlmAdapter`,实现 `async * stream(options)`。
- 注册两件事:
  - `ctx.llm.registerConfigurableProviders([{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs, settingsPath }])` —— 让 web Models 页可配置;
  - `ctx.llm.registerAdapter([PROVIDER], adapter)` —— 绑定 provider 路由(路由级注册,effect 绑定 apply fiber,HMR 安全;同路由重复注册抛错)。
- 配置:全部可选(缺 key 不在加载期报错,而是每请求解析时 `MISSING_CREDENTIAL`);显式 `resolve()` 步骤(load 时 fail loud + settings 快照首用时校验),满足"显式 > 隐式"的包边界原则。
- 密钥:经 `ctx.credentials` 缝(`credentialRef(config.apiKeyEnv ?? 'DEEPSEEK_API_KEY')`)按请求解析;无 credentials 服务时回退 launch environment。不写死读 key 文件。
- 附带 `installSettingsSection(ctx, NS, Config, config, …)` 让 `$DSH_HOME/settings.yaml` 的 `llm-deepseek:` 节可热改。

真实片段(节选自 `src/index.ts`):

```ts
export const name = 'llm-deepseek'
export const inject = ['llm']

export function apply(ctx: Context, config: Config): void {
  // …每请求解析 connection/credential 事实,失败时保留上一代好配置…
  const adapter = new DeepSeekAdapter({ options, resolveApiKey, resolveUserId })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  // …注册是 effect,绑在 apply fiber 的 ctx 上;retry 策略变化时 registration.replace([PROVIDER]) 原地刷新…
}
```

### 4.4 `packages/preset/persona/` —— 系统提示词 section(补充)

读过的文件:`src/index.ts`。要点:`inject = ['systemPrompt']`;`apply` 里 `ctx.effect(() => ctx.systemPrompt.section({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: config.text, … }))` 注册一个提示词 section;这是个**scope-only** 行——全局挂会与 registry 自带 persona 冲突并 loud fail,必须挂进 agent preset 的作用域(用 `isolate` realm),给单个会话换身份/工具集。完整片段见 2.4 节。

> 另可参考 `examples/headless-agent/cordis.yml`(真实产品级组合:settings/credentials/llm-deepseek/subprocess/bash/agent-spine/persistence/token-meter/compaction/subagent/workflow/todo/fs 一行一行怎么挂)、`packages/bundle/base/cordis.patch.yml`(bundle 层写法,一个 `insert:` 全量基础行 + 平台条件 `disabled: !!js process.platform …`)。

---

## 5. 本机验证记录(Windows 11,2026-08-17)

### 5.1 工具链

| 工具 | 版本 | 备注 |
|---|---|---|
| Node.js | v24.15.0 | 满足仓库要求 `^22.19 || >=24` |
| corepack | 0.34.6 | `corepack enable` 后可用 |
| git | 2.54.0.windows.1 | |
| pnpm | 11.7.0 | 首次在仓库内运行由 corepack 自动解析根 `package.json` 的 `"packageManager": "pnpm@11.7.0"`(corepack 先装了全局 11.22.0,进仓库后自动切到钉住的 11.7.0) |

### 5.2 clone / install / typecheck / build 结果

| 步骤 | 命令 | 耗时 | 结果 |
|---|---|---|---|
| clone | `git clone https://github.com/deepseek-ai/deepseek-harness.git .` | ≈16s(7412 文件) | 成功,分支 `master`,HEAD `47f943859b`(Merge PR #2519 feat/npm-public) |
| install | `pnpm install` | 22.6s | 成功(exit 0);postinstall 里 `scripts/install-lefthook.mjs` 打印 Done |
| lefthook(补装) | `env -u CI node scripts/install-lefthook.mjs` | 0.8s | 成功:`.git/dsh-hooks/{pre-commit,pre-merge-commit,pre-push}` + `core.hooksPath`(worktree 级) + `merge.dsh-translation-pairing` driver |
| typecheck | `pnpm run typecheck` | 62.8s | **通过**(exit 0):`tsc -b tsconfig.host.json` + tsdown(host)+ `tsc -b tsconfig.client.json` 全绿 |
| build | `pnpm run build` | 16.3s | 通过(exit 0):lib host/client + web 前端 vite build;仅有 chunk>500kB 提示,非错误 |
| dump-config | `pnpm dsh --profile web --dump-config` | 1.1s | 成功(exit 0),输出完整组合树(每层带 `# ==` 来源注释) |

**lefthook 说明**:本环境设置了 `CI=true` 环境变量,而 `install-lefthook.mjs` 见到 `CI=true` 会**刻意跳过**(CI 不装本地钩子),所以 `pnpm install` 的 postinstall "Done" 其实是跳过;按 `docs/development.md` 手动补跑时需要 `env -u CI`(否则同样被跳过)。安装后 `git config --show-origin core.hooksPath` 指向 `.git/dsh-hooks`。

**安装期两个 WARN(良性)**:`pnpm install` 曾警告 `examples/…/.bin/dsh-acp-demo` 与 `python/sdk-runtime/…/.bin/dsh-jsonrpc-agent` 的 bin 链接找不到 `lib/bin.js.EXE` —— 因为全新 checkout 还没构建,`lib/bin.js` 尚不存在;`pnpm run build` 后 `packages/examples/{acp-demo,jsonrpc-demo}/lib/bin.js` 均已生成,警告不再复现。

### 5.3 DEEPSEEK_API_KEY 结论

**`dsh --profile web --dump-config` 不需要 `DEEPSEEK_API_KEY`。** 实测:环境变量未设置、仓库根无 `.env`,命令仍 1.1s 成功退出。原因(读 `apps/cli/src/dump-config.ts`):`--dump-config` 只用 include 插件的 patch 算法**离线组合配置层**,不 boot 插件树、不求值 `!!js`、不碰 credentials/settings 服务,`!!js` 表达式原样打印。**真正启动** `pnpm dsh web` 或跑 headless 任务才需要 key(由 `dsh-llm-deepseek` 每请求解析,缺 key 报 `MISSING_CREDENTIAL` 而非加载期失败)。

### 5.4 本 checkout 的常用命令

```sh
pnpm run build                          # 全量构建(lib host/client + web 前端)
pnpm run typecheck                      # 类型检查(等价 tsc -b host + tsc -b client)
pnpm dsh --profile web --dump-config    # 打印 web profile 组合树(免 key)
pnpm dsh web                            # 启动 Web UI → http://127.0.0.1:3080(需 key)
pnpm dsh --profile headless "task"      # 一次性 headless 任务(需 key)
pnpm dsh --profile <name> --patch ./x.yml   # 带 overlay 启动
pnpm run test                           # vitest 单测
```

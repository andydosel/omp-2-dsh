# READ 侧路径级限制在 `dsh-v0.2.0-rc.2` 上是否可实现(只读核验)

- 目标 tag:`dsh-v0.2.0-rc.2` = `639ed015397290b3745d163aafe02ffee4aa3f84`
- 旧 pin 对照:`b150a551b8` = `dsh-v0.1.1-rc.2`
- 被核验的断言:`DESIGN-COORDINATOR-SUITE-V1.0.md` §5.9 表格——秘书(secretary)「读文档 ✓ / 读结构 ✓ / 读代码正文 ✗」,而文档只给出 `agentCtx.tools.restrict({allow:[...]})`(工具**名**级)+ **自建** `tools/pre-execute` **写**路径闸(`write`/`edit` 的 `file_path`)。
- 方法:`git show <tag>:<path>` / `git grep -n <pattern> <tag> -- <paths>`。**未改动仓库任何文件**;行号均指对应 tag 内文件行号(rc.2 为主,旧 pin 仅作对照)。
- 一句话结论:**READ 侧路径级限制可实现**,机制与现有写闸同构(一个 `agent.ctx` 上的 `tools/pre-execute` listener,按 `read`/`glob`/`grep` 等的路径参数 deny);dsh **没有任何内建**的"只能读这些路径"原语;**唯一诚实缺口是 `bash`**(bash 是未受管的读面,沙箱只围栏写)。

---

## 1. `tools/pre-execute` 的拦截范围:每一次工具执行(含 `read`/`grep`/`glob`/`bash`)

### 1.1 事件签名与调用点

- 事件签名:`packages/core/tools/src/index.ts:153`(旧 pin `:152`)
  `'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>`
- 调用点(`prepareExecution`,每个调用必经):
  - `packages/core/tools/src/index.ts:1489` `prepareScheduledExecution(input)` → `:1494` `prepareExecution<T>(...)`
  - `:1496` `createExecution(input)`(物化 + 冻结参数)
  - `:1504` `const carrier = scopeTarget(this, exec.agent)`
  - **`:1505-1508`** `await this.ctx.waterfall(carrier, 'tools/pre-execute', exec, () => Promise.resolve<PreToolDecision>({ kind: 'allow' }))`
  - 之后才 `:1535` `return await next({ kind: 'dispatch', exec })`(body 由 `:1581` `tool.execute(exec.arguments, exec)` 执行)
- **不是**"只对写类工具":`prepare` 属于调度器的固定三段(`prepare` → dispatch → post),`executionMode()`(`:1303`)与工具名无关地走同一条 prepare(`:1303-1311` 只决定 parallel/exclusive)。`read`、`grep`、`glob`、`bash` 与 `write` 走的是同一个 `:1505` waterfall。
- 仅有的两个"不进 pre-execute"分支,都不改变上述结论:
  - `:1500` 调用前已 abort(`callerCancelled`)→ 直接 `final-result`;
  - `:1400-1404` **collapsed**(PTC 模式折叠)的工具在 policy 之前确定性拒绝——注释(`:1403`)明说"pre-execute listeners, approval `ask`, and guards must never observe … a call that can only fail",即**设计上的例外恰恰证明其他所有调用都会进 pre-execute**。
- PTC(`run_code`)内层子调用同样过闸:`packages/core/tools/src/ptc.ts:420-421` 注释"prepare = pre-execute/guards",`:433` `/** Ordered stage: append the start event, await prepare (pre-execute/guards), launch the body into `flight`. */`。

### 1.2 `ToolExecution` 形状:listener 看得到 name + args

- `packages/core/tools/src/index.ts:326` `export interface ToolExecutionInput`(旧 pin `:314`):
  - `:327` `readonly callId: ToolCallId`
  - **`:333` `readonly name: string`**
  - `:335` `readonly schema?: ToolSchema`(仅 PTC 内层调用)
  - **`:337` `readonly arguments: unknown`** —— 注释:"Losslessly JSON-serializable parsed arguments (tools validate their own schema)"
  - `:339` `readonly agent?: Agent`("The agent on whose behalf the call runs (set by the agent loop)")
  - `:349` `readonly parent?: ToolExecutionToken`
  - `:351` `readonly signal: AbortSignal`
  - `:393` `export interface ToolExecution extends ToolExecutionInput { readonly rootCallId; readonly token }`
- 参数在 policy 之前就被物化并深冻结:`:1441` `const detached = snapshotJsonValue(exec.arguments)`,随后 `arguments: deepFreeze(detached)` 构成 `ToolRunContext`。⇒ listener 拿到的是**已解析成 JSON 对象的参数**(如 `read` 的 `file_path` 就是一个可直接取用的字段),不是字符串,也不是必须自己 parse。
- 可返回的决策:`packages/core/tools/src/index.ts:607-611` `PreToolDecision = {kind:'allow'} | {kind:'deny'; reason; info?} | {kind:'cancel'} | {kind:'ask'; reason?; displayReason?}`。
- **未命名的 `path` 字段**:参数对象就是模型给的那个对象(PTC 与 native 一致),故 `read` 的 `file_path`、`glob`/`grep` 的 `path`、`bash` 的 `command` 都能直接读到。同一模式的在仓先例:
  - `packages/context/agent-instructions/src/index.ts:75-83` `filePathFromExecution(exec)`:先按 `exec.name` 白名单(`:75` `new Set(['read','write','edit'])`),再 `'file_path' in exec.arguments && typeof … === 'string'`(`:78-80`)取出并 `trim()`。
  - `packages/hooks/hooks-codex/src/index.ts:329` `tool_input: { command: commandOf(exec.arguments) }`。
  - `packages/hooks/hooks-claude-code/src/index.ts:345` `tool_name: exec.name, tool_input: exec.arguments`。
- LSP:更精确地说,`exec` 在 `tools/execute`(dispatch)阶段被**再包装**为 `ToolDispatchExecution`(`:405`),而 pre-execute 的 view 就是 `ToolExecution` 本体(参数只读、`signal` 不可替换;`allow` 之后才允许 wrapper 换 signal)。

### 1.3 deny 确实短路 dispatch(e2e 证据)

`packages/core/agent-loop/tests/interception.spec.ts:705`(`describe('tools/pre-execute gate (native-plugin permission pattern, end-to-end through the loop)')`):`:716` 的 listener 对 `exec.name === 'danger'` 返回 `{kind:'deny', reason:'blocked dangerous tool'}`(`:717`)→ `:724` `expect(ran).toBe(false)`(body **未执行**),`:725-728` 模型看到的是一条 `isError` 结果。同一文件 `:753` 起是"native hook 就是一个普通 cordis 插件"的完整范例。⇒ deny 对任意工具名(包括 `read`)都有效,不是"写工具专属"。

### 1.4 三个使用注意(与实现强相关)

1. **监听器注册在 `agent.ctx` 时按 agent 路由**:`:1504` `scopeTarget(this, exec.agent)`;`packages/core/scope/src/scoped-events.generated.ts:34`:`'tools/pre-execute': args => (args[0] as Record<string, unknown>)['agent']`。⇒ 每个角色在自己的 agent scope 上挂一个 listener 是**一等公民用法**。同理 `ctx.tools.guard()`:`:1135` 注册、`:1145-1157` `guardReason` 按 global → `chainLayers(exec.agent)` 顺序取首个拒绝,文档 `:1126-1134` 明说"one registered through `agent.ctx` applies only to that agent"(`:1128-1129`)。生产代码里"按 agent 施加工具集"的现成先例:`packages/subagent/subagent/src/child-agent.ts:218` `if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)`(子 agent 的 `toolFilter` 落在 `childCtx`,即 agent scope)。
2. **pre-execute 有意不能改写 `exec.arguments`**:`packages/core/tools/README.md:230`("logged and rendered args would desync from what ran")。⇒ 闸只能 `allow`/`deny`/`ask`/`cancel`,**不能把路径夹到白名单**(如"把 `src/x.ts` 改写成提示")。
3. **args 在闸阶段未经 schema 校验**:`:337` 注释"tools validate their own schema"(校验发生在工具自己的 `parseReadArgs` 等)。⇒ 闸必须对参数形状做防御式取值(缺失/非字符串/空串一律 fail-closed),照抄 `agent-instructions` 的写法。

---

## 2. 有没有路径级 READ 限制原语?——**没有**(与 write 侧同样缺席)

| 候选机制 | 结论 | 证据 |
|---|---|---|
| `ctx.tools.restrict(filter)` | **只有工具名掩码**(allow/deny 全局工具名),无 path 维度 | `packages/core/tools/src/index.ts:700-706` `ToolRestriction { readonly allow?: readonly string[]; readonly deny?: readonly string[] }`(旧 pin `:680`);实现 `:1097-1125`,注释 `:1094`"global-tool mask: `allow` (keep only) and/or `deny` (remove)";错误信息也只处理**名字**(`:1117` names unknown global tool)。旧 pin `:1071` 同构 |
| `ctx.fs` 读 API | 签名只有 `target + signal`,**无 policy/allowlist 参数** | `packages/fs/fs/src/index.ts:181` `stat(target, signal?)`、`:205` `readText(target, signal?)`、`:216` `streamText(target, signal?)`、`:252` `listDir(target, signal?)`(旧 pin `:176`/`:187` 同形) |
| `read` 的路径解析边界 | **无边界**:只把相对路径按 session cwd 解析,绝对路径原样放行 | `packages/fs/tool-fs/src/read-target.ts:19-25` → `:24` `ctx.fs.resolve(requestedPath, sessionResolveOptions(exec))`,`:25` `ctx.fs.stat(...)`;唯一失败是 `undefined` → `FS_NOT_FOUND`(`:26-28`)、非普通文件 → `FS_NOT_REGULAR_FILE`(`:29-31`) |
| `fs-observation-policy` | **纯写侧门**:只有 `fs/write-intent` / `fs/edit-intent` / `fs/observed` 三个决策,**没有任何读准入** | `packages/fs/fs-observation-policy/src/index.ts:3-6`(模块注释:"Event-only filesystem observation policy… Without this plugin, tools retain the bare provider's unconditional mutation behavior");类内 `writeIntent` / `editIntent` / `observe` |
| `sandbox` / `sandboxMode` | **只围栏写**(`read-only` 模式=禁写,不是"只读某路径") | `packages/sandbox/sandbox-policy/src/session-mode.ts:42` `SANDBOX_MODES = ['read-only','workspace-write','danger-full-access']`;`packages/sandbox/sandbox-policy/README.md:148` "**File-effect modes only** — `SandboxMode` governs file effects";`packages/fs/fs-sandbox/src/index.ts:126-128` `if (mode === 'read-only') throw new FsError('… file access denied under read-only mode','FS_SANDBOX_DENIED')`(在 `checkedTarget()` 里,**只对 mutation 调用**:该 fence 只包 `writeText`/`editText` 等写入方法,如 `:108` `super.editText(await this.checkedTarget(...), …)`);`:111-121` 注释"Enforce the per-call policy against `target`… `read-only` denies"(`checkedTarget` 定义在 `:122`) |
| 沙箱 profile 是否顺带限制读 | **没有,全盘可读** | `packages/sandbox/sandbox-local/src/profiles.ts:17` bwrap:`['--ro-bind','/','/','--dev','/dev',…]`(整个 `/` 以只读方式挂进沙箱 → 什么都读得到);`:35` landlock:`landlockGrantArgs({ readOnly: ['/'], readWrite })`(读白名单=整个 `/`);`:52` seatbelt:`['(version 1)','(allow default)','(deny file-write*)',…]` |
| 全仓"读白名单"命中 | **零**;`allowlist`/`writableRoots` 命中全是写侧 | `packages/sandbox/sandbox-windows-acl/src/index.ts:62,73,166`(write-SID write allowlist)、`packages/sandbox/sandbox-windows-acl/README.md:182`("One **write** allowlist per workspace")、`packages/fs/fs-sandbox/README.md:75`(writableRoots) |

**结论**:dsh **不存在**任何内建的"这个 agent 只能读这些路径"的机制——不像"写有沙箱三档"那样至少有 mode 级近似,读侧连 mode 级近似都没有(`read-only` 档位读全开,见 `packages/fs/fs-sandbox/README.md:50`:"Reads, listings, metadata, and read-only watches work exactly as with `fs-local`; the mutation fence does not restrict observation")。因此 §5.9 的读侧梯度只能落在 `tools/pre-execute` 上(与写闸同一机制),这一点文档判断是对的,只是**没有把这个机制延伸到读面**。

---

## 3. `read` / `glob` / `grep` 暴露的路径参数(闸可取到的字段)

| 工具 | 注册 | 路径参数 | 备注 |
|---|---|---|---|
| `read` | `packages/fs/tool-fs/src/read.ts:78` | **`:81` `file_path`(required)**;`:82` `offset`、`:83` `limit` | `:136` `isConcurrencySafe: () => true` → **parallel**(写侧 `write`/`edit` 未声明 → exclusive,见 `packages/core/tools/src/index.ts:1307`);`:137` `execute` → `:141` `resolveRegularReadTarget`;`:146-147` `streamText`/`readText`;`:204`/`:206` presenter 也用 `args.file_path`(说明该字段在全部阶段稳定可读) |
| `read_image` | `packages/fs/tool-fs/src/read-image.ts:210` | **`:214` `file_path`(required)** | **另一个读面工具**(与 `read` 是不同工具名),读闸必须一并覆盖 |
| `glob` | `packages/fs/tool-fs-search/src/glob.ts:307` | **`:318` `path`(可选)**,"Directory to search in. Defaults to the session workspace" | `:312` `pattern`(required);`:336` `execute` |
| `grep` | `packages/fs/tool-fs-search/src/grep.ts:285` | **`:290` `path`(可选)**,"File or directory to search. Defaults to the session workspace" | `:289` `pattern`(required);`:321` `execute` |
| `str_replace_editor`(可选挂载) | `packages/fs/tool-str-replace-editor/src/index.ts:430` | **`:439` `path`(required)** + `:433-436` `command` enum `view|create|str_replace|insert` | **`view` 命令能读文件正文与目录树**(`:460` `view_range`)⇒ 即使不装 `read`,只要装了它,读面就存在 |
| `lsp`(可选挂载) | `packages/lsp/tool-lsp/src/index.ts:110` | **`:120` `file_path`(required)** | `:117` `operation` enum `goToDefinition/findReferences/goToImplementation/hover`(`packages/lsp/tool-lsp/src/render.ts:15`)⇒ **返回的是代码正文/符号**,纯读面 |
| `bash` | `packages/shell/tool-bash/src/index.ts:374` | **无路径参数**:`:377` `command`(string, required) | 见 §4(b) 旁路 —— `cat src/**.ts` 就读到代码正文 |

**组合事实(底座默认就装了读面)**:`packages/bundle/base/cordis.patch.yml:281-282` `tool-fs`、`:284-285` `tool-fs-search`、`:267-268` `tool-bash`(均为 base 层,默认在);web-app 侧把 `tool-fs`/`tool-fs-search` 下移到 **preset(agent)层**(`packages/bundle/web-app/presets/standard.patch.yml:26-29`、`ptc.patch.yml:26-29`),即"角色信封"要落在 preset 组合里才生效。

---

## 4. 裁决

### (a) READ 侧路径级限制能否用 `tools/pre-execute` 实现?——**能**

机制完全同构于文档已有的写闸,只是匹配的工具集合更大:

- 在角色 agent 的 scope 上挂 `tools/pre-execute`(`packages/core/tools/src/index.ts:153` 签名,`:1504-1508` 按 `exec.agent` 路由到该 scope;`scoped-events.generated.ts:34` 佐证 agent 路由键);
- 读 `exec.name`(`:333`)与 `exec.arguments`(`:337`,已 deepFreeze);
- 对 `read`/`read_image`/`lsp` 取 `file_path`,`glob`/`grep` 取 `path ?? workspace 根`,`str_replace_editor` 取 `(command==='view', path)`;
- 路径规范化后**不在**角色的读白名单(`docs/**` + 交接区 + 结构索引所需范围)内 → 返回 `{kind:'deny', reason:…}`(`:607`)。
- 效果已被 e2e 证明:deny 使 body 不执行、模型只看到 `isError`(`packages/core/agent-loop/tests/interception.spec.ts:716-728`)。

⇒ §5.9 的"读代码正文 ✗"对**文件工具面**是机制可强制的,不需要新原语。

### (b) 注意/限制(caveat)

1. **`read` 是 parallel-safe,写工具是 exclusive**——不影响闸:pre-execute 都先于 dispatch(`:1505` 早于 `:1581`),且闸本身可 await(`:1505` `await this.ctx.waterfall(...)`)。
2. **参数未校验 + 路径未规范化**——闸看到的只是模型给的原始字符串。`../`、符号链接、绝对路径、Windows 盘符/大小写/短名、UNC 等都能绕过朴素前缀判定。建议**白名单式**(只放行规范化后确实在 `docs/**` 之下的路径),而非"命中 `src/` 就拒绝"的黑名单式;并可复用 `ctx.fs.resolve` 的语义化行为(`packages/fs/tool-fs/src/read-target.ts:24`)做规范化。
3. **闸不能改写参数**(`packages/core/tools/README.md:230`)——只能 deny/ask,不能"把路径夹回白名单"。
4. **读面不止一个工具名**——`read`(`read.ts:78`)、`read_image`(`read-image.ts:210`)、`glob`(`glob.ts:307`)、`grep`(`grep.ts:285`)、可选 `str_replace_editor view`(`:430`/`:433-436`/`:439`)、可选 `lsp`(`tool-lsp/src/index.ts:110/:120`),此外 `skill-filesystem`、`session-query`(`session_search` 等,`packages/session-query/tool-session-query/src/index.ts:66-109`)、`web_fetch` 也都能带内容进上下文。⇒ 闸必须**枚举完整读面**或改为"默认拒绝 + 白名单放行",否则留缺口。
5. **`glob`/`grep` 的 `path` 可省略**——省略时默认整个 session workspace(`glob.ts:318`、`grep.ts:290`)。闸必须把"省略"解释为 **workspace 根**(即通常不属于 `docs/**` 白名单 → 拒绝),否则模型一次 `glob **/*.ts` 就拿到 `src/**` 的路径清单。"读结构 ✓"若不希望暴露 `src` 结构,`glob`/`grep` 也得按白名单限制,或另给一个只搜 `docs/**` 的 scoped 工具。
6. **`bash` 是决定性缺口(见下)**。

### (c) 建议写进文档的机制

1. **一个共享 listener,而不是两个闸**:`dsh-role-envelope`(可复用 `dsh-review-gate` 的骨架)为每个角色定义
   `{ toolAllow?: string[], toolDeny?: string[], readPaths: string[], writePaths: string[] }`,
   单条 `agent.ctx` 上的 `tools/pre-execute`(或 `ctx.tools.guard()`,同步版)按如下映射判:
   - `read` / `read_image` / `lsp` → `args.file_path`
   - `glob` / `grep` → `args.path ?? workspaceRoot`
   - `str_replace_editor` → `command === 'view' ? path → readPaths : path → writePaths`
   - `write` / `edit` → `args.file_path` → `writePaths`(＝文档现有写闸,合并进来)
   - 其余工具 → 按名 allow/deny(与 `agentCtx.tools.restrict` 互补:`restrict` 管"模型看不见",闸管"看见也不能做"——保留 `read` 却按路径限制时,只有闸能表达)
2. **两侧都用白名单**,`readPaths` 与 `writePaths` 明确按角色写清(秘书:`readPaths = docs/**` + 交接区 + 任务板,`writePaths = 交接区`;负责人:`readPaths = 全部`,`writePaths = docs/**` + 交接区;worker:全开),并在文档里给出 `deny` 的 reason 文案(让模型知道是能力信封,不是故障)。
3. **文档必须写明 bash 旁路这一诚实边界**,并在两者之间**明确二选一**(不要含糊):
   - **(i) 硬保证**:秘书的 `toolDeny` 含 `bash`(以及任何 shell/pwsh 变体、`str_replace_editor`、`lsp` 若不需要)。此时"读不到代码正文"是**机制强制**的。
   - **(ii) 保留 bash(秘书常需跑 `ls`/`grep` 探索)**:此时读面路径梯度**只能是 best-effort**——沙箱只围栏写(`profiles.ts:17/:35/:52`,`fs-sandbox/README.md:50`,`sandbox-policy/README.md:148`),`read-only` 模式下 `cat src/x.ts` 畅通无阻;闸对 `bash` 只能对 `command` 字符串做启发式(仓内先例 `hooks-codex/src/index.ts:329` 也只提取 command 文本),挡不住 `python -c`/`base64`/变量拼接/pager 等变换。文档应把"读代码正文 ✗"标为**约定+提醒(prompt/persona 层)**,而不是声称机制强制。
4. **顺带需澄清的文档内部不一致**(同一张 §5.9 表):"秘书 写文档(`docs/**`/`.md`)✗"与"秘书 写长任务书(交接区)✓"互相矛盾——若交接区=文档,则秘书至少需要一处 `writePaths`;建议把秘书的 `writePaths` 显式写成"交接区/任务板路径",而不是"无写权限"。另外"读结构(目录树/符号索引)✓"在 dsh 侧**没有内建符号索引工具**(只有 `glob` 目录树、可选 `lsp` 符号查询),需要明确秘书走哪个具体工具,否则该行无法落成配置。

---

## 附:旧 pin(`b150a551b8`)对照

结论**不随 pin 变化**,上述原语在旧 pin 同样存在且形状相同:

| 事实 | rc.2 | 旧 pin |
|---|---|---|
| `tools/pre-execute` 事件签名 | `core/tools/src/index.ts:153` | `:152` |
| `ToolExecutionInput`(含 `name`/`arguments`/`agent`) | `:326`(`name :333`,`arguments :337`,`agent :339`) | `:314`(`:321`,`:323`) |
| `ToolRestriction`(仅名掩码) | `:700` | `:680` |
| `restrict(filter)` | `:1097` | `:1071` |
| `read` 的 `file_path` / `isConcurrencySafe` | `packages/fs/tool-fs/src/read.ts:81` / `:136` | `:80` / `:135` |
| `glob` 的 `path` | `packages/fs/tool-fs-search/src/glob.ts:318` | `:324` |
| `fs.readText/streamText(target, signal?)` | `packages/fs/fs/src/index.ts:205` / `:216` | `:176` / `:187` |

即:该设计缺口不是"新 pin 的回归",而是 dsh 读侧能力**一直**缺席;写进文档的机制建议在两个 pin 上都可直接实施。

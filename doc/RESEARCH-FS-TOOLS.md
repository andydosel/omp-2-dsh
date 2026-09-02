# dsh 侧调研：迁移 omp read/write 的插件设计事实

> 目的：为「把 omp 的 read/write 迁移为 dsh 插件」提供 dsh 侧事实。只读调研，所有结论均附源码证据（`packages/fs/tool-fs`、`packages/core/tools`、`packages/core/scope`、`packages/fs/fs`、`packages/bundle/*`、`packages/fs/tool-fs-search`、`packages/fs/tool-str-replace-editor`、`packages/web/tool-web`、`packages/session-query/tool-session-query`、`apps/cli/config/agent-presets/*`）。
> 对照基准：omp `read`（单 `path` 字符串 + `:N-M`/`:raw`/`:conflicts` 选择器，覆盖文件/目录/归档/SQLite/URL/文档/notebook/内部 URL/图片）与 omp `write`（文件/归档条目/SQLite 行/conflict 解析/xd:// 设备）。

---

## 1. 当前 dsh 模型可见 fs 工具全景

`@deepseek-ai/dsh-tool-fs` 是唯一的「模型可见文件系统工具」包：**一个插件 `apply` 里一次注册全部四个工具**（`packages/fs/tool-fs/src/index.ts:33-66`）。`Config` 只有 4 个 read 上限字段，**没有 per-tool 开关**（`index.ts:28-40`）。

| 工具 | 参数（snake_case） | 输出 schema | 能力 | 上限（默认） |
|---|---|---|---|---|
| `read` | `file_path`(必)、`offset?`(number,1 起,默认 1)、`limit?`(默认=上限)（`src/read.ts:106-112`） | `{ path, offset, lines: [{number, text}], totalLines }`（`read.ts:115-123`） | **仅 UTF-8 文本文件**，行号输出；1 次 stat → `readText`/`streamText` → 行窗口；超大/未知大小文件流式（`read.ts:136-150`）；目录目标报 `FS_NOT_REGULAR_FILE`（`src/read-target.ts:26-31`） | `readLimit=2000` 行（`read.ts:30`）、`readMaxLineLength=2000` 字符/行（`read-render.ts:23`）、`readMaxBytes=51200`（50KiB）/次（`read-render.ts:26`）、`readStreamMinSize=10MiB`（`read.ts:36-37`） |
| `read_image` | `file_path`(必)（`src/read-image.ts:180-183`） | `{ path, image: { attachmentId, mediaType, bytes, width, height, name? } }`（`read-image.ts:94-109`） | 仅 PNG/JPEG/WebP/GIF（`read-image.ts:29-37`）；经 `attachments.saveImage` 持久化后返回原生 image block；**仅在 attachments 服务挂载时注册**（`index.ts:57-59`），执行时要求路由模型声明 image 输入（`read-image.ts:66-82`） | 字节上限 = `min(imageLimits.maxImageBytes, maxMessageImageBytes)`（`read-image.ts:159-161`） |
| `write` | `file_path`、`content`（均必填）；confining 后端下追加 `sandbox_permissions`/`justification`（`src/write.ts:77-82`） | `{ path, operation: 'create'\|'update', before: string\|null, after }`（`write.ts:91-102`） | **整文件创建或覆盖**（UTF-8）；无 stat；经 `fs/write-intent` waterfall 取得 intent（缺省=无条件覆盖；挂 `fs-observation-policy` 后=createIfAbsent / replaceIfVersion），再 `ctx.fs.writeText`（`write.ts:118-127`）；成功后 `fs/observed` 记录新版本（`write.ts:128-130`） | 无内容字节上限（provider 层 `diffBasisMaxBytes=10MiB` 仅约束 diff 语境，`fs-local/src/index.ts:52`） |
| `edit` | `file_path`、`old_string`(非空)、`new_string`、`replace_all?` + 沙箱字段（`src/edit.ts:56-73`） | `{ path, before, after }`（`edit.ts:90-98`） | 字面量替换，唯一匹配否则抛 `FS_AMBIGUOUS_EDIT`；经 `fs/edit-intent` + `ctx.fs.editText`（`edit.ts:117-132`） | 同 write |

调度：`read`/`read_image` 声明 `isConcurrencySafe: () => true` → 可并行（`read.ts:135`、`read-image.ts:162`）；`write`/`edit` 未声明 → **默认 exclusive**（`packages/core/tools/src/index.ts:1271-1285`）。

**结论（Q1）**：dsh `read` 只支持「1 起 offset + 正向 limit」窗口，**没有** omp 的行区间选择器（`:A-B`、`:A+C`、多区间、`:raw`、`:conflicts`），也**没有**目录列表、归档、SQLite、URL、文档、notebook、内部 URL 分支。`write` 只做整文件覆盖，**没有** hashline/快照校验（dsh 的新鲜度模型是 `FsVersion` token + `fs/observed` + provider CAS，见 §5），也没有归档条目/SQLite 行/conflict 写入。`edit` 走的是「观察版本 + CAS」，不是 omp 的 hashline `[path#TAG]`。

---

## 2. 其他 dsh 工具已覆盖 / 真正缺失（相对 omp read/write）

| 能力 | dsh 现状 | 证据 |
|---|---|---|
| 文件读 | `read`（UTF-8 文本，行窗口） | `tool-fs/src/read.ts` |
| 文件读+目录列表 | `str_replace_editor` 的 `view` 命令：文件（`view_range` 行号区间）或目录 2 层列表；另有 `create`/`str_replace`/`insert`，且同样走 `ctx.fs` + `fs/*` 事件 | `packages/fs/tool-str-replace-editor/src/index.ts:22,216-237,239-272` |
| 搜索/发现 | `glob`（默认 100 结果）、`grep`（默认 250 匹配、行预览 2000B、raw 输出 20MB、30s 超时） | `tool-fs-search/src/glob.ts:26`、`grep.ts:30-36`、`search-core.ts:35-42` |
| URL 读取 | `web_fetch`（`{url}` → `{url,statusCode,body,truncated}`，输出 cap 默认 200k 字符）——**但 base bundle 配置 `fetch: false` 默认禁用**，默认部署模型没有 URL 读取工具；`web_search` 开启（provider deepseek-official） | `tool-web/src/fetch.ts:437-490`、`tool-web/src/index.ts:29-32`、`packages/bundle/base/cordis.patch.yml:414-418` |
| 会话历史读 | `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read` | `packages/session-query/tool-session-query/src/index.ts:66-116` |
| 图片读 | 独立 `read_image`（仅 4 种格式，需 attachments + image 能力路由） | §1 |
| 执行命令 | `bash`/`pwsh`（按平台互斥，win32 用 pwsh） | `base/cordis.patch.yml:210-216` |

**真正缺失（迁移插件要补的）**：
- `read`：目录树渲染；`.tar/.tar.gz/.tgz/.zip/.jar/.war/.ear/.apk` 归档读取；SQLite（表列表/schema/行/`?q=`）；URL 渲染管线；`.pdf/.docx/.pptx/.xls/.rtf/.epub` 文档转换；`.ipynb` notebook；内部 URL（`local://`、`agent://`、`artifact://`、`history://`、`skill://` 等）；`A-B`/`A+C`/多区间/`:raw`/`:conflicts` 选择器；hashline 快照与编辑锚点。
- `write`：归档条目写（原子重写容器）、SQLite 行 insert/update/delete、`conflict://` 解析、`xd://` 设备分发。
- 这两者整个在 dsh 的工具层**不存在**（已 grep 全仓：除 tool-fs 外无任何 sqlite/archive/notebook/文档读取实现）。

---

## 3. 重名注册语义（关键结论）

- 工具注册表按 **scope 分层**（`ToolLayer`，`packages/core/tools/src/index.ts:714-729`）；每一层的 `tools` 是 `NamedEntries`，`insert` 时 `if (data.has(name)) throw this.duplicateError(name)`（`packages/core/scope/src/store.ts:43-46`）。
- duplicateError（`core/tools/src/index.ts:726-728`）：
  - 全局（root ctx）→ `tool "<name>" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
  - 作用域 → `tool "<name>" is already registered in this scope`
- **结论：同 scope 内同名注册 → 第二个注册立即抛错（没有 last-wins），插件 `apply` 直接失败**。`register` 注释明说：「Scoped tools shadow globals; duplicates within one layer and the reserved `run_code` name fail」（`index.ts:1032-1033`）。
- **跨层 shadow 合法**：`merge()` 按「全局层 → 祖先层 → 最近作用域」顺序，最近者胜（`store.ts:158-178`）。即 agent 作用域注册的 `read` 可以 shadow 全局的 `read`，前提是两者不在同一层。
- `run_code` 为保留名，不可注册也不可 shadow（`index.ts:1054-1056`）。
- `ctx.tools.restrict()` **确认只是可见性**：把 `allow`/`deny` 编译成 `CompiledToolRestriction`，只过滤「继承的表面」（全局+祖先层），**不影响本层注册、不注销工具**（`index.ts:1071-1098, 1137-1192`）；且要求 scoped ctx（agent.ctx），全局调用直接抛错（`index.ts:1073-1075`）。

**对迁移的意义**：插件若以 host 行（全局 ctx）注册 `read`/`write`，而 `tool-fs` 仍在同一（全局）层挂着 → 抛错。**必须先让 tool-fs 行在目标层消失**（见 §4），不能用 restrict() 顶替，也不能指望后注册覆盖。

---

## 4. 组合粒度：替换 read/write 时 edit/read_image 是连带损失

- base bundle（TUI/CLI 默认面）每包一行：
  - `- id: tool-fs, name: '@deepseek-ai/dsh-tool-fs'`（`base/cordis.patch.yml:224-225`）——**一行挂全部 4 个工具**；
  - 配套行：`fs-observation-policy`（221-222）、`tool-fs-search`（227-230）、`fs-sandbox` provider（443-444）、`tool-web`（414-418）。
- **没有 per-tool 开关**（tool-fs `Config` 只有 4 个上限，`index.ts:28-40`）。禁用 `tool-fs` 行 = read/read_image/write/edit 全丢；**edit 与 read_image 是替换 read/write 的连带损失**，需要插件补回（至少 edit，因为 `fs-observation-policy` 的 `fs/edit-intent` 依赖 read 的 `fs/observed` 记录）。
- 层叠语义：profile `dsh.profile.bundles` 顺序 → profile `cordis.patch.yml` → home 级 → `--patch`；**按行 id 整行替换 config，后层胜**；禁用写法 `- id: tool-fs` + `name:` 守卫 + `disabled: true`（参考 `dsh-plugin/plugin/profile-personal/cordis.patch.yml` 对 `session-title-llm` 的禁用）。
- **web-app 面不同**：host 层 `tool-fs` 已被 `disabled: true`（`packages/bundle/web-app/cordis.patch.yml:312-313`），模型面工具移到 **agent presets**——官方 `standard`/`code` preset 各在 agent 作用域挂一行 `tool-fs`（`apps/cli/config/agent-presets/standard/agent.cordis.yml`「── filesystem ──」段）。因此 web 场景要替换 read/write，**必须改 preset 组合**（复制 preset、去掉 tool-fs 行、加入迁移插件行），只改 host 层无效。

**结论（Q4）**：组合粒度是「包级整行」，不是工具级。替换 read/write 的最小路径 = 在目标组合层（TUI: profile patch；web: preset 组合）禁用 `tool-fs` 整行；**edit/read_image 必然一起消失**，需插件按需重注册。

---

## 5. 受支持的文件操作路径（新工具的正确实现方式）

**dsh 工具不直接使用 node:fs**——`dsh-tool-fs` README 明言「reads/writes/edits through the `ctx.fs` provider contract directly」，沙箱/审批/观察策略全在 `fs/*` 事件门上（`tool-fs/README.md`「The tool is the executor; policy is an event gate」）。`str_replace_editor` 同样走 `ctx.fs` + `fs/*`（`tool-str-replace-editor/src/index.ts:234-235,252-257`）。**新文件工具的正路就是 `ctx.fs`**。

`ctx.fs` 服务（`packages/fs/fs/src/index.ts`，`class FileSystem extends Service`，声明于 `Context { fs }`）：

| 方法 | 签名 | 行 |
|---|---|---|
| `resolve` | `(path, {cwd?, signal?}) → FsTarget`（相对路径按会话 cwd 解析） | 105-121 |
| `stat` | `(target, signal?) → FsInfo \| undefined`（`{version, type, size?}`；type: file/directory/other） | 142-151 |
| `readText` | `(target, signal?) → string`（整文件 UTF-8） | 160-166 |
| `streamText` | `(target, signal?) → AsyncIterable<string>`（大文件） | 175-186 |
| `readBytes` | `(target, signal, maxBytes) → Uint8Array`（**强制字节上限**，超限 `FS_TOO_LARGE`） | 196-207 |
| `listDir` | `(target, signal?) → FsDirEntry[]`（单层，稳定排序，不含内容） | 215-222 |
| `writeText` | `(target, content, expected?=FsWriteIntent, signal?, sandboxPolicy?) → FsWriteOutcome`（原子写；expected 缺省=无条件覆盖） | 233-248 |
| `editText` | `(target, edit, expected?={version}, signal?, sandboxPolicy?) → FsEditOutcome` | 262-277 |
| `sandboxMode` | getter：confining 后端报告默认沙箱模式，否则 undefined | 99-104 |
| 辅助 | `processPath` / `fileUrl` / `contains` / `lstat` | 123-159 |

事件门（新 read/write **必须**遵守才能与保留的 edit/策略协同）：
- `fs/write-intent`（waterfall，单槽，`index.ts:44-52`）与 `fs/edit-intent`（`55-63`）：`fs-observation-policy` 占据该槽决策 `createIfAbsent`/`replaceIfVersion` 或抛 `FS_NOT_OBSERVED`；新 write 工具必须 `ctx.waterfall('fs/write-intent', target, exec, () => undefined)`，否则失去读后写保护。
- `fs/observed`（emit，`66-72`）：新 read 成功后必须 `ctx.emit('fs/observed', target, {kind:'present', version}, exec)`，否则保留的 `edit` 会 `FS_NOT_OBSERVED`（直接 `ctx.fs` 读不会自动记录，见 `fs-observation-policy/README.md` Known Limitations）。
- 沙箱提升：confining 后端（`fs-sandbox`）下，write/edit 经 `ctx.sandboxPolicy.resolve()` 解析 per-call 模式 + `ctx.approval` 一次性提升，`FS_SANDBOX_DENIED` 转 `[sandbox: …]` 标记（`tool-fs/src/sandbox.ts`）。

---

## 6. 实现模式参考（`packages/fs/tool-fs/src/read.ts` 全文已读）

新 read 工具应照抄的骨架（`read.ts:95-203` + `read-render.ts` 纯函数层）：

1. **`defineTool` 契约**：`{ name, description, parameters, output: { schema, render, presentationMeta }, isConcurrencySafe?, execute, presentCall, presentResult }`；parameters 是 schemastery DSL（`type/required/description/enum`）；execute 返回一个**规范 JSON 值**（output.schema），人类可读文案走 `render`，UI 卡片走 `presentCall`/`presentResult`（纯函数，从 persisted `meta` 恢复，失败降级 generic——replay 安全）。
2. **execute 流程**：`parseReadArgs`（校验 + 默认值）→ `resolveRegularReadTarget`（`ctx.fs.resolve(path, sessionResolveOptions(exec, path))` + 1 次 `stat`；absent → emit `fs/observed absent` + `FS_NOT_FOUND`；非 file → `FS_NOT_REGULAR_FILE`，`read-target.ts:17-35`）→ `size >= streamMinSize` 或未知 → `ctx.fs.streamText` 否则 `readText` → `buildWindow(chunks, {offset, limit, maxLineLength, maxBytes})`（read-render.ts:129-177：行窗口 + 单行截断 `... (line truncated to N chars)` + 字节截断标记 + 精确 totalLines；offset 越界抛 `FS_NOT_FOUND`）→ `ctx.emit('fs/observed', …)` → 返回 `{path, offset, lines, totalLines}`。
3. **render**：`formatReadOutput` 输出 `<path>…</path>\n<type>file</type>\n<content>` 信封 + `N: text` 编号行 + footer（`(Showing lines a-b of z. Use offset=… to continue.)` / `(End of file - total n lines)` / `(Output capped. …)`，read-render.ts:118-146）。
4. **presentationMeta**：把结构化窗口 `{path, offset, lines, totalLines, lang?}` 写入 `meta`（`read-render.ts:104-112`），`presentResult` 从 meta 校验恢复（read-render.ts:150-205），保证重放/UI 一致性。
5. **系统提示词**：`ctx.systemPrompt.section({name: 'tool:read', order: 100, text: 'Use the read tool — not shell commands like cat …'})`（read.ts:95-98）。
6. 读路径选 `isConcurrencySafe: () => true`（只做同步版本记录器），写/编辑保持 exclusive（缺省即 exclusive）。

窗口化逻辑（buildWindow / formatReadOutput / readMetaFromMeta）是 Cordis-free 纯函数模块 `read-render.ts`，可独立单测——新插件应保持同样分层。

---

## 7. 推荐工具名策略（结论）

- **目标必须是同名 `read`/`write`**（模型行为无缝、提示词与 plan-mode 指引引用的是 `read` 名）；新名字（如 `read_v2`）会破坏一致性，不推荐。
- **TUI/CLI（base 面）**：profile patch 里禁用 `tool-fs` 行（带 `name` 守卫），插件以 host 行注册全局 `read`/`write`；**同时按需重注册 `edit`（连带损失，且保留 edit 需要新 read 的 `fs/observed`）与 `read_image`**。
- **web 面**：host 层 tool-fs 已禁，须复制 `standard`/`code` preset → 删掉 preset 里的 `tool-fs` 行 → preset 里加迁移插件行（agent 作用域注册）。**同一 preset scope 内不能再挂 tool-fs**（同层重名抛错）。
- **可选 shadow 路径**：若全局 tool-fs 仍挂载（如 TUI 想给部分 agent 换工具），可在 agent 作用域注册同名工具 shadow 全局——但 TUI 单 agent、web 面无全局 read，实际场景有限。
- **不可绕过的耦合**：新 `read`/`write` 必须 dispatch `fs/write-intent`/`fs/observed`（§5），否则保留的 `edit` 全部 `FS_NOT_OBSERVED`、写保护失效；这是迁移设计的第一约束。

---

## 8. 关键文件索引

| 文件 | 内容 |
|---|---|
| `packages/fs/tool-fs/src/index.ts` | 四工具组合注册、Config、read_image 条件注册 |
| `packages/fs/tool-fs/src/read.ts` | read 执行器（caps、schema、execute、present） |
| `packages/fs/tool-fs/src/read-render.ts` | 窗口化/渲染/meta 纯函数 + 三个默认上限 |
| `packages/fs/tool-fs/src/read-target.ts` | resolve + 1 stat + 类型校验 |
| `packages/fs/tool-fs/src/write.ts` / `edit.ts` | write/edit 执行器（fs/* intent + CAS） |
| `packages/fs/tool-fs/src/sandbox.ts` | 沙箱提升 API（共享自 tool-bash） |
| `packages/fs/fs/src/index.ts` + `types.ts` | `ctx.fs` 服务契约 + `fs/*` 事件 + FsError 码 |
| `packages/fs/fs-sandbox/README.md` / `fs-observation-policy/README.md` | 沙箱围栏 / 读后写策略（fs/* 事件门） |
| `packages/core/tools/src/index.ts` | register 重名抛错、scoped shadow、restrict 仅可见性、run_code 保留 |
| `packages/core/scope/src/store.ts` | NamedEntries.insert 抛错、merge 最近者胜 |
| `packages/bundle/base/cordis.patch.yml` | 每包一行；tool-fs:224-225；tool-fs-search:227-230；fs-observation-policy:221-222；fs-sandbox:443-444；tool-web:414-418 |
| `packages/bundle/web-app/cordis.patch.yml:312-316` | host 层 tool-fs / tool-fs-search disabled |
| `apps/cli/config/agent-presets/{standard,code}/agent.cordis.yml` | preset 在 agent 作用域挂 tool-fs |
| `packages/fs/tool-str-replace-editor/src/index.ts` | view（含目录 2 层）/create/str_replace/insert，同样走 ctx.fs |
| `packages/fs/tool-fs-search/src/{glob,grep,search-core}.ts` | glob/grep 工具与上限 |
| `packages/web/tool-web/src/{index,fetch}.ts` | web_search/web_fetch、fetch 默认禁用、200k 字符 cap |
| `packages/session-query/tool-session-query/src/index.ts` | 5 个 session 只读工具 |

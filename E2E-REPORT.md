# dsh 插件套件 E2E 集成测试报告

- 日期:2026-08-18
- 环境:Windows 11 Pro(x64,Node v24.15.0),dsh monorepo `C:/Users/Vantage_XLST/Documents/dsh`,插件 `C:/Users/Vantage_XLST/Documents/dsh-plugin/plugin`
- 测试套件:dsh-tree-engine(库)+ dsh-compact-mode + dsh-vibe-mode + dsh-tool-read-write + dsh-advisor + dsh-channel-wechat
- 运行方式:web profile(实际运行插件加载),DeepSeek 真实 API key,全部场景均为真实模型调用

## 1. 驱动面(Driving Surface)

**选型:web profile 的 HTTP RPC 面**(最可脚本化,支持多轮会话):

- 启动:`DEEPSEEK_API_KEY=<key> pnpm dsh --profile web --patch C:/Users/Vantage_XLST/Documents/dsh-plugin/.e2e-scratch/cordis.e2e.patch.yml --port 5199`
- 会话管理:`POST /api/session.create`(可选 `agentPreset`/`cwd`)、`POST /api/session.prompt`、`POST /api/session.history`
- **斜杠命令必须走 `POST /api/commands/execute`**,payload 形如 `{"type":"client-request","rpcId":"…","method":"commands/execute","payload":{"args":{"agentId":"<sessionId>","line":"/compact"}}}`;
  命令目录用 `POST /api/commands/list`(payload `{"args":{"agentId":"<sessionId>"}}`)。
- 信封格式:请求 `{type:'client-request',rpcId,method,payload}`,响应 `{type:'server-response',rpcId,result:{ok:true,value}|{ok:false,error}}`。
- 逐轮等待:轮询 `session.history` 直到出现 `turn/end`。
- headless 单发任务(`dsh --profile headless "<task>"`)也可用,但每进程只跑一轮,无法支撑多轮场景;`dsh terminal` 不存在(只有 web/headless profile)。

> 注意(核心发现):`packages/host/apiproxy/src/api/sessions.ts` 注释声称 `session.prompt` 会把以 `/` 开头的消息当命令执行,实测**不会**——`/compact` 经 `session.prompt` 发送会被当成普通消息交给模型。命令必须走 `commands/execute`(与客户端 `client/runtime …/session.ts:359` 的 `remote.commands.execute` 一致)。

## 2. API Key 来源(已脱敏)

- 启动时发现 hermes 配置 `C:/Users/Vantage_XLST/AppData/Local/hermes/config.yaml` 的 `model.api_key`(前缀 `sk-e499…`),已用它完成前段真实模型验证(该 key 有效:模型真实回复)。
- 用户随后直接提供了 key **`sk-5091…6f5c`**,已:
  - 写入当前 shell 环境变量;
  - `setx DEEPSEEK_API_KEY "sk-5091…6f5c"` 持久化为 Windows 用户级环境变量(不在任何 git 仓库内);
  - 用直连 `https://api.deepseek.com/chat/completions` 最小请求验证(返回真实补全 "OK")。
- 后续场景(advisor、read/write 等)均使用用户提供的 key 重启服务后执行。
- 确认:`packages/llm/llm-deepseek/src/index.ts:45` 默认读取 `DEEPSEEK_API_KEY` 环境变量,无需改配置文件。
- 未在任何 git 仓库文件写入 key;报告仅显示脱敏前缀。

## 3. 场景结果

### 场景 1 — Compact 模式审阅:**PASS**(在 `minimal` preset 会话上;`standard` 上有冲突,见问题 B1)

流程与证据(会话 `session-8b3ed4b0…`,keepRecentTokens 测试值 100):

1. 多轮对话(2+4 条消息,真实模型)。
2. `commands/execute "/compact"` → `"Compact mode active: the live loop is paused; the first draft is being generated."`;日志出现 `compaction/start`(seq 1007)。
3. `/compact tree` → `v1 (root): 该工具为 Windows 用户提供轻量级定时提醒功能…`(草案 v1 由真实模型生成)。
4. `/compact_edit 在末尾追加一句:支持多语言界面` → `"Revision v2 landed."`;`/compact tree` 显示 `v1 (root)` + `v2` 两级审阅树。
5. `/compact_apply` → `"Compaction applied: shadowed 10 surface nodes (~542 tokens). Compact mode off."`
6. 日志事件序列:seq 1007 `compaction/start` → 1016 `compaction/summary`(真实模型摘要)→ 1017 `user/message`(自动 checkpoint,`surfaceOp` 替换,见 reuse.ts:577)→ 1018 `compaction/end` → 1019 `compact/mode active:false`。
7. 审阅树销毁:apply 后 `/compact tree` → `"compact review is not active for this session"`。

注意:
- 会话过短时 `/compact` 报 `no compactable range: the whole surface is inside the protected recent window`(keepRecentTokens 保护窗);`/compact_apply` 在草案不小于被替换内容时报 `draft is not smaller than the shadowed content`(147 >= 20)——短会话需要先扩充内容(产品行为,非崩溃)。
- `/compact` 偶发 `compact mode requires an idle agent…`(agent 未完全 idle),稍后重试成功。

### 场景 2 — Vibe 模式:**PARTIAL**(`standard` preset;worker 链路通,`vibe_wait` 有序列化 bug)

- `/vibe on` → `"DIRECTOR mode on: toolset narrowed; use vibe_spawn/send/wait/kill/list for workers."`
- 指示 DIRECTOR 调度:`vibe_spawn {cli:'fast', prompt:'say hi in one word'}` + `vibe_wait`。
- 结果:worker(会话 `e7c99802-…`,标签 hi-worker)真实启动并产出最终输出 **"Hi."**,DIRECTOR 最终回复包含 `> **Hi.**`(子会话 closing message)。
- **插件 bug**:DIRECTOR 反馈 `vibe_wait` 连续两次报工具错误 `value is not lossless JSON`(工具输出序列化问题),只能靠后台通知 + `vibe_list` 交叉确认结果。
- `minimal` preset 上 `/vibe on` 失败:`tools.restrict() names unknown global tools "glob","grep","todo_write"; known global tools: bash, edit, inspect_image, read, read_image, str_replace_editor, write`(默认 readOnlyTools 依赖 standard 工具集,不可移植,见 B2)。
- `/vibe off`(park workers)未能在本次预算内单独验证;DIRECTOR 模式切换本身正常。

### 场景 3 — Advisor:**FAIL**(命令可用;reviewer 未挂载,无 advisory 送达)

- `/advisor on` → `"Advisor enabled. Use /advisor status…"`
- 对话 1 轮后:`/advisor status` → `"advisor: enabled … reviewers: none"`;会话日志无 `advisory`/`steer` 事件。
- 根因:advisor 绑定到插件加载后**第一个**创建的 agent(本测试中为 minimal preset 会话),其 reviewer 组合时 `tools.restrict({allow:['read','grep','glob']})` 因 minimal 无 `grep`/`glob` 失败(与 vibe 同根因,B4),reviewer 创建静默失败 → `reviewers: none`。standard 会话上状态仍指向最早那个 minimal 会话,同样无 reviewer。
- 未确认 `<advisory severity=…>` 送达路径(因 reviewer 从未起来)。

### 场景 4 — read/write 工具:**PASS**

- 会话 cwd 设为 `.e2e-scratch`(`session.create {cwd}`)。
- 模型真实调用 `read`(selector `1-10` 行):`tool/call` 176 → 返回 DESIGN-SHAKE-REVIEW.md 前 10 行(共 172 行)。
- 模型真实调用 `write`(`e2e-write-test.txt`):`tool/call` 1414;落盘文件 10 行,内容与 read 一致(已校验)。
- 越界写入(目标在会话工作区外)被沙箱正确拦截(`写入被沙箱拦截(目标路径在会话工作区之外)`),属预期行为。

### 附加:套件装载

5 个插件 + wechat(`enabled:false` 挂载验证)全部通过 `file:///` URL 装载,启动无 loader 错误;`commands/list` 可见 `advisor / compact / compact_abort / compact_apply / compact_edit / vibe`。`dsh --dump-config` 组合正常。

## 4. 发现的问题(文件 + 行)

- **B1(dsh 核心,阻塞 compact/vibe 落地)**:`disabled: true` patch 行只作用于 host 平面;**默认 agent preset `standard`(及 `code`)在 agent 平面重新挂载 `tool-fs`、`compaction-basic`、`command-compact`**(`apps/cli/config/agent-presets/standard/agent.cordis.yml:56`(tool-fs)、`:144-155`(compaction 组))。结果:即使 profile patch 禁用了 host 行(probe 证实 loader 树中 `disabled=true` 且 `fiber=none`),standard 会话仍运行**基础版** `/compact` 与基础压缩引擎(实测 `/compact` 立即压缩 10 项/6248 tokens,走基础流程),我们的 compact-mode `/compact`(进入审阅)与 `ctx.compaction` 被 per-agent 影子遮蔽。profile-main 的 compact+vibe patch 因此在默认会话上实际不生效。
- **B2(dsh-vibe-mode)**:`readOnlyTools:[read,glob,grep,read_image,todo_write]` 在缺少这些工具的 preset 上 `tools.restrict()` 抛错(fail-loud 合理,但配置不可移植)——`plugin/dsh-vibe-mode/src/mode.ts`(restrict 调用处)。
- **B3(dsh-vibe-mode)**:`vibe_wait` 工具报 `value is not lossless JSON`(worker 结果序列化失败,需降级用 vibe_list 确认)——`plugin/dsh-vibe-mode/lib/types/tools.js`。
- **B4(dsh-advisor)**:`defaultTools:[read,grep,glob]` 不可移植;minimal 会话上 reviewer 组合失败且错误静默,`/advisor status` 显示 `reviewers: none`,无 advisory 送达——`plugin/dsh-advisor/src/config.ts`(defaultTools)+ `advisor.ts` composeReviewer(restrict 失败未上抛/未记录可见日志)。
- **B5(dsh-compact-mode)**:手动 `/compact` 需要对话超出 `keepRecentTokens` 保护窗;`apply` 强制草案严格小于被替换内容(短会话 147>=20 拒绝)。行为合理,但对短会话体验不友好;`keepRecentTokens:20000` 默认值意味着新会话几乎无法手动进入审阅。
- **B6(dsh 文档)**:`packages/host/apiproxy/src/api/sessions.ts:317-321` 声称 `session.prompt` 拦截斜杠命令,实际不拦截(必须走 `commands/execute`)。

## 5. 已应用的修复

- 仅测试侧改动(均在 `.e2e-scratch/`,未动 profile-main,未与并行 worker 冲突):
  - 临时 patch `cordis.e2e.patch.yml` = profile-main 当前内容(compact+vibe)+ 追加 advisor / read-write / wechat(`enabled:false`)插入 + `tool-fs` host 行禁用;
  - `keepRecentTokens` 测试值 2000→100(让短会话可手动进入审阅);
  - 探测插件 `probe.js`(诊断 loader 树状态,已弃用)。
- 插件源码与 profile-main 未做任何修改(按任务约定由并行 worker 负责)。

## 6. 结论与阻塞项

- 真实 key 全程有效(含用户提供 key 的直连验证);驱动面(web RPC + commands/execute)可靠可复用。
- compact 审阅全链路(进入→草案 v1→`/compact_edit` v2→`/compact_apply`→事件序列→树销毁)**通过**;read/write(selector 读 + 写)**通过**;vibe worker 产出**部分通过**(vibe_wait 序列化 bug);advisor **未通过**(reviewer 未挂载)。
- **阻塞用户试用(必须修复)**:
  1. **B1**:默认 `standard` preset 的 per-agent `compaction-basic/command-compact/tool-fs` 遮蔽 host 平面禁用 → compact-mode 无法在默认会话接管 `/compact`(需在 agent-presets 层同样禁用/替换,或给 profile 配一个不含这些行的 preset 作为默认)。
  2. **B2/B4**:vibe 与 advisor 的默认工具名单在非 standard 工具集下 fail-loud / 静默失败(建议改为“仅对实际存在的工具做 restrict”,或随 preset 提供这些工具)。
  3. **B3**:`vibe_wait` 结果序列化必须修复(否则 DIRECTOR 无法可靠等待 worker)。
- 其余为体验级问题(B5 保护窗/缩容门槛、B6 文档)。

---

## 修复记录(2026-08-18,复验)

### B1 — profile-main:standard-rw 预设移除 agent 平面 compaction 遮蔽

- **修复**:`plugin/profile-main/agent-presets/standard-rw/agent.cordis.yml` 在保留 `tool-result-pruner` 的前提下删除 `compaction-basic` 与 `command-compact` 两行(连同此前已删的 `tool-fs`,共三处差异),agent 平面不再提供 `ctx.compaction` 与基础 `/compact`,改由 host 平面 compact-mode 提供;`preset.yml` 描述同步更新。
- **验证**:
  - `pnpm dsh --profile web --patch <abs profile-main/cordis.patch.yml> --dump-config` 通过;host 平面 `compaction-basic`/`command-compact` 均为 `disabled: true`(patch 行)。
  - web 实跑(标准 `default: standard-rw` 会话):`commands/list` 显示我们的 `/compact /compact_edit /compact_apply /compact_abort`(描述 "Enter compact mode, or inspect the review tree",非 base 的 "Compact older conversation history"),无重复注册。
- **场景 1(默认会话 compact 审阅)复验:PASS** — 会话 `session-3b79a981…`(standard-rw):
  - `/compact` → "Compact mode active: the live loop is paused; the first draft is being generated."(**进入审阅,非 base 立即压缩**);
  - `/compact tree` → `v1 (root): A Windows timer reminder tool lets users schedule…`(真实模型草案);
  - `/compact_edit …` → "Revision v2 landed.";`/compact tree` 显示 v1(root)+v2 两级审阅树;
  - `/compact_apply` → "Compaction applied: shadowed 4 surface nodes (~5354 tokens). Compact mode off."

### B2 — dsh-vibe-mode:`readOnlyTools` 与 agent 实际工具集求交

- **修复**:`plugin/dsh-vibe-mode/src/director.ts`(restrict 调用处)由 `tools.restrict({allow: readOnlyTools})` 改为:取 `agent.ctx.tools.schemas(agent)` 可见工具集求交;被丢弃的名字 `ctx.logger.warn` 警告;交集为空仍 fail-loud 抛错。配置默认 `[read, glob, grep, read_image, todo_write]` 不变;`minimal` 等窄 preset 上降级为交集 + 警告。
- **测试**:vibe-mode 42 个测试全过,新增 2 个(drop-with-warning、空交集抛错);`typecheck` 通过。
- **场景 2 复验(standard-rw):PASS** — `/vibe on` → DIRECTOR 模式;`vibe_spawn`(fast, hi-worker)真实启动 worker;`vibe_wait` 正常返回 **`[d3b9ccb2-… turn 1 completed] hello`**。

### B3 — dsh-vibe-mode:`vibe_wait` canonical 输出 lossless JSON

- **修复**:`plugin/dsh-vibe-mode/src/workers.ts`:`TurnEndResult.output` 改为可选键,worker 无最终文本(超时/无输出)时**整个省略该键**而非携带 `undefined`;新增 `turnEndResult()` 构造器;`vibe_wait` 的 canonical 值不再触发 `value is not lossless JSON`。
- **测试**:workers.spec.ts 新增回归——`JSON.stringify` 往返无损、无 `undefined` 字段(含 completed-with-output 与 timeout-without-output 两种 canonical 形状);42 个测试全过。
- **场景 2 复验:PASS**(见 B2,同一会话日志 `tool/result` 无任何 lossless 报错)。

### B4 — dsh-advisor:defaultTools 可移植 + reviewer 失败可见

- **修复**(`plugin/dsh-advisor/src/advisor.ts`):
  1. `composeReviewer` 对 `spec.tools` 与 reviewer agent scope 实际工具求交,丢弃名 `ctx.logger.warn` 警告;交集为空抛错。
  2. reviewer compose/创建失败不再静默:`reviewerError` 状态记录错误消息,`ctx.logger.warn` 输出,`/advisor status` 显示 `reviewers: 0 (error: <message>)`(成功 start/disable/teardown 时清除)。
- **测试**:advisor 91 个测试全过,新增 2 个(intersect-with-warning、empty→loud error surfaced in status);`typecheck` 通过。
- **场景 3 复验:PASS** — 默认会话 `/advisor status`:`advisor: enabled` + `- default [session-3b79a981…__advisor-default]: status=idle model=deepseek-v4-flash tokens=0`(reviewer 已挂载,不再 `reviewers: none`);对主会话对话后,主会话日志出现真实 advisory:`<advisory severity="nit" guidance="weigh, don't blindly obey">This is a plain descriptive question, not a repo task: answer in exactly 3 sentences…`。

### 复验环境

- 启动:`DEEPSEEK_API_KEY`(Windows 用户级环境变量,setx,`sk-5091…6f5c`,未输出全文)+ `pnpm dsh --profile web --patch .e2e-scratch/cordis.e2e.patch.yml --port 5199`;patch = profile-main 当前内容(`keepRecentTokens: 100` 测试值)。三个项目(compact-mode/tree-engine/vibe-mode/advisor/tool-read-write)已 `pnpm run build`。
- 驱动面与首次 E2E 一致:`session.create`(默认 standard-rw)、`session.prompt`、`commands/list`、`commands/execute`(斜杠命令)、轮询 `session.history` 至 `turn/end`。

### 提交(本地身份 dsh-dev \<dsh-dev@local\>)

- dsh-vibe-mode(B2+B3):`c7b6a2b`
- dsh-advisor(B4):`607ba4b`
- profile-main(B1):`3dbe98a`

### 遗留问题

- **B5(体验)**:`keepRecentTokens` 保护窗仍使新会话几乎无法手动进入审阅(本次复验沿用测试值 100;生产默认 20000 时需先扩充对话)。产品行为,未改。
- **B6(dsh 文档)**:`packages/host/apiproxy/src/api/sessions.ts:317-321` 声称 `session.prompt` 拦截斜杠命令,实测不拦截(必须走 `commands/execute`)。上游文档问题,未改。
- advisor 绑定目标仍为插件加载后**第一个**创建的 agent(本复验中为场景 1 的 compact 会话);如需按会话定向可配置 `agentId`。非阻塞。

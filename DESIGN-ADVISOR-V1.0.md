# 设计文档 v1.0:迁移 omp 的 advisor 功能(dsh 插件)

> 状态:设计草案,等待拍板点确认后开发
> 基线:dsh master 本地 clone `C:/Users/Vantage_XLST/Documents/dsh`(纯参考);开发在 `C:/Users/Vantage_XLST/Documents/dsh-plugin/plugin/` 独立项目
> 原则:一切以插件形式实现;涉及核心改动或非插件实现先提醒用户
> 依据:omp `advisor-watchdog.md`;dsh 侧调研 `RESEARCH-ADVISOR.md`(证据 file:line)

---

## 1. 需求

把 omp 的 **advisor** 子系统迁移为 dsh 插件:一个或多个可选的"评审模型"挂到会话上,评审主代理转录增量,可用受限工具集(read/grep/glob,可扩展)检查工作区,并把**分严重度的建议**注入主会话:

- `nit`(不打断旁注)→ 下一 step 边界批入主转录
- `concern`(打断转向)→ 有实质风险时中断并转向
- `blocker`(打断转向)→ 继续将产生废工时强制中断
- WATCHDOG.md 评审指引、WATCHDOG.yml 评审名册(每项:name/model/tools/instructions)
- 隔离(评审者独立 agent + 独立工具会话)、emission guard(去重/限频)、压缩/重写时重置、成本/用量可观测

## 2. 概念对齐(omp advisor ↔ dsh 机制)

| omp 组件 | omp 行为 | dsh 对应机制(调研结论) |
|---|---|---|
| 评审者 | full agent + 独立 ToolSession | **普通 agent**(`ctx.agents.create` + setup),非子代理(避免父子语义/结算噪音) |
| nit 投递 | 非打断旁注,下一边界批入 | `agent.inject(createUserMessage({source:{kind:'plugin',plugin:'advisor',form:'notice',summary}}))`(不唤醒,claim 前不可见) |
| concern/blocker | 打断转向消息 | `agent.steer(...)`(唤醒空闲;运行中 turn 在**下一 step 边界**消费并同 turn 再跑一步;无 mid-request 打断) |
| 终局回答保留为卡片 | plan 模式/终局回答时不唤醒 | 插件侧策略:`agent/turn-stopping` 处若 steer 会延展 turn;**卡片应等 `turn/end` 后再 inject**(notice form) |
| immuneTurns(限频) | 打断后 N 个主 turn 内降级旁注 | `tool-jobs` 的 `maxConsecutiveWakes:3` 模式(插件实现) |
| emission guard | 规范化去重 + 每更新一条 + 空话过滤 | 插件内纯逻辑(可独立单测) |
| 转录观察 | transcript delta | 根 ctx `session/event`(收全部会话)+ 公开 `session.deriveEventMessage(event)` 逐事件投影;自身 advice 过滤 |
| 压缩重置 | 重置转录/去重状态 | `compaction/*` 事件 / `user/message` 带 `surfaceOp:{op:'replace'}` / `replaceGeneration` 变化 / `agent/session-start{source:'resume'}` / `session/created`(fork) |
| WATCHDOG 发现 | 用户级+项目级向上走查 | dsh 无现成设施;按 `agent-instructions` 的走查模式自建(git root 标记 + `ctx.fs`/node:fs + 有界读取);内容**只进评审者 prompt** |

## 3. 关键约束(调研确认)

1. **评审者必须 join preset**:`agentPresets.composeFrom(agentCtx, primaryCtx)`,否则 preset 部署下工具注册表解析为空。
2. **工具授权**:`agentCtx.tools.restrict({allow:['read','grep','glob']})`(allow 掩码只作用于继承的全局工具)+ `agentCtx.tools.register(advise)`(scoped 注册不受掩码影响)。未知名字抛错,配置加载期校验。
3. **投递原语**:`followup`(另开整 turn)/`steer`(next-step,同 turn 再跑一步)/`inject`(不唤醒)。dsh 无 plan-mode 级 steer 门禁——"保留为卡片"策略全部插件侧实现。
4. **权限隔离**:普通 agent 不自动获得子代理的委托策略;插件用 `captureDelegatedPolicyOverrides`/`appendDelegatedPolicyOverrides` 固定评审者权限(只读 + advise)。
5. **用量**:评审者自身 session 的 `ctx.tokenMeter.measure()` / `tokenUsage` 投影;**dsh 无 cost 计算**,费率表插件自理。

## 4. 插件结构(单包 `dsh-advisor`,独立项目)

```
plugin/dsh-advisor/
  src/
    index.ts          # 插件入口:commands + 生命周期监听
    config.ts         # AdvisorConfig(roster/WATCHDOG 路径/immuneTurns/syncBacklog)
    advisor.ts        # AdvisorRuntime:创建/重建评审者 agent、cursor、delta 组装
    advise-tool.ts    # advise 工具定义(severity + note)
    delivery.ts       # nit/concern/blocker 投递策略 + 卡片策略 + immuneTurns 预算
    emission-guard.ts # 规范化/去重/每更新一条/空话过滤(纯函数)
    watchdog.ts       # WATCHDOG.md/.yml 发现 + 解析 + schema 校验
    commands.ts       # /advisor on|off|status|dump
    invariant.ts
  tests/
```

依赖(发布版 `@next`):cordis(peer)、schemastery、dsh-agent、dsh-session、dsh-llm、dsh-tools、dsh-token-meter、dsh-commands、dsh-agent-presets、dsh-subagent(仅委托策略 helper)。

## 5. 投递设计

- **严重度路由**:
  - `nit` → `agent.inject`(plugin-source `form:'notice'`,带 `summary` 截断——`boundContextSummary` 可复用)。
  - `concern` / `blocker` → `agent.steer`;投递前检查主 agent 状态:
    - 正在流式/已唤醒:steer 在下一 step 边界消费;
    - 空闲 + 终局回答(无排队工作):`concern` 保留为卡片(`turn/end` 后 inject),`blocker` 仍 steer(`agent/turn-stopping` 处 `agent.steer` 延展 turn);
    - 空闲 + 未终局:steer 触发新 turn。
  - 投递的 advisory 文本渲染为 `<advisory severity="…" guidance="weigh, don't blindly obey">note</advisory>`(XML 转义)。
- **immuneTurns**:每次成功送达 concern/blocker 后,后续 concern/blocker 降级为旁注,直至配置的主 turn 数(默认 3)完成;nit 不变。
- **emission guard**:NFKC + 小写 + 非字母数字折叠 → 空话短语过滤(`stop`/`done`/`lgtm`…) → 会话内去重(FIFO 4096)→ 每评审者每次 model 更新最多一条;重置时清空。

## 6. 转录观察

- 根 ctx `session/event`,按 `session.id === primaryId` 过滤;delta = 新增 surface 事件(`user/message`/`assistant/message`/`tool/result`),跳过 source 为 advisor 插件自身的消息(防自审)。
- 评审者自维护 cursor(已看 seq);delta 经 `session.deriveEventMessage(event)` 逐条投影成 Message 文本,拼成评审 prompt(含 reasoning/intent/tool 调用,secret 脱敏按 dsh 既有机制)。
- 评审调用:评审者作为**完整 agent**(自带循环)——插件把 delta prompt 经 `followup` 喂入评审者,评审者自行迭代工具调用与生成;插件只监听评审者会话事件(尤其 `advise` 工具调用及其结果)并路由投递。

## 7. 评审者构造与隔离

- `ctx.agents.create({sessionId, agentOptions(provider/model 按 roster 或 advisor 角色), setup})`;setup 内:
  1. `agentPresets.composeFrom(agentCtx, primaryCtx)`(必须);
  2. `agentCtx.tools.restrict({allow: config.tools ?? ['read','grep','glob']})`;
  3. `agentCtx.tools.register(advise)`(scoped,掩码免疫);
  4. 委托策略固定只读权限。
- 插件持有评审者 `AgentHandle`;用 `followup` 喂 delta、监听其会话事件捕获 advise 调用。
- 评审者 agent 的会话独立落盘(`__advisor` 语义:插件为评审者会话命名 `session-advisor` 或按 roster slug);`/advisor status` 展示每项:state/model/context 用量/token 用量。
- WATCHDOG.md 内容以 `<attention>` 块追加进评审 prompt;WATCHDOG.yml roster:name/enabled/model/tools/instructions(顶部共享 instructions 拼接)。

## 8. 重置

任一路信号触发:评审者 cursor 重绕到当前有界表面 + emission-guard 状态清空 + 评审者 agent dispose 重建:
- `compaction/start|summary|end`;`user/message` 带 `surfaceOp:{op:'replace'}`;`session.surface.replaceGeneration` 变化;`agent/session-start{source:'resume'}`;`session/created`(fork);`agent/disposed`。

## 9. 命令与用量

- `/advisor`(toggle)、`/advisor on|off|status|dump`:`ctx.commands.register`(plan-mode 模板);结果不进 model 历史。
- 用量:`ctx.tokenMeter.measure(reviewerSession)`;cost = usage × 插件费率表(配置)。

## 10. 配置

```yaml
- id: advisor
  name: '@dsh-plugin/dsh-advisor'
  config:
    enabled: true
    defaultTools: [read, grep, glob]
    immuneTurns: 3
    syncBacklog: off      # off|1|3|5;主 turn 结束时等待评审追平(上限 30s)
    model: ''             # 空 = 沿用主 agent 路由
    maxPromptTokens: 8192
    watchdog:
      userDir: ''         # 空 = $DSH_HOME
      projectMarkers: ['.git']
    costTable: {}         # provider/model -> per-1M tokens;空 = 只报 token
    roster: []            # WATCHDOG.yml 静态内联(文件发现为主)
```

## 11. 拍板点(全部确认,含一处修正)

1. **评审者形态(修正)**:评审者 = **完整 agent(自带循环)**——插件把 delta 经 `followup`/`inject` 喂入评审者 agent,评审者自跑循环、调用受限工具(read/grep/glob),要提建议时调用其 scoped `advise` 工具;插件监听评审者会话事件,见 advise 调用后按严重度路由投递。理由:`ctx.llm.stream()` 为单次调用、无工具循环,无法支撑工具型评审者;原"插件驱动 stream + agent 仅承载工具"方案废弃。 —— ✅ 确认
2. **默认工具集**:`read/grep/glob`(omp 默认),确认? —— ✅ 确认(按推荐)
3. **steer 交付策略**:concern/blocker 空闲终局回答时——concern 保留卡片、blocker 仍 steer(推荐,照 omp)确认? —— ✅ 确认(按推荐)
4. **WATCHDOG 文件名**:用 `WATCHDOG.md`/`WATCHDOG.yml`(omp 同名)还是 `.dsh/WATCHDOG.*`? —— ✅ 确认(按推荐)
5. **成本表**:v1 只报 token、cost 可配(推荐)还是必须内置费率? —— ✅ 确认(按推荐)
6. **包名**:`dsh-advisor`,确认? —— ✅ 确认(按推荐)

## 12. 风险

- steer 语义(step 边界消费)与 omp 的即时打断有差距:blocker 可能延迟一个 step;文档明示。
- WATCHDOG 发现为自建,路径约定(用户级/项目级/`.dsh/`)需与用户习惯对齐。
- 用量/cost 只按 token 估;无 provider 精确计价。
- 评审者为完整 agent,意味着每次评审有完整 agent 循环开销(提示词/工具组装);评审频率受 delta 批量与 syncBacklog 控制。

## 13. 验证(免 API key)

`constraints`/`typecheck`/`build` + 单测:投递路由(nit inject 不唤醒/concern steer 唤醒/终局卡片)、immuneTurns 降级、emission guard(规范化/去重/限频/空话)、delta 组装与 cursor、重置信号清状态、WATCHDOG 发现+解析、命令行为、评审者构造(composeFrom+restrict+advise 可见性)。mock LLM/agent,mock `session/event` 流。

## 14. 变更记录

- **v1.0**(2026-08-17):初始设计,等待拍板点确认。
- **v1.1**(2026-08-17):拍板点全部确认;评审者形态修正为完整 agent 循环(原 llm.stream 方案与工具型评审冲突)。

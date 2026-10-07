# 设计文档 v1.0:随行协调者套件(秘书/负责人/任务板/交枪门禁/问题面板/会话通信)

> 状态:**设计定稿**(拍板点均已确认;三方评审修正已并入;悬而未决见 §7.4)
> 基线:dsh master 本地 clone `C:/Users/Vantage_XLST/Documents/dsh`(纯参考)
> 开发:`C:/Users/Vantage_XLST/Documents/omp-2-dsh`(现有 7 插件工作区)
> 原则:一切以插件形式实现;涉及核心改动或非插件实现先提醒用户
> 依据:本仓库现有插件(vibe-mode/advisor/compact-mode/tool-read-write/mode-ui);dsh 侧调研见 `RESEARCH-*`;本文与 `DESIGN-ADVISOR-V1.0.md` 同构
> 本文是**新方案**,在现状之上**追加**,不改动现有 7 插件的既有语义。

---

## 0. 摘要

把"随行协调"模型落成一套新插件,叠加在现有 omp 移植套件之上。六个新零件 + 一个延后项:

1. **会话层级**(`dsh-org`):在声部/worker 之间插入**持久负责人**会话 —— 由**无父拥有的 top-level Agent**(`ctx.agents.create()`/`resume()`)实现,上下文像普通 agent 一样保留,只由你关闭;定义"谁接管谁、谁能碰谁"(manager + forbid);由 **`/org` 命令**激活(不是创建期注定)。
2. **任务板**(`dsh-task-board`):持久**需求/委托级**任务清单(你的记忆簿)+ **注意力工作集**(当前在手的粗粒度需求),+ agent 自省 + 保守闭环/重开。**独立功能,不耦合 org。**
3. **交枪门禁**(`dsh-review-gate`):`--review` 后缀指令,保留全工具、**自建写路径闸**设卡(方案批前 write/edit 到真源码被挡),审批经问题面板。
4. **问题面板**(`dsh-question-board`):异步、非阻塞、可乱序回答的问题收件箱,主会话不卡。
5. **会话间点对点通信 + 可提升协调者**(`dsh-peers`):进程内寻址/持久投递/去重/鉴权;任意会话可被提升为协调者。
6. **需求-评审循环**(`dsh-orchestrator`):定制化 goal 模式,由**评审工作子agent(continuable subagent)**承载,双跳出(零P0 或 人工决策);含 **`subtask_parallel`** 递归 fan-out + 三个可配闸。

**延后项**:模型路由(就是 vibe 现有 `fast/good` 两档的扩展,暂不立项)。

复用现有:评审者(advisor 构造模式)、上下文管理(compact-mode)、工具层(tool-read-write)、投影/徽章(mode-ui)。**vibe-mode(director/worker 调度)与本设计冲突,实现时弃用(见 §5.1)。**

**关键架构定论(访谈已确认 + 三方评审修正):**
- **进程内**通信,不做跨进程总线。
- **不替换 agent-loop**;评审/流程是 **goal + 事件 + 会话**驱动,不是 workflow 或自定义 loop。
- 评审用**一次性干净上下文**评审者(可靠),业务判断/累积/过滤在**负责人**(持上下文)。
- **goal 只放在被派出的可抛弃子agent 里(一个需求一个),绝不落在秘书/负责人会话上**。
- `--review` ≠ plan-mode:保留全工具、按**写作用域**设卡;dsh 无路径级 fence → **自建 `tools/pre-execute` 路径闸**。
- 递归 fan-out:`subtask_parallel` 显式工具 +(深度上限 / 总agent上限 / "是否值得拆"启发)三个可配闸。
- **不依赖 `ctx.agentTeams`**(仅借其 durable 模式);`dsh-task-board` 独立不耦合 org。

---

## 1. 需求(从痛点转来)

现有套件已解决:DIRECTOR 调度 + worker、审阅树压缩、omp 风格工具、评审 advisor、模式 UI。**缺口**在"随行长活协调"和"人机语义":

| # | 痛点(你原话/访谈提炼) | 转换为需求 |
|---|---|---|
| 1 | "worker 的上下文太不重要了""希望有一层负责人的角色,让他的上下文像普通 agent 一样保留" | 会话层级:一个**持久、只由用户关闭**的负责人会话,上下文跨轮保留 |
| 2 | "并行处理多个任务,秘书帮我整理""单个 agent 要开很多终端,各自不知彼此" | 任务板 + 会话间可见/通信 |
| 3 | "rule 是弱提示,不如每次对话提示""公司弱模型,先方案后执行" | 规则分**提醒型**与**门禁型**;门禁靠机制而非措辞 |
| 4 | "方案评审要跑 15 次,冷上下文重复推导、问题循环" | 评审用干净上下文评审者;发现由**负责人**累积/过滤/回喂 |
| 5 | "omp 只给 director read 工具,只能打字;多个问题一次涌回,回一个别的被顶掉" | **问题面板**:结构化、非阻塞、可乱序回答 |
| 6 | "有时希望先方案等我审批,有时希望它自己跑;写出方案后才想起要审" | `--review` 后缀:逐任务设卡,可有可无 |
| 7 | "希望随时让某个会话成为秘书统领其它会话""绕过秘书直接跟负责人对话" | 会话间点对点通信 + **可提升协调者**角色 |
| 8 | "agent 应能看到自己哪些任务没完成,并能自动闭环;我想手动关掉不要的" | 任务板**工作集**注入上下文 + 自动/手动闭环 + 从上下文退场 |
| 9 | "任务经常可拆成多个点,但 agent 只会拆,不会拆完就并发用 subagent 执行" | **递归 fan-out** + 并行执行(显式工具 + 可配闸) |

---

## 2. 概念对齐(新概念 ↔ dsh 机制 ↔ 现有插件)

| 新概念 | 含义 | dsh 机制 | 现有插件复用 |
|---|---|---|---|
| **秘书(根/协调者)** | 理解意图、改写指令、注入约束、掌控节奏、过滤/判断 | 一个**普通 agent 会话**(秘书即会话,走 agent-loop) | 复用语声部 DIRECTOR 的"作用域工具"模式 |
| **负责人(lead)** | 攒项目/业务知识、上下文持久、可被直接对话、可被提升为秘书 | **无父拥有的 top-level Agent**(`ctx.agents.create()`/`resume()`);协调者经 `ctx.agents.get(id).followup/steer/inject` 驱动;角色=作用域工具授权(命令激活) | 新 `dsh-org`;不改 vibe 的 worker |
| **worker** | 便宜、可抛弃、可再派 | 一次性子agent(`subtask_parallel`/spawn,provider=spawn;取代 `vibe_spawn`) | 现有声部(vibe 弃用后由 orchestrator 接管) |
| **任务板** | **需求/委托级**任务清单(用户记忆簿),非实现子步骤 | 新 `task/*` session 事件 + `ctx.taskBoard` 服务 | `dsh-mode-ui` 投影 + Web 节点 |
| **工作集/注意力** | 当前活跃的粗粒度需求任务;新任务默认进 | `ctx.systemPrompt.section()` 注入任务清单(有界,天然小) | — |
| **交枪门禁** | `--review` 保留全工具;按**写作用域**设卡 | 新 `dsh-review-gate`:自建 `tools/pre-execute` 写路径闸;审批经 `ctx.approval`+`ctx.userQuestions` | 现有 tool-read-write 的 write/exec |
| **递归 fan-out** | 拆成的独立子任务**并行**派给子agent;可递归 | 新 `subtask_parallel` 工具(或 workflow `parallel()`);配 `maxDepth`/`maxTotalAgents`/`fanOut` 启发 | — |
| **问题面板** | 异步问题收件箱,可乱序答 | 新 `dsh-question-board`:durable `question/*` 事件 + 工具 + 节点 | mode-ui 节点/徽章风格 |
| **会话间通信** | 进程内点对点寻址/投递 | 新 `dsh-peers`:`ctx.peers` + `peer_send`(复用 `ctx.sessions` 身份 + 持久投递) | — |
| **管理关系/会话面板** | 谁接管谁、谁能碰谁;按秘书看;解除/禁止 | `ctx.org`:`manager[session]→secretary`(每会话至多一个秘书)+ `forbidden[secretary]→Set<target>`(负向授权,动作前校验) | mode-ui/新 org 面板 |
| **可提升协调者** | 命令激活任一会话为协调者(秘书),获得协调工具+方法注入+名册 | `ctx.org` 角色注册 + 作用域工具授予 + role skill/persona 注入 | vibe 作用域工具模式 |
| **需求-评审循环** | 干净评审者→负责人过滤→修→再审到零P0 | 由**评审工作子agent** 持 goal(`ctx.goals`+`goal-round-driver`)+ `tool-subagent` 一次性评审 + `agent.steer/reportFrom` | advisor 的评审者构造(完整 agent+受限工具),改为一次性干净上下文 |
| **规则层** | 提醒型(persona/AGENTS.md)+ 门禁型(工具) | `system-prompt` section/`deployment:persona`(提醒);`tools/pre-execute`+approval(门禁) | 复用 agent-instructions/persona |

---

## 3. 关键约束(dsh/仓库调研确认 + 访谈定论 + 三方评审修正)

1. **负责人 = 无父拥有的 top-level Agent + 协调者驱动**(⚠ 已按评审修正):创建原语是 **`ctx.agents.create()`**(无 owner 的 top-level agent)/ **`ctx.agents.resume()`**(冷会话启动);**不是** `ctx.sessions.create()`(只建裸 Session 日志、不建可驱动的 Agent)或 `fork()`(写入 parentSession/seedLength 父血统,方向相反)。协调者经 `ctx.agents.get(leadId)` 解析 live Agent 后 `followup()/steer()/inject()` 驱动;`ctx.agents.get` 对冷会话返回 undefined,须先 `resume`。**不用 subagent 续传子会话**做负责人(父拥有、父 settle 级联,破坏"只有我能关")。角色是**作用域工具 + 协调权限**的升级,不是文本注记。
2. **评审者必须 join preset**:复用 advisor 的 `agentPresets.composeFrom(agentCtx, primaryCtx)`,受限工具用 `agentCtx.tools.restrict({allow:[...]})` + scoped 注册。
3. **投递原语**:`followup`(整 turn)/`steer`(next-step,同 turn 再跑一步)/`inject`(不唤醒)/`reportFrom`(子→父)。问题面板用 `agent.inject`/`steer` + 持久 question 事件,主会话不被阻塞。
4. **goal 只进子agent**:`ctx.goals` 每会话单当前目标。秘书管多项目、负责人管单项目多问题,都要保持自由;凡深度循环/复杂目标(如需求-评审循环)都由它们派出的**可抛弃子agent**扛(一个子agent 一个 goal),扛完就收。
5. **显式 + 递归 fan-out**:`subtask_parallel` 为一个显式工具;递归可调;三个可配闸 `maxDepth`/`maxTotalAgents`/`fanOut`(是否值得拆的启发),配置在 cordis.yml。
6. **`--review` 用写作用域,不用工具名分类**(⚠ 已按评审修正):dsh **无路径级写白名单**(sandbox 只有 read-only/workspace-write/danger-full-access 三档、按 workspace 根定界,且只包 subprocess argv、不覆盖 fs 的 write/edit)。所以 fence 必须**自建**:一个 `tools/pre-execute`(或 `ctx.tools.guard`)监听 `write`/`edit` 的 `file_path` 对"真源码路径"返回 `ask`/`deny`;`bash` 只能套 **mode 级**沙箱(无法路径级)。规划期 agent 可自由 `bash` 探索/读真码,但**路径闸挡住对真源码的 write/edit**;批准后开闸。
7. **权限隔离**:peers 消息需鉴权(只允许已登记 peer / 祖先 / 协调者互发);`forbidden[secretary]` 负向授权硬拦截(动作前校验)。
8. **上下文预算**:工作集注入用 `maxBytes` 有界(类比 agent-instructions);勾太多截断+提示。
9. **model-visible ⟺ logged**:任务板/问题板/peers 的模型可见输入都必须有对应 `SessionEvent`;UI 从会话日志回放。
10. **不改 agent-loop**:评审/流程全部走 goal + 事件 + 会话;workflow 仅可选作"一轮内 fan-out"(`parallel()`),非主干。
11. **模型路由(延后)**:不同角色用不同模型在进程内即可(`agentOptions.provider/model`)。详见 §7.2 延后项,不立项。

---

## 4. 总体架构(分层)

```
                     ┌───────────── 你(Web Client)─────────────┐
                     │   任务面板        问题面板       徽章/状态 │
                     │  (工作集/评审轮) (待答问题) (compact/vibe)│
                     └──────────────▲───────▲───────▲────────┘
                                    │投影     │投影
                     session 事件(持久、可回放)
                                    │
   ┌────────────────────────────────┴──────────────────────────┐
   │  秘书(协调者会话,`/org` 激活;不持 goal)                      │
   │    ├─ ctx.org(manager/forbid/roles)+ 会话面板               │
   │    ├─ ctx.taskBoard(工作集/闭环,独立)+ ctx.peers(会话通信)   │
   │    ├─ 规则层(persona/AGENTS.md 提醒 + 门禁拦截)              │
   │    └─ 路由/监控:把需求交给负责人                             │
   │        └─ 负责人(top-level Agent:前端/后端/各模块;持上下文,不持 goal)│
   │             └─ 派需求-评审工作子agent(continuable,持 goal)     │
   │                  ├─ subtask_parallel(递归 fan-out + 三个闸)  │
   │                  ├─ 一次性干净评审者(只喂代码+方案)           │
   │                  └─ worker(vibe_spawn,一次性,上下文可抛弃)     │
   └────────────────────────────────────────────────────────┘
```

组件(包)与依赖序:

```
dsh-task-board(独立) → dsh-orchestrator(评审循环 + subtask_parallel 递归 fan-out)
                     → dsh-review-gate(交枪门禁,自建写路径闸)
                     → dsh-question-board(async 问题收件箱)
dsh-org(会话层级/授权) → dsh-peers(会话间通信 + 可提升协调者)
dsh-rules(规则:提醒 + 门禁配置)
(mode-ui 扩展:任务/问题两个 Web 节点)
```

---

## 5. 各部件设计

### 5.1 会话层级 `dsh-org`(负责人/秘书 + 授权模型)

- **目标**:在 worker 与根之间插入**持久负责人**层;负责人上下文跨轮保留、可被直接对话、可被提升为秘书;并**明确定义"谁接管谁、谁能碰谁"**。
- **触发 = 命令(不是创建期注定)**:`/org on`(或 `/secretary`)在某会话激活协调者角色,`/org off` 降级;换秘书 = off+on。与现有 `/vibe`/`/plan`/`/compact`/`/advisor` **同范式**。"根/秘书" = 你激活成协调者的那个会话。
- **不依赖 `ctx.agentTeams`(仅借其模式)**:agent-team 是 experimental、单根扁平、teammate 父拥有、`writeScopes` 非 fence、无 forbidden——均撞本设计核心需求;仅**借用其 durable 设计模式**(roster 快照 / 邮箱 messageId+sender 去重 / 任务 DAG CAS+revision+tombstone / replay fold)作参考。
- **数据模型**:
  ```ts
  interface OrgState {
    manager: Record<SessionId, SessionId | undefined>  // 每会话至多一个秘书;undefined=独立
    forbidden: Record<SessionId, SessionId[]>          // 秘书 → 它不能碰的会话(负向授权)
    roles: Record<SessionId, 'secretary' | 'lead'>     // 角色状态(概念+授权来源)
  }
  ```
  - **每个会话最多一个秘书**(单秘书);某会话要么独立,要么归唯一秘书。
  - **`forbidden[secretary]`** 负向授权:该秘书不能向这些会话发消息/接管/把其当子会话;`dsh-peers`/`org` 每个动作前校验命中即拒绝(硬拦截)。
- **角色 = 三件套**(升级时一并开启):
  1. **工具/权限授予**:秘书获协调工具组(task/peers/ask_question/org);负责人获"派 worker + 上报";worker 被限制。作用域 `agent.ctx.tools`(vibe 已验证)。
  2. **行为/方法论注入**:role 的 skill / `system-prompt` section / persona(秘书怎么分解/派发/汇总/汇报;负责人怎么派 worker/提炼/上报)。
  3. **角色名册**:`ctx.org` 记录角色+管理边(授权依据 + UI 可见性)。
- **授权模型(用户=唯一发起者,agent=执行者)**:
  - **新建会话**:agent 随意(无重要上下文,低风险)。
  - **接管已存在会话**:默认**模型驱动 + 低打扰**(不逐个弹审批);模型能准确控制时成立。
  - **安全阀 = 会话面板"解除+禁止"按钮**(事后覆盖,非事前每步拦截):一次做两件事—— `manager[target]` 清掉(该秘书不再接管)+ `forbidden[秘书].add(target)`(以后也碰不到)。
  - **严格模式扳手**(per 项目/会话可配):弱模型/高风险项目上,把"接管已存在会话"重新变为需你点一下;平时关(少打扰),需要时开。
  - **"禁止"只对该秘书生效**:目标会话从**该秘书面板**消失,但**左侧全局会话列表**仍在(你能看到、能访问)。**你自己永远能访问任何会话**。
- **会话面板(按秘书看)**:点某秘书 → 列出它接管了哪些(每行带"解除+禁止");`forbidden` 的会话不在其面板(但全局列表有)。
- **角色分工总规则**:秘书管**多项目**、负责人管**单项目多问题**,二者都是**协调者**(持上下文/路由/监控)、**不持 goal**;凡深度循环/复杂目标都由它们派出的**可抛弃子agent**扛(一个子agent 一个 goal),扛完就收。goal 只存在于子agent 会话,绝不在协调者会话上。
- **与现有 vibe-mode 关系(冲突,实现时弃用)**:新架构(`dsh-org` + `dsh-peers` + `dsh-orchestrator` 的 `subtask_parallel`)会**取代 vibe-mode 的 director/worker 调度**,实现时移除 vibe-mode。需求阶段仅记录此冲突,实现设计时结合现状处理。

### 5.2 任务板 `dsh-task-board`(独立功能,不耦合 org)

- **目标**:持久**需求/委托级**任务清单(用户记忆簿,防忘记)+ **工作集/注意力**(当前在手的粗粒度需求);agent 能自见未完成任务并**保守闭环**;用户可**重开**。
- **任务 ≠ todo**:任务 = 一个需求/委托(你告诉秘书的"做某需求");`todo_write` = 单条需求内部临时拆的**实现子步骤**(复现→修→测→验)。二者不同粒度。
- **数据模型**(持久 session 事件 `task/*`,fold 出 `taskBoard` 投影):
  ```ts
  interface TaskSnapshot {
    id: TaskId            // 本会话局部,task-<n>
    revision: number      // CAS
    subject: string       // 需求级描述(一个需求=一条任务)
    status: 'pending' | 'in_progress' | 'awaiting_approval' | 'completed' | 'closed' | 'deleted'
    owner?: SessionId     // 负责的会话
    reviewRound: number   // 本轮评审次数
    findings: Finding[]   // 跨轮累积并集
    filteredFindings: Finding[] // 被负责人过滤的误报(业务需要)
    inContext: boolean    // 工作集:是否在当前上下文;新任务默认 true
  }
  ```
- **模型面工具**:`task_new`/`task_update`/`task_close`/`task_reopen`/`task_list`。
- **工作集注入**:`ctx.systemPrompt.section()`(优先级高、`maxBytes` 有界)渲染 `inContext === true` 的需求任务为极短清单;**粗粒度 → 工作集天然小**(同时在手的需求通常几个)。`inContext:false` 留 board 不进上下文。**注意**:`inContext` 变更必须是 durable session 事件(model-visible ⟺ logged)。
- **自动闭环(保守)**:监听 `tools/result`,**仅当命中明显完成信号**(如"测试通过"类)才标记 `completed` 并移出工作集;否则留 `in_progress` 等你确认。**怕乱关。**
- **手动闭环 + 重开**:UI 任务面板"关闭/重开"按钮 —— `task_close` 退场(留存 tombstone)、`task_reopen` 恢复(误关可恢复)。**你的控制权保留。**
- **自反风险平衡**:注入 section 极短,且明确"职责是执行被勾选任务,不是整理清单"。
- **在架构中的作用**:①**台账**——秘书的"外置记忆",记你交给它的需求,不靠模型硬记;②**注意力闸**——只有工作集(`inContext`)进上下文,代码/细节不进 → 秘书上下文轻、不易漂(与工具集限制双管齐下治"角色遗忘");③**跨层级联**——你的需求 → 秘书任务 → 指派某负责人的项目 → 该负责人再拆项目内问题;每层自己的板,任务下派、状态上报。

### 5.3 交枪门禁 `dsh-review-gate`

- **目标**:`--review`(及家族)保留全工具、仅**在写路径**设卡;审批经问题面板;默认(无 flag)自由执行。
- **输入预处理**:一个插件监听**用户输入边界**,识别末尾 `--review`/`--no-review`/`--workers N`,把它**剥离**(不让模型看到字面),并:
  - `--review` / `--plan` → 进入 **plan 草稿态**(见下门禁)+ 把本任务标记为 `awaiting_approval`,注入"用户要求先方案等你审批"提醒。
  - `--no-review` → 强制取消本任务门禁(覆盖规则文件默认)。
  - `--workers N` → 本轮评审个数。
- **门禁 = 自建写路径闸(不用工具名分类;dsh 无路径级 fence)**:
  - **规划期**:agent 可自由 `bash`/脚本探索、读真实项目;但 `tools/pre-execute` 对 `write`/`edit` 命中"真源码路径"返回 `deny`/`ask`——**碰不了真实源码**。
  - `bash` 只能套 **mode 级**沙箱(无法路径级);必要时规划期把 bash 限到 read-only/workspace-write。
  - **你批准**(`exit_plan_mode` 或问题面板"批准")→ 开闸,真源码解锁 → 后续按常规执行。
- **与 plan-mode 区别**:`--review` 是**更窄、逐任务、不限制探索**(只锁写),plan-mode 是另一档(进入协作态 + 可配限制)。二者可共存,`--review` 不必借 plan-mode。

### 5.4 问题面板 `dsh-question-board`

- **目标**:异步、非阻塞、可乱序回答的问题收件箱;主会话不卡。
- **数据模型**(durable `question/*` 事件):
  ```ts
  interface QuestionSnapshot {
    id: QuestionId
    asker: SessionId            // 谁提问(协调者/评审者)
    content: ContentBlock[]
    options?: ...               // 结构化选择(可选)
    blocking: 'blocking' | 'non-blocking'
    status: 'pending' | 'answered' | 'dismissed'
    answer?: ...
  }
  ```
- **模型面工具**:`ask_question`(协调者/评审者调用,登记进收件箱,不打印成长文本)。⚠ 评审修正:被父拥有的子会话**不能直接** `ctx.userQuestions.ask()`(抛 `DELEGATED_CALLER`);子agent 的问题**经父转接**(见 §5.7)。
- **投递语义**:
  - `blocking`:提问者暂停(其对话进度停),但**主会话/其它会话照常**;回答经 `agent.followup`/`steer` 唤醒,继续。
  - `non-blocking`:登记进面板,提问者照常走,你随时答。
- **UI 节点**:Web `ConversationNodeDefinition` + keyed renderer,按提问者分组列出待答问题,可勾选/乱序/一次答多个;回答回送提问者。
- **与 dsh 现成区别**:现有 `tool-ask-user`/approval 是**同步阻塞**;本面板是**异步队列化**的新模式(blocking 分支复用 `ctx.userQuestions`+`ctx.approval` provider,只新增 non-blocking 队列层)。

### 5.5 递归 fan-out `subtask_parallel`(+ 三个可配闸)

- **目标**:拆成的独立子任务**并行**派给子agent,可递归(支持"负责人拆并发派"和"子agent 自己拆再递归派")。
- **机制**:
  - `subtask_parallel([{brief, model?}...], {maxDepth?, maxTotalAgents?})` —— 显式工具:一次派 N 个、自动并发、统一收集、失败隔离。
  - **递归**:spawn 工具按角色递归发放(任何被标为 fan-out-capable 的 agent 都能再 fan-out),配深度上限。
  - **三个可配闸**(配置在 cordis.yml,`maxDepth`/`maxTotalAgents` 可由调用覆盖):
    - `maxDepth`(如 3):到顶就自己干活,不再往深派。
    - `maxTotalAgents`(如 20):一次任务/流程总预算,防爆炸。
    - `fanOut`(是否值得拆启发):`minSubtasks`(拆出 < 2 就不拆)+ `minEffortTokens`(子任务太小不自派)。
- **归一(评审建议,见 §7.4#2)**:与现有 `vibe_spawn` 同属 `ctx.subagents` 并行 fan-out 面,应统一到**一个 spawn 基底**(避免两套 worker 注册表);`maxDepth`/`maxTotalAgents` 复用现有原语,仅 `fanOut` 启发新增。
- **默认倾向**:优先级 `默认 good`——只有"明显机械劳动"才配 `fast`(见 §7.2 模型路由延后项,此处仅保留 `model` 字段,取值待定)。

### 5.6 会话间点对点通信 + 可提升协调者 `dsh-peers`

- **目标**:进程内会话互相寻址;任意会话可经命令提升为协调者(秘书)。
- **实现**:
  - `ctx.peers`(Service):会话注册表 + 逐会话 identity;`peer_send(target, content, {delivery})` 工具;(重用 `ctx.sessions` 身份,近零成本)。
  - `peer/message` session 事件(durable,`senderId/targetId/delivery/content`);目标收件箱记录;**去重键 = sender+messageId,须自建**(⚠ 评审修正:subagent seam **无**消息级幂等原语;在目标会话 durable 状态先查该键再投递)。
- **鉴权**:只允许已登记 peer / 祖先 / 协调者互发;`forbidden[secretary]` 负向授权硬拦截;复用 subagent 委托策略。
- **与现有关系**:这是把 vibe 的"主管-子worker"扩展为**平级会话**;worker 仍是 session 内的一次性子agent。

### 5.7 需求-评审循环(定制化 goal 模式,由评审工作子agent 承载)

- **形态**:一个**定制化 goal**(`ctx.goals` + `goal-round-driver` + 固化流程,**随时启动、自动逐轮、自动闭合**)。**由负责人派出的"评审工作子agent(continuable subagent)"承载,绝不落在秘书/负责人会话上**。秘书把需求路由给负责人;负责人派评审工作子agent 并**监控/过滤**(用业务上下文);评审工作子agent 持有该需求的 goal、跑循环。多个需求 → 多个评审工作子agent → 各持一个 goal → **并行**。
- **固化流程**(负责人的方法论/skill,进入 goal 即按此逐轮):
  1. **设计方案**。
  2. **循环**:`subtask_parallel` 派 **N 个一次性干净上下文评审者**(只喂代码+当前方案)→ 收集 findings(severity 分级)→ 负责人**过滤误报**、判定 P0/P1/P2/P3、累积进任务板(跨轮并集,count P0)→ **有 P0 就修方案并再派新一轮干净评审者**。
  3. **两个跳出条件**:
     - **(a) 零 P0** → `exit_plan_mode`/问题面板审批 → 实施(派实施子agent)→ 一致性核对 → 测试 → **汇报 + goal 自动闭合**。
     - **(b) 遇必须人工决策的点** → `goal.block({code, message})`(真业务判断/不可逆)→ **跳出等待人决策** → 人答 → `goal.resume` 继续。
       - ⚠ 评审修正:子agent **不能直接** `ctx.userQuestions.ask()`(对子会话抛 `DELEGATED_CALLER`)。链路须**经父转接**:子agent `report`/`reportFrom` 负责人 → 负责人经问题面板/`userQuestions` 呈现给你 → 你答 → 负责人 `subagents.sendMessage`(0.2.0-rc.2:`followup`→`sendMessage`,删 source)子agent → 子agent `goal.resume`。
- **可靠 vs 灵活**:评审者确定性(干净一次性)保证每轮可靠;**零P0由任务板计数**(数字,非模型感觉);"先方案后执行"是门禁(审批);只有**过滤误报 + 是否真需人拍板**留给负责人/人判断。**能自解就先自解,只在拿不准/不可逆时 block**。
- **约束(角色分工)**:`ctx.goals` 每会话单当前目标——所以 **goal 只放在独立评审工作子agent 里(一个需求一个),绝不放在秘书/负责人会话上**。
- **workflow 角色(可选)**:仅作**一轮内的 fan-out**(`parallel()` 同时派评审者);loop 本身由 goal 驱动,不靠 blocking workflow。
- **与 advisor 关系**:advisor 是**连续**挂载在会话上的评审者;本循环的评审者是**每轮全新一次性**。两者**共享"受限只读评审者构造 helper"**(composeFrom+restrict+advise+委托策略),只是 feed/delivery 不同(评审建议,见 §7.4#3)。**severity 词表需统一**(advisor=`nit/concern/blocker` vs 本循环=`P0-P3`)。

### 5.8 规则层 `dsh-rules`

- **目标**:提醒型规则(持久、高优先、挂载)+ 门禁型规则(工具拦截)。
- **提醒型**:写进 `$DSH_HOME/AGENTS.md`/`agent-instructions`(低优先、指导)或 `deployment:persona`(高优先);规则持久到文件,启动挂载。
- **门禁型**:写进审查门禁/approval 配置(哪些工具、哪些写路径);只落门禁的才可靠。**提醒型靠措辞,门禁型靠机制——分属两类,别混**。

### 5.9 角色工具集(能力信封,机制强制)

**核心原则:角色靠工具集(能力)强制,不靠提示词。** 上下文一长、注意力衰减,模型会忘记角色、自己动手。不给它工具,它就没有能力越界。

**机制(dsh 原生,现有插件已用)**:`agentCtx.tools.restrict({allow:[...]})`(掩掉不该有的全局工具)+ `agentCtx.tools.register(...)`(加角色专属工具)+ **路径/类型闸**(`tools/pre-execute` 按 writeScope 拦,同 `--review` 机制)。`/org on` 激活角色 = 给该 agent 套一个工具集 scope。

**三层能力梯度(越往上统筹越强、动手越弱)**:

| 能力 | 秘书 | 负责人 | worker |
|---|---|---|---|
| 读文档 | ✓ | ✓ | ✓ |
| 读结构(目录树/符号索引) | ✓ | ✓ | ✓ |
| 读代码正文 | ✗ | ✓ | ✓ |
| 写代码(`src/**`) | ✗ | ✗ | ✓ |
| 写文档/计划(`docs/**`/`.md`) | ✗ | ✓ | ✓ |
| 写长任务书(交接区) | ✓ | ✓ | — |
| 派活(`subtask_parallel`/spawn) | ✓(派负责人) | ✓(派 worker/评审) | 递归时 ✓ |
| 通信(`peer_send`/`report`) | ✓ | ✓ | ✗ |
| 任务板(`task_*`) | ✓ | ✓ | ✗ |
| org(接管/禁止) | ✓ | ✗ | ✗ |
| 问用户(`ask_question`) | ✓ | ✓(经父) | ✗ |

**关键点:**
- **"写" ≠ "实施"**。负责人必须能写(方案/设计/汇报文档)——跨 agent 通信有字符上限,长方案须**落成文档让子 agent 读**,而非塞进命令。
- **"实施" = 产出"这个任务的交付物",用 writeScope 表达**——负责人写 `docs/**`/`.md`/交接区(设计任务的交付物=文档 → 落在可写区 → 负责人完成它),写 `src/**` 被挡;worker 全写(代码任务的交付物=代码 → worker 完成)。**两种任务由"谁能写哪一类"统一覆盖,不必按任务重定规则。**
- **worker 递归默认开**(fan-out-capable,受 `maxDepth`/`maxTotalAgents` 闸);叶子 worker 不给 spawn。
- **交接区清理 = 秘书评判**:秘书拥有全局进展,任务完成时把过程文档**收敛成一句/合并一个文档**(进不进 git 由任务决定,出范围)。

---

### 5.10 角色工具清单(具体工具 + 语义 + 归属)

机制:`tools.restrict({allow:[...]})`(掩掉全局工具)+ `tools.register`(注册角色专属工具)。**秘书的读用专用工具,不直接给全局 `read`**(防止它读到代码正文)。

**秘书(协调者)专属工具**(负责人/worker 都没有,注册在秘书作用域):

| 工具 | 作用 | 输入 → 输出 |
|---|---|---|
| `org_claim` | 接管已存在会话为负责人 | `sessionId` → 注册 manager 边(严格模式需审批) |
| `org_relinquish` | 解除接管 | `sessionId` → 清 manager 边 |
| `org_forbid` | 禁止本秘书再访问某会话 | `sessionId` → 加 forbidden(硬拦截) |
| `org_spawn_lead` | 新建负责人会话并接管 | `{name, cwd, prompt}` → 新会话 id |
| `assign_task` | 把需求派给指定负责人 | `{leadId, subject, brief}` → 写任务板 + 投递负责人 |
| `read_project_docs` | 读项目文档(仅 `.md`/docs) | `path` → 文档文本(**不读代码**) |
| `project_structure` | 目录树 + 符号索引 | `path?` → 结构(无代码正文) |
| `summarize_reports` | 汇总多个负责人的汇报 | `reportIds[]` → 摘要 |
| `notify_user` | 向用户发通知/汇报 | `content` → — |

**秘书 + 负责人共享**:

| 工具 | 作用 |
|---|---|
| `peer_send` | 给指定会话发消息(经鉴权) |
| `task_new`/`task_update`/`task_close`/`task_reopen`/`task_list` | 任务板 CRUD |
| `ask_question` | 结构化问询用户(负责人经父转接) |

**负责人专属**:

| 工具 | 作用 |
|---|---|
| `subtask_parallel` | 批量并发派 worker/评审子agent(递归,受 `maxDepth`/`maxTotalAgents`/`fanOut` 三闸) |
| `report` | 向秘书/用户汇报(走 `peer_send`/`reportFrom`) |

**负责人读/写**:`restrict` 保留全局 `read`/`glob`/`grep`/`lsp`(读)/`read_image`;**写经路径闸**——只 `docs/**`/`.md`/`.dsh-plans/**`,挡 `src/**`(同 `--review` 机制)。

**worker 工具**(按 brief 的 `toolFilter` 裁剪):`read`/`write`/`edit`/`bash`/`glob`/`grep`/`lsp`/测试;递归时额外 `subtask_parallel`。

---

## 6. 配置示例(cordis.patch.yml 增行)

```yaml
- id: task-board
  name: '@dsh-plugin/dsh-task-board'
  config:
    maxContextBytes: 2000            # 工作集注入上限
    autoCloseSignals: [test-passed]  # 保守闭环:只认明显完成信号

- id: review-gate
  name: '@dsh-plugin/dsh-review-gate'
  config:
    protectedPaths: ['**/src/**', '**/*.ts']   # 真源码:write/edit 命中则 ask/deny
    scratchDir: '.dsh-plans'                     # 规划期可写区(自建路径闸)

- id: question-board
  name: '@dsh-plugin/dsh-question-board'
  config: {}

- id: org
  name: '@dsh-plugin/dsh-org'
  config:
    strictMode: false                # 弱模型/高风险项目开 true → 接管已存在会话需你点

- id: peers
  name: '@dsh-plugin/dsh-peers'
  config:
    allowAncestor: true

- id: orchestrator
  name: '@dsh-plugin/dsh-orchestrator'
  config:
    reviewersPerRound: 3
    reviewerTools: [read, grep, glob]
    zeroP0Approach: 'count'          # 数字判定,非模型感觉
    fanOut:                          # 三个可配闸
      maxDepth: 3
      maxTotalAgents: 20
      minSubtasks: 2
      minEffortTokens: 2000

- id: rules
  name: '@dsh-plugin/dsh-rules'
  config:
    advisoryFiles: ['$DSH_HOME/AGENTS.md', 'persona']
    gateRules: [...]                 # 转成写路径/审批门禁
```

---

## 7. 拍板点(状态)

### 7.1 已定

1. **负责人形态**:负责人用**无父拥有的 top-level Agent**(`ctx.agents.create()` / 冷启动 `resume()`,真正只由你关);协调者经 `ctx.agents` 驱动;角色=作用域工具授权(**`/org` 命令激活**)。**否决** `ctx.sessions.create`/`fork`(不建 agent / 引入父血统)与 subagent 续传子会话。
2. **协调者数量**:一个秘书可接管**多个会话/模块**(前后端同管);每个会话**至多一个秘书**(单秘书,`manager` 映射)。
3. **任务粒度与工作集**:任务 = **需求/委托级**(一个需求=一个任务);与 `todo_write`(单次子待办)不同;任务板 = 用户给秘书的委托记录(防忘记);新任务**默认进工作集**(`inContext:true`,粗粒度天然少、有界);自动闭环**保守**(只认明显完成信号)+ 用户可**重开**(`task_reopen`)。**task-board 独立,不耦合 org。**
4. **评审循环载体**:需求-评审循环 = **定制化 goal 模式**(`ctx.goals` + round-driver + 固化流程,随时启动、自动逐轮;双跳出:**零P0→自动闭合+汇报**、**遇人工决策→`goal.block` 等待→`resume` 继续**)。由**评审工作子agent** 承载(非秘书/负责人);一个需求一个评审 goal → 多需求可并行。workflow 仅可选作"一轮内 fan-out"。
5. **递归 fan-out**:`subtask_parallel` 显式工具,递归可调;三个可配闸 `maxDepth`/`maxTotalAgents`/`fanOut` 配置在 cordis.yml。
6. **`--review` 门禁**:按**写作用域**分(**自建 `tools/pre-execute` 路径闸**,dsh 无路径级 fence);规划期挡 write/edit 到真源码、放行读与 bash;批后开闸。不用工具名分类。
7. **秘书激活**:`/org`(或 `/secretary`)命令激活,不是创建期注定;换秘书 = off+on(主观发起)。
8. **不依赖 `ctx.agentTeams`**:因单根扁平/父拥有/writeScopes 非 fence/无 forbidden 撞核心需求;仅借其 durable 模式。

### 7.2 延后项

- **模型路由(延后)**:它就是 vibe 现有 `fast/good` 两档的扩展——按角色默认(秘书/负责人/评审者=good,worker 按 brief 主导性质)+ 评审/协调锁 good + 可按任务覆盖。暂不立项。

### 7.3 开发期再细化

- 会话生命周期/资源成本(每项目会话预算 + 成本计量 + 自动归档)。
- 任务/问题面板的 Web 节点交互细节(勾选/一次多答/键盘流)。
- `dsh-peers` 与 vibe"主管-子worker" 的职责边界细化。
- role skill/persona 的具体文本(秘书/负责人怎么做)。

### 7.4 悬而未决(三方评审后新增,待拍)

1. **substrate:自建 org/peers vs 依赖 agent-team**——推荐**自建**;命令驱动角色 + 多负责人 + 只由你关 + forbidden 均超出 agent-team 的单根扁平/父拥有模型。待你点头。
2. **vibe-mode 弃用(subtask_parallel 成唯一 spawn 底座)**——新架构实现后移除 vibe-mode,`subtask_parallel` 成为唯一 spawn 机制。实现时处理。
3. **severity(已定:不统一)**——advisor=`nit/concern/blocker` 是**方向级建议(可选采纳)**;评审循环=`P0-P3` 是**问题分级(必须解决)**。二者不同轴,不统一。
4. **严格模式默认值(已定)**:默认 **off**(低打扰),弱模型/高风险项目手动开。
5. **`--review` 路径规则**——哪些算"真源码"、哪些算"草稿区"(建议固定 `.dsh-plans/*`)。待定。
6. **评审者构造抽成共享 helper**——advisor(连续)与本循环(一次性)共用构造,只差 feed/delivery。待定。

---

## 8. MVP 切分与代码量估算

按**最痛最小、纯现成原语**先做:

- **MVP-1** `dsh-review-gate`(小,纯交互层):`--review` 解析 + 剥离 + **自建写路径闸** + `tools/pre-execute` 对真源码 write/edit 返回 `ask` + 问题面板"待批方案" + 批准/驳回。**直接杀你"15轮/先方案后执行"的最痛点**。约 1~1.5 人日。
- **MVP-2** `dsh-question-board`(小):`ask_question` 工具 + durable 事件 + Web 节点(可乱序/分组/一次多答),主会话不阻塞。约 1 人日。
- **MVP-3** `dsh-task-board`(中,核心,独立):task CRUD 工具 + 工作集注入 + 自动/手动闭环/重开 + 任务面板节点。约 2~3 人日。
- **MVP-4** `dsh-org` + `dsh-peers`(大,最难):负责人(top-level Agent)+ `/org` 命令激活 + 会话间通信 + 可提升协调者 + **管理关系/解除/禁止面板**。约 3~5 人日,且依赖 MVP-1/2/3 跑通后的经验。
- **MVP-5** `dsh-orchestrator`(中):评审循环(goal 由评审工作子agent 承载)+ `subtask_parallel` 递归 fan-out + 三个可配闸。约 2~3 人日。
- `dsh-rules`(小-中):规则文件 + 提醒型挂载 + 门禁配置。约 1 人日。

建议顺序:**review-gate → question-board → task-board → rules → orchestrator → org+peers**。

---

## 9. 风险

- **驱动 top-level Agent 的鉴权/唤醒**:协调者经 `ctx.agents.get(id)` 拿到 live Agent 才能 followup/steer;若目标会话**未活**(冷),须先 `ctx.agents.resume()`。对**非父会话** `followup/steer` 的鉴权边界需确认(需插件 `dsh-peers` 自己加鉴权)。
- **子agent 触达用户的限制**:子会话 `ctx.userQuestions.ask()` 抛 `DELEGATED_CALLER`;所有人工决策须经父转接(见 §5.7),否则死锁。
- **模型驱动接管的风险(弱模型)**:默认低打扰靠模型准确度;弱模型可能"好心"接管你没让它碰的会话。靠"解除+禁止"硬拦截 + 严格模式扳手兜底;**不要只靠提示词**。
- **递归 fan-out 失控**:深度/总agent数/是否值得拆 三个闸缺一不可;否则一个需求拆出几十个子agent。
- **`--review` 路径闸误配置**:protectedPaths 配错会误放/误拦。靠启动校验 + 默认保守(宁可拦多)。
- **工作集自反**:agent 可能沉迷管理清单而非干活;靠极短 section + 明确职责 + 保守自动闭环缓解。
- **peers 去重自建**:无现成幂等原语;须在目标 durable 状态维护 `sender+messageId` 键。
- **上下文预算**:工作集/问题面板若不过滤会塞爆;靠 `maxBytes` + 截断 + 提示。

---

## 10. 验证(免 API key)

- **单元**:task-board(fold/工作集/CAS/闭环/重开)、review-gate(flag 解析/剥离/写路径闸/批准开闸)、question-board(队列化/乱序/blocking vs 非阻塞/父转接)、org(manager/forbid/角色三件套/解除+禁止/`/org` 命令)、peers(寻址/投递/鉴权/自建去重/提升协调者)、orchestrator(评审派发/过滤/零P0计数/回喂/`subtask_parallel` 三闸)。
- **快照/键无关**:关键管线(mock LLM + mock agent + mock session/event 流);跑通"`--review` → 写路径闸 → 问题面板 → 批准 → 开闸/返修" + "评审循环 → 零P0 → 自动闭合/汇报" + "人工决策 → 父转接 → resume" 整条。
- **配置**:`--dump-config` 约束 + `constraints`/`typecheck`/`build`。

---

## 11. 变更记录

- **v1.0**(2026-09-04):初始设计。汇总访谈定论(进程内/不换 loop/干净评审者/`--review` 门禁/任务板工作集/问题面板/可提升协调者),叠加现有 7 插件,列为拍板点待确认。
- **v1.1**(2026-09-04):`dsh-org` 授权模型定稿(每会话至多一个秘书;`forbidden` 负向授权;角色=三件套;新建会话随意、接管默认模型驱动+低打扰、严格模式扳手;用户=唯一发起者由"解除+禁止"事后覆盖;用户永远可访问任何会话)。拍板点 2 已定。
- **v1.2**(2026-09-05):设计定稿。①任务粒度=需求/委托级 + 与 todo 区分 + 保守闭环+重开;②评审循环 = 定制化 goal,**由评审工作子agent 承载**(不落秘书/负责人)+ 双跳出(零P0 / 人工决策);③递归 fan-out `subtask_parallel` + 三个可配闸(maxDepth/maxTotalAgents/fanOut,配置在 cordis.yml);④`--review` 按**写作用域**分(不用工具名分类);⑤**模型路由延后**(就是 vibe `fast/good` 两档扩展,不立项)。
- **v1.3**(2026-09-05):**三方评审(适配性/可行性/正确性/重复)后修订**。①负责人创建原语改为 `ctx.agents.create()`/`resume()`(原 `ctx.sessions.create`/`fork` 错误——只建裸日志 / 引入父血统);②`--review` 写作用域改为**自建 `tools/pre-execute` 路径闸**(dsh 无路径级 fence,sandbox 仅 mode 级);③人工决策链补**父会话转接**(子agent 抛 `DELEGATED_CALLER`);④peers 去重改为**自建幂等键**(subagent seam 无消息级幂等);⑤明确**不依赖 `ctx.agentTeams`**(仅借模式);⑥task-board 标明独立功能;⑦新增 §7.4 悬而未决 6 条。
- **v1.4**(2026-09-05):角色工具集定稿。①新增 §5.9:角色=能力信封(工具集强制,非提示词)——秘书读文档+结构/写长任务书、负责人读码+写文档不写码、worker 全写+递归默认开;②"写≠实施","实施"用 writeScope 表达(文档 vs 代码);③交接区清理由秘书评判,进 git 由任务定(出范围);④severity 不统一(advisor=方向建议/可选,P0-P3=问题分级/必解);⑤vibe-mode 实现时弃用;⑥严格模式默认 off。
- **v1.5**(2026-10-07):0.2.0-rc.2 迁移对齐。新增 §12:9 处 API 修正(`subagents.spawn`→`startContinuable`、`userQuestions.registerProvider` 删、`goals` 硬依赖 `sessionProjections`、projection `init(header,inheritedEventCount)`、`followup`→`sendMessage`、`Session.events`→projection、消息自有 kind、`tool-result`→`role:'tool'`、客户端拆包);§5.7 父转接改 `sendMessage`。其余核心机制签名未变。
- **v1.6**(2026-10-07):新增 §5.10 角色工具清单——具体工具名 + 语义 + 归属。秘书专属 9 个(`org_claim/relinquish/forbid/spawn_lead`、`assign_task`、`read_project_docs`、`project_structure`、`summarize_reports`、`notify_user`);共享 3 组(`peer_send`、`task_*`、`ask_question`);负责人专属 2 个(`subtask_parallel`、`report`);worker 按 `toolFilter` 全读写 + 递归时 `subtask_parallel`。
- **v1.7**(2026-10-07):新增 §13 模块详细实现规格——每插件 TS 接口 + 工具 schema 级(review-gate 的 protectedPaths 闸、question-board 的 QuestionSnapshot/ask_question、task-board 的 TaskSnapshot/task_*、orchestrator 的 subtask_parallel、org+peers 的 OrgState/PeerMessageSnapshot/org_*/peer_send + /org 命令)。

---

## 12. 0.2.0-rc.2 API 对齐(迁移备注,实施时照此写)

本设计基于本地 dsh **0.1.1-rc.2** 撰写;实施时目标迁移到 **0.2.0-rc.2**。以下 API 引用需按新语义写(已由 `RESEARCH-LATEST-UPSTREAM-COMPAT.md` + `VERIFY-4-APIS-0.2.0-rc.2.md` 核实):

| # | 设计引用 | 0.2.0-rc.2 实况 | 修正 |
|---|---|---|---|
| 1 | `ctx.subagents.spawn(...)` | **从来不是方法**(仅 provider 注册名) | 可续传用 `startContinuable(spec)`;一次性走 `tool-subagent`(spawn-in-process provider) |
| 2 | `ctx.userQuestions.registerProvider()` | **删除** | 改 `user-questions/request` waterfall + `answer()`;`ask()` 保留 |
| 3 | `ctx.goals`(评审循环) | 签名未变,现**硬依赖 `sessionProjections`** | orchestrator 组合显式挂 `sessionProjections`;stateVersion 4→6(旧行作废) |
| 4 | session-projection `init()` | → `init(header, inheritedEventCount)` | 补参,正确支持 fork |
| 5 | `subagents.followup`(§5.7 父转接) | → `sendMessage(sender, targetId, content, {signal})` | 删 source |
| 6 | `Session.events`(任务板/问题板/org 折叠) | **删除** | session-projection + `session/event` 增量 |
| 7 | 消息来源通配 `plugin` kind | **删除** | 每个新插件 `declare module '@deepseek-ai/dsh-llm'` 声明自有 kind |
| 8 | `tool-result` 内容块 | **删除** | 工具结果走 `role:'tool'` 消息 |
| 9 | 客户端 `dsh-client-runtime` | **整包删除** | `dsh-client-store`/`ui-renderer`/`configForms`/`sessions.retain` |

**其余核心机制签名逐字节未变**(不影响设计):`ctx.fs`、`ctx.tools.register/restrict/presentAs`、`ctx.systemPrompt.section`、`ctx.commands`、`ctx.agents`(复数)、`ctx.sandbox` 升级面、`Agent.followup/steer/inject`、`tools/pre-execute`→`ctx.approval`、`ctx.llm.stream`、`agent/pre-step`。

---

## 13. 模块详细实现规格(接口 / 事件 / 工具 / 配置)

> 每个插件给到 TS 接口 + 工具 schema 级。0.2.0-rc.2 对齐见 §12。

### 13.1 `dsh-review-gate`

```ts
interface ReviewGateConfig {
  protectedPaths: string[]   // 真源码 glob,如 ['**/src/**', '**/*.ts', '**/*.tsx']
  scratchDir: string         // 草稿区,默认 '.dsh-plans'
  defaultPolicy: 'off' | 'on' // 无 flag 时默认门禁状态
}
```
- **无模型工具**。输入预处理监听用户输入边界,剥末尾 `--review`/`--no-review`/`--workers N`。
- **强制点**:`tools/pre-execute` 监听器,命中"写 + protectedPaths"→ 返回 `{ kind:'ask', reason }`(走 `ctx.approval`);`bash` 套 mode 级沙箱。
- **事件**:`review-gate/state`(`{ taskId, awaitingApproval: boolean }`)持久化"本任务待批"态。

### 13.2 `dsh-question-board`

```ts
interface QuestionOption { label: string; description?: string }
interface QuestionSnapshot {
  id: string; asker: SessionId
  content: ContentBlock[]; options?: QuestionOption[]
  blocking: 'blocking' | 'non-blocking'
  status: 'pending' | 'answered' | 'dismissed'
  answer?: string | string[]
}
```
- **事件**:`question/asked`(`{ id, asker, content, options, blocking }`)、`question/answered`(`{ id, answer }`)、`question/dismissed`(`{ id }`)。
- **工具** `ask_question`:
  ```ts
  { name:'ask_question', input: { content: string; options?: QuestionOption[]; blocking?: boolean },
    output: { id: string } }
  ```
- **服务**:`ctx.questionBoard.ask/answer/dismiss/list`。
- **投影**:`questionBoard`(`key`;`stateSchema: QuestionSnapshot[]`;`init(header, count)`;`apply` 于 `question/*`)。
- **投递**:blocking 答后 `agent.followup`/`steer` 唤醒;子 agent 经父转接(§5.7)。

### 13.3 `dsh-task-board`

```ts
interface Finding { severity: 'P0'|'P1'|'P2'|'P3'; summary: string; sourceRound: number }
interface TaskSnapshot {
  id: string; revision: number        // CAS
  subject: string                     // 需求级描述
  status: 'pending'|'in_progress'|'awaiting_approval'|'completed'|'closed'|'deleted'
  owner?: SessionId
  reviewRound: number
  findings: Finding[]; filteredFindings: Finding[]
  inContext: boolean                  // 工作集
}
```
- **事件**:`task/new`、`task/update`(带 `revision` CAS)、`task/closed`、`task/reopened`(皆 tombstone 可回放)。
- **工具**(协调者作用域):`task_new({subject})`、`task_update({id, patch, revision})`、`task_close({id})`、`task_reopen({id})`、`task_list()`。
- **服务**:`ctx.taskBoard`。
- **工作集注入**:`ctx.systemPrompt.section()` 渲染 `inContext===true` 的 `subject`(极短,`maxBytes` 有界)。
- **自动闭环**:监听 `tools/result`,命中 `autoCloseSignals`(如 test-passed)才 `completed`。

### 13.4 `dsh-rules`

```ts
interface RulesConfig { advisoryFiles: string[]; gateRules: { tool: string; paths?: string[] }[] }
```

### 13.5 `dsh-orchestrator`

```ts
interface OrchestratorConfig {
  reviewersPerRound: number           // 默认 3
  reviewerTools: string[]             // ['read','grep','glob']
  zeroP0Approach: 'count'             // 数字判定
  fanOut: { maxDepth: number; maxTotalAgents: number; minSubtasks: number; minEffortTokens: number }
}
```
- **工具** `subtask_parallel`:
  ```ts
  { name:'subtask_parallel',
    input: { tasks: { brief: string; model?: 'fast'|'good' }[]; maxDepth?: number; maxTotalAgents?: number },
    output: { results: { taskIndex: number; value: unknown }[] } }
  ```
  内部:`startContinuable`(可续传,持 goal 的评审工作子agent)+ spawn-in-process provider(一次性 worker)。
- **评审循环**:`ctx.goals.create({objective})` → 每轮 `subtask_parallel` 派干净评审者 → 收集 findings → 负责人过滤 → `task.update` 累积 → `count P0 === 0` 则 `complete`;人工决策点 `goal.block(reason)` → 等待 → `goal.resume`。
- **评审者构造**:复用 3.3 抽取的 `composeReviewer(agentCtx, agent, spec, watchdog)`。

### 13.6 `dsh-org` + `dsh-peers`

```ts
interface OrgState {
  manager: Record<SessionId, SessionId | undefined>  // 每会话至多一个秘书
  forbidden: Record<SessionId, SessionId[]>          // 秘书 → 它不能碰的会话
  roles: Record<SessionId, 'secretary' | 'lead'>
}
interface PeerMessageSnapshot {
  id: string; senderId: SessionId; targetId: SessionId
  delivery: 'quiet' | 'wakeup'; content: ContentBlock[]
}
```
- **事件**:`org/claim`、`org/relinquish`、`org/forbid`、`org/role`;`peer/message`(幂等键 = `senderId+messageId`,自建去重)。
- **工具(秘书专属)**:`org_claim({sessionId})`、`org_relinquish({sessionId})`、`org_forbid({sessionId})`、`org_spawn_lead({name,cwd,prompt})`、`assign_task({leadId,subject,brief})`、`read_project_docs({path})`(仅 .md/docs)、`project_structure({path?})`、`summarize_reports({reportIds[]})`、`notify_user({content})`。
- **工具(共享)**:`peer_send({targetId, content, delivery?})`、`task_*`、`ask_question`。
- **工具(负责人专属)**:`subtask_parallel`、`report({content})`。
- **服务**:`ctx.org`(`manager/forbidden/roles` + claim/relinquish/forbid/spawnLead/assign);`ctx.peers`(send/listMessages/去重)。
- **命令**:`/org on|off|claim <id>|relinquish <id>|forbid <id>|list`。
- **投影**:`org`(按秘书看的 manager 列表 + forbidden)、`peers`(收件箱)。
- **UI**:会话面板(点秘书 → 列接管会话,每行"解除+禁止");左侧全局会话列表标"谁归谁管/孤儿"。

---

## 待补(延后/后续独立文档)

- 模型路由(延后,见 §7.2)。
- 会话生命周期/资源成本控制(每项目会话预算 + 成本计量 + 自动归档)细节。
- `dsh-peers` 与现有 `vibe` 主管-子worker 的职责边界细化。
- 任务面板/问题面板的 Web 节点交互细节(勾选/一次多答/键盘流)。

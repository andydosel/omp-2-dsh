# 设计文档 v1.1:compact 模式(shake 压缩 + plan 式审阅 + 审阅树)

> 状态:设计定稿(拍板点已全部确认),等待最终开工确认
> 基线:dsh(deepseek-harness)master,本地 clone `C:/Users/Vantage_XLST/Documents/dsh`
> 参考:omp `compaction.md` / `vibe-mode.md` / `tree.md` / `session-tree-plan.md`;dsh `docs/architecture.md`、`docs/subsystems/compaction.md`、`packages/plan/plan-mode/README.md`、`packages/compaction/compaction-basic/README.md`

---

## 0. 插件原则(用户约束,硬性)

- **一切必须以插件形式实现**:挂载、替换、扩展全部走 cordis 行;不修改 dsh 核心(会话模型、agent-loop、持久化 schema、核心服务)。
- 任何需求若**涉及核心改动**或**实现形式不是插件**,必须先提醒用户、讨论后再动。
- 本设计范围内全部满足插件化:替换 `ctx.compaction` backend、模式事件(声明合并扩展 `SessionEventMap`,与 `plan-mode` 同款)、人类命令、独立存储 domain、通用树引擎,均为插件包。

## 1. 需求

1. 用 **shake** 替换 dsh 默认压缩策略(现默认 `dsh-compaction-basic`)。
2. shake 完仍超过 60% 用量 → **提示用户是否进入 compact 模式**。
3. compact 模式:live 会话暂停,**所有消息 = 指令**;每一步(指令 + 结果)记入**审阅树**,可回溯。
4. 审阅树:可观测、可通过对话微调、**用户确认后才应用**(plan 式)。
5. 审阅树与**普通对话记录分开存储**。
6. 用户可**随时退出** compact 模式(不压缩);也**随时进入**(命令入口)。
7. UI 相关暂不做。
8. vibe 模式:独立工作流(另见 §附)。
9. 完整会话树(omp 式导航/分支/标签):后续独立大项目,需核心改动,届时提醒用户。

## 2. 概念对齐(omp ↔ dsh)

| omp 概念 | omp 定义 | dsh 对应物 |
|---|---|---|
| shake 策略 | 本地机械削减:可弃 tool result 与大段 fenced/XML 块 → 可恢复引用;保护窗口 + 最小节省阈值;压不进恢复区间则回退摘要 | `ctx.toolResultPruner` + `ctx.spillStore` + `ctx.tokenMeter` |
| plan 式审阅 | 先产草案 → 对话审阅/修改 → 确认后执行 | dsh `plan-mode` 同构模式:`plan/mode` 事件 + fold、命令、工具 + `ctx.userQuestions` |
| vibe 模式 | 主会话变 DIRECTOR,worker 干活;fast/good;会话持久化 | `ctx.subagents` + `ctx.jobs` + 会话日志 + `ctx.tools.restrict()` |
| tree | append-only 日志 + 每条 `id/parentId` + `leaf` 指针;分支 = 移 leaf,不改历史;导航/标签/搜索/分支摘要 | 本设计新建 `dsh-tree-engine`(通用 mini 树引擎,审阅树消费之) |

**关键可行性**:dsh 压缩是标准能力缝(`ctx.compaction` + backend + `command-compact`),换策略 = profile 禁用 `dsh-compaction-basic` 行、插入新 backend,不改核心。压缩有 `compaction/start → summary → end` 日志事件 + `user/message` surface replace;未闭合的 start 事件是天然锁。

**审阅树为何不碰核心**:树节点(指令 + 草稿)放独立存储,与会话日志物理分离;只有最终确认的草稿经**现有** compaction 事件(`compaction/summary` + `user/message` replace)进入日志。完整 omp 式会话树才需要改核心(事件加 parentId、上下文派生改路径化、持久化/投影/压缩适配),那是后续项目。

## 3. 插件结构(两个新包,全部插件形态)

| 包 | 职责 | 说明 |
|---|---|---|
| `dsh-tree-engine` | 通用 append-only 树引擎:节点(id/parentId)、leaf、分支(非破坏)、标签、模糊搜索、存储层抽象 | 数据模型抄 omp tree 核心,不含 UI;可复用(未来完整会话树直接消费) |
| `dsh-compact-mode` | `ctx.compaction` backend(shake + 摘要)+ compact 模式(事件/命令/状态机)+ 审阅树接线 + 独立存储 domain | 替换 `dsh-compaction-basic`;命令并入,profile 同时禁用 `dsh-command-compact` 行 |

## 4. compact 模式

- **状态**:`compact/mode { active: boolean }` 日志事件(整值替换,`plan/mode` 同款,fold 可恢复)。
- **进入**:任意时刻 `/compact`(命令入口,同 omp `/plan`);60% 软阈值提示"进入 compact 模式?";**硬溢出**提示 + 选项"进入 / 不进入"。忽略提示 = 不进入,继续正常对话。
- **提示策略**:每会话每阈值只提示一次(可配冷却),不刷屏。
- **退出**:`/compact_apply`(确认并应用)→ 应用后退出;`/compact_abort`(不应用)退出。
- **互斥**:与 plan / vibe 互斥——进入 compact 前要求退出 plan/vibe,反之亦然(读 `ctx.planMode` 与 vibe 状态,冲突时提示先退出)。
- **活跃时**:live 循环暂停(模型不醒);所有用户消息按指令处理。

## 5. 总体流程

```
触发(压力/溢出/手动 /compact)
  → shake(自动,本地削减)
  → 重测 ≤60%? → 完成(仅本地削减)
  → >60%? → 提示进入 compact 模式(或硬溢出提示+选项)
  → 进入 → 生成草稿 v1(独立辅助调用)
  → [审阅循环] 用户消息=指令 → 修订调用(草稿+指令+源)→ 新树节点
       ├─ 回溯:回到某草稿节点 → 从该处分支(非破坏)
       ├─ 对比(可选):/compact diff <a> <b>
       ├─ /compact_apply → 应用草稿(compaction 事件)+ 退出 + 树销毁
       └─ /compact_abort → 退出不应用;树保留;上下文变动后删除
```

## 6. Shake 阶段(纯本地,零模型调用)

1. 可弃 tool result → `ctx.toolResultPruner` 确定性裁剪。
2. 大段 fenced/XML 块 → 占位符 + `ctx.spillStore` 可恢复定位符(无 spill 则纯截断标记)。
3. 保护窗口 `keepRecentTokens`(近期上下文原样保留)。
4. 最小节省阈值 `minShakeSavingsRatio`(防空转)。
5. `ctx.tokenMeter` 重测;usage/context-window ≤60% → 完成;>60% → 进入提示。
6. shake 替换是 durable 表面事件(引用被遮蔽节点,可重放恢复)。

## 7. 审阅(独立辅助调用,不碰 live 上下文)

- 生成/修订 = `ctx.llm.stream()` 一次性调用(`purpose: 'compaction'`,重放前缀吃 provider KV 缓存),**输入 = 当前草稿 + 指令 + 源上下文**,有界、不累积——多次微调不会超限(60% 触发下余量充足)。
- **live 会话零增长**:暂停 + 指令路由到修订调用,不产生模型可见记录。
- **指令入口**:v1 用 `/compact_edit <指令>`(命令,确定可靠);普通消息自动截获为指令(v1.2 增强,需验证 dsh 在循环暂停时插件能否看到未认领消息——不行则保持命令形式)。
- 每次修订结果 = 新草稿,记入树节点;草稿回显给用户经 `/compact view <n>`(无 UI 阶段)。

## 8. 审阅树(`dsh-tree-engine` 消费)

- **节点内容**:指令 + 修订后草稿 + 时间戳 + 来源草稿 + 修订调用 token 用量(审计)。
- **回溯**:分支语义(非破坏,旧分支保留)。
- **存储**:经 `ctx.storage` seam 的独立领域 domain(挂 storage-json 等后端),与普通对话记录**物理分离**。
- **生命周期**:
  - `/compact_abort` 退出 → **树保留**;
  - 退出后若**上下文变动**(新用户/助手消息、会话 fork、表面替换)→ **树删除**(下次进入全新开始);
  - `/compact_apply` 应用后 → **树销毁**(结果已在会话日志)。
- **观测(无 UI)**:`/compact tree`(树列表)、`/compact view <n>`、`/compact jump <n>`、`/compact diff <a> <b>`(可选)。

## 9. 事件与存储汇总

| 位置 | 内容 |
|---|---|
| 会话日志(新增事件,声明合并扩展 `SessionEventMap`) | `compact/mode`(整值替换) |
| 会话日志(现有 compaction 事件) | `compaction/start`、`compaction/summary`(最终草稿)、`compaction/end`、`user/message` surface replace(应用) |
| 独立存储(审阅树) | 树节点(指令/草稿/时间戳/来源/token 用量)+ leaf + 标签 |

## 10. 配置

```yaml
- id: compact-mode
  name: '@deepseek-ai/dsh-compact-mode'
  config:
    thresholdRatio: 0.6            # shake 后 >60% 提示进入 compact 模式
    keepRecentTokens: 20000        # shake 保护窗口
    minShakeSavingsRatio: 0.05     # 防空转
    summarizationProvider: ''      # 空 = 沿用最近请求路由
    summarizationModel: ''
    maxTokens: 8192
    promptOnThreshold: true        # 60% 时提示
    promptCooldown: 0              # 提示冷却(0 = 每会话每阈值一次)
    promptOnHardOverflow: true     # 硬溢出提示+选项
    reviewTimeoutMs: 0             # 0 = 审阅不超时
    auto: true                     # 注册自动压力/溢出监听
```

## 11. 拍板点记录(全部已确认)

1. 审阅树先行、零核心改动;完整会话树后续独立立项 —— ✅(Q1)
2. 审阅树存储:独立领域存储(`ctx.storage`)—— ✅(Q2=2a)
3. 树生命周期:退出保留,上下文变动删除,应用后销毁 —— ✅(Q3,用户细化)
4. 硬溢出:提示 + 选项(进入/不进入),不强制;随时 `/compact` 入口 —— ✅(Q4)
5. 模式互斥(compact ↔ plan/vibe)—— ✅(Q5)
6. 回溯:分支语义(非破坏)—— ✅(Q6)
7. 节点内容:指令 + 草稿 + 时间戳 + 来源 + token 用量 —— ✅(Q7)
8. 确认方式:`/compact_apply` 人类命令 —— ✅(并入模式设计)
9. 指令入口:v1 命令形式(`/compact_edit`);消息自动截获为 v1.2 增强 —— ✅
10. 包名:`dsh-tree-engine` / `dsh-compact-mode`(可再议)—— ✅

## 12. 风险与取舍

- **审阅期间超限**:已消除——live 暂停(零增长)+ 独立有界调用(草稿+指令+源 < 窗口)。
- **普通消息截获可行性未验证**:v1 用命令;验证后可升 v1.2。
- **完整会话树需核心改动**:后续项目,届时提醒用户(插件原则 §0)。
- **提示刷屏**:冷却机制。
- **60% 后继续对话**:可能接近硬溢出;硬溢出提示 + 选项,用户拒绝则会话可能卡死——有 `/compact` 随时入口兜底。
- **`compactRegion` 与审阅模式的交互**:显式区域压缩(非模式路径)行为需实现时与模式锁协调(审阅挂起时拒绝并发区域压缩)。

## 13. 验证(免 API key)

`constraints` / `typecheck` / `build`;单测:树引擎(节点/分支/回溯/标签/搜索)、模式状态机(进入/退出/互斥)、指令→修订调用映射、应用前后表面替换、上下文变动删树、提示冷却;`--dump-config` 验证 backend 替换与命令行生效。

## 14. 变更记录

- **v1.0**(2026-08-17):初始设计(shake + 60% + plan 式审阅),5 个拍板点待确认。
- **v1.1**(2026-08-17):compact 模式化;审阅改独立辅助调用(live 暂停,解决超限);审阅树 + 分开存储 + 生命周期规则;新增插件原则(§0);拍板点全部确认(§11);包结构定为 `dsh-tree-engine` + `dsh-compact-mode`。

## 15. 迭代约定

- 每轮优化在本文件基础上改,版本号 +0.1(小改)/ +1(大改)。
- 已确认决策记入 §11/§14。
- 设计变更先落文档,再动代码。
- 涉及核心改动或非插件实现 → 先提醒用户(§0)。

---

## 附:vibe 模式(独立工作流,概要)

- `/vibe` 切换;`vibe/mode` 事件 + fold(镜像 plan/mode)。
- 活跃时:注入 DIRECTOR 指令 section;作用域工具收窄为 read + todo + 5 个 vibe 工具;注册 `vibe_spawn/send/wait/kill/list`。
- 后端:`ctx.subagents`(默认 spawn-in-process)+ `ctx.jobs` + 会话日志持久化;fast/good 映射可配。
- 退出:终止/停靠全部 worker。
- 与 compact/plan 互斥。
- 独立立项,压缩插件交付后并行开发。

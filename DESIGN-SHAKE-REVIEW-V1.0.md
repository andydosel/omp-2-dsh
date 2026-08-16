# 设计文档 v1.0:shake 压缩 + plan 式审阅 + vibe 模式

> 状态:已评审草案(等待拍板点确认后进入开发)
> 基线:dsh(deepseek-harness)master,本地 clone `C:/Users/Vantage_XLST/Documents/dsh`
> 参考:omp 文档 `compaction.md` / `vibe-mode.md`;dsh `docs/architecture.md`、`docs/subsystems/compaction.md`、`packages/plan/plan-mode/README.md`、`packages/compaction/compaction-basic/README.md`

---

## 1. 需求

1. 用 **shake** 替换 dsh 默认压缩策略(现默认 `dsh-compaction-basic` 的 LLM 摘要式压缩)。
2. shake 完**仍超过 60%** 用量 → 才启动"真正的上下文压缩"(LLM 摘要)。
3. 真压缩要像 plan 模式:能**观测**压缩结果、**通过对话编辑**、**确认后**才应用。
4. UI 相关暂不做。
5. 另需 omp 的 **vibe 模式**(见 §4,独立工作流)。

## 2. 概念对齐(omp ↔ dsh)

| omp 概念 | omp 定义 | dsh 对应物 |
|---|---|---|
| shake 策略 | 不调模型的本地机械削减:可弃 tool result 与大段 fenced/XML 块 → 可恢复 `artifact://` 引用;保护窗口 + 最小节省阈值;自动 shake 压不进恢复区间则回退全文摘要(防空转) | `ctx.toolResultPruner`(确定性裁剪)+ `ctx.spillStore`(溢出文本→可恢复定位符)+ `ctx.tokenMeter`(重测) |
| plan 模式审阅 | 先产草案 → 对话中审阅/修改 → 确认后执行 | dsh `plan-mode` 现成模式可镜像:`plan/mode` 日志事件 + fold、`plan:policy` section、`/plan` 命令、`exit_plan_mode` 工具 + `ctx.userQuestions` 审批 |
| vibe 模式 | 主会话变 DIRECTOR:工具收窄为 read+todo+5 个 vibe 工具,worker 干活;fast/good 两级;worker 会话持久化 | `ctx.subagents` + `ctx.jobs` + 会话日志;`ctx.tools.restrict()` 作用域限制 |

**关键可行性**:dsh 压缩是标准能力缝——`ctx.compaction`(Service Definition)+ 一个 backend + 人类消费者(`command-compact`)。**换策略 = profile 禁用 `dsh-compaction-basic` 行、插入新 backend**,不改上游代码。压缩有 `compaction/start → summary → end` 日志事件 + `user/message` surface replace;未闭合的 start 事件是天然锁,防并发压缩。

## 3. 插件 A:`dsh-compaction-shake-review`

实现 `ctx.compaction` 三动词(`compactIfNeeded` / `compactNow` / `compactRegion`),替换 compaction-basic。

### 3.1 触发
- 自动:`agent/pre-step` 压力检查(serial,请求组装前)+ `agent/request-error` 溢出恢复。
- 手动:`/compact`(人类命令;profile 禁用 `dsh-command-compact` 行避免同名冲突)。

### 3.2 状态机

```
idle ──触发──▶ shaking ──压到≤60%──▶ done(仅本地削减)
                │
                └─仍>60%──▶ reviewing(生成摘要草稿,锁住,等待审阅)
                              │
              ┌───────────────┼────────────────┐
    用户 /compact_edit      对话提修改          /compact_abort
              │          (模型 update_compaction_draft)
              ▼               ▼                ▼
        更新草稿(记录)   更新草稿(记录)     取消:不碰会话表面,
              └───────────────┼────────────────┘ 记录失败尝试
                              ▼
                        /compact_apply
                              ▼
                     applying:user/message surface replace + compaction/end
```

### 3.3 Shake 阶段(纯本地,零模型调用)
1. 可弃 tool result → `ctx.toolResultPruner` 确定性裁剪。
2. 大段 fenced/XML 块 → 占位符 + `ctx.spillStore` 可恢复定位符(无 spill 服务则纯截断标记)。
3. 保护窗口 `keepRecentTokens`(近期上下文原样保留)。
4. 最小节省阈值 `minShakeSavingsRatio`(防空转;省不够跳过 shake)。
5. `ctx.tokenMeter` 重测;usage/context-window **≤60% → 完成**;**>60% → 进审阅**。
6. shake 替换是 durable 表面事件(引用被遮蔽节点,可重放恢复)。

### 3.4 审阅阶段(plan 式,无 UI)
- **生成草稿**:复用 compaction-basic 的摘要方式——`ctx.llm.stream()` 一次性调用,重放会话前缀吃 provider KV 缓存,`purpose: 'compaction'`;草稿存 `compaction/summary` 事件。
- **可观测**:草稿经 `agent.inject()` 进上下文(遵循"模型可见即日志"不变量);模型在回复中呈现草稿。
- **对话编辑**:用户反馈 → 模型调用新工具 `update_compaction_draft {text}` 确定性更新草稿(修订记录为日志事件)。
- **确认应用**:`/compact_apply`(人类命令,不经模型)→ 执行 `user/message` surface replace + `compaction/end`。
- **取消**:`/compact_abort` → 表面零改动,日志记录失败尝试。
- 审阅期间 `compaction/start` 锁保持打开 → 自动压缩被阻塞;支持可配审阅超时。
- 备选确认方式:模型工具 `apply_compaction` + `ctx.userQuestions` 审批(plan-mode 同款)。

### 3.5 新增会话事件(扩展 `SessionEventMap`,仅日志)
`compaction/review`(状态:draft/active/edit/approve/abort)、`compaction/draft-revision`(草稿修订)。与 `plan/mode` 同模式:fold 后可恢复、可重放。

### 3.6 配置(默认按需求)

```yaml
- id: compaction:shake-review
  name: '@deepseek-ai/dsh-compaction-shake-review'
  config:
    thresholdRatio: 0.6        # shake 后 >60% 才启动真压缩
    keepRecentTokens: 20000    # shake 保护窗口
    minShakeSavingsRatio: 0.05 # 防空转
    reviewTimeoutMs: 0         # 0=不超时,审阅挂起则自动压缩暂停
    summarizationProvider: ''  # 空=沿用最近请求路由
    summarizationModel: ''
    maxTokens: 8192
    auto: true
```

### 3.7 风险与取舍
- 审阅期间上下文仍超限(应用前模型仍看全量历史);provider 硬溢出时 `request-error` 路径在审阅挂起时先提示(可选:审阅时暂停模型轮次)。
- 与 `command-compact` 的 `/compact` 冲突 → profile 禁用其行。
- shake 单次每压力事件,防循环(omp 同设计)。

### 3.8 验证(免 API key)
`constraints`/`typecheck`/`build` + 单测:状态机转移、事件序列、`/compact_apply` 前后表面替换、`update_compaction_draft` 确定性、审阅期间锁阻塞;`--dump-config` 验证替换生效。

## 4. 插件 B:`dsh-vibe-mode`(概要,独立工作流)

- `/vibe` 切换;状态存日志事件 + fold(镜像 `plan/mode`)。
- 活跃时:注入 DIRECTOR 指令 section;作用域内工具收窄为 read + todo + 5 个 vibe 工具(`ctx.tools.restrict()` + agent preset `isolate`);注册 `vibe_spawn/send/wait/kill/list`。
- 后端:`ctx.subagents`(默认 spawn-in-process,可配外部 provider)+ `ctx.jobs` 管轮次 + 会话日志持久化 worker 转录;fast/good 映射可配置模型。
- 退出:终止/停靠全部 worker。
- 体量约为压缩插件两倍;建议批准后作为并行工作流开发。

## 5. 拍板点(待用户确认)

1. 确认方式:`/compact_apply` 人类命令(v1 推荐)vs `exit_plan_mode` 式工具 + 审批弹窗。
2. 审阅期间超限:允许继续(简单)vs 暂停模型轮次(更稳)。
3. 60% 口径:shake 后估算用量 / 模型上下文窗口(同 compaction-basic `thresholdRatio`,默认 0.8→0.6)。
4. vibe worker 后端:进程内 spawn-in-process 够用?是否支持外部(ACP/Codex/Claude Code)。
5. 包名:`dsh-compaction-shake-review` / `dsh-vibe-mode` 可接受?

## 6. 变更记录

- **v1.0**(2026-08-17):初始设计,等待拍板点确认。

## 7. 迭代约定

- 每轮优化在本文件基础上改,版本号 +0.1(小改)/ +1(大改)。
- 已确认的拍板点移入 §6 变更记录,注明确认日期与结论。
- 设计变更先落文档,再动代码。

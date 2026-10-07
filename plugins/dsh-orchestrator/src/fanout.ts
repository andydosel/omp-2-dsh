/**
 * The `subtask_parallel` gates: the three configurable knobs that keep a
 * recursive fan-out from exploding (DESIGN-COORDINATOR-SUITE-V1.0.md §5.5,
 * §9 risk "递归 fan-out 失控").
 *
 * - `maxDepth` — the delegation-depth cap. At the cap the caller does the work
 *   itself instead of delegating deeper.
 * - `maxTotalAgents` — the blast-radius budget of one flow. Over budget the
 *   fan-out refuses; nothing partial is dispatched.
 * - `fanOut` heuristics — `minSubtasks` (splitting one task into one task) and
 *   `minEffortTokens` (delegating work smaller than the coordination overhead).
 *
 * A per-call `maxDepth` / `maxTotalAgents` may only TIGHTEN the deployment
 * bound (`Math.min`). The design allows a call to carry its own budget for a
 * sub-tree; letting a model RAISE the cap it is subject to would make the gate
 * advisory, which is exactly the failure §9 warns about.
 *
 * Pure: no context, no I/O, so the gates are unit-testable on their own.
 *
 * @module @dsh-plugin/dsh-orchestrator/fanout
 */

import { estimateTokens } from './findings.ts'

/** What a dispatched sub-task's child is for. */
export type SubTaskRole = 'worker' | 'reviewer'

/** The dispatch tier one sub-task routes to (the worker-spawn vocabulary). */
export type SubTaskTier = 'fast' | 'good'

/** One requested sub-task, exactly as the model passed it. */
export interface FanOutTaskSpec {
  /** The complete task prompt handed to the child (its only context). */
  readonly brief: string
  /** Optional dispatch tier; omitted means `good`. */
  readonly model?: SubTaskTier
  /** Optional role; omitted means `worker`. Reviewers are read-only one-shots. */
  readonly role?: SubTaskRole
}

/** One validated, defaulted sub-task. */
export interface NormalizedSubTask {
  readonly brief: string
  readonly tier: SubTaskTier
  readonly role: SubTaskRole
}

/** The configured gate values. */
export interface FanOutBounds {
  readonly maxDepth: number
  readonly maxTotalAgents: number
  readonly minSubtasks: number
  readonly minEffortTokens: number
}

/** One `subtask_parallel` call. */
export interface FanOutRequest {
  readonly tasks: readonly FanOutTaskSpec[]
  readonly maxDepth?: number
  readonly maxTotalAgents?: number
}

/** The calling flow's current position in its budget. */
export interface FanOutContext {
  readonly bounds: FanOutBounds
  /** The calling agent's delegation depth (a top-level agent is 0). */
  readonly depth: number
  /** Sub-agents this flow has already dispatched. */
  readonly spent: number
}

/** Why a fan-out was refused. */
export type FanOutRefusalCode =
  | 'no-tasks'
  | 'invalid-task'
  | 'invalid-bounds'
  | 'depth-exhausted'
  | 'budget-exhausted'
  | 'too-few-subtasks'
  | 'effort-too-small'

/** One refusal: a stable code plus the model-facing explanation. */
export interface FanOutRefusal {
  readonly code: FanOutRefusalCode
  readonly reason: string
}

/** The plan for one fan-out: dispatch these sub-tasks, or do the work here. */
export type FanOutPlan =
  | {
    readonly kind: 'fan-out'
    readonly tasks: readonly NormalizedSubTask[]
    /** The delegation-depth cap the dispatched children inherit. */
    readonly maxDepth: number
    /** The flow budget after this dispatch is accounted. */
    readonly maxTotalAgents: number
    /** Estimated brief size that passed the effort gate. */
    readonly effortTokens: number
  }
  | { readonly kind: 'do-it-yourself'; readonly refusal: FanOutRefusal }

/** Whether one value is a dispatch tier. */
export function isSubTaskTier(value: unknown): value is SubTaskTier {
  return value === 'fast' || value === 'good'
}

/** Whether one value is a dispatch role. */
export function isSubTaskRole(value: unknown): value is SubTaskRole {
  return value === 'worker' || value === 'reviewer'
}

/** The outcome of validating one optional caller bound. */
type BoundCheck =
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly refusal: FanOutRefusal }

/** Require a whole-number bound, or `undefined` when the caller omitted it. */
function checkBound(value: unknown, field: string): BoundCheck {
  if (value === undefined) return { ok: true, value: undefined }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return {
      ok: false,
      refusal: {
        code: 'invalid-bounds',
        reason: `${field} must be a non-negative whole number, got ${JSON.stringify(value)}`,
      },
    }
  }
  return { ok: true, value: value as number }
}

/** The outcome of normalizing one requested sub-task. */
type TaskCheck =
  | { readonly ok: true; readonly task: NormalizedSubTask }
  | { readonly ok: false; readonly refusal: FanOutRefusal }

/** Normalize one requested sub-task, or explain why it is unusable. */
function checkTask(task: FanOutTaskSpec, index: number): TaskCheck {
  if (task.model !== undefined && !isSubTaskTier(task.model)) {
    return {
      ok: false,
      refusal: {
        code: 'invalid-task',
        reason: `task #${index} model must be 'fast' or 'good', got ${JSON.stringify(task.model)}`,
      },
    }
  }
  if (task.role !== undefined && !isSubTaskRole(task.role)) {
    return {
      ok: false,
      refusal: {
        code: 'invalid-task',
        reason: `task #${index} role must be 'worker' or 'reviewer', got ${JSON.stringify(task.role)}`,
      },
    }
  }
  const brief = typeof task.brief === 'string' ? task.brief.trim() : ''
  if (brief === '') {
    return { ok: false, refusal: { code: 'invalid-task', reason: `task #${index} needs a non-empty brief` } }
  }
  return { ok: true, task: { brief, tier: task.model ?? 'good', role: task.role ?? 'worker' } }
}

/**
 * Apply the three gates to one fan-out request.
 * @param context - the flow's bounds, delegation depth, and spent budget.
 * @param request - the requested sub-tasks and optional tighter bounds.
 * @returns the dispatch plan, or the refusal that keeps the caller working.
 */
export function planFanOut(context: FanOutContext, request: FanOutRequest): FanOutPlan {
  const bounds = context.bounds
  const callDepth = checkBound(request.maxDepth, 'maxDepth')
  if (!callDepth.ok) return { kind: 'do-it-yourself', refusal: callDepth.refusal }
  const callTotal = checkBound(request.maxTotalAgents, 'maxTotalAgents')
  if (!callTotal.ok) return { kind: 'do-it-yourself', refusal: callTotal.refusal }
  const maxDepth = Math.min(bounds.maxDepth, callDepth.value ?? bounds.maxDepth)
  const maxTotalAgents = Math.min(bounds.maxTotalAgents, callTotal.value ?? bounds.maxTotalAgents)

  if (!Array.isArray(request.tasks) || request.tasks.length === 0) {
    return {
      kind: 'do-it-yourself',
      refusal: { code: 'no-tasks', reason: 'subtask_parallel needs at least one task' },
    }
  }
  const tasks: NormalizedSubTask[] = []
  for (const [index, task] of request.tasks.entries()) {
    const checked = checkTask(task, index)
    if (!checked.ok) return { kind: 'do-it-yourself', refusal: checked.refusal }
    tasks.push(checked.task)
  }

  if (context.depth >= maxDepth) {
    return {
      kind: 'do-it-yourself',
      refusal: {
        code: 'depth-exhausted',
        reason: `this agent is at delegation depth ${context.depth}, the cap is ${maxDepth}: do the work here instead of delegating deeper`,
      },
    }
  }
  if (context.spent + tasks.length > maxTotalAgents) {
    return {
      kind: 'do-it-yourself',
      refusal: {
        code: 'budget-exhausted',
        reason: `this flow already dispatched ${context.spent} of its ${maxTotalAgents} sub-agent budget; `
          + `${tasks.length} more would exceed it — do these tasks here (or raise fanOut.maxTotalAgents)`,
      },
    }
  }
  if (tasks.length < bounds.minSubtasks) {
    return {
      kind: 'do-it-yourself',
      refusal: {
        code: 'too-few-subtasks',
        reason: `${tasks.length} sub-task(s) is below fanOut.minSubtasks=${bounds.minSubtasks}: `
          + 'the coordination overhead outweighs the parallelism — do it inline',
      },
    }
  }
  const effortTokens = estimateTokens(tasks.map(task => task.brief).join('\n'))
  if (effortTokens < bounds.minEffortTokens) {
    return {
      kind: 'do-it-yourself',
      refusal: {
        code: 'effort-too-small',
        reason: `the combined brief is ~${effortTokens} tokens, below fanOut.minEffortTokens=${bounds.minEffortTokens}: `
          + 'do it inline instead of paying a sub-agent spawn',
      },
    }
  }
  return { kind: 'fan-out', tasks, maxDepth, maxTotalAgents, effortTokens }
}

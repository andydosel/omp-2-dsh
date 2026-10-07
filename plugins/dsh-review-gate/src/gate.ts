/**
 * The review-gate write fence: one `tools/pre-execute` decision function plus
 * the listener adapter that records which calls the fence blocked.
 *
 * The fence never classifies by tool name alone — `write`/`edit` are fenced by
 * the TARGET PATH (dsh has no path-level write fence, so the plugin builds
 * one). Reading, listing, searching and `bash` pass untouched except for the
 * session-level sandbox tightening the controller applies while the fence is
 * closed.
 *
 * @module @dsh-plugin/dsh-review-gate/gate
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ResolvedReviewGateConfig } from './config.ts'
import { classifyPath, relativeToWorkspace } from './paths.ts'
import type { ReviewGateState } from './state.ts'

/** The model-facing write-path tools the fence inspects (by name). */
export const WRITE_TOOL_NAMES: Record<string, true> = { write: true, edit: true }

/** The plugin's approval-policy surface, read opportunistically from `ctx.approval`. */
export type GateApprovalPolicy = 'ask' | 'never'

/** Fence decision for one call, before delegation to the downstream chain. */
export type WriteGateDecision =
  | { kind: 'allow' }
  | { kind: 'ask'; reason: string; displayReason: { en: string; zh: string } }
  | { kind: 'deny'; reason: string }

/** Inputs of one fence evaluation. */
export interface WriteGateRequest {
  /** The called tool's name. */
  readonly tool: string
  /** The tool's parsed arguments. */
  readonly args: unknown
  /** The session's folded gate state (absent before the unit folds anything). */
  readonly state: ReviewGateState | undefined
  /** The session's approval policy (`'never'` means an ask can never be granted). */
  readonly approvalPolicy: GateApprovalPolicy | undefined
  /** Session workspace root. */
  readonly cwd: string
  /** Resolved plugin configuration. */
  readonly config: ResolvedReviewGateConfig
}

/**
 * Whether the fence is closed: the gate applies to this task AND its plan
 * approval is outstanding. State shared by the decision function and the
 * controller's unlock bookkeeping.
 * @param state - the folded gate state.
 * @returns true while protected-target writes must ask.
 */
export function isGateClosed(state: ReviewGateState): boolean {
  return state.enabled && state.awaitingApproval
}

/**
 * Read the target path off a tool's arguments defensively: the fence sees
 * unvalidated model input, so a missing, non-string or blank target is
 * "unknown" rather than a crash. Both spellings of the write target are
 * accepted — `file_path` (dsh-core `tool-fs`) and `path` (the omp
 * `dsh-tool-read-write` suite this profile mounts), preferring the former.
 * @param args - the call's parsed arguments.
 * @returns the trimmed target path, or `undefined` when the call carries none.
 */
export function readToolPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  for (const key of ['file_path', 'path']) {
    if (!(key in args)) continue
    const value: unknown = Reflect.get(args, key)
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

/** Materialize the fence's approval ask (audited reason plus localized prompt). */
function approvalAsk(reason: string, promptEn: string, promptZh: string): WriteGateDecision {
  return { kind: 'ask', reason, displayReason: { en: promptEn, zh: promptZh } }
}

/**
 * Decide one call against the closed fence. The scratch area always wins, an
 * unreadable target is fenced conservatively, and a `'never'` approval policy
 * denies outright instead of asking a question nobody can answer.
 * @param request - the call and the fence configuration.
 * @returns the decision the pre-execute listener returns (or delegates on).
 */
export function evaluateWriteGate(request: WriteGateRequest): WriteGateDecision {
  if (WRITE_TOOL_NAMES[request.tool] !== true) return { kind: 'allow' }
  const state = request.state
  if (state === undefined || !isGateClosed(state)) return { kind: 'allow' }
  const filePath = readToolPath(request.args)
  if (filePath === undefined) {
    return approvalAsk(
      `review-gate: the user is still reviewing this task's plan and the "${request.tool}" call has no readable file_path, so the write is treated as protected source.`,
      `review-gate: this task awaits plan approval and "${request.tool}" carries no readable target path — treated as protected.`,
      `review-gate:本任务等待方案审批,且 "${request.tool}" 没有可读的目标路径——按受保护源码处理。`,
    )
  }
  const target = classifyPath({
    filePath,
    cwd: request.cwd,
    protectedPaths: request.config.protectedPaths,
    scratchDir: request.config.scratchDir,
  })
  if (target !== 'protected') return { kind: 'allow' }
  const relative = relativeToWorkspace(filePath, request.cwd)
  if (request.approvalPolicy === 'never') {
    return {
      kind: 'deny',
      reason: `review-gate: "${relative}" is protected source and this session's approval policy is "never", so the plan approval the gate requires cannot be granted. Write the plan under "${request.config.scratchDir}" and ask the user to approve it.`,
    }
  }
  return approvalAsk(
    `review-gate: "${relative}" is protected source and task "${state.taskId}" is still awaiting the user's plan approval (${state.reviewers > 0 ? `--workers ${state.reviewers}` : '--review'}).`,
    `review-gate: "${relative}" is protected source; approving this call also opens the gate for the rest of the task.`,
    `review-gate:"${relative}" 是受保护源码;批准此调用也会为本任务其余写入开闸。`,
  )
}

/** Runtime hooks the listener adapter needs from the controller. */
export interface WriteGateListenerDeps {
  /** Resolved plugin configuration. */
  readonly config: ResolvedReviewGateConfig
  /** Folded gate state of one session. */
  stateOf(session: Session): ReviewGateState | undefined
  /** Approval policy of one session, when an approval service is mounted. */
  approvalPolicyOf(session: Session): GateApprovalPolicy | undefined
  /** Whether an approval already opened the gate in memory (state commit follows at the next step). */
  isUnlocked(session: Session): boolean
  /** Record a blocked call so its approval outcome can be observed. */
  onGuarded(session: Session, callId: string, target: string): void
}

/**
 * Build the single `tools/pre-execute` listener: it returns `ask`/`deny` (which
 * short-circuit dispatch — `next()` is never called) or delegates with
 * `next()`.
 * @param deps - controller hooks.
 * @returns the listener to register on the plugin context.
 */
export function createWriteGateListener(
  deps: WriteGateListenerDeps,
): (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision> {
  return async (exec, next) => {
    const session = exec.agent?.session
    if (session === undefined) return next()
    if (deps.isUnlocked(session)) return next()
    // A session header's cwd is optional (agentless/seeded sessions); the
    // process cwd is the same fallback the sandbox policy uses.
    const cwd = session.header.cwd ?? process.cwd()
    const decision = evaluateWriteGate({
      tool: exec.name,
      args: exec.arguments,
      state: deps.stateOf(session),
      approvalPolicy: deps.approvalPolicyOf(session),
      cwd,
      config: deps.config,
    })
    if (decision.kind === 'allow') return next()
    if (decision.kind === 'ask') {
      const target = readToolPath(exec.arguments)
      deps.onGuarded(session, exec.callId, target === undefined ? '(unknown target)' : target)
    }
    return decision
  }
}

/**
 * dsh-review-gate: `--review`, the per-task "plan first, wait for my approval"
 * gate.
 *
 * Design (`DESIGN-COORDINATOR-SUITE.md` §5.3 / §13.1):
 *
 * - The user suffixes their input with `--review` / `--no-review` /
 *   `--workers N`. The flags are stripped at the user-input boundary (the
 *   `agent/pre-step` claimed batch) so the model never reads the literal
 *   tokens; a gate notice is injected for the same step, and the whole task's
 *   state is logged as `review-gate/state`.
 * - The gate keeps EVERY tool: it fences only the WRITE PATH. dsh has no
 *   path-level fence (the sandbox is mode-level), so this plugin builds one —
 *   a single `tools/pre-execute` listener that asks for approval
 *   (`ctx.approval`) on `write`/`edit` hitting `protectedPaths`, while the
 *   configured `scratchDir` stays writable so the plan can be drafted on disk.
 * - Honest boundary: `bash` cannot be path-fenced. While the fence is closed
 *   the session's sandbox mode is TIGHTENED to `draftSandboxMode` (never
 *   loosened), which is the only lever the mode-level sandbox offers; reads,
 *   searches and exploration stay free.
 * - Approving one fenced write opens the gate for the rest of the task
 *   (observed through the `approval/asked` + `approval/decided` audit pair and
 *   the dispatched result). A successful `exit_plan_mode` — the plan-mode
 *   plugin's approval surface, when the deployment mounts it — opens it too.
 *   A rejected or cancelled ask leaves the fence closed and feeds the refusal
 *   back to the model at the next step.
 *
 * No model-facing tools: the whole feature is a boundary plus a fence.
 *
 * @module @dsh-plugin/dsh-review-gate
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode, type SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { Config, resolveConfig, type ResolvedReviewGateConfig, type ReviewGateConfig } from './config.ts'
import { findFlagTarget, parseInputFlags, stripFlags, type InputFlags } from './flags.ts'
import { createWriteGateListener, isGateClosed, type GateApprovalPolicy } from './gate.ts'
import {
  applyFlagsToState,
  createReviewGateProjection,
  initialGateState,
  type ReviewGateState,
} from './state.ts'

export { Config, resolveConfig, DEFAULT_PROTECTED_PATHS, DEFAULT_SCRATCH_DIR } from './config.ts'
export type { DraftSandboxMode, GatePolicy, ResolvedReviewGateConfig, ReviewGateConfig } from './config.ts'
export { findFlagTarget, parseInputFlags, stripFlags } from './flags.ts'
export type { FlagTarget, InputFlags } from './flags.ts'
export { classifyPath, globToRegExp, isWithinDir, relativeToWorkspace } from './paths.ts'
export type { PathClass, PathClassRequest } from './paths.ts'
export { createWriteGateListener, evaluateWriteGate, isGateClosed, readToolPath, WRITE_TOOL_NAMES } from './gate.ts'
export type { GateApprovalPolicy, WriteGateDecision, WriteGateListenerDeps, WriteGateRequest } from './gate.ts'
export { applyFlagsToState, createReviewGateProjection, initialGateState, reviewGateStateSchema } from './state.ts'
export type { ReviewGateState, ReviewGateView } from './state.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Gate notices injected into the step that carried the flags, and the approval/refusal narration. */
    'dsh-review-gate': { kind: 'dsh-review-gate' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    reviewGate: ReviewGateController
  }
}

/** The plan-mode plugin's approval tool; a successful call there approves the plan. */
const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode'

/** Sandbox-mode ordering: the gate only ever moves a session toward less access. */
const SANDBOX_RESTRICTIVENESS: Record<SandboxMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/** One gate notice as an immutable user-role message from this plugin. */
function notice(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-review-gate', form: 'notice', summary },
  })
}

/** The model-facing narration of one flag-bearing input. */
function flagNotice(
  flags: InputFlags,
  state: ReviewGateState,
  config: ResolvedReviewGateConfig,
): UserMessage {
  const lines: string[] = []
  if (flags.review === true) {
    const protectedPaths = config.protectedPaths.join(', ')
    const sandbox = config.draftSandboxMode === '' ? 'unchanged' : config.draftSandboxMode
    lines.push(
      `review-gate: the user requested a review gate for this task (--review, task "${state.taskId}"): produce a plan and wait for the user's approval before implementing.`
      + ` While the gate is closed, write/edit against protected source (${protectedPaths}) asks for approval, and the session sandbox is kept at or below "${sandbox}".`
      + ` Reads, searches, bash and writes under "${config.scratchDir}/" stay free. Approving a fenced write opens the gate for the rest of the task.`,
    )
  }
  if (flags.review === false) {
    lines.push(
      `review-gate: the user cancelled the review gate for this task (--no-review, task "${state.taskId}"): implement freely.`,
    )
  }
  if (flags.workers !== undefined) {
    lines.push(`review-gate: this task round runs ${String(flags.workers)} reviewer(s) (--workers ${String(flags.workers)}).`)
  }
  const summary = flags.review === true
    ? 'review gate armed'
    : flags.review === false
      ? 'review gate cancelled'
      : `review gate: --workers ${String(flags.workers ?? 0)}`
  return notice(lines.join('\n'), summary)
}

/** The step's admitted batch after the pre-step waterfall (the enter variant). */
type EnterDecision = Extract<PreStepDecision, { kind: 'enter' }>

/**
 * `ctx.reviewGate`: the gate state and the write fence. Sibling plugins read
 * {@link ReviewGateController.stateOf} for a task's gate/`reviewers` and may
 * open a task explicitly with {@link ReviewGateController.approve}.
 */
export class ReviewGateController extends Service {
  static inject = ['tools', 'sessionProjections'] as const

  static Config = Config

  /** Validated configuration of this deployment. */
  readonly config: ResolvedReviewGateConfig

  /** Fenced calls per session: call id → target path, awaiting its approval outcome. */
  private readonly guarded = new WeakMap<Session, Map<string, string>>()

  /** Approval-request id → session, for the asks this fence issued. */
  private readonly askedApprovals = new Map<string, Session>()

  /** Sessions whose gate has been approved in memory; the durable state commit follows at the next accepted step. */
  private readonly pendingUnlock = new WeakSet<Session>()

  /** Session sandbox override before the fence tightened it (`null` = deployment default). */
  private readonly sandboxPrior = new WeakMap<Session, SandboxMode | null>()

  private sandboxPolicy: SandboxPolicyService | undefined

  private approvalPolicyOf: (session: Session) => GateApprovalPolicy | undefined = () => undefined

  constructor(ctx: Context, config: ReviewGateConfig = {}) {
    super(ctx, 'reviewGate')
    this.config = resolveConfig(config)
    ctx.sessionProjections.register(createReviewGateProjection(this.config.defaultPolicy))

    // Both seams are opportunistic: the fence works (asking through whatever
    // approval channel exists) even when neither service is composed, and the
    // sandbox transition needs the policy owner to read the current mode.
    ctx.inject(['approval'], approvalCtx => {
      this.approvalPolicyOf = session => approvalCtx.approval.overrideOf(session)
    })
    ctx.inject(['sandboxPolicy'], sandboxCtx => {
      this.sandboxPolicy = sandboxCtx.sandboxPolicy
    })

    ctx.on('tools/pre-execute', createWriteGateListener({
      config: this.config,
      stateOf: session => this.stateOf(session),
      approvalPolicyOf: session => this.approvalPolicyOf(session),
      isUnlocked: session => this.pendingUnlock.has(session),
      onGuarded: (session, callId, target) => {
        let calls = this.guarded.get(session)
        if (calls === undefined) {
          calls = new Map()
          this.guarded.set(session, calls)
        }
        calls.set(callId, target)
      },
    }))

    // Approval outcome of a fenced call: the audit pair says whether the user
    // granted it; a dispatched non-error result is the same news by another
    // route (a denied call never reaches the body). A granted ask unlocks the
    // gate in memory immediately — the durable state commit happens at the
    // next accepted pre-step, the one boundary where appending is safe.
    ctx.on('session/event', (session, event) => {
      if (event.type === 'approval/asked') {
        const callId = event.data.callId
        if (callId === undefined) return
        if (this.guarded.get(session)?.has(callId) !== true) return
        this.askedApprovals.set(event.data.id, session)
        return
      }
      if (event.type !== 'approval/decided') return
      const origin = this.askedApprovals.get(event.data.id)
      if (origin === undefined) return
      this.askedApprovals.delete(event.data.id)
      if (event.data.outcome !== 'allowed-once') return
      this.guarded.delete(origin)
      this.pendingUnlock.add(origin)
    })

    ctx.on('tools/result', (exec, result) => {
      const session = exec.agent?.session
      if (session === undefined) return
      if (exec.name === EXIT_PLAN_MODE_TOOL) {
        if (!result.isError) this.pendingUnlock.add(session)
        return
      }
      const calls = this.guarded.get(session)
      if (calls?.has(exec.callId) !== true) return
      if (result.isError) return
      calls.delete(exec.callId)
      this.pendingUnlock.add(session)
    })

    ctx.on('agent/pre-step', async ({ agent, turn, messages, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      signal.throwIfAborted()
      return this.applyStep(agent.session, turn, messages, decision)
    })
  }

  /**
   * Folded gate state of one session (the configured default policy before any
   * flag or state event).
   * @param session - the session to read.
   * @returns its current gate state.
   */
  stateOf(session: Session): ReviewGateState {
    return this.ctx.sessionProjections.stateOf(session, 'reviewGate')
      ?? initialGateState(this.config.defaultPolicy)
  }

  /**
   * Open one session's gate as if the user had approved it. The in-memory
   * unlock takes effect for the very next fenced call and is committed to the
   * session log at the next accepted step.
   * @param session - the session whose task was approved.
   */
  approve(session: Session): void {
    this.guarded.delete(session)
    this.pendingUnlock.add(session)
  }

  /**
   * Apply one accepted step: strip the flag suffix, commit flag/approval state
   * changes, tighten or restore the sandbox, and narrate the gate.
   * @param session - the stepping agent's session.
   * @param turn - the turn the step belongs to.
   * @param claimed - the step's claimed messages (the user-input boundary).
   * @param decision - the admit decision returned by the downstream chain.
   * @returns the decision to hand the loop, with the strip and notices applied.
   */
  private applyStep(
    session: Session,
    turn: number,
    claimed: readonly UserMessage[],
    decision: EnterDecision,
  ): PreStepDecision {
    let messages = decision.messages
    const notices: UserMessage[] = []

    const target = findFlagTarget(claimed)
    if (target !== undefined) {
      const flags = parseInputFlags(target.text)
      if (flags.review !== undefined || flags.workers !== undefined) {
        messages = stripFlags(messages, target, flags.text)
        const next = applyFlagsToState(this.stateOf(session), flags, turn)
        if (this.appendState(session, next)) {
          if (isGateClosed(next)) this.tightenSandbox(session)
          else this.restoreSandbox(session)
          if (flags.review === true) this.markTaskAwaitingApproval(session)
        }
        notices.push(flagNotice(flags, next, this.config))
        this.pendingUnlock.delete(session)
        this.guarded.delete(session)
      }
    }

    const state = this.stateOf(session)
    if (this.pendingUnlock.has(session)) {
      if (isGateClosed(state)) {
        if (this.appendState(session, { ...state, awaitingApproval: false })) {
          this.pendingUnlock.delete(session)
          this.restoreSandbox(session)
          this.guarded.delete(session)
          notices.push(notice(
            `review-gate: the user approved the plan — the gate is open for task "${state.taskId}". Protected-source writes now pass without asking; implement the approved plan.`,
            'review gate open',
          ))
        }
      } else {
        // Nothing left to open (the task was cancelled or already opened): the
        // unlock signal has done its job and must not leak into a later task.
        this.pendingUnlock.delete(session)
      }
    }

    const held = this.guarded.get(session)
    if (held !== undefined && held.size > 0) {
      const targets = [...new Set(held.values())]
      held.clear()
      notices.push(notice(
        `review-gate: the user did not approve the pending write(s) to ${targets.join(', ')}; the gate stays closed for task "${this.stateOf(session).taskId}". Revise the plan (writes under "${this.config.scratchDir}/" stay allowed) and present it again.`,
        'review gate held closed',
      ))
    }

    if (notices.length === 0) return messages === decision.messages ? decision : { ...decision, messages }
    return { ...decision, messages: [...messages, ...notices] }
  }

  /**
   * Hand the armed task off to the task board: `--review`/`--plan` means the
   * requirement is waiting for the human's approval (§5.3/§5.2). The board is
   * optional and is reached structurally, so the gate stays independent of it.
   */
  private markTaskAwaitingApproval(session: Session): void {
    const board = this.ctx.get('taskBoard') as { markAwaitingApproval?: (session: Session) => unknown } | undefined
    try {
      board?.markAwaitingApproval?.(session)
    } catch (error: unknown) {
      this.ctx.logger.warn('dsh-review-gate: could not mark the board task awaiting approval: %o', error)
    }
  }

  /** Append one gate state, keeping the plan-less deployment loadable on failure. */
  private appendState(session: Session, state: ReviewGateState): boolean {
    try {
      session.append('review-gate/state', state)
      return true
    } catch (error: unknown) {
      this.ctx.logger.warn('dsh-review-gate: failed to append gate state: %o', error)
      return false
    }
  }

  /**
   * Put the session under the configured draft sandbox while the fence is
   * closed. Never loosens: a session already at or below the draft mode keeps
   * its own policy, and the prior override is remembered for the restore.
   */
  private tightenSandbox(session: Session): void {
    const draft = this.config.draftSandboxMode
    const policy = this.sandboxPolicy
    if (draft === '' || policy === undefined || this.sandboxPrior.has(session)) return
    const current = policy.overrideOf(session) ?? policy.defaultMode
    if (SANDBOX_RESTRICTIVENESS[draft] >= SANDBOX_RESTRICTIVENESS[current]) return
    this.sandboxPrior.set(session, policy.overrideOf(session) ?? null)
    setSandboxMode(session, draft)
  }

  /** Restore the sandbox override the fence tightened, if it tightened one. */
  private restoreSandbox(session: Session): void {
    if (!this.sandboxPrior.has(session)) return
    const prior = this.sandboxPrior.get(session) ?? null
    this.sandboxPrior.delete(session)
    const policy = this.sandboxPolicy
    if (policy === undefined) return
    setSandboxMode(session, prior ?? policy.defaultMode)
  }
}

export default ReviewGateController

/**
 * `ctx.orchestrator`: the review loop's effects, and the fan-out gates' view of
 * the world.
 *
 * Responsibilities:
 * - **Fan-out accounting** — the delegation depth and the spent budget the
 *   `subtask_parallel` gates read, keyed by the ROOT session of the calling
 *   lineage so one flow shares one blast-radius budget.
 * - **Dispatch plumbing** — one `SubTaskDispatcher` (its own `WorkerRegistry`)
 *   per dispatching agent, unwound when that agent is disposed or the plugin
 *   unloads.
 * - **Review loops** — starting one (spawn the review-work subagent, create and
 *   arm the goal on ITS session, register the loop), running rounds through
 *   clean reviewers, and the two exits: zero-P0 → `review_finish` →
 *   `review_complete` (goal complete + report to the lead), and human decision
 *   → `review_block` → wait → `review_resume`.
 *
 * Only `subtask_parallel` dispatches are charged to `fanOut.maxTotalAgents`.
 * A loop's reviewers are bounded by `reviewersPerRound × maxGoalRounds`
 * instead — two different budgets for two different mechanisms, as §5.5 and
 * §5.7 describe them.
 *
 * @module @dsh-plugin/dsh-orchestrator/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GoalBlockReason, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { interruptWorker, startWorker, sendWorkerMessage } from '@dsh-plugin/dsh-worker-spawn'
import { renderCompletionReport, renderLoopMethodology, renderReviewerBrief } from './briefs.ts'
import type { ResolvedOrchestratorConfig } from './config.ts'
import type { DispatcherOptions, SubTaskDispatcher, SubTaskOutcome } from './dispatch.ts'
import { createDispatcher } from './dispatch.ts'
import { planFanOut } from './fanout.ts'
import type { FanOutPlan, FanOutRequest, SubTaskRole, SubTaskTier } from './fanout.ts'
import type { ReviewTally } from './findings.ts'
import { ReviewLoop } from './loop.ts'
import type { FilteredFinding, LoopSnapshot, RejectionRequest } from './loop.ts'
import type { RoundResult, SubTaskResult } from './types.ts'

/** How many ancestors the root walk may climb before it gives up on a cycle. */
const ROOT_WALK_LIMIT = 32

/** One loop as the service reports it. */
export interface LoopSummary {
  readonly loopId: string
  readonly carrierId: SessionId
  readonly leadId: SessionId
  readonly objective: string
  readonly status: LoopSnapshot['status']
  readonly round: number
  readonly P0: number
  readonly findings: number
  readonly filtered: number
  readonly zeroP0: boolean
}

/** The plugin's whole observable value. */
export interface OrchestratorStatus {
  readonly reviewerTools: readonly string[]
  readonly reviewersPerRound: number
  readonly zeroP0Approach: string
  readonly dispatchers: number
  readonly loops: readonly LoopSummary[]
}

/** What `review_loop` reports back to the delegating agent. */
export interface LoopStartResult {
  readonly loop: LoopSnapshot
  readonly reviewersPerRound: number
}

/** What a loop exit reports. */
export interface LoopExitResult {
  readonly loop: LoopSnapshot
  /** The goal's id and phase as the goal service recorded them. */
  readonly goal: { readonly id: string; readonly phase: string }
  /** Whether the completion report reached the delegating session. */
  readonly reported: boolean
}

/** How the runtime builds one agent's sub-task dispatcher (a test seam). */
export type DispatcherFactory = (
  ctx: Context,
  carrier: Agent,
  options: DispatcherOptions,
) => SubTaskDispatcher

/** The review-loop and fan-out effects of this plugin. */
export class OrchestratorRuntime {
  private readonly loops = new Map<SessionId, ReviewLoop>()
  private readonly dispatchers = new Map<SessionId, SubTaskDispatcher>()
  private readonly budgets = new Map<string, number>()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedOrchestratorConfig,
    private readonly createDispatch: DispatcherFactory = createDispatcher,
  ) {
    // A dispatching agent's registry unwinds with the agent, not only with the
    // plugin fiber: a spawned worker's completion must never steer a dead one.
    ctx.on('agent/disposed', ({ agent }) => {
      this.disposeDispatcher(agent.id)
    })
  }

  /** The dispatcher that owns one agent's sub-tasks, created on first use. */
  private dispatcherFor(agent: Agent): SubTaskDispatcher {
    const existing = this.dispatchers.get(agent.id)
    if (existing !== undefined) return existing
    const created = this.createDispatch(this.ctx, agent, {
      workerSpawn: this.config.workerSpawn,
      workerTimeoutMs: this.config.workerTimeoutMs,
      reviewTimeoutMs: this.config.reviewTimeoutMs,
      reviewerTools: this.config.reviewerTools,
      warn: (message, ...args) => { this.ctx.logger.warn(message, ...args) },
    })
    this.dispatchers.set(agent.id, created)
    return created
  }

  private disposeDispatcher(id: SessionId): void {
    const existing = this.dispatchers.get(id)
    if (existing === undefined) return
    this.dispatchers.delete(id)
    existing.dispose()
  }

  /**
   * The root of one agent's delegation tree (the flow that shares a budget).
   * Walk the durable parent chain while the ancestors are live; a missing
   * ancestor is the durable root (a resumed session whose parent is gone).
   */
  private rootKey(agent: Agent): SessionId {
    let current = agent
    for (let hops = 0; hops < ROOT_WALK_LIMIT; hops += 1) {
      const parentId = current.session.header.parentSession
      if (parentId === undefined) return current.id
      const parent = this.ctx.agents.get(parentId)
      if (parent === undefined) return parentId
      current = parent
    }
    return current.id
  }

  /** Sub-agents already dispatched by the calling agent's flow. */
  private spent(agent: Agent): number {
    return this.budgets.get(this.rootKey(agent)) ?? 0
  }

  /** Charge dispatched sub-agents to the calling agent's flow budget. */
  private account(agent: Agent, count: number): void {
    const key = this.rootKey(agent)
    this.budgets.set(key, (this.budgets.get(key) ?? 0) + count)
  }

  /**
   * Apply the three fan-out gates for one caller.
   * @param agent - the calling agent.
   * @param request - the requested sub-tasks and optional per-call bounds.
   */
  previewFanOut(agent: Agent, request: FanOutRequest): FanOutPlan {
    return planFanOut(
      { bounds: this.config.fanOut, depth: delegationDepthOf(agent), spent: this.spent(agent) },
      request,
    )
  }

  /**
   * Dispatch one fan-out plan's sub-tasks concurrently, in request order, with
   * failure isolation: one child that fails, times out, or is aborted resolves
   * as that task's outcome and never rejects the call.
   */
  async runSubtasks(
    agent: Agent,
    tasks: Extract<FanOutPlan, { kind: 'fan-out' }>['tasks'],
    signal: AbortSignal,
  ): Promise<SubTaskResult[]> {
    const dispatcher = this.dispatcherFor(agent)
    this.account(agent, tasks.length)
    return await Promise.all(tasks.map(async (task, taskIndex): Promise<SubTaskResult> => {
      const value = await dispatchOne(dispatcher, task.role, task.tier, task.brief, `subtask-${taskIndex + 1}`, signal)
      return { taskIndex, value }
    }))
  }

  /** The live carrier agent of one loop, or a loud failure. */
  private requireCarrier(loop: ReviewLoop): Agent {
    const carrier = this.ctx.agents.get(loop.carrierId)
    if (carrier === undefined) {
      throw new Error(`review loop ${loop.id}: its review-work subagent "${loop.carrierId}" is no longer live`)
    }
    return carrier
  }

  /** The loop one agent carries (`review_*` tools are carrier-scoped by authority). */
  requireLoop(agent: Agent): ReviewLoop {
    const loop = this.loops.get(agent.id)
    if (loop === undefined) {
      throw new Error(
        `agent "${agent.id}" is not carrying a review loop: only the review-work subagent a review_loop spawned may drive one`,
      )
    }
    return loop
  }

  /** The carrier's current goal ref (the CAS identity every mutation needs). */
  private goalRef(carrier: Agent): GoalRef {
    const view = this.ctx.goals.get(carrier)
    if (view === undefined) {
      throw new Error(`carrier "${carrier.id}" has no current goal`)
    }
    return { id: view.id, revision: view.revision }
  }

  /**
   * Start one review loop: spawn the disposable review-work subagent that
   * carries the goal, create and arm the goal ON ITS OWN session, and register
   * the loop. The carrier is a durable continuable child of the caller, so the
   * caller can relay a human answer to it (`subagents.sendMessage`).
   * @param agent - the delegating agent (the loop's "lead").
   * @param request - the objective, plus the plan/code references to hand every round.
   * @param signal - caller cancellation, owning the spawn only until inbox acceptance.
   */
  async startLoop(
    agent: Agent,
    request: { readonly objective: string; readonly plan?: string; readonly files?: readonly string[] },
    signal: AbortSignal,
  ): Promise<LoopStartResult> {
    const objective = request.objective.trim()
    if (objective === '') {
      throw new Error('review_loop needs a non-empty objective')
    }
    const files = [...(request.files ?? [])]
    const prompt = renderLoopMethodology({
      objective,
      ...request.plan === undefined ? {} : { plan: request.plan },
      files,
      reviewersPerRound: this.config.reviewersPerRound,
      maxGoalRounds: this.config.maxGoalRounds,
      zeroP0Approach: this.config.zeroP0Approach,
    })
    const started = await startWorker(this.ctx, {
      parent: agent,
      tier: 'good',
      prompt,
      label: `review loop: ${objective.slice(0, 80)}`,
      tiers: this.config.workerSpawn.tiers,
      provider: this.config.workerSpawn.provider,
      signal,
    })
    const carrier = this.ctx.agents.get(started.childId)
    if (carrier === undefined) {
      throw new Error(`review-work subagent "${started.childId}" did not materialize as a live agent`)
    }
    let goal: GoalView
    try {
      goal = this.ctx.goals.create(carrier, { objective, maxGoalRounds: this.config.maxGoalRounds })
    } catch (error: unknown) {
      // The carrier exists but its goal could not be established: park it so
      // nothing keeps working toward an objective nobody tracks.
      try {
        interruptWorker(this.ctx, agent, started.childId)
      } catch (interruptError: unknown) {
        this.ctx.logger.warn('dsh-orchestrator: could not park carrier %s: %s', started.childId, describe(interruptError))
      }
      throw new Error(`could not create the review goal on "${started.childId}": ${describe(error)}`)
    }
    const loop = new ReviewLoop({
      loopId: `loop-${started.childId}`,
      carrierId: started.childId,
      leadId: agent.id,
      objective,
      goalId: goal.id,
    })
    this.loops.set(started.childId, loop)
    this.ctx.logger.info('dsh-orchestrator: review loop %s started on carrier %s', loop.id, started.childId)
    return { loop: loop.snapshot(), reviewersPerRound: this.config.reviewersPerRound }
  }

  /**
   * The reviewer count for one round.
   *
   * Precedence: an explicit tool argument (bounded by `reviewersPerRound`, so a
   * model cannot inflate its own round) → the human's `--workers N` from the
   * review gate's per-session state (§5.3: the flag IS the round's reviewer
   * count, and a human instruction outranks the deployment default) → the
   * configured `reviewersPerRound`.
   */
  private reviewerCount(carrier: Agent, requested: number | undefined): number {
    if (requested !== undefined) {
      if (!Number.isSafeInteger(requested) || requested < 1) {
        throw new Error(`review_round reviewers must be a positive whole number, got ${String(requested)}`)
      }
      return Math.min(requested, this.config.reviewersPerRound)
    }
    const gate = this.ctx.get('reviewGate') as
      | { stateOf?: (session: unknown) => { reviewers?: number } | undefined }
      | undefined
    const flagged = gate?.stateOf?.(carrier.session)?.reviewers
    if (flagged !== undefined && Number.isSafeInteger(flagged) && flagged > 0) return flagged
    return this.config.reviewersPerRound
  }

  /**
   * Run one review round: dispatch fresh one-shot clean reviewers with only the
   * plan and the code references, parse their reports, and fold them into the
   * loop's cross-round union.
   * @param agent - the carrier agent (authority-checked).
   * @param request - the plan under review, code references, focus, and an
   *   optional reviewer count override.
   * @param signal - caller cancellation.
   */
  async round(
    agent: Agent,
    request: {
      readonly plan: string
      readonly files?: readonly string[]
      readonly focus?: string
      readonly reviewers?: number
    },
    signal: AbortSignal,
  ): Promise<RoundResult> {
    const loop = this.requireLoop(agent)
    const plan = request.plan.trim()
    if (plan === '') throw new Error('review_round needs the plan text under review')
    const reviewers = this.reviewerCount(agent, request.reviewers)
    const files = [...(request.files ?? [])]
    const round = loop.nextRound()
    const dispatcher = this.dispatcherFor(agent)
    const outcomes = await Promise.all(Array.from({ length: reviewers }, async (_unused, index): Promise<SubTaskResult> => {
      const brief = renderReviewerBrief({
        round,
        index: index + 1,
        total: reviewers,
        plan,
        files,
        ...request.focus === undefined ? {} : { focus: request.focus },
      })
      const value = await dispatchOne(dispatcher, 'reviewer', 'good', brief, `review-r${round}-${index + 1}`, signal)
      return { taskIndex: index, value }
    }))
    const record = loop.recordRound({ round, dispatched: reviewers, outcomes: outcomes.map(result => result.value) })
    return { record, loop: loop.snapshot(), results: outcomes }
  }

  /**
   * Remove findings from the accepted union — the false positives the lead
   * disproved and the ones the revised plan now answers (the lead's own
   * judgment, not a model's grade). Removed findings stop counting and are
   * retained with their reason.
   */
  filter(
    agent: Agent,
    reject: readonly RejectionRequest[],
  ): {
    readonly loop: LoopSnapshot
    readonly removed: readonly FilteredFinding[]
    readonly unmatched: readonly RejectionRequest[]
  } {
    const loop = this.requireLoop(agent)
    if (reject.length === 0) throw new Error('review_filter needs at least one finding to remove')
    const { removed, unmatched } = loop.filterFindings(reject)
    return { loop: loop.snapshot(), removed, unmatched }
  }

  /**
   * Close the review phase on the numeric zero-P0 verdict (exit A's gate).
   * The goal stays open: the approved plan still has to be implemented.
   * @throws while any P0 remains, while a reviewer failure leaves the round
   *   uncertified, or before any reviewer has reported.
   */
  finish(agent: Agent): { readonly loop: LoopSnapshot; readonly verdict: ReviewTally } {
    const loop = this.requireLoop(agent)
    const verdict = loop.clear()
    return { loop: loop.snapshot(), verdict }
  }

  /**
   * Close the loop and its goal (exit A's completion) and relay the audit
   * report to the delegating session.
   * @param summary - optional one-line outcome for the report.
   */
  async complete(agent: Agent, summary?: string, signal?: AbortSignal): Promise<LoopExitResult> {
    const loop = this.requireLoop(agent)
    const carrier = this.requireCarrier(loop)
    const verdict = loop.assertCompletable()
    const goal = this.ctx.goals.complete(carrier, this.goalRef(carrier))
    loop.markComplete()
    const reported = await this.report(loop, carrier, verdict, summary, signal ?? new AbortController().signal)
    return { loop: loop.snapshot(), goal: { id: goal.id, phase: goal.phase }, reported }
  }

  /** Relay the completion report to the loop's lead (never fatal to completion). */
  private async report(
    loop: ReviewLoop,
    carrier: Agent,
    verdict: ReviewTally,
    summary: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    const snapshot = loop.snapshot()
    const text = renderCompletionReport({
      objective: loop.objective,
      rounds: verdict.rounds,
      reviewers: verdict.reviewers,
      failures: verdict.failures,
      counts: verdict.counts,
      filtered: snapshot.filtered.length,
      ...summary === undefined ? {} : { summary },
      carrierId: String(loop.carrierId),
    })
    try {
      await sendWorkerMessage(this.ctx, carrier, loop.leadId, [{ type: 'text', text }], signal)
      return true
    } catch (error: unknown) {
      this.ctx.logger.warn('dsh-orchestrator: could not report loop %s to %s: %s', loop.id, loop.leadId, describe(error))
      return false
    }
  }

  /** Enter the human-decision wait (exit B). The carrier's parent relays the answer. */
  block(agent: Agent, reason: GoalBlockReason): LoopExitResult {
    const loop = this.requireLoop(agent)
    const carrier = this.requireCarrier(loop)
    loop.assertBlockable()
    const goal = this.ctx.goals.block(carrier, this.goalRef(carrier), reason)
    loop.markBlocked({ code: reason.code, message: reason.message })
    return { loop: loop.snapshot(), goal: { id: goal.id, phase: goal.phase }, reported: false }
  }

  /** Resume a blocked loop once the human answer arrived. */
  resume(agent: Agent): LoopExitResult {
    const loop = this.requireLoop(agent)
    const carrier = this.requireCarrier(loop)
    loop.assertResumable()
    const goal = this.ctx.goals.resume(carrier, this.goalRef(carrier))
    loop.markResumed()
    return { loop: loop.snapshot(), goal: { id: goal.id, phase: goal.phase }, reported: false }
  }

  /** The loops this plugin knows about too (currently live only). */
  loopSnapshot(carrierId: SessionId): LoopSnapshot | undefined {
    return this.loops.get(carrierId)?.snapshot()
  }

  /** How many review loops are registered. */
  get loopCount(): number {
    return this.loops.size
  }

  /** Every registered loop summary (the plugin's observable state). */
  status(): OrchestratorStatus {
    return {
      reviewerTools: [...this.config.reviewerTools],
      reviewersPerRound: this.config.reviewersPerRound,
      zeroP0Approach: this.config.zeroP0Approach,
      dispatchers: this.dispatchers.size,
      loops: [...this.loops.values()].map(loop => {
        const snapshot = loop.snapshot()
        return {
          loopId: snapshot.loopId,
          carrierId: snapshot.carrierId,
          leadId: snapshot.leadId,
          objective: snapshot.objective,
          status: snapshot.status,
          round: snapshot.round,
          P0: snapshot.tally.counts.P0,
          findings: snapshot.tally.findings,
          filtered: snapshot.filtered.length,
          zeroP0: snapshot.tally.zeroP0,
        }
      }),
    }
  }

  /** Unwind every dispatcher (the plugin fiber is unloading). */
  dispose(): void {
    const dispatchers = [...this.dispatchers.values()]
    this.dispatchers.clear()
    for (const dispatcher of dispatchers) dispatcher.dispose()
    this.loops.clear()
    this.budgets.clear()
  }
}

/**
 * Dispatch one sub-task, containing a throwing dispatcher into that task's
 * outcome so one broken child cannot reject a whole fan-out.
 */
async function dispatchOne(
  dispatcher: SubTaskDispatcher,
  role: SubTaskRole,
  tier: SubTaskTier,
  brief: string,
  label: string,
  signal: AbortSignal,
): Promise<SubTaskOutcome> {
  try {
    return await dispatcher.dispatch({ role, tier, brief, label }, signal)
  } catch (error: unknown) {
    return { role, status: signal.aborted ? 'aborted' : 'error', error: describe(error) }
  }
}

/** Render one thrown value for a result or a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

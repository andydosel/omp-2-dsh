/**
 * The orchestrator runtime: the review loop's effects, and the fan-out gates'
 * view of the world.
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
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { GoalBlockReason, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { interruptWorker, startWorker, sendWorkerMessage, WORKER_INHERITED_TOOLS } from '@dsh-plugin/dsh-worker-spawn'
import { describeError } from '@dsh-plugin/dsh-util/error'
import { renderBlockNotice, renderCompletionReport, renderLoopMethodology, renderReviewerBrief } from './briefs.ts'
import type { ResolvedOrchestratorConfig } from './config.ts'
import type { DispatcherOptions, SubTaskDispatcher, SubTaskOutcome } from './dispatch.ts'
import { createDispatcher } from './dispatch.ts'
import { planFanOut } from './fanout.ts'
import type { FanOutBounds, FanOutPlan, FanOutRequest, SubTaskRole, SubTaskTier } from './fanout.ts'
import type { ReviewTally } from './findings.ts'
import { ReviewLoop } from './loop.ts'
import type { FilteredFinding, LoopSnapshot, RejectionRequest } from './loop.ts'
import type { RoundResult, SubTaskResult } from './types.ts'

/** How many ancestors the root walk may climb before it gives up on a cycle. */
const ROOT_WALK_LIMIT = 32

/**
 * The review-work carrier's OWN tools. A carrier is started through the shared
 * worker base (so it keeps the implementation tools plus `subtask_parallel`),
 * and these review-loop controls sit outside the worker allow-list — without
 * them a restricted carrier could not run a round, filter, or close the loop.
 */
export const REVIEW_CARRIER_TOOLS: readonly string[] = [
  'review_round',
  'review_filter',
  'review_finish',
  'review_complete',
  'review_block',
  'review_resume',
]

/** The task-board row fields this plugin reads and writes (structural, no import). */
interface BoardTask {
  readonly id: string
  readonly revision: number
  readonly status: string
}

/** The subset of `ctx.taskBoard` the review loop mirrors its state onto. */
interface TaskBoardSyncProbe {
  list(session: Session): readonly BoardTask[]
  create(session: Session, input: { subject: string; owner?: SessionId | string }): BoardTask
  update(
    session: Session,
    id: string,
    patch: {
      status?: string
      reviewRound?: number
      findings?: readonly { severity: string; summary: string; sourceRound: number }[]
      filteredFindings?: readonly { severity: string; summary: string; sourceRound: number }[]
    },
    revision?: number,
  ): BoardTask
}

/** Task states that are already out of the work set. */
const TERMINAL_TASK_STATUS: Readonly<Record<string, true>> = { completed: true, closed: true, deleted: true }

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

/** One flow's spend and the tighter per-call bounds a parent fan-out propagated. */
interface FlowBudget {
  spent: number
  /** The effective depth cap a parent call established (already min'ed with config). */
  maxDepth?: number
  /** The effective total-agent budget a parent call established. */
  maxTotalAgents?: number
}

/** The review-loop and fan-out effects of this plugin. */
export class OrchestratorRuntime {
  private readonly loops = new Map<SessionId, ReviewLoop>()
  private readonly dispatchers = new Map<SessionId, SubTaskDispatcher>()
  private readonly budgets = new Map<string, FlowBudget>()
  /** The task-board row each loop currently mirrors onto (created on demand). */
  private readonly boardTasks = new Map<string, string>()

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

  /** The flow state one agent belongs to (created on demand). */
  private flow(agent: Agent): FlowBudget {
    const key = this.rootKey(agent)
    const existing = this.budgets.get(key)
    if (existing !== undefined) return existing
    const created: FlowBudget = { spent: 0 }
    this.budgets.set(key, created)
    return created
  }

  /**
   * The gate bounds for one flow: the deployment config, tightened by whatever
   * bounds an ANCESTOR fan-out call propagated. A child therefore sees the
   * caller's `maxDepth`/`maxTotalAgents` for its own recursive
   * `subtask_parallel`, not just the deployment ceiling.
   */
  private flowBounds(agent: Agent): FanOutBounds {
    const flow = this.flow(agent)
    return {
      ...this.config.fanOut,
      ...flow.maxDepth === undefined ? {} : { maxDepth: flow.maxDepth },
      ...flow.maxTotalAgents === undefined ? {} : { maxTotalAgents: flow.maxTotalAgents },
    }
  }

  /**
   * Apply the three fan-out gates for one caller.
   * @param agent - the calling agent.
   * @param request - the requested sub-tasks and optional per-call bounds.
   */
  previewFanOut(agent: Agent, request: FanOutRequest): FanOutPlan {
    return planFanOut(
      { bounds: this.flowBounds(agent), depth: delegationDepthOf(agent), spent: this.flow(agent).spent },
      request,
    )
  }

  /**
   * Charge one dispatched plan to the calling flow and PROPAGATE its effective
   * bounds so the children's own fan-outs are gated by the tighter call bounds
   * (design §5.5 recursive fan-out).
   */
  private accountPlan(agent: Agent, plan: Extract<FanOutPlan, { kind: 'fan-out' }>): void {
    const flow = this.flow(agent)
    flow.spent += plan.tasks.length
    flow.maxDepth = flow.maxDepth === undefined ? plan.maxDepth : Math.min(flow.maxDepth, plan.maxDepth)
    flow.maxTotalAgents = flow.maxTotalAgents === undefined
      ? plan.maxTotalAgents
      : Math.min(flow.maxTotalAgents, plan.maxTotalAgents)
  }

  /**
   * Dispatch one fan-out plan's sub-tasks concurrently, in request order, with
   * failure isolation: one child that fails, times out, or is aborted resolves
   * as that task's outcome and never rejects the call.
   */
  async runSubtasks(
    agent: Agent,
    plan: Extract<FanOutPlan, { kind: 'fan-out' }>,
    signal: AbortSignal,
  ): Promise<SubTaskResult[]> {
    const dispatcher = this.dispatcherFor(agent)
    this.accountPlan(agent, plan)
    return await Promise.all(plan.tasks.map(async (task, taskIndex): Promise<SubTaskResult> => {
      const value = await dispatchOne(
        dispatcher,
        task.role,
        task.tier,
        task.brief,
        `subtask-${taskIndex + 1}`,
        signal,
        task.toolFilter,
      )
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

  /**
   * Resolve one agent's loop for the FILTER path: the carrier may act, and so
   * may the delegating lead (§5.7 puts false-positive filtering on the lead).
   * A lead driving several loops must name one; an unrelated agent is refused.
   */
  private loopForFilter(agent: Agent, loopId: string | undefined): ReviewLoop {
    if (loopId !== undefined) {
      const loop = [...this.loops.values()].find(candidate => candidate.id === loopId)
      if (loop !== undefined && (String(loop.carrierId) === String(agent.id) || String(loop.leadId) === String(agent.id))) {
        return loop
      }
      throw new Error(`review loop ${loopId} does not belong to agent "${agent.id}"`)
    }
    const carried = this.loops.get(agent.id)
    if (carried !== undefined) return carried
    const led = [...this.loops.values()].filter(loop => String(loop.leadId) === String(agent.id))
    if (led.length === 1) return led[0]!
    if (led.length > 1) {
      throw new Error(`agent "${agent.id}" leads ${led.length} review loops: pass loopId to filter a specific one`)
    }
    throw new Error(
      `agent "${agent.id}" is not carrying or leading a review loop: only the review-work subagent or its delegating session may filter`,
    )
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
      toolFilter: [...WORKER_INHERITED_TOOLS, ...REVIEW_CARRIER_TOOLS],
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
        this.ctx.logger.warn('dsh-orchestrator: could not park carrier %s: %s', started.childId, describeError(interruptError))
      }
      throw new Error(`could not create the review goal on "${started.childId}": ${describeError(error)}`)
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
  private reviewerCount(loop: ReviewLoop, requested: number | undefined): number {
    if (requested !== undefined) {
      if (!Number.isSafeInteger(requested) || requested < 1) {
        throw new Error(`review_round reviewers must be a positive whole number, got ${String(requested)}`)
      }
      return Math.min(requested, this.config.reviewersPerRound)
    }
    const gate = this.ctx.get('reviewGate') as
      | { stateOf?: (session: unknown) => { reviewers?: number } | undefined }
      | undefined
    // `--workers N` is recorded on the session that SENT the user input (the
    // delegating lead), not on the disposable carrier the loop spawned.
    const flagged = gate?.stateOf?.(this.ctx.agents.get(loop.leadId)?.session)?.reviewers
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
    const reviewers = this.reviewerCount(loop, request.reviewers)
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
    this.syncTaskBoard(loop)
    return { record, loop: loop.snapshot(), results: outcomes }
  }

  /**
   * Mirror the loop's review state onto the delegating session's task board:
   * each round's `reviewRound` and cross-round findings union, the filtered
   * false positives, and (when requested) a status. The board is optional and
   * reached structurally; a board failure must never break the review.
   */
  private syncTaskBoard(loop: ReviewLoop, status?: 'awaiting_approval' | 'completed'): void {
    const lead = this.ctx.agents.get(loop.leadId)
    const board = this.ctx.get('taskBoard') as Partial<TaskBoardSyncProbe> | undefined
    if (lead === undefined || board?.list === undefined || board.update === undefined) return
    try {
      const rows = board.list(lead.session)
      // The loop's board row is created on demand: a requirement-level task
      // must exist for the cross-round union to accumulate on, and a cached
      // id is reused until the lead closes it.
      const cachedId = this.boardTasks.get(loop.id)
      let task = cachedId === undefined ? undefined : rows.find(row => row.id === cachedId && TERMINAL_TASK_STATUS[row.status] !== true)
      task ??= [...rows].reverse().find(row => TERMINAL_TASK_STATUS[row.status] !== true)
      if (task === undefined) {
        if (board.create === undefined) return
        task = board.create(lead.session, { subject: loop.objective, owner: loop.leadId })
      }
      this.boardTasks.set(loop.id, task.id)
      const snapshot = loop.snapshot()
      const findings = snapshot.findings.map(row => ({ severity: row.severity, summary: row.summary, sourceRound: row.sourceRound }))
      const filtered = snapshot.filtered.map(row => ({ severity: row.severity, summary: row.summary, sourceRound: row.sourceRound }))
      board.update(lead.session, task.id, {
        reviewRound: snapshot.round,
        findings,
        filteredFindings: filtered,
        ...status === undefined ? {} : { status },
      }, task.revision)
    } catch (error: unknown) {
      this.ctx.logger.warn('dsh-orchestrator: could not write loop %s to the task board: %s', loop.id, describeError(error))
    }
  }

  /**
   * Remove findings from the accepted union — the false positives the lead
   * disproved and the ones the revised plan now answers (the lead's own
   * judgment, not a model's grade). Removed findings stop counting and are
   * retained with their reason. Callable by the carrier AND by the delegating
   * lead (§5.7), so the business filter is not stuck in the review child.
   */
  filter(
    agent: Agent,
    reject: readonly RejectionRequest[],
    loopId?: string,
  ): {
    readonly loop: LoopSnapshot
    readonly removed: readonly FilteredFinding[]
    readonly unmatched: readonly RejectionRequest[]
  } {
    const loop = this.loopForFilter(agent, loopId)
    if (reject.length === 0) throw new Error('review_filter needs at least one finding to remove')
    const { removed, unmatched } = loop.filterFindings(reject)
    this.syncTaskBoard(loop)
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
    this.syncTaskBoard(loop)
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
    this.syncTaskBoard(loop, 'completed')
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
      this.ctx.logger.warn('dsh-orchestrator: could not report loop %s to %s: %s', loop.id, loop.leadId, describeError(error))
      return false
    }
  }

  /**
   * Enter the human-decision wait (exit B) and relay the reason to the
   * delegating session (the carrier's parent), which asks the human and sends
   * the answer back. The relay is never fatal to the block itself.
   */
  async block(agent: Agent, reason: GoalBlockReason, signal?: AbortSignal): Promise<LoopExitResult> {
    const loop = this.requireLoop(agent)
    const carrier = this.requireCarrier(loop)
    loop.assertBlockable()
    const goal = this.ctx.goals.block(carrier, this.goalRef(carrier), reason)
    loop.markBlocked({ code: reason.code, message: reason.message })
    this.syncTaskBoard(loop, 'awaiting_approval')
    let reported = false
    try {
      await sendWorkerMessage(
        this.ctx,
        carrier,
        loop.leadId,
        [{ type: 'text', text: renderBlockNotice({ loopId: loop.id, objective: loop.objective, reason, carrierId: String(loop.carrierId) }) }],
        signal ?? new AbortController().signal,
      )
      reported = true
    } catch (error: unknown) {
      this.ctx.logger.warn('dsh-orchestrator: could not relay the block of loop %s to %s: %s', loop.id, loop.leadId, describeError(error))
    }
    return { loop: loop.snapshot(), goal: { id: goal.id, phase: goal.phase }, reported }
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
    this.boardTasks.clear()
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
  toolFilter?: readonly string[],
): Promise<SubTaskOutcome> {
  try {
    return await dispatcher.dispatch({ role, tier, brief, label, ...toolFilter === undefined ? {} : { toolFilter } }, signal)
  } catch (error: unknown) {
    return { role, status: signal.aborted ? 'aborted' : 'error', error: describeError(error) }
  }
}


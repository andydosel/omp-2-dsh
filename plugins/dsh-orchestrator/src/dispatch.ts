/**
 * The orchestrator's real sub-task dispatcher: how one `subtask_parallel` task
 * or one review-round reviewer becomes a live child agent, how its turn is
 * awaited turn-precisely, and how its output (and, for a reviewer, its parsed
 * findings) comes back.
 *
 * Two roles share one base on purpose (§5.5 归一: "统一到一个 spawn 基底,避免两套
 * worker 注册表"):
 *
 * - `worker` — a durable continuable child established by the shared
 *   `@dsh-plugin/dsh-worker-spawn` `startWorker` (spawn-in-process provider,
 *   `fast`/`good` tier routing). It keeps its conversation across turns; a
 *   `subtask_parallel` task reads only its first turn.
 * - `reviewer` — a ONE-SHOT clean reviewer: a fresh agent on its own session id,
 *   composed by the advisor's shared `composeReviewer` recipe (preset join,
 *   read-only tool allow-list, scoped `advise`, pinned delegated policy) plus
 *   this plugin's reviewer role section. It is disposed once its single turn
 *   settles, so the next round's reviewers cannot inherit its context.
 *
 * Turn precision comes from the shared `WorkerRegistry`: a continuable child
 * produces no jobs, `agent/status` idle is not a turn-end signal, and
 * `subagent/end` is epoch-granular — the child session's own `turn/end` is the
 * only precise signal, and a wait registered after the fact still resolves from
 * the child's log.
 *
 * @module @dsh-plugin/dsh-orchestrator/dispatch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { childSessionEvents, startWorker, WORKER_INHERITED_TOOLS, WorkerRegistry } from '@dsh-plugin/dsh-worker-spawn'
import type { ResolvedWorkerSpawnConfig } from '@dsh-plugin/dsh-worker-spawn/types'
import { composeReviewer } from '@dsh-plugin/dsh-advisor/reviewer'
import { describeError } from '@dsh-plugin/dsh-util/error'
// Type-only: resolves `agentCtx.systemPrompt` for the reviewer's role section.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { renderReviewerRole } from './briefs.ts'
import { parseReviewerReport } from './findings.ts'
import type { RawFinding } from './findings.ts'
import type { SubTaskRole, SubTaskTier } from './fanout.ts'

/** One sub-task to dispatch, already normalized by the fan-out gates. */
export interface SubTaskRequest {
  readonly role: SubTaskRole
  readonly tier: SubTaskTier
  readonly brief: string
  /** Child label: the worker's creation label, or the reviewer's session/name suffix. */
  readonly label: string
  /** Optional per-brief worker tool filter (already normalized by the fan-out gates). */
  readonly toolFilter?: readonly string[]
}

/** How one dispatched sub-task settled, and what it produced. */
export interface SubTaskOutcome {
  readonly role: SubTaskRole
  readonly status: 'completed' | 'timeout' | 'aborted' | 'disposed' | 'error'
  /** The child's final assistant text, when it produced any. */
  readonly output?: string
  /**
   * The reviewer's parsed findings. ABSENT — never a silent empty array — when
   * the child produced no usable report, so a broken reviewer counts as a
   * failure instead of a clean round.
   */
  readonly findings?: readonly RawFinding[]
  /** Why the dispatch did not produce a usable result. */
  readonly error?: string
}

/** The seam the runtime depends on; tests inject a scripted implementation. */
export interface SubTaskDispatcher {
  /** Run one sub-task to its first turn's settlement. */
  dispatch(request: SubTaskRequest, signal: AbortSignal): Promise<SubTaskOutcome>
  /** Unwind this dispatcher's listeners and registry. */
  dispose(): void
}

/** Deployment values the dispatcher needs from the resolved config. */
export interface DispatcherOptions {
  /** The resolved worker-spawn base config (provider, tier routes, wake budget). */
  readonly workerSpawn: ResolvedWorkerSpawnConfig
  /** Per-worker turn-wait budget in milliseconds. */
  readonly workerTimeoutMs: number
  /** Per-reviewer wait budget in milliseconds. */
  readonly reviewTimeoutMs: number
  /** The read-only tool allow-list every clean reviewer is restricted to. */
  readonly reviewerTools: readonly string[]
  readonly warn: (message: string, ...args: unknown[]) => void
}

/** One carrier's dispatch surface: a registry plus the deployment's options. */
class CarrierDispatcher implements SubTaskDispatcher {
  private readonly registry: WorkerRegistry
  private reviewerSequence = 0

  constructor(
    private readonly ctx: Context,
    private readonly carrier: Agent,
    private readonly options: DispatcherOptions,
  ) {
    // The roster sink is intentionally inert: this plugin has no worker dock;
    // its observable surface is the runtime status and the loop's tools. The
    // registry is used for its turn-precise wait semantics.
    this.registry = new WorkerRegistry(
      ctx,
      carrier,
      options.workerSpawn.maxConsecutiveWakes,
      () => {},
    )
  }

  /** Await one child's `turn` settlement, mapping the registry's outcomes. */
  private async awaitTurn(
    childId: SessionId,
    turn: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ readonly status: SubTaskOutcome['status']; readonly output?: string; readonly error?: string }> {
    try {
      const result = await this.registry.waitForTurn(childId, turn, () => childSessionEvents(this.ctx, childId), {
        timeoutMs,
        signal,
      })
      return {
        status: result.status === 'completed' ? 'completed' : result.status === 'timeout' ? 'timeout' : 'disposed',
        ...result.output === undefined ? {} : { output: result.output },
      }
    } catch (error: unknown) {
      const message = describeError(error)
      return signal.aborted
        ? { status: 'aborted', error: message }
        : { status: 'error', error: message }
    }
  }

  async dispatch(request: SubTaskRequest, signal: AbortSignal): Promise<SubTaskOutcome> {
    return request.role === 'reviewer'
      ? await this.dispatchReviewer(request, signal)
      : await this.dispatchWorker(request, signal)
  }

  /** Spawn a durable continuable worker and read its first turn. */
  private async dispatchWorker(request: SubTaskRequest, signal: AbortSignal): Promise<SubTaskOutcome> {
    try {
      // A brief may only NARROW the worker toolset: coordination tools and
      // anything else outside the worker vocabulary can never be granted here.
      const toolFilter = request.toolFilter === undefined
        ? undefined
        : request.toolFilter.filter(name => WORKER_INHERITED_TOOLS.includes(name))
      const started = await startWorker(this.ctx, {
        parent: this.carrier,
        tier: request.tier,
        prompt: request.brief,
        label: request.label,
        ...toolFilter === undefined ? {} : { toolFilter },
        tiers: this.options.workerSpawn.tiers,
        provider: this.options.workerSpawn.provider,
        signal,
      })
      const record = this.registry.spawn(
        started.childId,
        request.tier,
        request.label,
        childSessionEvents(this.ctx, started.childId),
      )
      const settled = await this.awaitTurn(started.childId, record.lastTurn, this.options.workerTimeoutMs, signal)
      return { role: 'worker', ...settled }
    } catch (error: unknown) {
      return { role: 'worker', status: signal.aborted ? 'aborted' : 'error', error: describeError(error) }
    }
  }

  /** Compose, run, read, and dispose one one-shot clean reviewer. */
  private async dispatchReviewer(request: SubTaskRequest, signal: AbortSignal): Promise<SubTaskOutcome> {
    // The label carries the round and index; the dispatcher's own sequence
    // makes the durable session id unique even if a loop is replayed.
    this.reviewerSequence += 1
    const sessionId = SessionId(`${this.carrier.id}__orchestrator-${request.label}-${this.reviewerSequence}`)
    const cwd = this.carrier.session.header.cwd
    let handle: AgentHandle | undefined
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        ...cwd === undefined ? {} : { meta: { cwd } },
        setup: (agentCtx, agent) => {
          composeReviewer(agentCtx, agent, {
            name: request.label,
            tools: [...this.options.reviewerTools],
            primary: this.carrier,
            warn: this.options.warn,
          })
          agentCtx.systemPrompt.section({ name: 'orchestrator:reviewer', order: 60, text: renderReviewerRole() })
        },
      })
      const reviewer = handle.agent
      // Register the reviewer's turn BEFORE dispatch so `turn` 1 is the
      // follow-up below, then deliver the brief and await that exact turn.
      const record = this.registry.send(reviewer.id, childSessionEvents(this.ctx, reviewer.id))
      reviewer.followup(createUserMessage({
        content: [{ type: 'text', text: request.brief }],
        source: { kind: 'dsh-orchestrator', form: 'relay' },
      }))
      const settled = await this.awaitTurn(reviewer.id, record.lastTurn, this.options.reviewTimeoutMs, signal)
      if (settled.status !== 'completed') {
        // A reviewer that is still working when its budget runs out must not
        // keep burning tokens behind the round's back.
        try {
          reviewer.cancel({ kind: 'user' }, { keepInbox: true })
        } catch (error: unknown) {
          this.options.warn('dsh-orchestrator: could not cancel reviewer %s: %s', reviewer.id, describeError(error))
        }
        return { role: 'reviewer', ...settled }
      }
      const output = settled.output
      if (output === undefined) {
        return { role: 'reviewer', status: 'completed', error: 'reviewer produced no final text' }
      }
      const findings = parseReviewerReport(output)
      return {
        role: 'reviewer',
        status: 'completed',
        output,
        ...findings === undefined
          ? { error: 'reviewer reply was not a usable findings report' }
          : { findings },
      }
    } catch (error: unknown) {
      return { role: 'reviewer', status: signal.aborted ? 'aborted' : 'error', error: describeError(error) }
    } finally {
      if (handle !== undefined) {
        try {
          await handle.dispose()
        } catch (error: unknown) {
          this.options.warn('dsh-orchestrator: reviewer %s dispose failed: %s', sessionId, describeError(error))
        }
      }
    }
  }

  dispose(): void {
    this.registry.dispose()
  }
}

/**
 * Build the production dispatcher for one carrier agent.
 * @param ctx - the plugin root context (the registry listens on it for every session's events).
 * @param carrier - the live agent whose sub-tasks these are.
 * @param options - resolved deployment values.
 */
export function createDispatcher(ctx: Context, carrier: Agent, options: DispatcherOptions): SubTaskDispatcher {
  return new CarrierDispatcher(ctx, carrier, options)
}

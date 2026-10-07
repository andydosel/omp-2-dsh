/**
 * spawn-in-process dispatch primitives: how the worker-spawn core starts one
 * continuable in-process child, sends it a follow-up turn, interrupts it, and
 * drains its forest.
 *
 * Extracted from the five DIRECTOR tools' `vibe_spawn`/`vibe_send`/
 * `vibe_kill` call sites. `ctx.subagents.startContinuable` is unchanged in
 * dsh 0.2.0-rc.2, so the start shape is lifted verbatim; the follow-up call
 * migrated from `subagents.followup(parent, childId, content, { source,
 * signal })` to `subagents.sendMessage(sender, targetId, content, { signal })`
 * — the service now derives durable sender attribution from the live sender
 * and the `source` option is gone.
 *
 * @module @dsh-plugin/dsh-worker-spawn/spawn
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContinuableStart } from '@deepseek-ai/dsh-subagent'
import { DEFAULT_WORKER_PROVIDER, tierAgentOptions, type TierRoutes, type WorkerTier } from './types.ts'

/** One worker dispatch: tier, brief, and caller cancellation. */
export interface SpawnWorkerSpec {
  /** The spawning agent (the worker's durable parent). */
  readonly parent: Agent
  /** The worker tier; selects the model route from {@link SpawnWorkerSpec.tiers}. */
  readonly tier: WorkerTier
  /** The initial task prompt, delivered as the child's user message. */
  readonly prompt: string
  /** Optional short label persisted as the child's creation label. */
  readonly label?: string
  /** Per-tier model-route overrides; a tier with no route inherits the parent's. */
  readonly tiers?: TierRoutes
  /** Subagent provider registry name (default `spawn` = spawn-in-process). */
  readonly provider?: string
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}

/** One started worker: its ids plus the dispatch metadata a registry records. */
export interface StartedWorker extends ContinuableStart {
  /** The tier it was spawned under. */
  readonly tier: WorkerTier
  /** The durable creation label actually used. */
  readonly label: string
}

/**
 * Establish one worker: a durable continuable child on the configured subagent
 * provider (by default the spawn-in-process backend registered as `spawn`),
 * started with the tier's model route merged over the parent's options.
 *
 * Resolves when the child's inbox accepted the initial prompt, without waiting
 * for the turn to start; any earlier failure rejects with no ids and rolls the
 * child back entirely. Register the result with
 * {@link WorkerRegistry.spawn}, reading the child's live events for the seed.
 */
export async function startWorker(ctx: Context, spec: SpawnWorkerSpec): Promise<StartedWorker> {
  const tier = spec.tier
  const label = spec.label ?? `${tier} worker`
  const agentOptions = tierAgentOptions(tier, spec.tiers)
  const started = await ctx.subagents.startContinuable({
    provider: spec.provider ?? DEFAULT_WORKER_PROVIDER,
    label,
    request: {
      prompt: [{ type: 'text', text: spec.prompt }],
      parent: spec.parent,
      ...agentOptions === undefined ? {} : { agentOptions },
    },
    signal: spec.signal,
  })
  return { ...started, tier, label }
}

/**
 * Steer one follow-up message to a worker (its next FIFO turn). A running
 * worker admits it at the nearest step boundary; an idle worker starts a turn;
 * an absent direct child cold-resumes from persistence.
 *
 * @returns the accepted message's inbox id.
 */
export function sendWorkerMessage(
  ctx: Context,
  sender: Agent,
  targetId: SessionId,
  content: ContentBlock[],
  signal: AbortSignal,
): Promise<MessageId> {
  return ctx.subagents.sendMessage(sender, targetId, content, { signal })
}

/**
 * Interrupt one worker's current turn under its live spawning ancestor. The
 * session, queued messages, and descendants are preserved; a later send
 * resumes it. Fire-and-return: the cancel signal is issued before this
 * returns, but the target may keep running until it observes the signal.
 */
export function interruptWorker(ctx: Context, spawner: Agent, childId: SessionId): void {
  ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: spawner })
}

/**
 * Hard-destroy every continuable descendant of the given spawners: stops their
 * visible descendant activations, awaits admitted materializations, and
 * releases the forests child-first. The scoped cutoff lasts until each exact
 * parent leaves the agent registry.
 */
export function drainWorkers(ctx: Context, parents: readonly Agent[]): Promise<void> {
  return ctx.subagents.drainContinuableDescendants(parents)
}

/**
 * spawn-in-process dispatch primitives: how the worker-spawn core starts one
 * local subagent activation, sends it a follow-up turn, interrupts it, and
 * drains its forest.
 *
 * Extracted from the five DIRECTOR tools' `vibe_spawn`/`vibe_send`/
 * `vibe_kill` call sites. dsh 0.2.1 replaced `startContinuable` with
 * `startActivation`, whose `SubagentActivationSpec` moves `label`/`signal`
 * to the spec and requires a `delivery` policy — `'parent'` preserves the
 * completion notice and settle-wake behavior this core is built on. The
 * start request gained `agentPreset`/`cwd` and lost `toolFilter`/`persona`;
 * the follow-up call stays `subagents.sendMessage(sender, targetId, content,
 * { signal })`.
 *
 * @module @dsh-plugin/dsh-worker-spawn/spawn
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { DEFAULT_WORKER_PROVIDER, tierAgentOptions, type TierRoutes, type WorkerTier } from './types.ts'

/**
 * The implementation tool names a spawned worker keeps (§5.9). Coordination
 * surfaces (`peer_send`, `task_*`, org tools, `ask_question`) are deliberately
 * absent: a worker reports through its result, and its parent owns routing.
 * `subtask_parallel` is the spec's sanctioned recursion exception — a worker
 * may still fan out mechanical sub-work behind the same gates.
 */
export const WORKER_INHERITED_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'glob',
  'grep',
  'lsp',
  'write',
  'edit',
  'bash',
  'str_replace_editor',
  'todo_write',
  'subtask_parallel',
]

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
  /**
   * Optional worker tool allow-list (the brief's `toolFilter`). Defaults to
   * {@link WORKER_INHERITED_TOOLS}. Only names the child scope actually
   * inherits survive: a narrower preset simply lacks some names, and 0.2.1
   * `tools.restrict({allow})` fails loud on an unknown name.
   */
  readonly toolFilter?: readonly string[]
  /** Optional independent agent-preset id; omitted joins the parent's composition. */
  readonly agentPreset?: string
  /** Optional initial child directory; omitted inherits the parent's current directory. */
  readonly cwd?: string
  /** Per-tier model-route overrides; a tier with no route inherits the parent's. */
  readonly tiers?: TierRoutes
  /** Subagent provider registry name (default `spawn` = spawn-in-process). */
  readonly provider?: string
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}

/** One started worker: its activation plus the dispatch metadata a registry records. */
export interface StartedWorker extends SubagentActivation {
  /** The tier it was spawned under. */
  readonly tier: WorkerTier
  /** The durable creation label actually used. */
  readonly label: string
}

/**
 * Establish one worker: a durable local child on the configured subagent
 * provider (by default the spawn-in-process backend registered as `spawn`),
 * started with the tier's model route merged over the parent's options.
 *
 * Resolves when the child's inbox accepted the initial prompt, without waiting
 * for the turn to start; any earlier failure rejects with no ids and rolls the
 * child back entirely. `delivery: 'parent'` keeps the completion notice that
 * wakes the spawning session. Register the result with
 * {@link WorkerRegistry.spawn}, reading the child's live events for the seed.
 */
export async function startWorker(ctx: Context, spec: SpawnWorkerSpec): Promise<StartedWorker> {
  const tier = spec.tier
  const label = spec.label ?? `${tier} worker`
  const agentOptions = tierAgentOptions(tier, spec.tiers)
  const started = await ctx.subagents.startActivation({
    provider: spec.provider ?? DEFAULT_WORKER_PROVIDER,
    label,
    request: {
      prompt: [{ type: 'text', text: spec.prompt }],
      parent: spec.parent,
      ...spec.agentPreset === undefined ? {} : { agentPreset: spec.agentPreset },
      ...spec.cwd === undefined ? {} : { cwd: spec.cwd },
      ...agentOptions === undefined ? {} : { agentOptions },
    },
    delivery: 'parent',
    signal: spec.signal,
  })
  // A local child is live by the time startActivation resolves, so its agent
  // scope can be masked before it reaches for a tool. External providers have
  // no local scope (agents.get misses) and are not masked here.
  const child = ctx.get('agents')?.get(started.childId)
  if (child !== undefined) {
    try {
      // 0.2.1 `tools.restrict` rejects names absent from the global registry,
      // and a narrower child preset can also lack a name this core assumes.
      // Keep only what the child scope actually inherited (same intersection
      // rule as dsh-org's role envelopes) and warn about every dropped name.
      const desired = [...new Set(spec.toolFilter ?? WORKER_INHERITED_TOOLS)]
      const schemas = child.ctx.tools.schemas
      let allow = desired
      if (typeof schemas === 'function') {
        const present = new Set(schemas.call(child.ctx.tools, child).map(schema => schema.name))
        const dropped = desired.filter(name => !present.has(name))
        allow = desired.filter(name => present.has(name))
        if (dropped.length > 0) {
          ctx.logger.warn(
            'dsh-worker-spawn: worker %s does not inherit tool(s) %s; keeping [%s]',
            started.childId,
            dropped.join(', '),
            allow.join(', '),
          )
        }
        if (allow.length === 0) {
          throw new Error(
            `the worker scope inherits none of the requested tool(s) [${desired.join(', ')}]; `
            + 'its preset composition does not expose them',
          )
        }
      }
      child.ctx.tools.restrict({ allow })
    } catch (error: unknown) {
      await started.dispose()
      throw new Error(`dsh-worker-spawn: could not restrict worker ${started.childId}: ${String(error)}`)
    }
  }
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
  return ctx.subagents.drainDescendants(parents)
}

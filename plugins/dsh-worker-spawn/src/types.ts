/**
 * Worker-spawn shared vocabulary: the two dispatch tiers and their model
 * routes, the live worker roster shapes, and the config resolver.
 *
 * Extracted from dsh-vibe-mode's DIRECTOR mode as the reusable worker-spawn
 * core (the base a future subtask_parallel dispatcher builds on). The tier
 * vocabulary and the `tiers` validation are lifted verbatim from that
 * plugin's `VibeModeConfig`; everything DIRECTOR-specific (prompt sections,
 * tool allow-lists, settings, wait timeouts) stayed behind with the plugin.
 *
 * @module @dsh-plugin/dsh-worker-spawn/types
 */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'

/** The two worker tiers a dispatcher can spawn. */
export type WorkerTier = 'fast' | 'good'

/** Every worker tier, cheapest first. */
export const WORKER_TIERS = ['fast', 'good'] as const satisfies readonly WorkerTier[]

/** One tier's model route; empty fields inherit the spawning agent's route. */
export interface TierConfig {
  /** Provider route (must have a registered adapter at call time). */
  provider?: string
  /** Model id interpreted by the selected provider adapter. */
  model?: string
}

/** Per-tier model-route overrides, keyed by tier. */
export type TierRoutes = { fast?: TierConfig; good?: TierConfig }

/**
 * The live state of one worker as the roster reports it.
 * `starting` = freshly spawned, first turn not yet opened; `running` = a turn
 * is open; `idle` = last turn completed, awaiting a follow-up; `parked` =
 * interrupted, session preserved; `dead` = hard-destroyed (drain/terminate),
 * kept in the roster for terminal-state filtering.
 */
export type WorkerState = 'starting' | 'running' | 'idle' | 'parked' | 'dead'

/** One row of the whole-value worker roster (wire JSON). */
export interface WorkerView {
  /** Durable child session id, stable across activations. */
  id: string
  /** Spawn label (the worker's session label). */
  name?: string
  /** The tier the worker was spawned under. */
  tier: WorkerTier
  /** Live state as of the last registry transition. */
  state: WorkerState
  /** The expected absolute turn of the most recently dispatched message. */
  turn: number
  /** ISO timestamp of the last state transition. */
  lastActivity?: string
}

/** The whole-value worker roster (a roster sink payload / wire value). */
export interface WorkersRoster {
  workers: WorkerView[]
}

/** The default subagent provider registry name (spawn-in-process). */
export const DEFAULT_WORKER_PROVIDER = 'spawn'

/** The default consecutive-wake budget before spawn refusal. */
export const DEFAULT_MAX_CONSECUTIVE_WAKES = 3

/** Deployment configuration for the worker-spawn core. */
export interface WorkerSpawnConfig {
  /** The subagent provider that establishes workers (default `spawn`). */
  provider?: string
  /**
   * Per-tier `agentOptions` overrides. An empty tier inherits the spawning
   * agent's route (no override is passed to the child).
   */
  tiers?: TierRoutes
  /**
   * Consecutive settle notifications a spawner may be woken by before spawn
   * refuses new work until the next user-authored input (default 3). Bounds
   * the self-exciting chain where a woken turn spawns the worker whose
   * settlement wakes it again.
   */
  maxConsecutiveWakes?: number
}

/**
 * The fully-resolved config: every optional field has a concrete value, so
 * consumers never re-default.
 */
export interface ResolvedWorkerSpawnConfig {
  provider: string
  tiers: TierRoutes
  maxConsecutiveWakes: number
}

/** Validate the non-empty `provider`/`model` fields of one tier route. */
function resolveTier(raw: TierConfig): TierConfig {
  const unknown = Object.keys(raw).filter(key => key !== 'provider' && key !== 'model')
  if (unknown.length > 0) {
    throw new Error(`WorkerSpawnConfig tier has unknown key(s) ${unknown.join(', ')} — a tier is { provider?, model? }`)
  }
  if (raw.provider !== undefined && typeof raw.provider !== 'string') {
    throw new Error('WorkerSpawnConfig tier `provider` must be a string')
  }
  if (raw.model !== undefined && typeof raw.model !== 'string') {
    throw new Error('WorkerSpawnConfig tier `model` must be a string')
  }
  return raw
}

/**
 * The model-route override one tier selects: `{provider, model}` carrying only
 * the fields the route actually set, or `undefined` when the tier has no route
 * and therefore inherits the spawning agent's own route. This is the tier
 * switch — `fast`/`good` resolve to the deployment's configured routes.
 *
 * @param tier - the dispatch tier.
 * @param tiers - the per-tier route overrides (may be absent entirely).
 * @returns the `agentOptions` override to pass to the provider, or `undefined`.
 */
export function tierAgentOptions(tier: WorkerTier, tiers: TierRoutes | undefined): AgentOptions | undefined {
  const route = tiers?.[tier]
  if (route === undefined) return undefined
  const options: AgentOptions = {
    ...route.provider === undefined ? {} : { provider: route.provider },
    ...route.model === undefined ? {} : { model: route.model },
  }
  return Object.keys(options).length === 0 ? undefined : options
}

/**
 * Validate deployment-owned worker-spawn config. Missing, blank, or mistyped
 * fields fail at load rather than being ignored.
 *
 * @param config Raw config.
 * @returns A detached validated config.
 */
export function resolveWorkerSpawnConfig(config: WorkerSpawnConfig = {}): ResolvedWorkerSpawnConfig {
  const provider = (config as Partial<WorkerSpawnConfig>).provider ?? DEFAULT_WORKER_PROVIDER
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('WorkerSpawnConfig `provider` must be a non-empty provider name string')
  }
  const tiers: TierRoutes = {
    ...config.tiers?.fast !== undefined ? { fast: resolveTier(config.tiers.fast) } : {},
    ...config.tiers?.good !== undefined ? { good: resolveTier(config.tiers.good) } : {},
  }
  const maxConsecutiveWakes = config.maxConsecutiveWakes ?? DEFAULT_MAX_CONSECUTIVE_WAKES
  if (!Number.isSafeInteger(maxConsecutiveWakes) || maxConsecutiveWakes < 0) {
    throw new Error(`WorkerSpawnConfig maxConsecutiveWakes (${maxConsecutiveWakes}) must be a non-negative whole number of turns`)
  }
  const unknown = Object.keys(config).filter(key => !['provider', 'tiers', 'maxConsecutiveWakes'].includes(key))
  if (unknown.length > 0) {
    throw new Error(`WorkerSpawnConfig has unknown key(s) ${unknown.join(', ')}`)
  }
  return { provider, tiers, maxConsecutiveWakes }
}

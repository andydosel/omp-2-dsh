/**
 * Vibe-mode shared types: deployment config, tier routes, and the fold over
 * the logged `vibe/mode` event.
 *
 * @module @dsh-plugin/dsh-vibe-mode/types
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

/** The two worker tiers a director can spawn. */
export type VibeTier = 'fast' | 'good'

/** One tier's model route; empty fields inherit the director's route. */
export interface TierConfig {
  /** Provider route (must have a registered adapter at call time). */
  provider?: string
  /** Model id interpreted by the selected provider adapter. */
  model?: string
}

/**
 * The live state of one vibe worker as the `vibe/workers` roster reports it.
 * `starting` = freshly spawned, first turn not yet opened; `running` = a turn
 * is open; `idle` = last turn completed, awaiting a followup; `parked` =
 * interrupted (vibe_kill or `/vibe off`), session preserved; `dead` =
 * hard-destroyed (drain/terminate), kept in the roster for the client's
 * "hide completed" filter.
 */
export type VibeWorkerState = 'starting' | 'running' | 'idle' | 'parked' | 'dead'

/** One row of the `vibe/workers` whole-value roster (wire JSON). */
export interface VibeWorkerView {
  /** Durable child session id, stable across activations. */
  id: string
  /** Spawn label (the worker's session label). */
  name?: string
  /** The tier the director spawned it under. */
  tier: VibeTier
  /** Live state as of the last registry transition. */
  state: VibeWorkerState
  /** The expected absolute turn of the most recently dispatched message. */
  turn: number
  /** ISO timestamp of the last state transition. */
  lastActivity?: string
}

/** The whole-value payload of the `vibe/workers` session event. */
export interface VibeWorkersProjection {
  workers: VibeWorkerView[]
}

/**
 * The schemastery schema resolving the `dsh-vibe-mode` settings namespace,
 * shaped like {@link VibeModeConfig}: the settings layer overrides the
 * composition config (the plugin's own config is the `base` fallback), and
 * the runtime DIRECTOR-instructions source is
 * `resolved.section ?? config.section ?? DEFAULT_DIRECTOR_SECTION`. The
 * client settings panel can only touch this namespace because the host's
 * api-proxy whitelist exposes it (added by the annex worker); without that
 * whitelist entry every read/write answers `settings-not-exposed`.
 */
export const VibeModeConfigSchema: z<VibeModeConfig> = z.object({
  section: z.string(),
  readOnlyTools: z.array(z.string()),
  provider: z.string(),
  tiers: z.object({
    fast: z.object({ provider: z.string(), model: z.string() }),
    good: z.object({ provider: z.string(), model: z.string() }),
  }),
  waitTimeoutMs: z.number(),
  maxWaitTimeoutMs: z.number(),
  maxConsecutiveWakes: z.number(),
})

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The director's live worker roster, folded from `vibe/workers` whole-value events. */
    vibeWorkers: VibeWorkersProjection
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whether DIRECTOR mode is in force from this point on: log-only,
     * non-surface, whole-value replace. The last `vibe/mode` wins; a log with
     * none folds to inactive through {@link foldVibeMode}.
     */
    'vibe/mode': { active: boolean }
    /**
     * The director's live worker roster: log-only, non-surface, whole-value
     * replace, appended whenever the registry changes (spawn, send, kill,
     * turn-start/turn-end transitions, mode exit). Folds into the
     * `vibeWorkers` projection; the persistence catalog entry for this type
     * lives in the monorepo annex (added by the parallel annex worker).
     */
    'vibe/workers': { workers: VibeWorkerView[] }
  }
}

/**
 * The shipped DIRECTOR instructions: imperative delegation rules rendered as
 * the `director:instructions` prompt section while vibe mode is active. A
 * deployment may override with its own `section` config.
 */
export const DEFAULT_DIRECTOR_SECTION =
  'You are the DIRECTOR in vibe mode. You MUST NOT perform exploration or implementation work yourself. '
  + 'Your only job is to: (a) decompose the task, (b) spawn workers via vibe_spawn — cli=fast for mechanical work, cli=good for judgment — each with a complete self-contained brief, '
  + '(c) wait with vibe_wait and review, (d) iterate with vibe_send and merge results into one answer. '
  + 'EVERY task step beyond a quick read MUST be delegated. Self-exploration is limited to what a good worker brief needs (one listing or one file read). '
  + 'If a step would take more than ~2 of your own tool calls, delegate it. '
  + 'NEVER explore, edit, write, or test yourself.'

/** Deployment configuration for the vibe/director mode plugin. */
export interface VibeModeConfig {
  /**
   * DIRECTOR instructions, rendered as the `director:instructions` prompt
   * section while vibe mode is active. Defaults to the shipped
   * {@link DEFAULT_DIRECTOR_SECTION}; a blank string still fails loudly.
   */
  section?: string
  /**
   * Global tool names that stay visible to the director; every other
   * inherited tool is masked for that agent. Defaults to the read-only set
   * `read`, `glob`, `grep`, `read_image`, `todo_write`. Unknown names throw
   * loudly at mode entry (the tools service validates them).
   */
  readOnlyTools?: string[]
  /** The subagent provider that establishes workers (default `spawn`). */
  provider?: string
  /**
   * Per-tier `agentOptions` overrides. An empty tier inherits the director's
   * route (no override is passed to the child).
   */
  tiers?: { fast?: TierConfig; good?: TierConfig }
  /** Wait duration applied when `vibe_wait` sets no timeout (default 60s). */
  waitTimeoutMs?: number
  /** Hard cap on any single wait; a larger model-supplied timeout is clamped down to it (default 10min). */
  maxWaitTimeoutMs?: number
  /**
   * Consecutive `subagent-settled` notifications a director may be woken by
   * before `vibe_spawn` refuses new work until the next user-authored input
   * (default 3). Bounds the self-exciting chain where a woken turn spawns the
   * worker whose settlement wakes it again — the vibe analogue of
   * `tool-jobs`' `maxConsecutiveWakes`.
   */
  maxConsecutiveWakes?: number
}

/** The default read-only tool allow-list, matching the feasibility doc. */
export const DEFAULT_READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'read_image', 'todo_write'] as const

/** The default subagent provider registry name (spawn-in-process). */
export const DEFAULT_PROVIDER = 'spawn'

/** The default per-wait timeout and its hard cap. */
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_WAIT_TIMEOUT_MS = 600_000

/** The default consecutive-wake budget before spawn refusal. */
export const DEFAULT_MAX_CONSECUTIVE_WAKES = 3

/**
 * The fully-resolved config after {@link resolveConfig}: every optional field
 * has a concrete value, so consumers never re-default.
 */
export type ResolvedVibeModeConfig = {
  section: string
  readOnlyTools: string[]
  provider: string
  tiers: { fast?: TierConfig; good?: TierConfig }
  waitTimeoutMs: number
  maxWaitTimeoutMs: number
  maxConsecutiveWakes: number
}

/** Validate the non-empty `provider`/`model` fields of one tier route. */
function resolveTier(raw: TierConfig | undefined): TierConfig | undefined {
  if (raw === undefined) return undefined
  const unknown = Object.keys(raw).filter(key => key !== 'provider' && key !== 'model')
  if (unknown.length > 0) {
    throw new Error(`VibeModeConfig tier has unknown key(s) ${unknown.join(', ')} — a tier is { provider?, model? }`)
  }
  if (raw.provider !== undefined && typeof raw.provider !== 'string') {
    throw new Error('VibeModeConfig tier `provider` must be a string')
  }
  if (raw.model !== undefined && typeof raw.model !== 'string') {
    throw new Error('VibeModeConfig tier `model` must be a string')
  }
  return raw
}

/**
 * Validate deployment-owned vibe-mode config. Missing, blank, or mistyped
 * fields fail at plugin load rather than being ignored; a missing `section`
 * inherits the shipped {@link DEFAULT_DIRECTOR_SECTION}.
 *
 * @param config Raw plugin config.
 * @returns A detached validated config.
 */
export function resolveConfig(config: VibeModeConfig): ResolvedVibeModeConfig {
  const section = (config as Partial<VibeModeConfig>).section
  if (section !== undefined && typeof section !== 'string') {
    throw new Error('VibeModeConfig `section` must be a string')
  }
  if (section?.trim() === '') {
    throw new Error('VibeModeConfig needs a non-empty `section`')
  }
  const readOnlyTools = config.readOnlyTools ?? [...DEFAULT_READ_ONLY_TOOLS]
  if (!Array.isArray(readOnlyTools) || readOnlyTools.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new Error('VibeModeConfig `readOnlyTools` must be an array of non-empty tool-name strings')
  }
  const provider = config.provider ?? DEFAULT_PROVIDER
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('VibeModeConfig `provider` must be a non-empty provider name string')
  }
  const tiers = {
    ...config.tiers?.fast !== undefined ? { fast: resolveTier(config.tiers.fast) } : {},
    ...config.tiers?.good !== undefined ? { good: resolveTier(config.tiers.good) } : {},
  }
  const waitTimeoutMs = config.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const maxWaitTimeoutMs = config.maxWaitTimeoutMs ?? DEFAULT_MAX_WAIT_TIMEOUT_MS
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0) {
    throw new Error('VibeModeConfig `waitTimeoutMs` must be a positive number of milliseconds')
  }
  if (!Number.isFinite(maxWaitTimeoutMs) || maxWaitTimeoutMs <= 0) {
    throw new Error('VibeModeConfig `maxWaitTimeoutMs` must be a positive number of milliseconds')
  }
  if (waitTimeoutMs > maxWaitTimeoutMs) {
    throw new Error(`VibeModeConfig waitTimeoutMs (${waitTimeoutMs}) exceeds maxWaitTimeoutMs (${maxWaitTimeoutMs})`)
  }
  const maxConsecutiveWakes = config.maxConsecutiveWakes ?? DEFAULT_MAX_CONSECUTIVE_WAKES
  if (!Number.isSafeInteger(maxConsecutiveWakes)) {
    throw new Error(`VibeModeConfig maxConsecutiveWakes (${maxConsecutiveWakes}) must be a whole number of turns`)
  }
  const unknown = Object.keys(config).filter(key => ![
    'section', 'readOnlyTools', 'provider', 'tiers', 'waitTimeoutMs', 'maxWaitTimeoutMs', 'maxConsecutiveWakes',
  ].includes(key))
  if (unknown.length > 0) {
    throw new Error(`VibeModeConfig has unknown key(s) ${unknown.join(', ')}`)
  }
  return {
    section: section ?? DEFAULT_DIRECTOR_SECTION,
    readOnlyTools,
    provider,
    tiers,
    waitTimeoutMs,
    maxWaitTimeoutMs,
    maxConsecutiveWakes,
  }
}

/**
 * Whether vibe mode is in force after the first `end` events. The last
 * `vibe/mode` wins; a prefix with none is inactive.
 *
 * @param events The session log or any prefix of it.
 * @param end Fold `events[0, end)`; defaults to the whole log.
 * @returns Whether vibe mode is active.
 */
export function foldVibeMode(events: readonly SessionEvent[], end = events.length): boolean {
  let active = false
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === 'vibe/mode') active = event.data.active
  }
  return active
}

/**
 * Advisor plugin configuration: schema, validation, and the detached resolved
 * shape consumed by the runtime.
 *
 * @module @dsh-plugin/dsh-advisor/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * WATCHDOG discovery configuration. Discovery looks in the user-level
 * directory (`userDir`, defaulting to `$DSH_HOME`) and walks from the session
 * working directory upward to the nearest directory containing any
 * `projectMarkers` entry (default `.git`), looking for `WATCHDOG.md` /
 * `WATCHDOG.yml` at each level (omp naming).
 */
export interface AdvisorWatchdogConfig {
  /** User-level directory searched for WATCHDOG files; empty = `$DSH_HOME`. */
  userDir?: string
  /** Directory child names that identify a project root (default `['.git']`). */
  projectMarkers?: string[]
}

/** Allowed `syncBacklog` values (off, or a bounded catch-up threshold). */
export type SyncBacklog = 0 | 1 | 3 | 5

/**
 * Raw (user-written) advisor plugin configuration. All fields optional; see
 * {@link ResolvedAdvisorConfig} for the defaults applied by
 * {@link resolveConfig}.
 */
export interface AdvisorConfig {
  /** Whether the advisor is attached at load (default `true`). */
  enabled?: boolean
  /** Global tools the reviewer may call (default `['read', 'grep', 'glob']`). */
  defaultTools?: string[]
  /**
   * Number of primary turns a successful concern/blocker delivery keeps
   * later concern/blocker advice downgraded to asides (default `3`).
   */
  immuneTurns?: number
  /**
   * Bounded catch-up wait at primary turn end: when a delta feed reaches this
   * threshold, the runtime waits (≤ 30s) for the reviewer to catch up.
   * `0` disables the wait (default `0`). Allowed: `0 | 1 | 3 | 5`.
   */
  syncBacklog?: SyncBacklog
  /** Reviewer model id; empty = follow the primary agent's route (default `''`). */
  model?: string
  /** Token budget cap for one serialized delta/baseline prompt (default `8192`). */
  maxPromptTokens?: number
  /** WATCHDOG discovery configuration. */
  watchdog?: AdvisorWatchdogConfig
  /**
   * Optional per-1M-token cost table keyed by `provider/model`, `provider`,
   * or `model`; used only by `/advisor status` (empty = report tokens only).
   */
  costTable?: Record<string, number>
  /**
   * Exact agent id to attach to; empty = attach to the first non-reviewer
   * agent (default `''`).
   */
  agentId?: string
}

/** Detached, validated configuration consumed by the runtime. */
export interface ResolvedAdvisorConfig {
  readonly enabled: boolean
  readonly defaultTools: readonly string[]
  readonly immuneTurns: number
  readonly syncBacklog: SyncBacklog
  readonly model: string
  readonly maxPromptTokens: number
  readonly watchdog: {
    readonly userDir: string
    readonly projectMarkers: readonly string[]
  }
  readonly costTable: Readonly<Record<string, number>>
  readonly agentId: string
}

/** Schema of the advisor plugin configuration. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  defaultTools: z.array(z.string()).default(['read', 'grep', 'glob']),
  immuneTurns: z.number().step(1).min(1).default(3),
  syncBacklog: z.union([0, 1, 3, 5] as const).default(0),
  model: z.string().default(''),
  maxPromptTokens: z.number().step(1).min(256).default(8192),
  watchdog: z.object({
    userDir: z.string().default(''),
    projectMarkers: z.array(z.string()).default(['.git']),
  }).default({} as never),
  costTable: z.dict(z.number().min(0)).default({}),
  agentId: z.string().default(''),
})

/**
 * Validate raw configuration and return a detached resolved copy.
 * Unknown keys and invalid values fail at plugin load rather than silently
 * degrading the runtime.
 * @param config - raw plugin config.
 * @returns the validated configuration with defaults applied.
 */
export function resolveConfig(config: AdvisorConfig = {}): ResolvedAdvisorConfig {
  const raw = Config(config)
  const defaultTools = raw.defaultTools ?? ['read', 'grep', 'glob']
  const syncBacklog = raw.syncBacklog ?? 0
  const maxPromptTokens = raw.maxPromptTokens ?? 8192
  const watchdog = raw.watchdog ?? {}
  if (syncBacklog !== 0 && syncBacklog !== 1 && syncBacklog !== 3 && syncBacklog !== 5) {
    throw new Error(`AdvisorConfig.syncBacklog must be one of 0|1|3|5, got ${String(syncBacklog)}`)
  }
  if (defaultTools.length === 0) {
    throw new Error('AdvisorConfig.defaultTools must name at least one tool')
  }
  if (maxPromptTokens < 256) {
    throw new Error('AdvisorConfig.maxPromptTokens must be at least 256')
  }
  return {
    enabled: raw.enabled ?? true,
    defaultTools: [...defaultTools],
    immuneTurns: raw.immuneTurns ?? 3,
    syncBacklog,
    model: raw.model ?? '',
    maxPromptTokens,
    watchdog: {
      userDir: watchdog.userDir ?? '',
      projectMarkers: [...(watchdog.projectMarkers ?? ['.git'])],
    },
    costTable: { ...(raw.costTable ?? {}) },
    agentId: raw.agentId ?? '',
  }
}

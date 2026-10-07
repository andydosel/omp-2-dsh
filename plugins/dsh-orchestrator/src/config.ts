/**
 * Orchestrator plugin configuration: the schemastery schema the loader
 * validates, and the detached fully-resolved shape the runtime consumes
 * (DESIGN-COORDINATOR-SUITE-V1.0.md §6 `orchestrator` row, §13.5).
 *
 * The four design-owned knobs are `reviewersPerRound`, `reviewerTools`,
 * `zeroP0Approach` and `fanOut`. Four further fields exist because the
 * mechanisms the design delegates to this plugin need a concrete bound:
 *
 * - `workerSpawn` — the shared worker-spawn base's own config block
 *   (`provider` / `tiers` / `maxConsecutiveWakes`). Without it the tool's
 *   per-task `model: 'fast' | 'good'` field would route nowhere.
 * - `workerTimeoutMs` / `reviewerTimeoutMs` — the per-dispatch turn-wait
 *   budget. A turn-precise wait (`WorkerRegistry.waitForTurn`, or the
 *   reviewer's idle wait) has no unbounded form, and an implementation worker
 *   and a read-only reviewer deserve different ceilings.
 * - `maxGoalRounds` — the round cap for the review-loop goal. The goal
 *   service's 256-round default is a safety net for human goals, not a budget
 *   for an automated review loop.
 *
 * @module @dsh-plugin/dsh-orchestrator/config
 */

import z from '@deepseek-ai/schemastery'
import { resolveWorkerSpawnConfig } from '@dsh-plugin/dsh-worker-spawn'
import type { ResolvedWorkerSpawnConfig, WorkerSpawnConfig } from '@dsh-plugin/dsh-worker-spawn/types'

/** The only zero-P0 verdict mechanism v1 implements: the numeric count. */
export type ZeroP0Approach = 'count'

/** The recursive fan-out gates (`subtask_parallel`). */
export interface FanOutConfig {
  /** Maximum delegation depth; at the cap an agent does the work itself. */
  maxDepth?: number
  /** Total sub-agents one flow may dispatch; the blast-radius budget. */
  maxTotalAgents?: number
  /** Below this many sub-tasks the fan-out is not worth the overhead. */
  minSubtasks?: number
  /** Below this estimated brief size (tokens) the fan-out is not worth it. */
  minEffortTokens?: number
}

/** Raw (deployment-authored) orchestrator configuration; every field optional. */
export interface OrchestratorConfig {
  /** One-shot clean reviewers dispatched per review round (default `3`). */
  reviewersPerRound?: number
  /** The read-only tool allow-list every clean reviewer is restricted to. */
  reviewerTools?: string[]
  /** How a round decides the loop may close (default `'count'`). */
  zeroP0Approach?: ZeroP0Approach
  /** The recursive fan-out gates. */
  fanOut?: FanOutConfig
  /** The worker-spawn base's config (provider, tier routes, wake budget). */
  workerSpawn?: WorkerSpawnConfig
  /** Per-worker turn-wait budget in milliseconds (default 30 minutes). */
  workerTimeoutMs?: number
  /** Per-reviewer wait budget in milliseconds (default 10 minutes). */
  reviewTimeoutMs?: number
  /** Round cap for one review-loop goal (default 32). */
  maxGoalRounds?: number
}

/** Detached, validated configuration consumed by the runtime. */
export interface ResolvedOrchestratorConfig {
  readonly reviewersPerRound: number
  readonly reviewerTools: readonly string[]
  readonly zeroP0Approach: ZeroP0Approach
  readonly fanOut: {
    readonly maxDepth: number
    readonly maxTotalAgents: number
    readonly minSubtasks: number
    readonly minEffortTokens: number
  }
  readonly workerSpawn: ResolvedWorkerSpawnConfig
  readonly workerTimeoutMs: number
  readonly reviewTimeoutMs: number
  readonly maxGoalRounds: number
}

/** Schema of the orchestrator plugin configuration. */
export const Config = z.object({
  reviewersPerRound: z.number().step(1).min(1).default(3),
  reviewerTools: z.array(z.string()).default(['read', 'grep', 'glob']),
  zeroP0Approach: z.union(['count'] as const).default('count'),
  fanOut: z.object({
    maxDepth: z.number().step(1).min(0).default(3),
    maxTotalAgents: z.number().step(1).min(1).default(20),
    minSubtasks: z.number().step(1).min(0).default(2),
    minEffortTokens: z.number().step(1).min(0).default(2000),
  }).default({} as never),
  // The worker-spawn block is validated by its own resolver (non-empty
  // strings, unknown keys), so the schema carries it verbatim rather than
  // materializing defaults that would erase "this tier has no route".
  workerSpawn: z.any().default({}),
  workerTimeoutMs: z.number().step(1).min(1000).default(1_800_000),
  reviewTimeoutMs: z.number().step(1).min(1000).default(600_000),
  maxGoalRounds: z.number().step(1).min(1).default(32),
})

/** Require one positive whole-number field. */
function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`OrchestratorConfig.${field} must be a positive whole number, got ${String(value)}`)
  }
  return value as number
}

/** Require one non-negative whole-number field. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`OrchestratorConfig.${field} must be a non-negative whole number, got ${String(value)}`)
  }
  return value as number
}

/**
 * Validate raw configuration and return a detached resolved copy. Invalid
 * values fail at plugin load rather than silently degrading the runtime. The
 * `workerSpawn` block is validated by the shared worker-spawn base's own
 * resolver, so both consumers of that block agree on its contract.
 * @param config - raw plugin config.
 * @returns the validated configuration with every default materialized.
 */
export function resolveConfig(config: OrchestratorConfig = {}): ResolvedOrchestratorConfig {
  const raw = Config(config) as OrchestratorConfig
  const reviewersPerRound = positiveInteger(raw.reviewersPerRound ?? 3, 'reviewersPerRound')
  const reviewerTools = [...(raw.reviewerTools ?? ['read', 'grep', 'glob'])]
  if (reviewerTools.length === 0) {
    throw new Error('OrchestratorConfig.reviewerTools must name at least one tool')
  }
  if (reviewerTools.some(tool => typeof tool !== 'string' || tool.trim() === '')) {
    throw new Error('OrchestratorConfig.reviewerTools entries must be non-empty tool names')
  }
  const zeroP0Approach = raw.zeroP0Approach ?? 'count'
  if (zeroP0Approach !== 'count') {
    throw new Error(`OrchestratorConfig.zeroP0Approach must be 'count', got ${JSON.stringify(zeroP0Approach)}`)
  }
  const fanOut = raw.fanOut ?? {}
  return {
    reviewersPerRound,
    reviewerTools,
    zeroP0Approach,
    fanOut: {
      maxDepth: nonNegativeInteger(fanOut.maxDepth ?? 3, 'fanOut.maxDepth'),
      maxTotalAgents: positiveInteger(fanOut.maxTotalAgents ?? 20, 'fanOut.maxTotalAgents'),
      minSubtasks: nonNegativeInteger(fanOut.minSubtasks ?? 2, 'fanOut.minSubtasks'),
      minEffortTokens: nonNegativeInteger(fanOut.minEffortTokens ?? 2000, 'fanOut.minEffortTokens'),
    },
    workerSpawn: resolveWorkerSpawnConfig(raw.workerSpawn ?? {}),
    workerTimeoutMs: positiveInteger(raw.workerTimeoutMs ?? 1_800_000, 'workerTimeoutMs'),
    reviewTimeoutMs: positiveInteger(raw.reviewTimeoutMs ?? 600_000, 'reviewTimeoutMs'),
    maxGoalRounds: positiveInteger(raw.maxGoalRounds ?? 32, 'maxGoalRounds'),
  }
}

/**
 * `@dsh-plugin/dsh-worker-spawn` — the reusable worker-spawn core extracted
 * from dsh-vibe-mode's DIRECTOR mode: the `fast`/`good` dispatch tier routing,
 * the spawn-in-process dispatch primitives (`startActivation`/`sendMessage`/`interrupt`/
 * `drainDescendants`), and the per-spawner `WorkerRegistry`
 * (registration, lifecycle, roster, and turn-precise wait semantics).
 *
 * Pure library: it declares no cordis service, no Context key, and no plugin
 * entry. A consumer (a subtask_parallel dispatcher, for example) depends on
 * this package and supplies its own spawning Agent plus a roster sink; the
 * DIRECTOR-mode director/UI surface (prompt sections, settings, the five
 * `vibe_*` tools, the Web dock) was NOT extracted and was deleted with
 * dsh-vibe-mode.
 *
 * @module @dsh-plugin/dsh-worker-spawn
 */

export {
  DEFAULT_MAX_CONSECUTIVE_WAKES,
  DEFAULT_WORKER_PROVIDER,
  resolveWorkerSpawnConfig,
  tierAgentOptions,
  WORKER_TIERS,
} from './types.ts'
export type {
  ResolvedWorkerSpawnConfig,
  TierConfig,
  TierRoutes,
  WorkerSpawnConfig,
  WorkersRoster,
  WorkerState,
  WorkerTier,
  WorkerView,
} from './types.ts'

export { childSessionEvents, completedTurnsOf, WorkerRegistry } from './workers.ts'
export type { TurnEndResult, WaitForTurnOptions, WorkerRecord } from './workers.ts'

export { WORKER_INHERITED_TOOLS, drainWorkers, interruptWorker, sendWorkerMessage, startWorker } from './spawn.ts'
export type { SpawnWorkerSpec, StartedWorker } from './spawn.ts'

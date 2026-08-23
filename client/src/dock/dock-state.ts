/**
 * Pure dock-state derivation: roster filtering and the waiting-cue fact.
 * Kept react-free so the dock's presentational rules are unit-testable
 * without a DOM harness.
 *
 * @module @dsh-plugin/dsh-vibe-mode/client/dock-state
 */

import type { VibeWorkerView } from '../../../src/types.ts'

/**
 * Whether the dock shows the "waiting for worker" cue: at least one worker
 * is `running` (a turn in flight, result not yet settled). The main session
 * is not blocked — the user can keep chatting.
 */
export function hasRunningWorker(workers: readonly VibeWorkerView[]): boolean {
  return workers.some(worker => worker.state === 'running')
}

/**
 * The roster rows the dock renders under the "隐藏已完成" filter (default
 * ON): dead rows are hidden; starting/running/idle/parked stay visible.
 */
export function visibleWorkers(
  workers: readonly VibeWorkerView[],
  hideDone: boolean,
): VibeWorkerView[] {
  return hideDone ? workers.filter(worker => worker.state !== 'dead') : [...workers]
}

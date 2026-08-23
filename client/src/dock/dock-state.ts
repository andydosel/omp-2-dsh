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

/** The dock's presentation decision, kept react-free so collapse + filter are unit-testable. */
export interface DockPresentation {
  /** Whether the dock should mount at all (workers.length > 0); false renders null (no space). */
  readonly render: boolean
  /** Collapsed (default): a slim header bar only — near-zero vertical space. */
  readonly headerOnly: boolean
  /** The roster rows to show when expanded (empty when collapsed or all filtered out). */
  readonly rows: VibeWorkerView[]
}

/**
 * Derive what the dock should show: no roster renders nothing; otherwise the
 * default-collapsed dock is a slim header (rows hidden), and expanding shows
 * the roster rows under the 隐藏已完成 filter.
 */
export function dockPresentation(
  workers: readonly VibeWorkerView[],
  hideDone: boolean,
  collapsed: boolean,
): DockPresentation {
  if (workers.length === 0) return { render: false, headerOnly: false, rows: [] }
  return {
    render: true,
    headerOnly: collapsed,
    rows: collapsed ? [] : visibleWorkers(workers, hideDone),
  }
}

/**
 * `compactMode` projection unit: folds the `compact/mode` whole-value events
 * dsh-compact-mode appends (log-only, last one wins). Pure mathematics only —
 * the session-projection registry drives this over committed session events.
 *
 * @module @dsh-plugin/dsh-mode-ui/projections/compact
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls dsh-compact-mode's SessionEventMap merge (`compact/mode`)
// so the discriminated-union narrowing below is typed. Erased at build time;
// the host side collaborates with the sibling plugin through the session log
// only.
import type {} from '@dsh-plugin/dsh-compact-mode'
import type { CompactModeProjection } from '../types.ts'

/** Fold state of the compactMode unit. */
export interface CompactModeUnitState {
  active: boolean
}

/**
 * Pure transition: the last `compact/mode` wins; any other event returns the
 * same state reference (zero downstream work).
 */
export function applyCompactModeEvent(state: CompactModeUnitState, event: SessionEvent): CompactModeUnitState {
  if (event.type !== 'compact/mode') return state
  return event.data.active === state.active ? state : { active: event.data.active }
}

/** State → wire payload (the read-side projection). */
export function viewCompactMode(state: CompactModeUnitState): CompactModeProjection {
  return { active: state.active }
}

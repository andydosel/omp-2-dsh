/**
 * `compactMode` projection unit: the read-side view. The `apply` transition is
 * re-sourced in `src/index.ts` to read the sibling dsh-compact-mode store (the
 * mode flag is plugin-owned state, not a session event).
 *
 * @module @dsh-plugin/dsh-mode-ui/projections/compact
 */

import type { CompactModeProjection, CompactModeUnitState } from '../types.ts'

export type { CompactModeUnitState } from '../types.ts'

/** State → wire payload (the read-side projection). */
export function viewCompactMode(state: CompactModeUnitState): CompactModeProjection {
  return { active: state.active }
}

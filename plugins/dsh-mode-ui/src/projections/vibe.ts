/**
 * `vibeMode` projection unit: the read-side view. The `apply` transition is
 * re-sourced in `src/index.ts` to read the sibling dsh-vibe-mode store (the
 * mode flag is plugin-owned state, not a session event).
 *
 * @module @dsh-plugin/dsh-mode-ui/projections/vibe
 */

import type { VibeModeProjection, VibeModeUnitState } from '../types.ts'

export type { VibeModeUnitState } from '../types.ts'

/** State → wire payload (the read-side projection). */
export function viewVibeMode(state: VibeModeUnitState): VibeModeProjection {
  return { active: state.active }
}

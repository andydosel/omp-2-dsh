/**
 * `vibeMode` projection unit: folds the `vibe/mode` whole-value events
 * dsh-vibe-mode appends (log-only, last one wins). Pure mathematics only.
 *
 * @module @dsh-plugin/dsh-mode-ui/projections/vibe
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls dsh-vibe-mode's SessionEventMap merge (`vibe/mode`).
import type {} from '@dsh-plugin/dsh-vibe-mode'
import type { VibeModeProjection, VibeModeUnitState } from '../types.ts'

export type { VibeModeUnitState } from '../types.ts'

/**
 * Pure transition: the last `vibe/mode` wins; any other event returns the
 * same state reference (zero downstream work).
 */
export function applyVibeModeEvent(state: VibeModeUnitState, event: SessionEvent): VibeModeUnitState {
  if (event.type !== 'vibe/mode') return state
  return event.data.active === state.active ? state : { active: event.data.active }
}

/** State → wire payload (the read-side projection). */
export function viewVibeMode(state: VibeModeUnitState): VibeModeProjection {
  return { active: state.active }
}

/**
 * `advisorStatus` projection unit: the read-side view. The `apply` transition
 * is re-sourced in `src/index.ts` to read the sibling dsh-advisor runtime (the
 * enabled/reviewers state is plugin-owned, not a session event).
 *
 * @module @dsh-plugin/dsh-mode-ui/projections/advisor
 */

import type { AdvisorStatusProjection, AdvisorStatusUnitState } from '../types.ts'

export type { AdvisorStatusUnitState } from '../types.ts'

/** State → wire payload (the read-side projection). */
export function viewAdvisorStatus(state: AdvisorStatusUnitState): AdvisorStatusProjection {
  return { enabled: state.enabled, reviewers: state.reviewers }
}

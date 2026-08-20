/**
 * `advisorStatus` projection unit: folds the `advisor/status` whole-value
 * events dsh-advisor appends whenever the advisor enables/disables or the
 * reviewer set changes. Pure mathematics only.
 *
 * @module @dsh-plugin/dsh-mode-ui/projections/advisor
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls dsh-advisor's SessionEventMap merge (`advisor/status`).
import type {} from '@dsh-plugin/dsh-advisor'
import type { AdvisorStatusProjection } from '../types.ts'

/** Fold state of the advisorStatus unit. */
export interface AdvisorStatusUnitState {
  enabled: boolean
  reviewers: number
}

/**
 * Pure transition: whole-value replace on `advisor/status`; any other event
 * returns the same state reference (zero downstream work).
 */
export function applyAdvisorStatusEvent(state: AdvisorStatusUnitState, event: SessionEvent): AdvisorStatusUnitState {
  if (event.type !== 'advisor/status') return state
  return { enabled: event.data.enabled, reviewers: event.data.reviewers }
}

/** State → wire payload (the read-side projection). */
export function viewAdvisorStatus(state: AdvisorStatusUnitState): AdvisorStatusProjection {
  return { enabled: state.enabled, reviewers: state.reviewers }
}

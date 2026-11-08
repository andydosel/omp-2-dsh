/**
 * The `advisorStatus` session projection: the host-computed value behind the
 * header badge (enabled flag + live reviewer count).
 *
 * The advisor package owns this unit end to end, so the badge no longer needs
 * a separate mode-status plugin: the runtime publishes its state into a
 * plugin-owned store (never a session event), this unit folds that state on
 * every committed event, and the client badge reads the wire value. The unit
 * child activates only when a projection registry is composed.
 *
 * @module @dsh-plugin/dsh-advisor/status-projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: pulls the SessionProjectionMap / SessionProjectionStateMap merges.
import type { AdvisorStatusProjection, AdvisorStatusUnitState } from './types.ts'

export type { AdvisorStatusProjection, AdvisorStatusUnitState } from './types.ts'

/** Wire payload schema (validated before leaving the host). */
const advisorStatusSchema: ZodType<AdvisorStatusProjection> = zod.object({
  enabled: zod.boolean(),
  reviewers: zod.number().int().nonnegative(),
})

/**
 * State → wire payload (the read-side projection).
 * @param state - the folded unit state.
 * @returns the browser-visible payload.
 */
export function viewAdvisorStatus(state: AdvisorStatusUnitState): AdvisorStatusProjection {
  return { enabled: state.enabled, reviewers: state.reviewers }
}

/**
 * Register the `advisorStatus` unit on the host projection registry.
 *
 * The `apply` transition re-reads the runtime on every committed event and
 * returns the same reference while the value is unchanged (the registry's
 * Object.is gate), so the badge re-syncs to plugin state without any session
 * event.
 * @param ctx - host context (the child activates only with a projection registry).
 * @param read - reads the runtime's current status, or undefined before the runtime starts.
 */
export function registerAdvisorStatusProjection(
  ctx: Context,
  read: () => AdvisorStatusProjection | undefined,
): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'advisorStatus', AdvisorStatusUnitState>({
      key: 'advisorStatus',
      stateSchema: advisorStatusSchema,
      init: () => ({ enabled: false, reviewers: 0 }),
      apply: (state) => {
        const next = read() ?? { enabled: false, reviewers: 0 }
        return next.enabled === state.enabled && next.reviewers === state.reviewers ? state : next
      },
      wire: { viewSchema: advisorStatusSchema, view: viewAdvisorStatus },
      stateVersion: 1,
    })
  })
}

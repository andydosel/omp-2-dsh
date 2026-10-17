/**
 * Durable review-gate state: the `review-gate/state` session event, its
 * projection, and the pure flag → state transition.
 *
 * The whole task's gate rides ONE durable event (`model-visible ⟺ logged`: the
 * model-facing fence follows exactly this state), so resume and fork restore
 * it by replay, and any sibling plugin reads it through
 * `ctx.sessionProjections.stateOf(session, 'reviewGate')`.
 *
 * @module @dsh-plugin/dsh-review-gate/state
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session/types'
import type { GatePolicy } from './config.ts'
import type { InputFlags } from './flags.ts'

/**
 * Gate state of the current task.
 *
 * The fence is CLOSED exactly when `enabled && awaitingApproval`: `enabled` is
 * whether the gate applies to this task at all (`--no-review` clears it), and
 * `awaitingApproval` is whether the user's plan approval is still outstanding.
 */
export interface ReviewGateState {
  /** Local task id (`task-<turn>`) the flags opened, `''` before any task. */
  taskId: string
  /** Whether a first plan is still waiting for the user's approval. */
  awaitingApproval: boolean
  /** Whether the write fence applies to this task. */
  enabled: boolean
  /** Reviewer count recorded by `--workers N` for this task (`0` = unrecorded). */
  reviewers: number
}

/** Client-visible wire value of the `reviewGate` projection (same shape as the host state). */
export interface ReviewGateView {
  taskId: string
  awaitingApproval: boolean
  enabled: boolean
  reviewers: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The review gate's whole current state from this point on: log-only (like
     * `plan/mode`; NOT a surface event), whole-value replace, last one wins.
     * A log with none folds to the configured default policy.
     */
    'review-gate/state': ReviewGateState
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Review-gate collaboration state, for a status badge or a session panel. */
    reviewGate: ReviewGateView
  }

  interface SessionProjectionStateMap {
    /** Host fold state of the `reviewGate` unit; state and wire value are the same shape. */
    reviewGate: ReviewGateState
  }
}

/** State schema, validating persisted state before it seeds a fold. */
export const reviewGateStateSchema: ZodType<ReviewGateState> = zod.object({
  taskId: zod.string(),
  awaitingApproval: zod.boolean(),
  enabled: zod.boolean(),
  reviewers: zod.number().int().nonnegative(),
})

/**
 * The gate state a session starts from under one default policy: `'on'` starts
 * every task behind the fence until the user approves or sends `--no-review`.
 * @param defaultPolicy - the configured `defaultPolicy`.
 * @returns the initial state.
 */
export function initialGateState(defaultPolicy: GatePolicy): ReviewGateState {
  const armed = defaultPolicy === 'on'
  return { taskId: '', awaitingApproval: armed, enabled: armed, reviewers: 0 }
}

/**
 * Fold one flag-bearing user input into the gate state. `--review` opens a new
 * task behind the fence, `--no-review` cancels the gate for this task, and a
 * bare `--workers N` only records the round's reviewer count.
 * @param previous - the state before this input.
 * @param flags - the parsed input flags.
 * @param turn - the turn the input was claimed in (the task id suffix).
 * @returns the next state.
 */
export function applyFlagsToState(
  previous: ReviewGateState,
  flags: InputFlags,
  turn: number,
): ReviewGateState {
  const reviewers = flags.workers ?? previous.reviewers
  if (flags.review === true) {
    return { taskId: `task-${turn}`, enabled: true, awaitingApproval: true, reviewers }
  }
  if (flags.review === false) {
    return { taskId: `task-${turn}`, enabled: false, awaitingApproval: false, reviewers }
  }
  return { ...previous, reviewers }
}

/**
 * The registered unit shape: the registry's client-visible overload requires a
 * `wire` view, so the definition narrows that member from optional.
 */
export type ReviewGateProjection = ProjectionDefinition<'reviewGate', ReviewGateState> & {
  wire: NonNullable<ProjectionDefinition<'reviewGate', ReviewGateState>['wire']>
}

/**
 * The `reviewGate` projection unit: a log-only whole-value replacer.
 * @param defaultPolicy - the configured default policy, folded into `init`.
 * @returns the projection definition to register.
 */
export function createReviewGateProjection(
  defaultPolicy: GatePolicy,
): ReviewGateProjection {
  return {
    key: 'reviewGate',
    stateVersion: 1,
    stateSchema: reviewGateStateSchema,
    init: () => initialGateState(defaultPolicy),
    apply: (state, event) => (event.type === 'review-gate/state' ? { ...event.data } : state),
    // The wire value IS the fold state: reusing its reference keeps the
    // registry's Object.is gate from publishing on unrelated events.
    wire: { viewSchema: reviewGateStateSchema, view: state => state },
  }
}

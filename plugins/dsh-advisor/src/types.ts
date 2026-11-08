/**
 * Advisor-domain shared types.
 *
 * Plugin-only rework: the `advisor/status` session event is gone — the
 * enabled flag and reviewer count are plugin-owned runtime state (see
 * `state-store.ts`) surfaced through the `advisorStatus` projection, not a
 * session event.
 *
 * @module @dsh-plugin/dsh-advisor/types
 */

/** The advisor runtime's whole value (enabled + live reviewer count). */
export interface AdvisorStatusEvent {
  enabled: boolean
  reviewers: number
}

/**
 * Payload of the durable `advisor/advice` session event: the user-visible
 * copy of one accepted advisory. Log-only (no `surfaceOp`): the model-visible
 * delivery stays the plugin-sourced `user/message`, while this event is the
 * replayable card the Web transcript renders.
 */
export interface AdvisorAdviceEvent {
  /** Advisory grade (drives the card's severity treatment). */
  severity: 'nit' | 'concern' | 'blocker'
  /** The reviewer's note, exactly as advised. */
  note: string
  /** Reviewer roster name that produced the advice. */
  reviewer: string
}

/**
 * Browser-visible advisor state: the enabled flag and the live reviewer count
 * the runtime publishes. The host half folds it into the `advisorStatus`
 * session projection; the header badge reads the same key, so the card and the
 * badge share one type home.
 */
export interface AdvisorStatusProjection {
  enabled: boolean
  reviewers: number
}

/** Host fold state of the `advisorStatus` unit. State and wire value are the same shape. */
export interface AdvisorStatusUnitState {
  enabled: boolean
  reviewers: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Advisor runtime state folded from the plugin's own runtime state. */
    advisorStatus: AdvisorStatusProjection
  }

  interface SessionProjectionStateMap {
    /** Advisor host fold state. */
    advisorStatus: AdvisorStatusUnitState
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One accepted advisory, recorded in the primary session when it is
     * routed. Log-only: it never enters model history and never rewrites the
     * conversation surface; the Chat client renders it as a card.
     */
    'advisor/advice': AdvisorAdviceEvent
  }
}
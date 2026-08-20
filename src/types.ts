/**
 * Session-event type declarations of the advisor domain.
 *
 * `advisor/status` is appended by the runtime (src/advisor.ts) whenever the
 * advisor enables/disables or the reviewer set changes; the projection unit
 * in @dsh-plugin/dsh-mode-ui folds it per-session. Like the sibling mode
 * events, it is log-only and non-surface: the model never sees it, the
 * client projection does.
 *
 * NOTE ON PERSISTENCE CATALOG: like `compact/mode` in dsh-compact-mode, this
 * standalone out-of-tree plugin consumes the event only from OUR code, so no
 * persistence catalog regeneration is needed.
 *
 * @module @dsh-plugin/dsh-advisor/types
 */

/** Whole-value payload of the `advisor/status` session event. */
export interface AdvisorStatusEvent {
  enabled: boolean
  reviewers: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The advisor runtime's whole value: whether the advisor is enabled and
     * how many reviewers are live. Log-only, non-surface, whole-value
     * replace — the last `advisor/status` wins; a log with none folds to
     * disabled/zero. Appended on enable/disable and whenever the reviewer
     * set changes (bind, ready, start failure).
     */
    'advisor/status': AdvisorStatusEvent
  }
}

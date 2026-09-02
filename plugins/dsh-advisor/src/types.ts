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

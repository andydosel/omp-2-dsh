/**
 * Invariants and shared predicates for the compact-mode plugin.
 *
 * @module @dsh-plugin/dsh-compact-mode/invariant
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Whether the log holds an opened turn without its closing `turn/end`. */
export function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/** Whether the session log has a live (unmatched) compaction start marker. */
export function hasUnmatchedCompactionStart(events: readonly SessionEvent[]): boolean {
  let unmatched = false
  for (const event of events) {
    if (event.type === 'compaction/start') unmatched = true
    else if (event.type === 'compaction/end') unmatched = false
  }
  return unmatched
}

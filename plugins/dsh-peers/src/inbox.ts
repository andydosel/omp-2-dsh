/**
 * Pure inbox fold: the `peers` projection state is the ordered list of
 * messages addressed to one session. The fold is idempotent by the snapshot's
 * `id` (the `senderId#messageId` dedupe key), so replaying a log — or a
 * double append — never duplicates a message; and it returns the SAME state
 * reference unless a `peer/message` event actually changed it, which is the
 * projection registry's `Object.is` gate.
 *
 * @module @dsh-plugin/dsh-peers/inbox
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { PeerMessageSnapshot } from './types.ts'

/**
 * Whether a snapshot with this dedupe key is already folded.
 * @param state - the folded inbox.
 * @param key - the `senderId#messageId` dedupe key.
 * @returns true when the key is present.
 */
export function hasKey(state: readonly PeerMessageSnapshot[], key: string): boolean {
  return state.some(message => message.id === key)
}

/**
 * Find one folded message by dedupe key.
 * @param state - the folded inbox.
 * @param key - the `senderId#messageId` dedupe key.
 * @returns the snapshot, or undefined.
 */
export function findMessage(state: readonly PeerMessageSnapshot[], key: string): PeerMessageSnapshot | undefined {
  return state.find(message => message.id === key)
}

/**
 * Fold one session event into the inbox.
 * @param state - the folded inbox.
 * @param event - one committed session event.
 * @returns the SAME reference for a non-`peer/message` event or an
 *   already-present key; otherwise a new array with the snapshot appended.
 */
export function applyPeerEvent(state: PeerMessageSnapshot[], event: SessionEvent): PeerMessageSnapshot[] {
  if (event.type !== 'peer/message') return state
  if (hasKey(state, event.data.id)) return state
  return [...state, event.data]
}

/**
 * Fold a whole (or partial) log into the inbox.
 * @param events - the session events, in log order.
 * @returns the folded inbox.
 */
export function foldPeerInbox(events: readonly SessionEvent[]): PeerMessageSnapshot[] {
  let state: PeerMessageSnapshot[] = []
  for (const event of events) state = applyPeerEvent(state, event)
  return state
}

/**
 * The inbox messages, optionally narrowed to one target.
 * @param state - the folded inbox (may hold several targets).
 * @param targetId - when given, keep only messages addressed to it.
 * @returns a fresh array.
 */
export function listMessages(state: readonly PeerMessageSnapshot[], targetId?: SessionId | string): PeerMessageSnapshot[] {
  if (targetId === undefined) return [...state]
  const target = String(targetId)
  return state.filter(message => String(message.targetId) === target)
}

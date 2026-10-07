/**
 * dsh-peers durable vocabulary: the `peer/message` session event, the `peers`
 * projection pair, and the structural contracts siblings probe.
 *
 * The dedupe key IS the snapshot's `id` (`<senderId>#<messageId>`), so the
 * fold and the service dedupe a replay or a double-append by reading one
 * field. A `peer/message` event is appended to the TARGET session's log — that
 * log IS the inbox — which is why the fold state for one session is exactly
 * the messages addressed to it and the wire view is the same JSON array.
 *
 * @module @dsh-plugin/dsh-peers/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** How a delivered message reaches the target session. */
export type PeerDelivery = 'quiet' | 'wakeup'

/** One message another session addressed to this one, as recorded in the target's log. */
export interface PeerMessageSnapshot {
  /** The dedupe key `${senderId}#${messageId}` (see {@link dedupeKey}). */
  id: string
  /** The sending session. */
  senderId: SessionId
  /** The addressed session (the log this snapshot lives in). */
  targetId: SessionId
  /** Sender-supplied (or minted) identity, unique per sender. */
  messageId: string
  /** Whether delivery also starts/steers the target's turn. */
  delivery: PeerDelivery
  /** The message body. */
  content: ContentBlock[]
  /** Unix epoch milliseconds of the append. */
  time: number
}

/**
 * The stable dedupe key `senderId#messageId`; exactly the value stored as
 * {@link PeerMessageSnapshot.id}.
 * @param senderId - the sending session.
 * @param messageId - the sender-scoped message identity.
 * @returns the `#`-joined dedupe key.
 */
export function dedupeKey(senderId: SessionId, messageId: string): string {
  return `${senderId}#${messageId}`
}

/**
 * Runtime guard for one {@link PeerMessageSnapshot}. It drives the projection
 * `z.custom` state schema (zod cannot express a `ContentBlock[]` structurally),
 * so it checks the fields the fold and the service depend on and leaves the
 * block array opaque, exactly as a persisted fold must round-trip.
 * @param value - any candidate.
 * @returns whether `value` is a well-formed snapshot.
 */
export function isPeerMessageSnapshot(value: unknown): value is PeerMessageSnapshot {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || !('senderId' in value) || !('targetId' in value)) return false
  if (!('messageId' in value) || !('delivery' in value) || !('content' in value) || !('time' in value)) return false
  const { id, senderId, targetId, messageId, delivery, content, time } = value
  return typeof id === 'string'
    && typeof senderId === 'string'
    && typeof targetId === 'string'
    && typeof messageId === 'string'
    && (delivery === 'quiet' || delivery === 'wakeup')
    && Array.isArray(content)
    && typeof time === 'number'
}

/** Request accepted by {@link PeersServiceApi.send}. */
export interface PeersSendInput {
  /** The addressed session id (branded or raw). */
  targetId: SessionId | string
  /** The message body, non-empty and within `maxContentBytes`. */
  content: string
  /** Delivery mode; defaults to `wakeup`. */
  delivery?: PeerDelivery
  /** Sender-scoped identity; minted when absent. */
  messageId?: string
}

/** Outcome of one {@link PeersServiceApi.send}. */
export interface PeersSendResult {
  /** `duplicate` means the dedupe key already existed: nothing was appended and nothing woke. */
  status: 'delivered' | 'duplicate'
  /** The delivered (or pre-existing) snapshot. */
  message: PeerMessageSnapshot
  /** Whether a live agent was woken by this send. */
  woke: boolean
}

/**
 * The structural contract `ctx.get('peers')` satisfies. Siblings probe this
 * shape (never import the package) so load order stays decoupled.
 */
export interface PeersServiceApi {
  /**
   * Deliver one message to a live session.
   * @param sender - the sending agent (its session id names the sender).
   * @param input - target, body, delivery, and optional message id.
   * @returns the delivery outcome.
   */
  send(sender: Agent, input: PeersSendInput): Promise<PeersSendResult>
  /**
   * The messages addressed to one session, in arrival order.
   * @param targetId - the addressed session id.
   * @returns the folded inbox (a fresh array).
   */
  listMessages(targetId: SessionId | string): readonly PeerMessageSnapshot[]
}

/**
 * Structural probe for the optional `dsh-org` service. A `true` from
 * `isForbidden` is a HARD authorization block on `peer_send` (the negative
 * grant is authoritative; `dsh-peers` never imports `dsh-org`).
 */
export interface OrgForbiddenProbe {
  /**
   * Whether `secretaryId` may not address `targetId`.
   * @param secretaryId - the candidate sender.
   * @param targetId - the candidate target.
   * @returns true to block the send.
   */
  isForbidden(secretaryId: SessionId, targetId: SessionId): boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A message another session addressed to this one, appended to THIS
     * session's log (the target's log is the durable inbox). Log-only: it
     * never enters the model transcript.
     */
    'peer/message': PeerMessageSnapshot
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The inbox: messages addressed to this session, in arrival order. */
    peers: PeerMessageSnapshot[]
  }

  interface SessionProjectionStateMap {
    /** Host fold state of the `peers` unit (the same JSON array as the wire value). */
    peers: PeerMessageSnapshot[]
  }
}

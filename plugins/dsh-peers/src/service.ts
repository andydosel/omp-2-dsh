/**
 * `ctx.peers`: the peer-channel service.
 *
 * The durable `peer/message` event is appended to the TARGET session's log —
 * that log IS the inbox — and every committed append is folded into a
 * per-target in-memory inbox keyed by the `senderId#messageId` dedupe key, so
 * a resumed session (seeded lazily from its log) and a double-send dedupe
 * identically and never wake twice.
 *
 * Delivery: `quiet` only records; `wakeup` additionally `followup`s a live
 * agent, which queues its own turn and wakes it. `wakeupEnabled: false`
 * degrades every delivery to `quiet` without changing the tool surface — the
 * switch for targets whose turns must only ever start from human input.
 *
 * Authorization composes with the optional `dsh-org` service through a
 * structural probe: a `true` from `isForbidden` is a HARD block (the negative
 * grant is authoritative), while the absence of `dsh-org` leaves the channel
 * open — the channel is meaningful without any org.
 *
 * @module @dsh-plugin/dsh-peers/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { findMessage, foldPeerInbox, hasKey } from './inbox.ts'
import { registerPeersProjection } from './projection.ts'
import { definePeerSendTool } from './tool.ts'
import { dedupeKey } from './types.ts'
import type { OrgForbiddenProbe, PeerDelivery, PeerMessageSnapshot, PeersSendInput, PeersSendResult } from './types.ts'

/** Raw (user-written) `dsh-peers` configuration. */
export interface PeersConfig {
  /** Whether `wakeup` deliveries may start/steer the target's turn (default `true`). */
  wakeupEnabled?: boolean
  /** Maximum UTF-8 byte length of one message body (default `16384`). */
  maxContentBytes?: number
}

/** Detached, validated configuration consumed by the service. */
export interface ResolvedPeersConfig {
  /** Effective wake switch. */
  wakeupEnabled: boolean
  /** Effective body-size bound, in UTF-8 bytes. */
  maxContentBytes: number
}

const KNOWN_CONFIG_KEYS: Readonly<Record<string, true>> = { wakeupEnabled: true, maxContentBytes: true }

/**
 * Validate raw configuration and return a detached resolved copy.
 * @param config - the row's config object.
 * @returns the resolved configuration.
 * @throws when an unknown key is present or a value is out of range (fail loud).
 */
export function resolvePeersConfig(config: PeersConfig = {}): ResolvedPeersConfig {
  for (const key of Object.keys(config)) {
    if (KNOWN_CONFIG_KEYS[key] === undefined) {
      throw new Error(`dsh-peers: unknown config key "${key}" (known: wakeupEnabled, maxContentBytes)`)
    }
  }
  const wakeupEnabled = config.wakeupEnabled ?? true
  if (typeof wakeupEnabled !== 'boolean') {
    throw new Error(`dsh-peers: wakeupEnabled must be a boolean (got ${JSON.stringify(config.wakeupEnabled)})`)
  }
  const maxContentBytes = config.maxContentBytes ?? 16384
  if (!Number.isInteger(maxContentBytes) || maxContentBytes <= 0) {
    throw new Error(`dsh-peers: maxContentBytes must be a positive integer (got ${JSON.stringify(config.maxContentBytes)})`)
  }
  return { wakeupEnabled, maxContentBytes }
}

/** Failure codes of a rejected peer send. */
export type PeerSendErrorCode = 'NO_TARGET' | 'SELF_SEND' | 'EMPTY_CONTENT' | 'CONTENT_TOO_LARGE' | 'BAD_DELIVERY' | 'FORBIDDEN'

/** A `peer_send` request that cannot be honored. */
export class PeerSendError extends Error {
  /** Stable machine-readable code. */
  readonly code: PeerSendErrorCode

  /**
   * @param message - human-readable reason.
   * @param code - stable machine-readable code.
   */
  constructor(message: string, code: PeerSendErrorCode) {
    super(message)
    this.name = 'PeerSendError'
    this.code = code
  }
}

/** Escape one XML text/value character (the delivery card is XML). */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * The message's plain text (non-text blocks contribute nothing).
 * @param snapshot - the delivered message.
 * @returns the joined text blocks.
 */
export function snapshotText(snapshot: PeerMessageSnapshot): string {
  return snapshot.content.map(block => (block.type === 'text' ? block.text : '')).filter(text => text !== '').join('\n')
}

/**
 * Render a snapshot as the model-visible `<peer-message>` card.
 * @param snapshot - the delivered message.
 * @returns the compact XML block with escaped attributes and body.
 */
export function renderPeerMessage(snapshot: PeerMessageSnapshot): string {
  return `<peer-message from="${escapeXml(String(snapshot.senderId))}"`
    + ` message-id="${escapeXml(snapshot.messageId)}" delivery="${snapshot.delivery}">`
    + `${escapeXml(snapshotText(snapshot))}</peer-message>`
}

/**
 * Build the user message a `wakeup` delivery hands to the target agent: a
 * plugin-sourced `notice`, so the durable log records what woke the turn.
 * @param snapshot - the delivered message.
 * @returns the immutable user message.
 */
export function deliveryMessage(snapshot: PeerMessageSnapshot): UserMessage {
  const content: ContentBlock[] = [{ type: 'text', text: renderPeerMessage(snapshot) }]
  return createUserMessage({
    content,
    source: {
      kind: 'dsh-peers',
      form: 'notice',
      summary: boundContextSummary(`Peer message from ${String(snapshot.senderId)}`),
    },
  })
}

/**
 * The cordis entry: registers the global `peer_send` tool, the `peers`
 * projection, and its live `session/event` fold, and exposes the channel as
 * `ctx.peers`.
 */
export class PeersService extends Service {
  static inject = ['agents', 'sessions'] as const

  /** The validated configuration. */
  readonly config: ResolvedPeersConfig

  /** Per-target inboxes, seeded lazily from the target's durable log. */
  readonly #inboxes = new Map<string, PeerMessageSnapshot[]>()

  /** Monotonic counter for minted message ids (uniqueness is per process). */
  #messageCounter = 0

  /**
   * @param ctx - the plugin context (`agents` and `sessions` are injected).
   * @param config - the row's raw configuration.
   */
  constructor(ctx: Context, config: PeersConfig = {}) {
    super(ctx, 'peers')
    this.config = resolvePeersConfig(config)
    // The ROOT listener sees every session's committed events (the firehose),
    // so a `peer/message` appended by anyone lands in the target's inbox; the
    // fold dedupes by key, so observing our own append is idempotent.
    ctx.on('session/event', (_session: Session, event: SessionEvent) => { this.record(event) })
    ctx.inject(['tools'], (toolsCtx) => { toolsCtx.tools.register(definePeerSendTool(this)) })
    registerPeersProjection(ctx)
  }

  /**
   * Deliver one message to a live session. The target session's log is the
   * inbox, so this appends `peer/message` there; a duplicate dedupe key
   * returns without appending and without waking.
   * @param sender - the sending agent (its session id names the sender).
   * @param input - target, body, delivery, and optional message id.
   * @returns the delivery outcome.
   * @throws {PeerSendError} on an unknown target, a self-send, an empty or
   *   oversized body, an invalid delivery mode, or a forbidden sender.
   */
  async send(sender: Agent, input: PeersSendInput): Promise<PeersSendResult> {
    const targetId = SessionId(String(input.targetId))
    const targetSession = this.ctx.get('sessions')?.get(targetId) ?? this.ctx.get('agents')?.get(targetId)?.session
    if (targetSession === undefined) {
      throw new PeerSendError(`peer_send: no live session or agent with id "${String(targetId)}"`, 'NO_TARGET')
    }
    if (String(sender.id) === String(targetId)) {
      throw new PeerSendError('peer_send: cannot send a peer message to yourself', 'SELF_SEND')
    }
    const text = input.content
    if (typeof text !== 'string' || text.trim() === '') {
      throw new PeerSendError('peer_send: content must be a non-empty string', 'EMPTY_CONTENT')
    }
    if (Buffer.byteLength(text, 'utf8') > this.config.maxContentBytes) {
      throw new PeerSendError(
        `peer_send: content exceeds maxContentBytes (${this.config.maxContentBytes} UTF-8 bytes)`,
        'CONTENT_TOO_LARGE',
      )
    }
    const delivery: PeerDelivery = input.delivery ?? 'wakeup'
    if (delivery !== 'quiet' && delivery !== 'wakeup') {
      throw new PeerSendError(`peer_send: delivery must be quiet|wakeup (got ${JSON.stringify(input.delivery)})`, 'BAD_DELIVERY')
    }
    // A negative grant from the optional org service is authoritative.
    const org = this.ctx.get('org') as OrgForbiddenProbe | undefined
    if (org?.isForbidden(sender.id, targetId) === true) {
      throw new PeerSendError(
        `peer_send: ${String(sender.id)} is forbidden from addressing ${String(targetId)}`,
        'FORBIDDEN',
      )
    }

    const messageId = input.messageId ?? this.#mintMessageId()
    const key = dedupeKey(sender.id, messageId)
    const existing = findMessage(this.inboxFor(targetId), key)
    if (existing !== undefined) {
      return { status: 'duplicate', message: existing, woke: false }
    }

    const snapshot: PeerMessageSnapshot = {
      id: key,
      senderId: sender.id,
      targetId,
      messageId,
      delivery,
      content: [{ type: 'text', text }],
      time: Date.now(),
    }
    const logged = targetSession.append('peer/message', snapshot)
    this.record(logged)

    const agent = this.ctx.get('agents')?.get(targetId)
    const woke = delivery === 'wakeup' && this.config.wakeupEnabled && agent !== undefined
    if (woke) agent?.followup(deliveryMessage(logged.data))
    return { status: 'delivered', message: logged.data, woke }
  }

  /**
   * The messages addressed to one session, in arrival order.
   * @param targetId - the addressed session id.
   * @returns a fresh array.
   */
  listMessages(targetId: SessionId | string): readonly PeerMessageSnapshot[] {
    return [...this.inboxFor(targetId)]
  }

  /**
   * Whether one exact message already exists in a target's inbox.
   * @param senderId - the sending session id.
   * @param messageId - the sender-scoped message id.
   * @param targetId - the addressed session id.
   * @returns true when the dedupe key is present.
   */
  has(senderId: SessionId | string, messageId: string, targetId: SessionId | string): boolean {
    return hasKey(this.inboxFor(targetId), dedupeKey(SessionId(String(senderId)), messageId))
  }

  /**
   * The size of one target's inbox.
   * @param targetId - the addressed session id.
   * @returns the number of folded messages.
   */
  inboxSize(targetId: SessionId | string): number {
    return this.inboxFor(targetId).length
  }

  /**
   * The target's inbox, seeded on first touch from its durable log so a
   * session that was resumed (or appended to before this plugin activated)
   * dedupes against history.
   * @param targetId - the addressed session id.
   * @returns the live inbox array (mutated only through {@link record}).
   */
  private inboxFor(targetId: SessionId | string): PeerMessageSnapshot[] {
    const key = String(targetId)
    const existing = this.#inboxes.get(key)
    if (existing !== undefined) return existing
    const session = this.ctx.get('sessions')?.get(SessionId(key))
    const seeded = session === undefined ? [] : foldPeerInbox(session.snapshotEvents())
    this.#inboxes.set(key, seeded)
    return seeded
  }

  /** Fold one committed event into the sending target's inbox, deduping by key. */
  private record(event: SessionEvent): void {
    if (event.type !== 'peer/message') return
    const snapshot = event.data
    const inbox = this.inboxFor(snapshot.targetId)
    if (hasKey(inbox, snapshot.id)) return
    this.#inboxes.set(String(snapshot.targetId), [...inbox, snapshot])
  }

  /** Mint a sender-scoped message id (`msg-<monotonic>-<random>`). */
  #mintMessageId(): string {
    this.#messageCounter += 1
    return `msg-${this.#messageCounter}-${Math.random().toString(36).slice(2, 10)}`
  }
}

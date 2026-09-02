/**
 * WeChat platform adapter: the poll loop, inbound pipeline, and outbound
 * delivery, mirroring hermes `WeixinAdapter` (`connect`/`disconnect`/`send`/
 * `send_typing`/`stop_typing`/`get_chat_info`, `_poll_loop`,
 * `_process_message`) against the design's `BasePlatformAdapter` interface.
 * @module @dsh-plugin/dsh-channel-wechat/adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Config } from './config.ts'
import { resolveStateDir } from './config.ts'
import { ILinkClient } from './ilink/client.ts'
import { BACKOFF_DELAY_SECONDS, DEFAULT_LONG_POLL_TIMEOUT_MS, MAX_CONSECUTIVE_FAILURES, RETRY_DELAY_SECONDS, isSessionExpired, isStaleSessionRet, SESSION_EXPIRED_ERRCODE, RATE_LIMIT_ERRCODE } from './ilink/client.ts'
import { MessageDeduplicator, processInbound, TextDebouncer, type InboundEvent, type InboundVerdict } from './inbound.ts'
import { SPLIT_THRESHOLD, WeChatOutbound } from './outbound.ts'
import { type PairingStore } from './pairing.ts'
import { sessionKeyForPeer, type WeChatSessionManager } from './session-map.ts'
import { AccountStore, ContextTokenStore, SyncStore } from './state.ts'
import { join } from 'node:path'

/** Send result shape (hermes `SendResult`). */
export interface SendResult {
  success: boolean
  messageId?: string
  error?: string
}

/** Chat info shape (hermes `get_chat_info`). */
export interface ChatInfo {
  name: string
  type: 'dm' | 'group'
  chat_id: string
}

/** Live poll-loop state, surfaced by `/wechat status`. */
export interface PollState {
  running: boolean
  lastPollAt?: number
  consecutiveFailures: number
  syncBufLength: number
  messagesProcessed: number
  lastError?: string
}

/** Construction options for the adapter. */
export interface WeChatAdapterOptions {
  ctx: Context
  config: Config
  client: ILinkClient
  accountStore: AccountStore
  tokenStore: ContextTokenStore
  syncStore: SyncStore
  pairingStore: PairingStore
  outbound: WeChatOutbound
  sessionManager: WeChatSessionManager
  logger: (message: string, ...args: unknown[]) => void
}

/** Map a dsh session key back to the outbound chat id (`weixin:dm:X` → X; `weixin:group:Y...` → Y). */
export function chatIdFromSessionKey(sessionId: SessionId): string {
  const key = String(sessionId)
  if (key.startsWith('weixin:group:')) {
    return key.slice('weixin:group:'.length).split(':')[0] ?? ''
  }
  if (key.startsWith('weixin:dm:')) {
    return key.slice('weixin:dm:'.length)
  }
  return key
}

/** The sessions-service surface the channel needs to record its status. */
export interface ChannelSessionSource {
  get(id: string): Session | undefined
  list(): readonly Session[]
}

/**
 * Choose the session that records the channel-global `wechat/channel`
 * status: the channel's own most recent mapped peer session if any, else the
 * most recent live session, else none.
 *
 * Channel events are not per-session — the dsh event log is session-bound,
 * so the status mirror lands on ONE session and the projection unit folds it
 * per-session. Documented limitation: a session created after the last
 * event has no mirror until the next connect/disconnect (a fresh session's
 * badge reads the absent-key default).
 */
export function pickChannelSession(
  source: ChannelSessionSource | undefined,
  managed: readonly string[],
): Session | undefined {
  if (source === undefined) return undefined
  for (let i = managed.length - 1; i >= 0; i--) {
    const id = managed[i]
    if (id === undefined) continue
    const session = source.get(id)
    if (session !== undefined) return session
  }
  const all = source.list()
  return all.length > 0 ? all.at(-1) : undefined
}

/**
 * One long-poll loop instance per account (single account in v1). Started
 * and stopped via `ctx.effect`; aborts the in-flight poll on stop.
 */
export class WeChatAdapter {
  readonly accountId: string
  private readonly ctx: Context
  private readonly config: Config
  private readonly client: ILinkClient
  private readonly tokenStore: ContextTokenStore
  private readonly syncStore: SyncStore
  private readonly pairingStore: PairingStore
  private readonly outbound: WeChatOutbound
  private readonly sessionManager: WeChatSessionManager
  private readonly log: (message: string, ...args: unknown[]) => void

  private readonly dedup = new MessageDeduplicator()
  private readonly debouncer: TextDebouncer
  private readonly pollAbort = new AbortController()
  private pollTask: Promise<void> | undefined
  private running = false

  readonly pollState: PollState = {
    running: false,
    consecutiveFailures: 0,
    syncBufLength: 0,
    messagesProcessed: 0,
  }

  /** Per-peer send serialization (chunks of one peer must arrive in order). */
  private readonly peerTails = new Map<string, Promise<void>>()

  constructor(options: WeChatAdapterOptions) {
    this.ctx = options.ctx
    this.config = options.config
    this.client = options.client
    this.tokenStore = options.tokenStore
    this.syncStore = options.syncStore
    this.pairingStore = options.pairingStore
    this.outbound = options.outbound
    this.sessionManager = options.sessionManager
    this.log = options.logger
    this.accountId = options.config.accountId
    this.debouncer = new TextDebouncer({
      quietSeconds: this.config.textBatchDelaySeconds,
      splitQuietSeconds: this.config.textBatchSplitDelaySeconds,
      splitThreshold: SPLIT_THRESHOLD,
      dispatch: (event) => this.dispatchEvent(event),
    })
  }

  // ----- lifecycle -----

  /** Start the poll loop (hermes `connect`). */
  connect(): void {
    if (this.running) return
    this.running = true
    this.pollState.running = true
    this.pollTask = this.pollLoop()
    void this.pollTask.catch((error) => {
      this.log(`wechat: poll loop exited: ${String(error)}`)
      this.pollState.running = false
      this.pollState.lastError = String(error)
    })
  }

  /** Stop the poll loop, flush debounce queues, cancel pending media (hermes `disconnect`). */
  async disconnect(): Promise<void> {
    this.running = false
    this.pollState.running = false
    this.pollAbort.abort()
    this.debouncer.flushAll()
    if (this.pollTask) {
      try {
        await this.pollTask
      } catch {
        // loop error already surfaced
      }
      this.pollTask = undefined
    }
    await this.drainPeerTails()
  }

  /**
   * The channel-global state (whether the poll loop is running and under which
   * account). Replaces the old `wechat/channel` session-event mirror; the
   * `wechatChannel` projection reads this getter.
   */
  status(): { connected: boolean; account: string } {
    return { connected: this.running, account: this.accountId }
  }


  private async drainPeerTails(): Promise<void> {
    await Promise.allSettled([...this.peerTails.values()])
    this.peerTails.clear()
  }

  // ----- polling -----

  private async pollLoop(): Promise<void> {
    let syncBuf = this.syncStore.load(this.accountId)
    this.pollState.syncBufLength = syncBuf.length
    let timeoutMs = this.config.longPollTimeoutMs || DEFAULT_LONG_POLL_TIMEOUT_MS
    let consecutiveFailures = 0

    while (this.running) {
      try {
        const response = await this.client.getUpdates(syncBuf, timeoutMs, this.pollAbort.signal)
        const suggested = response.longpolling_timeout_ms
        if (typeof suggested === 'number' && suggested > 0) timeoutMs = suggested
        this.pollState.lastPollAt = Date.now()

        const ret = response.ret ?? 0
        const errcode = response.errcode ?? 0
        const errmsg = response.errmsg
        if (ret !== 0 || errcode !== 0) {
          if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE
            || isStaleSessionRet(ret, errcode, errmsg)) {
            this.log('wechat: session expired; pausing for 10 minutes')
            this.pollState.lastError = `session expired (ret=${ret} errcode=${errcode})`
            await this.sleepAbortable(600)
            consecutiveFailures = 0
            continue
          }
          consecutiveFailures += 1
          this.pollState.consecutiveFailures = consecutiveFailures
          this.pollState.lastError = `getUpdates failed ret=${ret} errcode=${errcode} errmsg=${errmsg ?? ''}`
          this.log(this.pollState.lastError)
          await this.sleepAbortable(
            consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_SECONDS : RETRY_DELAY_SECONDS,
          )
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
          continue
        }

        consecutiveFailures = 0
        this.pollState.consecutiveFailures = 0
        this.pollState.lastError = undefined
        const newSyncBuf = String(response.get_updates_buf ?? '')
        if (newSyncBuf) {
          syncBuf = newSyncBuf
          this.pollState.syncBufLength = syncBuf.length
          this.syncStore.save(this.accountId, syncBuf)
        }

        for (const message of response.msgs) {
          this.pollState.messagesProcessed += 1
          void this.processMessageSafe(message)
        }
      } catch (error) {
        if (this.pollAbort.signal.aborted) break
        consecutiveFailures += 1
        this.pollState.consecutiveFailures = consecutiveFailures
        this.pollState.lastError = String(error)
        this.log(`wechat: poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(error)}`)
        await this.sleepAbortable(
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_SECONDS : RETRY_DELAY_SECONDS,
        )
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
      }
    }
  }

  private sleepAbortable(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pollAbort.signal.removeEventListener('abort', onAbort)
        resolve()
      }, seconds * 1000)
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.pollAbort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  // ----- inbound -----

  private async processMessageSafe(message: Record<string, unknown>): Promise<void> {
    try {
      await this.processMessage(message)
    } catch (error) {
      this.log(`wechat: unhandled inbound error from=${String(message['from_user_id'] ?? '')}: ${String(error)}`)
    }
  }

  private async processMessage(message: Record<string, unknown>): Promise<void> {
    const sessionKeyFor = (chatType: 'dm' | 'group', chatId: string, senderId: string, msg: Record<string, unknown>): string =>
      sessionKeyForPeer(chatType, chatId, senderId, msg, this.config)

    const verdict = await processInbound(message, {
      accountId: this.accountId,
      config: this.config,
      dedup: this.dedup,
      media: {
        client: this.client,
        cacheDir: join(resolveStateDir(this.config), 'media-cache'),
      },
      sessionKeyFor,
      isApproved: (userId) => this.pairingStore.isApproved('weixin', userId),
    })

    switch (verdict.kind) {
      case 'drop':
      case 'denied':
        return
      case 'pairing':
        await this.handlePairing(verdict)
        return
      case 'message':
        await this.handleMessage(verdict.event)
        return
    }
  }

  private async handlePairing(verdict: Extract<InboundVerdict, { kind: 'pairing' }>): Promise<void> {
    const { senderId, chatId, contextToken } = verdict
    // hermes rate-limits ALL pairing responses per user to avoid spam.
    if (this.pairingStore.isRateLimited('weixin', senderId)) return
    const code = await this.pairingStore.generateCode('weixin', senderId, senderId)
    if (code) {
      this.log(`wechat: offered pairing code to ${senderId}`)
      await this.outbound.sendText(
        chatId,
        "Hi~ I don't recognize you yet!\n\n"
        + `Here's your pairing code: \`${code}\`\n\n`
        + 'Ask the bot owner to approve it with:\n'
        + `/wechat pairing approve ${code}`,
        contextToken,
      )
    } else {
      await this.outbound.sendText(
        chatId,
        'Too many pairing requests right now~ Please try again later!',
        contextToken,
      )
      this.pairingStore.recordRateLimitFor('weixin', senderId)
    }
  }

  private async handleMessage(event: InboundEvent): Promise<void> {
    if (event.contextToken) {
      this.tokenStore.set(this.accountId, event.chatId, event.contextToken)
    }
    void this.maybeFetchTypingTicket(event.chatId, event.contextToken)

    if (event.mediaPaths.length === 0) {
      this.debouncer.enqueue(event)
    } else {
      await this.dispatchEvent(event)
    }
  }

  private async dispatchEvent(event: InboundEvent): Promise<void> {
    try {
      await this.sessionManager.followup(event.sessionKey, event.text)
    } catch (error) {
      this.log(`wechat: followup failed for ${event.sessionKey}: ${String(error)}`)
    }
  }

  private async maybeFetchTypingTicket(userId: string, contextToken: string | undefined): Promise<void> {
    if (this.outbound.hasTypingTicket(userId)) return
    try {
      const response = await this.client.getConfig(userId, contextToken)
      const ticket = String(response['typing_ticket'] ?? '')
      if (ticket) this.outbound.cacheTypingTicket(userId, ticket)
    } catch {
      // debug-level noise in hermes; skip
    }
  }

  // ----- outbound -----

  /** Serialized per-peer outbound send (chunks must arrive in order). */
  enqueueSend(chatId: string, content: string): void {
    const prev = this.peerTails.get(chatId) ?? Promise.resolve()
    const next = prev
      .then(() => this.send(chatId, content))
      .then((result) => {
        if (!result.success) this.log(`wechat: send failed to ${chatId}: ${result.error ?? ''}`)
      })
      .catch((error) => this.log(`wechat: send error to ${chatId}: ${String(error)}`))
    this.peerTails.set(chatId, next)
    void next.finally(() => {
      if (this.peerTails.get(chatId) === next) this.peerTails.delete(chatId)
    })
  }

  /** Serialized per-peer typing signal. */
  enqueueTyping(chatId: string, kind: 'start' | 'stop'): void {
    const prev = this.peerTails.get(chatId) ?? Promise.resolve()
    const next = prev.then(() => (
      kind === 'start' ? this.outbound.sendTypingStart(chatId) : this.outbound.sendTypingStop(chatId)
    )).catch((error) => this.log(`wechat: typing ${kind} failed for ${chatId}: ${String(error)}`))
    this.peerTails.set(chatId, next)
    void next.finally(() => {
      if (this.peerTails.get(chatId) === next) this.peerTails.delete(chatId)
    })
  }

  /** Send one payload to a peer (hermes `WeixinAdapter.send`). */
  async send(chatId: string, content: string): Promise<SendResult> {
    if (!this.running) return { success: false, error: 'Not connected' }
    const contextToken = this.tokenStore.get(this.accountId, chatId)
    try {
      await this.outbound.sendContent(chatId, content, contextToken, (path, error) => {
        this.log(`wechat: media delivery failed for ${path}: ${String(error)}`)
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Typing start (hermes `send_typing`). */
  async sendTyping(chatId: string): Promise<void> {
    await this.outbound.sendTypingStart(chatId)
  }

  /** Typing stop (hermes `stop_typing`). */
  async stopTyping(chatId: string): Promise<void> {
    await this.outbound.sendTypingStop(chatId)
  }

  /** Chat info (hermes `get_chat_info`). */
  getChatInfo(chatId: string): ChatInfo {
    const type = chatId.endsWith('@chatroom') ? 'group' : 'dm'
    return { name: chatId, type, chat_id: chatId }
  }
}

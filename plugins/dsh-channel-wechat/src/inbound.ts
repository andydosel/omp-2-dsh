/**
 * Inbound normalization for iLink messages, mirroring hermes
 * `gateway/platforms/weixin.py` (`_guess_chat_type`, `_extract_text`,
 * `_process_message`) and `helpers.py` (`MessageDeduplicator`).
 *
 * Pipeline: sender/self filter → message_id dedup (TTL 300s) → text md5
 * fingerprint dedup → chat-type guess → DM/group policy gate → context_token
 * persistence → media download/decrypt → voice transcription preference →
 * text debounce merge (3s quiet; 5s when the last chunk >= 1800 chars).
 * @module @dsh-plugin/dsh-channel-wechat/inbound
 */

import { createHash } from 'node:crypto'
import type { Config } from './config.ts'
import { ITEM_IMAGE, ITEM_TEXT, ITEM_VIDEO, ITEM_VOICE, ITEM_FILE } from './ilink/client.ts'
import type { ILinkClient } from './ilink/client.ts'
import { cacheMediaBytes, downloadAndDecryptMedia, imageAesKey, mediaReference } from './ilink/media.ts'

/** Message dedup cache (hermes `MessageDeduplicator`, TTL 300s / cap 2000). */
export class MessageDeduplicator {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly ttlSeconds = 300,
    private readonly maxSize = 2000,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  /** True when `msgId` was seen within the TTL window (and re-recorded). */
  isDuplicate(msgId: string): boolean {
    if (!msgId) return false
    const now = this.now()
    const seenAt = this.seen.get(msgId)
    if (seenAt !== undefined) {
      if (now - seenAt < this.ttlSeconds) return true
      this.seen.delete(msgId)
    }
    this.seen.set(msgId, now)
    if (this.seen.size > this.maxSize) {
      const cutoff = now - this.ttlSeconds
      for (const [key, value] of this.seen) {
        if (value <= cutoff) this.seen.delete(key)
      }
      if (this.seen.size > this.maxSize) {
        const newest = [...this.seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.maxSize)
        this.seen.clear()
        for (const [key, value] of newest) this.seen.set(key, value)
      }
    }
    return false
  }
}

/** Chat-type + effective chat id (hermes `_guess_chat_type`). */
export function guessChatType(
  message: Record<string, unknown>,
  accountId: string,
): { chatType: 'dm' | 'group'; effectiveChatId: string } {
  const roomId = String(message['room_id'] ?? message['chat_room_id'] ?? '').trim()
  const toUserId = String(message['to_user_id'] ?? '').trim()
  const isGroup = Boolean(roomId)
    || (Boolean(toUserId) && Boolean(accountId) && toUserId !== accountId && message['msg_type'] === 1)
  if (isGroup) {
    return {
      chatType: 'group',
      effectiveChatId: roomId || toUserId || String(message['from_user_id'] ?? ''),
    }
  }
  return { chatType: 'dm', effectiveChatId: String(message['from_user_id'] ?? '') }
}

/**
 * Extract user-visible text from an item list (hermes `_extract_text`):
 * first `ITEM_TEXT` (with `ref_msg` quoting), else voice transcription.
 */
export function extractText(itemList: Record<string, unknown>[]): string {
  for (const item of itemList) {
    if (item['type'] === ITEM_TEXT) {
      const textItem = asRecord(item['text_item'])
      const text = String(textItem['text'] ?? '')
      const ref = asRecord(item['ref_msg'])
      const refItem = asRecord(ref['message_item'])
      const refType = refItem['type']
      if (refType === ITEM_IMAGE || refType === ITEM_VIDEO || refType === ITEM_FILE || refType === ITEM_VOICE) {
        const title = String(ref['title'] ?? '')
        const prefix = title ? `[引用媒体: ${title}]\n` : '[引用媒体]\n'
        return `${prefix}${text}`.trim()
      }
      if (Object.keys(refItem).length > 0) {
        const parts: string[] = []
        if (ref['title']) parts.push(String(ref['title']))
        const refText = extractText([refItem])
        if (refText) parts.push(refText)
        if (parts.length > 0) return `[引用: ${parts.join(' | ')}]\n${text}`.trim()
      }
      return text
    }
  }
  for (const item of itemList) {
    if (item['type'] === ITEM_VOICE) {
      const voiceText = String((asRecord(item['voice_item'])['text']) ?? '')
      if (voiceText) return voiceText
    }
  }
  return ''
}

/** Media kinds present in the item list, for message typing. */
export function collectMediaTypes(itemList: Record<string, unknown>[]): string[] {
  const types: string[] = []
  for (const item of itemList) {
    switch (item['type']) {
      case ITEM_IMAGE: types.push('image/jpeg'); break
      case ITEM_VIDEO: types.push('video/mp4'); break
      case ITEM_FILE: types.push('application/octet-stream'); break
      case ITEM_VOICE: types.push('audio/silk'); break
      default: break
    }
  }
  return types
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** A normalized inbound message ready for session dispatch. */
export interface InboundEvent {
  /** Stable dsh session key for this peer. */
  sessionKey: string
  /** Rendered user text (voice transcription preferred). */
  text: string
  chatType: 'dm' | 'group'
  chatId: string
  senderId: string
  messageId?: string
  /** Locally cached, decrypted media file paths (appended to text). */
  mediaPaths: string[]
  mediaTypes: string[]
  contextToken?: string
}

/** Why a message was not dispatched. */
export type InboundVerdict =
  | { kind: 'drop'; reason: string }
  | { kind: 'pairing'; senderId: string; chatId: string; sessionKey: string; contextToken?: string }
  | { kind: 'denied'; reason: string; senderId: string }
  | { kind: 'message'; event: InboundEvent }

/** DM/group policy evaluation (hermes `_is_dm_allowed` + group gate in `_process_message`). */
export function gatePolicy(
  config: Config,
  senderId: string,
  chatType: 'dm' | 'group',
  chatId: string,
): { allowed: boolean; needsPairing: boolean } {
  if (chatType === 'group') {
    if (config.groupPolicy === 'disabled') return { allowed: false, needsPairing: false }
    if (config.groupPolicy === 'allowlist' && !config.groupAllowedUsers.includes(chatId)) {
      return { allowed: false, needsPairing: false }
    }
    return { allowed: true, needsPairing: false }
  }
  switch (config.dmPolicy) {
    case 'disabled': return { allowed: false, needsPairing: false }
    case 'allowlist': return { allowed: config.allowedUsers.includes(senderId), needsPairing: false }
    case 'pairing': return { allowed: false, needsPairing: true }
    default: return { allowed: true, needsPairing: false }
  }
}

/** Media download context the normalizer needs. */
export interface InboundMediaContext {
  client: ILinkClient
  cacheDir: string
}

/**
 * Process one raw iLink message into a verdict. Pure-ish: side effects are
 * limited to the dedup cache and (when `media` is provided) media download
 * + cache writes.
 */
export async function processInbound(
  message: Record<string, unknown>,
  options: {
    accountId: string
    config: Config
    dedup: MessageDeduplicator
    media?: InboundMediaContext
    /** Pairing-policy admission: whether the sender is already approved. */
    isApproved?: (userId: string) => boolean
    sessionKeyFor: (chatType: 'dm' | 'group', chatId: string, senderId: string, message: Record<string, unknown>) => string
  },
): Promise<InboundVerdict> {
  const senderId = String(message['from_user_id'] ?? '').trim()
  if (!senderId) return { kind: 'drop', reason: 'empty sender' }
  if (senderId === options.accountId) return { kind: 'drop', reason: 'self message' }

  const messageId = String(message['message_id'] ?? '').trim()
  if (messageId && options.dedup.isDuplicate(messageId)) {
    return { kind: 'drop', reason: 'duplicate message_id' }
  }

  const itemList = Array.isArray(message['item_list']) ? message['item_list'] as Record<string, unknown>[] : []
  const text = extractText(itemList)
  if (text) {
    const contentKey = `content:${senderId}:${createHash('md5').update(text, 'utf-8').digest('hex')}`
    if (options.dedup.isDuplicate(contentKey)) {
      return { kind: 'drop', reason: 'duplicate content fingerprint' }
    }
  }

  const { chatType, effectiveChatId } = guessChatType(message, options.accountId)
  const sessionKey = options.sessionKeyFor(chatType, effectiveChatId, senderId, message)
  const contextToken = String(message['context_token'] ?? '').trim() || undefined

  const gate = gatePolicy(options.config, senderId, chatType, effectiveChatId)
  if (!gate.allowed) {
    if (gate.needsPairing) {
      // pairing policy admits approved users and offers codes to strangers
      if (!(options.isApproved?.(senderId) ?? false)) {
        return { kind: 'pairing', senderId, chatId: effectiveChatId, sessionKey, contextToken }
      }
    } else {
      return { kind: 'denied', reason: `${chatType} policy ${chatType === 'group' ? options.config.groupPolicy : options.config.dmPolicy}`, senderId }
    }
  }

  const mediaPaths: string[] = []
  const mediaTypes = collectMediaTypes(itemList)
  if (options.media) {
    for (const item of itemList) {
      await collectInboundMedia(options.media, item, mediaPaths)
      const refItem = asRecord(asRecord(item['ref_msg'])['message_item'])
      if (Object.keys(refItem).length > 0) {
        await collectInboundMedia(options.media, refItem, mediaPaths)
      }
    }
  }

  if (!text && mediaPaths.length === 0) return { kind: 'drop', reason: 'no text and no media' }

  let finalText = text
  if (mediaPaths.length > 0) {
    const mediaLines = mediaPaths.map((p) => `[Media: ${p}]`).join('\n')
    finalText = finalText ? `${finalText}\n${mediaLines}` : mediaLines
  }

  return {
    kind: 'message',
    event: {
      sessionKey,
      text: finalText,
      chatType,
      chatId: effectiveChatId,
      senderId,
      messageId: messageId || undefined,
      mediaPaths,
      mediaTypes,
      contextToken,
    },
  }
}

/** Download + decrypt + cache one media item (hermes `_collect_media`). */
export async function collectInboundMedia(
  context: InboundMediaContext,
  item: Record<string, unknown>,
  paths: string[],
): Promise<void> {
  try {
    switch (item['type']) {
      case ITEM_IMAGE: {
        const data = await downloadAndDecryptMedia(context.client, {
          encryptedQueryParam: mediaReference(item, 'image_item')['encrypt_query_param'] as string | undefined,
          aesKeyB64: imageAesKey(item),
          fullUrl: mediaReference(item, 'image_item')['full_url'] as string | undefined,
          timeoutSeconds: 30,
        })
        paths.push(cacheMediaBytes(context.cacheDir, 'image.jpg', data))
        break
      }
      case ITEM_VIDEO: {
        const data = await downloadAndDecryptMedia(context.client, {
          encryptedQueryParam: mediaReference(item, 'video_item')['encrypt_query_param'] as string | undefined,
          aesKeyB64: mediaReference(item, 'video_item')['aes_key'] as string | undefined,
          fullUrl: mediaReference(item, 'video_item')['full_url'] as string | undefined,
          timeoutSeconds: 120,
        })
        paths.push(cacheMediaBytes(context.cacheDir, 'video.mp4', data))
        break
      }
      case ITEM_FILE: {
        const fileItem = asRecord(item['file_item'])
        const media = asRecord(fileItem['media'])
        const filename = String(fileItem['file_name'] ?? 'document.bin')
        const data = await downloadAndDecryptMedia(context.client, {
          encryptedQueryParam: media['encrypt_query_param'] as string | undefined,
          aesKeyB64: media['aes_key'] as string | undefined,
          fullUrl: media['full_url'] as string | undefined,
          timeoutSeconds: 60,
        })
        paths.push(cacheMediaBytes(context.cacheDir, filename, data))
        break
      }
      case ITEM_VOICE: {
        const voiceItem = asRecord(item['voice_item'])
        if (voiceItem['text']) return // transcription preferred; skip download
        const media = asRecord(voiceItem['media'])
        const data = await downloadAndDecryptMedia(context.client, {
          encryptedQueryParam: media['encrypt_query_param'] as string | undefined,
          aesKeyB64: media['aes_key'] as string | undefined,
          fullUrl: media['full_url'] as string | undefined,
          timeoutSeconds: 60,
        })
        paths.push(cacheMediaBytes(context.cacheDir, 'voice.silk', data))
        break
      }
      default:
        break
    }
  } catch {
    // hermes logs and continues without the media
  }
}

/** Session-scoped text debounce merge (hermes `_enqueue_text_event`/`_flush_text_batch`). */
export class TextDebouncer {
  private readonly pending = new Map<string, InboundEvent>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly options: {
      quietSeconds: number
      splitQuietSeconds: number
      splitThreshold: number
      dispatch: (event: InboundEvent) => Promise<void> | void
    },
  ) {}

  /** Buffer a text event, cancel the previous timer, and re-arm the flush. */
  enqueue(event: InboundEvent): void {
    const key = event.sessionKey
    const existing = this.pending.get(key)
    if (existing === undefined) {
      this.pending.set(key, event)
    } else {
      if (event.text) {
        existing.text = existing.text ? `${existing.text}\n${event.text}` : event.text
      }
      existing.mediaPaths.push(...event.mediaPaths)
      existing.mediaTypes.push(...event.mediaTypes)
    }
    const prior = this.timers.get(key)
    if (prior !== undefined) clearTimeout(prior)
    const last = this.pending.get(key)!
    const delayMs = (last.text.length >= this.options.splitThreshold
      ? this.options.splitQuietSeconds
      : this.options.quietSeconds) * 1000
    this.timers.set(key, setTimeout(() => {
      void this.flush(key)
    }, delayMs))
  }

  /** Flush one session immediately (used by graceful shutdown). */
  flush(key: string): Promise<void> | void {
    const timer = this.timers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
    const event = this.pending.get(key)
    if (!event) return
    this.pending.delete(key)
    return this.options.dispatch(event)
  }

  /** Flush everything (disconnect). */
  flushAll(): Promise<void>[] {
    return [...this.pending.keys()].map((key) => this.flush(key) as Promise<void>).filter(Boolean)
  }

  get pendingCount(): number {
    return this.pending.size
  }
}

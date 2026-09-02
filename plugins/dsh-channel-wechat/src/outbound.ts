/**
 * Outbound delivery: text chunking (≤2000 chars, 1.5s inter-chunk delay),
 * context_token echo, errcode -14 token-downgrade retry, -2 rate-limit
 * backoff, typing start/stop, and media-first delivery — mirroring hermes
 * `WeixinAdapter` (`_split_text_for_weixin_delivery`, `_send_text_chunk`,
 * `send`, `send_typing`, `_wrap_copy_friendly_lines_for_weixin`).
 *
 * send-final-only: WeChat cannot edit messages, so every chunk carries
 * `message_state: 2` (finish) and is never revised.
 * @module @dsh-plugin/dsh-channel-wechat/outbound
 */

import type { ILinkClient, ILinkResponse } from './ilink/client.ts'
import { isRateLimited, isSessionExpired, TYPING_START, TYPING_STOP } from './ilink/client.ts'
import { extractLocalFiles, extractMedia, sendFile, type ExtractedMedia } from './ilink/media.ts'
import type { ContextTokenStore } from './state.ts'

/** Default per-message length cap (hermes `MAX_MESSAGE_LENGTH`). */
export const MAX_MESSAGE_LENGTH = 2000
/** Chunk boundary for the debounce split delay (hermes `_SPLIT_THRESHOLD`). */
export const SPLIT_THRESHOLD = 1800

const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/
const TABLE_RULE_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/
const FENCE_RE = /^```([^\n`]*)\s*$/
const WEIXIN_COPY_LINE_WIDTH = 120

/** Normalize markdown blocks: collapse blank runs outside code fences (hermes `_normalize_markdown_blocks`). */
export function normalizeMarkdownBlocks(content: string): string {
  const result: string[] = []
  let inCodeBlock = false
  let blankRun = 0
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (FENCE_RE.test(line.trim())) {
      inCodeBlock = !inCodeBlock
      result.push(line)
      blankRun = 0
      continue
    }
    if (inCodeBlock) {
      result.push(line)
      continue
    }
    if (!line.trim()) {
      blankRun += 1
      if (blankRun <= 1) result.push('')
      continue
    }
    blankRun = 0
    result.push(line)
  }
  return result.join('\n').trim()
}

/** Wrap display lines longer than 120 chars so they are copyable in WeChat (hermes `_wrap_copy_friendly_lines_for_weixin`). */
export function wrapCopyFriendlyLines(content: string): string {
  if (!content) return content
  const wrapped: string[] = []
  let inCodeBlock = false
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const stripped = line.trim()
    if (FENCE_RE.test(stripped)) {
      inCodeBlock = !inCodeBlock
      wrapped.push(line)
      continue
    }
    if (
      inCodeBlock
      || line.length <= WEIXIN_COPY_LINE_WIDTH
      || !stripped
      || stripped.startsWith('|')
      || TABLE_RULE_RE.test(stripped)
    ) {
      wrapped.push(line)
      continue
    }
    const splitLines = wrapLine(line, WEIXIN_COPY_LINE_WIDTH)
    wrapped.push(...(splitLines.length > 0 ? splitLines : [line]))
  }
  return wrapped.join('\n').trim()
}

function wrapLine(line: string, width: number): string[] {
  const out: string[] = []
  let current = ''
  for (const token of line.split(/(\s+)/)) {
    if (!token) continue
    if (current.length + token.length <= width || current.length === 0) {
      current += token
    } else {
      out.push(current.trim())
      current = token
    }
  }
  if (current) out.push(current.trim())
  return out
}

/** The full WeChat text pre-format (hermes `format_message`). */
export function formatWechatText(content: string): string {
  return wrapCopyFriendlyLines(normalizeMarkdownBlocks(content))
}

/** Split markdown into top-level blocks, keeping fenced code blocks intact (hermes `_split_markdown_blocks`). */
export function splitMarkdownBlocks(content: string): string[] {
  if (!content) return []
  const blocks: string[] = []
  let current: string[] = []
  let inCodeBlock = false
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (FENCE_RE.test(line.trim())) {
      if (!inCodeBlock && current.length > 0) {
        blocks.push(current.join('\n').trim())
        current = []
      }
      current.push(line)
      inCodeBlock = !inCodeBlock
      if (!inCodeBlock) {
        blocks.push(current.join('\n').trim())
        current = []
      }
      continue
    }
    if (inCodeBlock) {
      current.push(line)
      continue
    }
    if (!line.trim()) {
      if (current.length > 0) {
        blocks.push(current.join('\n').trim())
        current = []
      }
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current.join('\n').trim())
  return blocks.filter((block) => block.length > 0)
}

function looksLikeChattyLine(line: string): boolean {
  const stripped = line.trim()
  if (!stripped) return false
  if (stripped.length > 48) return false
  if (line.startsWith(' ') || line.startsWith('\t')) return false
  if (stripped.startsWith('>') || stripped.startsWith('-') || stripped.startsWith('*')
    || stripped.startsWith('【') || stripped.startsWith('#') || stripped.startsWith('|')) return false
  if (TABLE_RULE_RE.test(stripped)) return false
  if (/^\*\*[^*]+\*\*$/.test(stripped)) return false
  if (/^\d+\.\s/.test(stripped)) return false
  return true
}

function looksLikeHeadingLine(line: string): boolean {
  const stripped = line.trim()
  if (!stripped) return false
  if (HEADER_RE.test(stripped)) return true
  return stripped.length <= 24 && (stripped.endsWith(':') || stripped.endsWith('：'))
}

function shouldSplitShortChatBlock(block: string): boolean {
  const lines = block.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2 || lines.length > 6) return false
  if (looksLikeHeadingLine(lines[0]!)) return false
  return lines.every((line) => looksLikeChattyLine(line))
}

/** Split a long message into chunks, preserving code fences + "(i/n)" indicators (hermes `truncate_message`). */
export function truncateMessage(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content]
  const INDICATOR_RESERVE = 10
  const FENCE_CLOSE = '\n```'
  const chunks: string[] = []
  let remaining = content
  let carryLang: string | undefined

  while (remaining) {
    const prefix = carryLang !== undefined ? `\`\`\`${carryLang}\n` : ''
    const totalChunks = estimateChunkCount(remaining, maxLength, prefix)
    const indicator = chunks.length + 1 === totalChunks ? '' : ` (${chunks.length + 1}/${totalChunks})`
    let headroom = maxLength - INDICATOR_RESERVE - prefix.length - FENCE_CLOSE.length - indicator.length
    if (headroom < 1) headroom = Math.floor(maxLength / 2)

    if (prefix.length + remaining.length <= maxLength - indicator.length) {
      chunks.push(prefix + remaining)
      break
    }

    const region = remaining.slice(0, headroom)
    let splitAt = region.lastIndexOf('\n')
    if (splitAt < Math.floor(headroom / 2)) splitAt = region.lastIndexOf(' ')
    if (splitAt < 1) splitAt = headroom

    // Avoid splitting inside an inline code span.
    const candidate = remaining.slice(0, splitAt)
    const backtickCount = (candidate.match(/`/g) ?? []).length - (candidate.match(/\\`/g) ?? []).length
    if (backtickCount % 2 === 1) {
      const lastBt = candidate.lastIndexOf('`')
      let safe = Math.max(candidate.lastIndexOf(' ', lastBt), candidate.lastIndexOf('\n', lastBt))
      if (safe > Math.floor(headroom / 4)) splitAt = safe
    }

    const chunkBody = remaining.slice(0, splitAt)
    remaining = remaining.slice(splitAt).replace(/^\s+/, '')

    const fullChunk = prefix + chunkBody
    chunks.push(fullChunk)

    // Determine whether the chunk ends inside an open code fence.
    let inCode = carryLang !== undefined
    const lang = carryLang ?? ''
    for (const line of chunkBody.split('\n')) {
      if (FENCE_RE.test(line.trim())) inCode = !inCode
    }
    if (inCode) {
      carryLang = lang
      chunks[chunks.length - 1] = fullChunk + FENCE_CLOSE
    } else {
      carryLang = undefined
    }
  }
  return chunks
}

function estimateChunkCount(remaining: string, maxLength: number, prefix: string): number {
  // Rough estimate for the "(i/n)" indicator; final chunking is exact.
  const usable = Math.max(maxLength - 10, 100)
  return Math.max(1, Math.ceil((prefix.length + remaining.length) / usable))
}

/** Pack markdown blocks into max-length messages (hermes `_pack_markdown_blocks_for_weixin`). */
export function packMarkdownBlocks(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content]
  const packed: string[] = []
  let current = ''
  for (const block of splitMarkdownBlocks(content)) {
    const candidate = current ? `${current}\n\n${block}` : block
    if (candidate.length <= maxLength) {
      current = candidate
      continue
    }
    if (current) {
      packed.push(current)
      current = ''
    }
    if (block.length <= maxLength) {
      current = block
      continue
    }
    packed.push(...truncateMessage(block, maxLength))
  }
  if (current) packed.push(current)
  return packed
}

/** Split delivery units (one message per top-level line, code fences intact) — hermes `_split_delivery_units_for_weixin`. */
export function splitDeliveryUnits(content: string): string[] {
  const units: string[] = []
  for (const block of splitMarkdownBlocks(content)) {
    if (FENCE_RE.test(block.split('\n')[0]!.trim())) {
      units.push(block)
      continue
    }
    let current: string[] = []
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\s+$/, '')
      if (!line.trim()) {
        if (current.length > 0) {
          units.push(current.join('\n').trim())
          current = []
        }
        continue
      }
      const isContinuation = current.length > 0 && (rawLine.startsWith(' ') || rawLine.startsWith('\t'))
      if (isContinuation) {
        current.push(line)
        continue
      }
      if (current.length > 0) units.push(current.join('\n').trim())
      current = [line]
    }
    if (current.length > 0) units.push(current.join('\n').trim())
  }
  return units.filter((u) => u.length > 0)
}

/**
 * Split content into sequential WeChat messages (hermes
 * `_split_text_for_weixin_delivery`): compact default (single message when it
 * fits, block-aware packing otherwise), per-line legacy with
 * `splitPerLine`.
 */
export function splitText(content: string, maxLength: number = MAX_MESSAGE_LENGTH, splitPerLine = false): string[] {
  if (!content) return []
  if (splitPerLine) {
    if (content.length <= maxLength && !content.includes('\n')) return [content]
    const chunks: string[] = []
    for (const unit of splitDeliveryUnits(content)) {
      if (unit.length <= maxLength) {
        chunks.push(unit)
        continue
      }
      chunks.push(...packMarkdownBlocks(unit, maxLength))
    }
    return chunks.filter((c) => c.length > 0).length > 0 ? chunks.filter((c) => c.length > 0) : [content]
  }
  if (content.length <= maxLength) {
    return shouldSplitShortChatBlock(content) ? splitDeliveryUnits(content) : [content]
  }
  return packMarkdownBlocks(content, maxLength)
}

/** Typing ticket cache from `getconfig` (hermes `TypingTicketCache`, TTL 600s). */
export class TypingTicketCache {
  private readonly cache = new Map<string, { ticket: string; at: number }>()

  constructor(
    private readonly ttlSeconds = 600,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  get(userId: string): string | undefined {
    const entry = this.cache.get(userId)
    if (!entry) return undefined
    if (this.now() - entry.at >= this.ttlSeconds) {
      this.cache.delete(userId)
      return undefined
    }
    return entry.ticket
  }

  set(userId: string, ticket: string): void {
    this.cache.set(userId, { ticket, at: this.now() })
  }
}

/** Options for the outbound sender. */
export interface OutboundOptions {
  accountId: string
  maxMessageLength?: number
  sendChunkDelaySeconds: number
  sendChunkRetries: number
  sendChunkRetryDelaySeconds: number
  splitMultilineMessages: boolean
}

/** Typed error for exhausted send retries. */
export class SendExhaustedError extends Error {
  constructor(message: string) {
    super(message)
  }
}

/**
 * Chunked, retrying text sender for one account. All per-peer delivery is
 * serialized by the caller (each peer's chunks must arrive in order).
 */
export class WeChatOutbound {
  private readonly client: ILinkClient
  private readonly tokenStore: ContextTokenStore
  private readonly options: OutboundOptions
  private readonly typingTickets: TypingTicketCache

  constructor(options: {
    client: ILinkClient
    tokenStore: ContextTokenStore
    options: OutboundOptions
    typingTickets?: TypingTicketCache
  }) {
    this.client = options.client
    this.tokenStore = options.tokenStore
    this.options = options.options
    this.typingTickets = options.typingTickets ?? new TypingTicketCache()
  }

  /** Split one assistant message into WeChat chunks. */
  split(content: string): string[] {
    return splitText(
      formatWechatText(content),
      this.options.maxMessageLength ?? MAX_MESSAGE_LENGTH,
      this.options.splitMultilineMessages,
    ).filter((chunk) => chunk.trim().length > 0)
  }

  /**
   * Send one text chunk with per-chunk retry, -14 token-downgrade, and -2
   * backoff (hermes `_send_text_chunk`).
   */
  async sendTextChunk(chatId: string, chunk: string, contextToken: string | undefined): Promise<void> {
    let lastError: Error | undefined
    let retriedWithoutToken = false
    let effectiveContextToken = contextToken
    for (let attempt = 0; attempt <= this.options.sendChunkRetries; attempt++) {
      try {
        const resp = await this.client.sendMessage({
          to: chatId,
          text: chunk,
          contextToken: effectiveContextToken,
          clientId: `dsh-wechat-${randomClientSuffix()}`,
        })
        const ret = asErrorCode(resp['ret'])
        const errcode = asErrorCode(resp['errcode'])
        const errmsg = String(resp['errmsg'] ?? resp['msg'] ?? '')
        if (ret !== undefined || errcode !== undefined) {
          if ((ret !== 0 && ret !== undefined) || (errcode !== 0 && errcode !== undefined)) {
            if (isSessionExpired(ret, errcode, errmsg) && !retriedWithoutToken && effectiveContextToken) {
              retriedWithoutToken = true
              effectiveContextToken = undefined
              this.tokenStore.clear(this.options.accountId, chatId)
              continue
            }
            if (isRateLimited(ret, errcode, errmsg)) {
              lastError = new SendExhaustedError(
                `iLink sendmessage rate limited: ret=${ret} errcode=${errcode} errmsg=${errmsg}`,
              )
              if (attempt >= this.options.sendChunkRetries) break
              await sleep(this.options.sendChunkRetryDelaySeconds * 3)
              continue
            }
            throw new SendExhaustedError(
              `iLink sendmessage error: ret=${ret} errcode=${errcode} errmsg=${errmsg}`,
            )
          }
        }
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt >= this.options.sendChunkRetries) break
        await sleep(this.options.sendChunkRetryDelaySeconds * (attempt + 1))
      }
    }
    if (lastError) throw lastError
  }

  /** Send all chunks of a text with the configured inter-chunk delay. */
  async sendText(chatId: string, content: string, contextToken: string | undefined): Promise<void> {
    const chunks = this.split(content)
    for (let idx = 0; idx < chunks.length; idx++) {
      await this.sendTextChunk(chatId, chunks[idx]!, contextToken)
      if (idx < chunks.length - 1 && this.options.sendChunkDelaySeconds > 0) {
        await sleep(this.options.sendChunkDelaySeconds)
      }
    }
  }

  /**
   * Deliver one full assistant payload: MEDIA: tags + bare local paths first,
   * then text chunks (hermes `WeixinAdapter.send`). Media failures are logged
   * and never abort text delivery.
   */
  async sendContent(
    chatId: string,
    content: string,
    contextToken: string | undefined,
    onMediaError?: (path: string, error: unknown) => void,
  ): Promise<void> {
    const { media, cleaned: mediaCleaned } = extractMedia(content)
    const { files, cleaned } = extractLocalFiles(mediaCleaned)

    for (const entry of media as ExtractedMedia[]) {
      try {
        await this.deliverMedia(chatId, entry.path, entry.isVoice, contextToken)
      } catch (error) {
        if (onMediaError) onMediaError(entry.path, error)
      }
    }
    for (const file of files) {
      try {
        await this.deliverMedia(chatId, file, false, contextToken)
      } catch (error) {
        if (onMediaError) onMediaError(file, error)
      }
    }
    if (cleaned.trim()) {
      await this.sendText(chatId, cleaned, contextToken)
    }
  }

  private async deliverMedia(chatId: string, path: string, isVoice: boolean, contextToken: string | undefined): Promise<void> {
    // Outbound voice bubbles are not proven-working upstream: prefer the
    // reliable file-attachment fallback (hermes `send_voice`).
    const ext = path.toLowerCase().slice(path.lastIndexOf('.'))
    const forceAttachment = isVoice || ['.ogg', '.opus', '.mp3', '.wav', '.m4a', '.flac'].includes(ext)
    await sendFile(this.client, {
      to: chatId,
      path,
      caption: forceAttachment ? '[voice message as attachment]' : '',
      contextToken,
      forceFileAttachment: forceAttachment,
    })
  }

  /** sendtyping start (hermes `send_typing`). */
  async sendTypingStart(chatId: string): Promise<void> {
    const ticket = this.typingTickets.get(chatId)
    if (!ticket) return
    try {
      await this.client.sendTyping(chatId, ticket, TYPING_START)
    } catch {
      // best-effort; hermes logs at debug
    }
  }

  /** sendtyping stop (hermes `stop_typing`). */
  async sendTypingStop(chatId: string): Promise<void> {
    const ticket = this.typingTickets.get(chatId)
    if (!ticket) return
    try {
      await this.client.sendTyping(chatId, ticket, TYPING_STOP)
    } catch {
      // best-effort
    }
  }

  /** Record a typing ticket (from getconfig) into the cache. */
  cacheTypingTicket(userId: string, ticket: string): void {
    this.typingTickets.set(userId, ticket)
  }

  /** Whether a fresh ticket is cached for this user. */
  hasTypingTicket(userId: string): boolean {
    return this.typingTickets.get(userId) !== undefined
  }
}

function asErrorCode(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function randomClientSuffix(): string {
  return Math.random().toString(16).slice(2, 18)
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

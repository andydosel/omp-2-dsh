/**
 * iLink Bot API HTTP client, mirroring hermes
 * `gateway/platforms/weixin.py` (`_api_post`, `_api_get`, `_get_updates`,
 * `_send_message`, `_send_typing`, `_get_config`, `_get_upload_url`,
 * `_upload_ciphertext`, `_download_bytes`, `_headers`, `_random_wechat_uin`,
 * `_cdn_download_url`/`_cdn_upload_url`, `_assert_weixin_cdn_url`,
 * `_is_stale_session_ret`).
 *
 * Uses node's built-in `fetch`; long-poll timeouts are managed per request
 * (AbortSignal.timeout) exactly like hermes's `asyncio.wait_for`.
 * @module @dsh-plugin/dsh-channel-wechat/ilink/client
 */

import { randomBytes } from 'node:crypto'

/** iLink endpoints (hermes `weixin.py:80-86`). */
export const EP_GET_UPDATES = 'ilink/bot/getupdates'
export const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
export const EP_SEND_TYPING = 'ilink/bot/sendtyping'
export const EP_GET_CONFIG = 'ilink/bot/getconfig'
export const EP_GET_UPLOAD_URL = 'ilink/bot/getuploadurl'

export const ILINK_APP_ID = 'bot'
/** `(2 << 16) | (2 << 8) | 0` (hermes `CHANNEL_VERSION` 2.2.0). */
export const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0
export const CHANNEL_VERSION = '2.2.0'

export const API_TIMEOUT_MS = 15_000
export const CONFIG_TIMEOUT_MS = 10_000
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
export const CDN_UPLOAD_TIMEOUT_MS = 120_000
export const CDN_DOWNLOAD_TIMEOUT_SECONDS = 60

/** Poll-loop failure handling (hermes `weixin.py:88-91`). */
export const MAX_CONSECUTIVE_FAILURES = 3
export const RETRY_DELAY_SECONDS = 2
export const BACKOFF_DELAY_SECONDS = 30

/** Error codes (hermes `weixin.py:92-95`). */
export const SESSION_EXPIRED_ERRCODE = -14
export const RATE_LIMIT_ERRCODE = -2

/** Item type codes (hermes `ITEM_*`, `weixin.py:135-140`). */
export const ITEM_TEXT = 1
export const ITEM_IMAGE = 2
export const ITEM_VOICE = 3
export const ITEM_FILE = 4
export const ITEM_VIDEO = 5

/** Media type codes for `getuploadurl` (hermes `MEDIA_*`). */
export const MEDIA_IMAGE = 1
export const MEDIA_VIDEO = 2
export const MEDIA_FILE = 3
export const MEDIA_VOICE = 4

/** Outbound message flags (hermes `MSG_TYPE_*` / `MSG_STATE_FINISH`). */
export const MSG_TYPE_USER = 1
export const MSG_TYPE_BOT = 2
export const MSG_STATE_FINISH = 2

export const TYPING_START = 1
export const TYPING_STOP = 2

/** Whether `ret=-2`/`errcode=-2` with errmsg "unknown error" means stale session, not rate limit. */
export function isStaleSessionRet(
  ret: number | undefined,
  errcode: number | undefined,
  errmsg: string | undefined,
): boolean {
  if (ret !== RATE_LIMIT_ERRCODE && errcode !== RATE_LIMIT_ERRCODE) return false
  return (errmsg ?? '').toLowerCase() === 'unknown error'
}

/** Whether an API response means the session expired (hermes `-14` + stale-session `-2`). */
export function isSessionExpired(
  ret: number | undefined,
  errcode: number | undefined,
  errmsg: string | undefined,
): boolean {
  return ret === SESSION_EXPIRED_ERRCODE
    || errcode === SESSION_EXPIRED_ERRCODE
    || isStaleSessionRet(ret, errcode, errmsg)
}

/** Whether an API response is a genuine rate limit (`-2`, after stale-session exclusion). */
export function isRateLimited(
  ret: number | undefined,
  errcode: number | undefined,
  errmsg: string | undefined,
): boolean {
  if (ret !== RATE_LIMIT_ERRCODE && errcode !== RATE_LIMIT_ERRCODE) return false
  return !isStaleSessionRet(ret, errcode, errmsg)
}

/** Random `X-WECHAT-UIN` header value (hermes `_random_wechat_uin`). */
export function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf-8').toString('base64')
}

/** JSON body of every POST, mirroring hermes `_base_info`. */
export function baseInfo(): Record<string, string> {
  return { channel_version: CHANNEL_VERSION }
}

/** iLink API response envelope. */
export interface ILinkResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msg?: string
  [key: string]: unknown
}

/** Options for the HTTP client. */
export interface ILinkClientOptions {
  /** iLink API base URL. */
  baseUrl: string
  /** `{account_id}:{secret}` bearer credential. */
  token: string
  /** WeChat media CDN base URL. */
  cdnBaseUrl: string
  /** Long-poll timeout; the server may suggest a better value. */
  longPollTimeoutMs?: number
  /** fetch implementation override (tests). */
  fetchImpl?: typeof fetch
  /** Timeout signaling override (tests). */
  signalFactory?: (ms: number) => AbortSignal
}

/** Error thrown for HTTP-level failures. */
export class ILinkHttpError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string, endpoint: string) {
    super(`iLink POST ${endpoint} HTTP ${status}: ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
  }
}

/** Result of one long-poll `getupdates` call. */
export interface GetUpdatesResult {
  ret: number
  errcode?: number
  errmsg?: string
  msgs: Record<string, unknown>[]
  get_updates_buf: string
  longpolling_timeout_ms?: number
}

/** Media CDN hosts we are willing to fetch (SSRF allowlist, hermes `_WEIXIN_CDN_ALLOWLIST`). */
export const WEIXIN_CDN_ALLOWLIST: ReadonlySet<string> = new Set([
  'novac2c.cdn.weixin.qq.com',
  'ilinkai.weixin.qq.com',
  'wx.qlogo.cn',
  'thirdwx.qlogo.cn',
  'res.wx.qq.com',
  'mmbiz.qpic.cn',
  'mmbiz.qlogo.cn',
])

/** Reject URLs not on the WeChat CDN allowlist (hermes `_assert_weixin_cdn_url`). */
export function assertCdnUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Unparseable media URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Media URL has disallowed scheme ${parsed.protocol}; only http/https are permitted.`)
  }
  if (!WEIXIN_CDN_ALLOWLIST.has(parsed.hostname)) {
    throw new Error(
      `Media URL host ${parsed.hostname} is not in the WeChat CDN allowlist. `
      + 'Refusing to fetch to prevent SSRF.',
    )
  }
}

/** Build the download URL (hermes `_cdn_download_url`). */
export function cdnDownloadUrl(cdnBaseUrl: string, encryptedQueryParam: string): string {
  return `${cdnBaseUrl.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

/** Build the upload URL (hermes `_cdn_upload_url`). */
export function cdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return `${cdnBaseUrl.replace(/\/+$/, '')}/upload`
    + `?encrypted_query_param=${encodeURIComponent(uploadParam)}`
    + `&filekey=${encodeURIComponent(filekey)}`
}

/** Request headers mirroring hermes `_headers`. */
export function apiHeaders(token: string | undefined, body: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

/** The iLink HTTP client. */
export class ILinkClient {
  readonly baseUrl: string
  readonly token: string
  readonly cdnBaseUrl: string
  readonly longPollTimeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly signalFactory: (ms: number) => AbortSignal

  constructor(options: ILinkClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.cdnBaseUrl = options.cdnBaseUrl.replace(/\/+$/, '')
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? fetch
    this.signalFactory = options.signalFactory ?? ((ms) => AbortSignal.timeout(ms))
  }

  /** One POST to an `ilink/bot/*` endpoint (hermes `_api_post`). */
  async postJson(
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<ILinkResponse> {
    const body = JSON.stringify({ ...payload, base_info: baseInfo() })
    const url = `${this.baseUrl}/${endpoint}`
    const timeoutSignal = this.signalFactory(timeoutMs)
    const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: apiHeaders(this.token, body),
        body,
        signal,
      })
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new ILinkTimeoutError(endpoint, timeoutMs)
      }
      throw error
    }
    const raw = await response.text()
    if (!response.ok) {
      throw new ILinkHttpError(response.status, raw, endpoint)
    }
    return JSON.parse(raw) as ILinkResponse
  }

  /** Long-poll `getupdates` (hermes `_get_updates`: timeout → empty result). */
  async getUpdates(syncBuf: string, timeoutMs: number, externalSignal?: AbortSignal): Promise<GetUpdatesResult> {
    try {
      const response = await this.postJson(EP_GET_UPDATES, { get_updates_buf: syncBuf }, timeoutMs, externalSignal)
      return {
        ret: Number(response.ret ?? 0),
        errcode: response.errcode === undefined ? undefined : Number(response.errcode),
        errmsg: response.errmsg as string | undefined,
        msgs: Array.isArray(response.msgs) ? response.msgs as Record<string, unknown>[] : [],
        get_updates_buf: String(response.get_updates_buf ?? syncBuf),
        longpolling_timeout_ms: typeof response.longpolling_timeout_ms === 'number'
          ? response.longpolling_timeout_ms
          : undefined,
      }
    } catch (error) {
      if (error instanceof ILinkTimeoutError) {
        return { ret: 0, msgs: [], get_updates_buf: syncBuf }
      }
      throw error
    }
  }

  /** Send one bot text message (hermes `_send_message`). */
  async sendMessage(options: {
    to: string
    text: string
    contextToken?: string
    clientId: string
  }): Promise<ILinkResponse> {
    if (!options.text.trim()) throw new Error('sendMessage: text must not be empty')
    const message: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: options.to,
      client_id: options.clientId,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text: options.text } }],
    }
    if (options.contextToken) message['context_token'] = options.contextToken
    return this.postJson(EP_SEND_MESSAGE, { msg: message }, API_TIMEOUT_MS)
  }

  /** Send one bot media message (item built by `ilink/media.ts`). */
  async sendMediaMessage(options: {
    to: string
    item: Record<string, unknown>
    contextToken?: string
    clientId: string
  }): Promise<ILinkResponse> {
    const message: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: options.to,
      client_id: options.clientId,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [options.item],
    }
    if (options.contextToken) message['context_token'] = options.contextToken
    return this.postJson(EP_SEND_MESSAGE, { msg: message }, API_TIMEOUT_MS)
  }

  /** `sendtyping` start/stop (hermes `_send_typing`). */
  async sendTyping(toUserId: string, typingTicket: string, status: number): Promise<ILinkResponse> {
    return this.postJson(
      EP_SEND_TYPING,
      { ilink_user_id: toUserId, typing_ticket: typingTicket, status },
      CONFIG_TIMEOUT_MS,
    )
  }

  /** `getconfig` — fetch the `typing_ticket` (hermes `_get_config`). */
  async getConfig(userId: string, contextToken?: string): Promise<ILinkResponse> {
    const payload: Record<string, unknown> = { ilink_user_id: userId }
    if (contextToken) payload['context_token'] = contextToken
    return this.postJson(EP_GET_CONFIG, payload, CONFIG_TIMEOUT_MS)
  }

  /** `getuploadurl` — pre-authorize a CDN upload (hermes `_get_upload_url`). */
  async getUploadUrl(options: {
    toUserId: string
    mediaType: number
    filekey: string
    rawsize: number
    rawfilemd5: string
    filesize: number
    aeskeyHex: string
  }): Promise<ILinkResponse> {
    return this.postJson(
      EP_GET_UPLOAD_URL,
      {
        filekey: options.filekey,
        media_type: options.mediaType,
        to_user_id: options.toUserId,
        rawsize: options.rawsize,
        rawfilemd5: options.rawfilemd5,
        filesize: options.filesize,
        no_need_thumb: true,
        aeskey: options.aeskeyHex,
      },
      API_TIMEOUT_MS,
    )
  }

  /** POST ciphertext to the CDN; returns the `x-encrypted-param` header (hermes `_upload_ciphertext`). */
  async cdnUpload(uploadUrl: string, ciphertext: Uint8Array): Promise<string> {
    const response = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: ciphertext,
      signal: this.signalFactory(CDN_UPLOAD_TIMEOUT_MS),
    })
    if (response.status === 200) {
      const encryptedParam = response.headers.get('x-encrypted-param')
      if (encryptedParam) {
        await response.arrayBuffer()
        return encryptedParam
      }
      const raw = await response.text()
      throw new Error(`CDN upload missing x-encrypted-param header: ${raw.slice(0, 200)}`)
    }
    const raw = await response.text()
    throw new Error(`CDN upload HTTP ${response.status}: ${raw.slice(0, 200)}`)
  }

  /** GET bytes from the CDN (hermes `_download_bytes`). */
  async cdnDownload(url: string, timeoutSeconds: number = CDN_DOWNLOAD_TIMEOUT_SECONDS): Promise<Uint8Array> {
    assertCdnUrl(url)
    const response = await this.fetchImpl(url, {
      method: 'GET',
      signal: this.signalFactory(timeoutSeconds * 1000),
    })
    if (!response.ok) {
      throw new Error(`CDN download HTTP ${response.status}: ${url}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }
}

/** Raised when an iLink API call exceeds its timeout. */
export class ILinkTimeoutError extends Error {
  readonly endpoint: string
  constructor(endpoint: string, timeoutMs: number) {
    super(`iLink POST ${endpoint} timed out after ${timeoutMs}ms`)
    this.endpoint = endpoint
  }
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof ILinkTimeoutError) return true
  if (error instanceof DOMException && error.name === 'TimeoutError') return true
  if (error instanceof Error && error.name === 'TimeoutError') return true
  return false
}

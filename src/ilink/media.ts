/**
 * WeChat media transport: inbound CDN download + AES decrypt + local cache,
 * outbound AES encrypt + CDN upload + sendmessage media item, and the
 * `MEDIA:<path>` tag / bare-path extraction hermes performs in
 * `gateway/platforms/base.py` (`extract_media`, `extract_local_files`).
 *
 * Outbound item shapes mirror hermes `WeixinAdapter._outbound_media_builder`
 * and `_send_file` (`weixin.py:1972-2135`); the `aes_key` the API receives
 * is base64(hex-string) — see `ilink/crypto.ts`.
 * @module @dsh-plugin/dsh-channel-wechat/ilink/media
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { ILinkClient, ILinkResponse } from './client.ts'
import { ITEM_FILE, ITEM_IMAGE, ITEM_VIDEO, ITEM_VOICE, MEDIA_FILE, MEDIA_IMAGE, MEDIA_VIDEO, MEDIA_VOICE, cdnDownloadUrl, cdnUploadUrl } from './client.ts'
import { aes128EcbDecrypt, aes128EcbEncrypt, aesKeyForApi, aesPaddedSize, parseAesKey } from './crypto.ts'

/** MIME → media kind for `getuploadurl` (`media_type`). */
export type MediaKind = 'image' | 'video' | 'voice' | 'file'

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp'])
const AUDIO_EXTS = new Set(['.ogg', '.opus', '.mp3', '.wav', '.m4a', '.flac'])
/** Bare-path detection extension set (hermes `MEDIA_DELIVERY_EXTS`). */
const DELIVERY_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp',
  'mp4', 'mov', 'avi', 'mkv', 'webm', '3gp',
  'ogg', 'opus', 'mp3', 'wav', 'm4a', 'flac',
  'silk', 'pdf', 'txt', 'md', 'csv', 'json', 'xlsx', 'xls', 'docx', 'zip', 'tar', 'gz',
])

/** A `MEDIA:` tag or bare path parsed out of agent content. */
export interface ExtractedMedia {
  /** Filesystem path to deliver. */
  path: string
  /** True when the `[[audio_as_voice]]` directive applies (file-attachment fallback). */
  isVoice: boolean
}

/** The `media` reference inside an inbound item (hermes `_media_reference`). */
export function mediaReference(item: Record<string, unknown>, key: string): Record<string, unknown> {
  const holder = item[key]
  if (typeof holder === 'object' && holder !== null) {
    const media = (holder as Record<string, unknown>)['media']
    if (typeof media === 'object' && media !== null) return media as Record<string, unknown>
  }
  return {}
}

/**
 * Inbound image aes key: hermes reads `image_item.aeskey` (a HEX string) and
 * base64-encodes it, falling back to `media.aes_key`
 * (`weixin.py:1562-1566`). `parseAesKey` tolerates both encodings.
 */
export function imageAesKey(item: Record<string, unknown>): string | undefined {
  const imageItem = item['image_item']
  if (typeof imageItem === 'object' && imageItem !== null) {
    const hex = (imageItem as Record<string, unknown>)['aeskey']
    if (typeof hex === 'string' && hex) {
      try {
        return Buffer.from(hex, 'ascii').toString('base64')
      } catch {
        // fall through to media.aes_key
      }
    }
  }
  const media = mediaReference(item, 'image_item')
  return typeof media['aes_key'] === 'string' ? media['aes_key'] : undefined
}

/**
 * Download and decrypt one inbound media payload (hermes
 * `_download_and_decrypt_media`). Returns the PLAINTEXT bytes.
 */
export async function downloadAndDecryptMedia(
  client: ILinkClient,
  options: {
    encryptedQueryParam?: string
    aesKeyB64?: string
    fullUrl?: string
    timeoutSeconds?: number
  },
): Promise<Uint8Array> {
  let raw: Uint8Array
  if (options.encryptedQueryParam) {
    raw = await client.cdnDownload(
      cdnDownloadUrl(client.cdnBaseUrl, options.encryptedQueryParam),
      options.timeoutSeconds,
    )
  } else if (options.fullUrl) {
    raw = await client.cdnDownload(options.fullUrl, options.timeoutSeconds)
  } else {
    throw new Error('media item had neither encrypt_query_param nor full_url')
  }
  if (options.aesKeyB64) {
    return aes128EcbDecrypt(raw, parseAesKey(options.aesKeyB64))
  }
  return raw
}

/** Atomically write decrypted media into the cache dir; returns the file path. */
export function cacheMediaBytes(cacheDir: string, filename: string, data: Uint8Array): string {
  mkdirSync(cacheDir, { recursive: true })
  const safeName = basename(filename).replace(/[^\w.\-]+/g, '_') || 'media.bin'
  const path = join(cacheDir, `${Date.now()}-${randomBytes(4).toString('hex')}-${safeName}`)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
  return path
}

/** Resolve media kind + `getuploadurl` media_type from a file extension (hermes `_outbound_media_builder`). */
export function mediaKindForPath(path: string, forceFileAttachment: boolean): MediaKind {
  const ext = extname(path).toLowerCase()
  if (!forceFileAttachment) {
    if (IMAGE_EXTS.has(ext)) return 'image'
    if (VIDEO_EXTS.has(ext)) return 'video'
    if (ext === '.silk') return 'voice'
  }
  if (AUDIO_EXTS.has(ext) || IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || ext === '.silk') {
    return 'file'
  }
  return 'file'
}

/** Map MediaKind → getuploadurl media_type (hermes MEDIA_*). */
export function mediaTypeForKind(kind: MediaKind): number {
  switch (kind) {
    case 'image': return MEDIA_IMAGE
    case 'video': return MEDIA_VIDEO
    case 'voice': return MEDIA_VOICE
    default: return MEDIA_FILE
  }
}

/** Build the sendmessage media item (hermes `_outbound_media_builder`). */
export function buildMediaItem(
  kind: MediaKind,
  path: string,
  encryptedQueryParam: string,
  aesKeyForApiValue: string,
  ciphertextSize: number,
  plaintextSize: number,
  rawfilemd5: string,
): Record<string, unknown> {
  const media = {
    encrypt_query_param: encryptedQueryParam,
    aes_key: aesKeyForApiValue,
    encrypt_type: 1,
  }
  switch (kind) {
    case 'image':
      return { type: ITEM_IMAGE, image_item: { media, mid_size: ciphertextSize } }
    case 'video':
      return {
        type: ITEM_VIDEO,
        video_item: { media, video_size: ciphertextSize, play_length: 0, video_md5: rawfilemd5 },
      }
    case 'voice':
      return {
        type: ITEM_VOICE,
        voice_item: {
          media,
          encode_type: 6,
          bits_per_sample: 16,
          sample_rate: 24000,
          playtime: 0,
        },
      }
    default:
      return {
        type: ITEM_FILE,
        file_item: { media, file_name: basename(path), len: String(plaintextSize) },
      }
  }
}

/** Result of an outbound media send. */
export interface MediaSendResult {
  clientId: string
  response: ILinkResponse
}

/**
 * Encrypt + upload + send one local file (hermes `_send_file`). Returns the
 * last `client_id` used (caption message, when sent, or the media message).
 */
export async function sendFile(
  client: ILinkClient,
  options: {
    to: string
    path: string
    caption?: string
    contextToken?: string
    forceFileAttachment?: boolean
  },
): Promise<MediaSendResult> {
  const path = options.path
  const plaintext = readFileSync(path)
  const kind = mediaKindForPath(path, options.forceFileAttachment ?? false)
  const filekey = randomBytes(16).toString('hex')
  const aesKey = randomBytes(16)
  const rawsize = plaintext.length
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
  const filesize = aesPaddedSize(rawsize)

  const uploadResponse = await client.getUploadUrl({
    toUserId: options.to,
    mediaType: mediaTypeForKind(kind),
    filekey,
    rawsize,
    rawfilemd5,
    filesize,
    aeskeyHex: Buffer.from(aesKey).toString('hex'),
  })
  const uploadParam = String(uploadResponse['upload_param'] ?? '')
  const uploadFullUrl = String(uploadResponse['upload_full_url'] ?? '')
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`getUploadUrl returned neither upload_param nor upload_full_url: ${JSON.stringify(uploadResponse)}`)
  }

  const ciphertext = aes128EcbEncrypt(new Uint8Array(plaintext), aesKey)
  const uploadUrl = uploadFullUrl || cdnUploadUrl(client.cdnBaseUrl, uploadParam, filekey)
  const encryptedQueryParam = await client.cdnUpload(uploadUrl, ciphertext)

  // THE GOTCHA: the API expects base64(hex-string), not base64(raw bytes).
  const aesKeyForApiValue = aesKeyForApi(aesKey)
  const item = buildMediaItem(
    kind, path, encryptedQueryParam, aesKeyForApiValue,
    ciphertext.length, rawsize, rawfilemd5,
  )

  let lastClientId = `dsh-wechat-${randomBytes(8).toString('hex')}`
  if (options.caption) {
    await client.sendMessage({
      to: options.to,
      text: options.caption,
      contextToken: options.contextToken,
      clientId: lastClientId,
    })
  }
  lastClientId = `dsh-wechat-${randomBytes(8).toString('hex')}`
  const response = await client.sendMediaMessage({
    to: options.to,
    item,
    contextToken: options.contextToken,
    clientId: lastClientId,
  })
  return { clientId: lastClientId, response }
}

/**
 * Extract `MEDIA:<path>` tags and the `[[audio_as_voice]]` directive from
 * agent content (hermes `extract_media`, simplified: no code-span masking —
 * a v1 limitation noted in the report).
 */
export function extractMedia(content: string): { media: ExtractedMedia[]; cleaned: string } {
  let cleaned = content
  const hasVoiceTag = cleaned.includes('[[audio_as_voice]]')
  cleaned = cleaned.replaceAll('[[audio_as_voice]]', '').replaceAll('[[as_document]]', '')

  const media: ExtractedMedia[] = []
  const tagRegex = /(?:^|\n)\s*MEDIA:\s*("(?:[^"\n]*)"|'(?:[^'\n]*)'|`(?:[^`\n]*)`|(\S+))/g
  const removed: { start: number; end: number }[] = []
  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(cleaned)) !== null) {
    let path = match[1]!
    if (path.length >= 2 && ['"', "'", '`'].includes(path[0]!) && path[0] === path[path.length - 1]) {
      path = path.slice(1, -1)
    }
    path = path.trim().replace(/[`"',.;:)}]+$/, '')
    if (path) {
      media.push({ path, isVoice: hasVoiceTag })
      removed.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  if (removed.length > 0) {
    const chars = [...cleaned]
    for (const span of removed.sort((a, b) => b.start - a.start)) {
      chars.splice(span.start, span.end - span.start)
    }
    cleaned = chars.join('').replace(/\n{3,}/g, '\n\n').trim()
  }
  return { media, cleaned }
}

/**
 * Detect bare local file paths in agent content (hermes `extract_local_files`,
 * simplified: absolute/tilde/Windows paths ending in a known media extension,
 * skipping fenced/inline code spans, validated with `fs.existsSync`).
 */
export function extractLocalFiles(content: string): { files: string[]; cleaned: string } {
  const codeSpans: { start: number; end: number }[] = []
  for (const m of content.matchAll(/```[^\n]*\n.*?```/gs)) {
    codeSpans.push({ start: m.index!, end: m.index! + m[0].length })
  }
  for (const m of content.matchAll(/`[^`\n]+`/g)) {
    codeSpans.push({ start: m.index!, end: m.index! + m[0].length })
  }
  const inCode = (pos: number): boolean => codeSpans.some((s) => s.start <= pos && pos < s.end)

  const extPart = [...DELIVERY_EXTS].join('|')
  const pathRegex = new RegExp(
    `(?<![\\/:\\w.])(?:~\\/|\\/|[A-Za-z]:[\\\\/])(?:[\\w.\\-~]+[\\\\/])*[\\w.\\-~]+\\.(?:${extPart})\\b`,
    'gi',
  )
  const files: string[] = []
  let cleaned = content
  const removed: { start: number; end: number }[] = []
  let match: RegExpExecArray | null
  while ((match = pathRegex.exec(content)) !== null) {
    if (inCode(match.index)) continue
    const raw = match[0]
    const expanded = raw.startsWith('~/')
      ? join(process.env.HOME ?? process.env.USERPROFILE ?? '', raw.slice(2))
      : resolve(raw)
    let exists = false
    try {
      exists = existsSync(expanded)
    } catch {
      exists = false
    }
    if (exists) {
      files.push(expanded)
      removed.push({ start: match.index, end: match.index + raw.length })
    }
  }
  if (removed.length > 0) {
    const chars = [...cleaned]
    for (const span of removed.sort((a, b) => b.start - a.start)) {
      chars.splice(span.start, span.end - span.start)
    }
    cleaned = chars.join('').replace(/[ \t]{2,}/g, ' ').trim()
  }
  return { files, cleaned }
}

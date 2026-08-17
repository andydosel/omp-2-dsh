import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.ts'
import {
  collectMediaTypes,
  extractText,
  guessChatType,
  MessageDeduplicator,
  processInbound,
  TextDebouncer,
} from '../src/inbound.ts'
import { ILinkClient } from '../src/ilink/client.ts'
import { aes128EcbEncrypt } from '../src/ilink/crypto.ts'
import { randomBytes } from 'node:crypto'

const ACCOUNT = 'c5610f3ce386@im.bot'

function config(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    accountId: ACCOUNT,
    token: `${ACCOUNT}:secret`,
    baseUrl: 'https://ilink.test',
    cdnBaseUrl: 'https://cdn.test',
    dmPolicy: 'open',
    allowedUsers: [],
    groupPolicy: 'disabled',
    groupAllowedUsers: [],
    homeChannel: '',
    longPollTimeoutMs: 35_000,
    sendChunkDelaySeconds: 1.5,
    sendChunkRetries: 4,
    sendChunkRetryDelaySeconds: 1.0,
    splitMultilineMessages: false,
    textBatchDelaySeconds: 3.0,
    textBatchSplitDelaySeconds: 5.0,
    groupSessionsPerUser: true,
    threadSessionsPerUser: false,
    stateDir: '',
    ...overrides,
  }
}

const keyFor = (chatType: 'dm' | 'group', chatId: string, senderId: string): string =>
  chatType === 'dm' ? `weixin:dm:${chatId}` : `weixin:group:${chatId}:${senderId}`

function dmMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from_user_id: 'peer1@im.wechat',
    to_user_id: ACCOUNT,
    msg_type: 1,
    message_id: 'msg-1',
    context_token: 'CT-1',
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
    ...overrides,
  }
}

describe('guessChatType', () => {
  it('detects DMs when to_user_id is the account', () => {
    const result = guessChatType(dmMessage(), ACCOUNT)
    expect(result).toEqual({ chatType: 'dm', effectiveChatId: 'peer1@im.wechat' })
  })

  it('detects groups from room_id / chat_room_id', () => {
    expect(guessChatType(dmMessage({ room_id: 'room@chatroom' }), ACCOUNT).chatType).toBe('group')
    expect(guessChatType(dmMessage({ chat_room_id: 'room@chatroom' }), ACCOUNT).chatType).toBe('group')
  })

  it('detects groups when to_user_id != account on a user message', () => {
    const result = guessChatType(dmMessage({ to_user_id: 'other@im.wechat' }), ACCOUNT)
    expect(result).toEqual({ chatType: 'group', effectiveChatId: 'other@im.wechat' })
  })

  it('does not treat a bot message to another id as a group (msg_type != 1)', () => {
    const result = guessChatType(dmMessage({ to_user_id: 'other@im.wechat', msg_type: 2 }), ACCOUNT)
    expect(result.chatType).toBe('dm')
  })
})

describe('extractText', () => {
  it('extracts the first text item', () => {
    expect(extractText([{ type: 1, text_item: { text: 'hi' } }])).toBe('hi')
  })

  it('prefers voice transcription when no text item exists', () => {
    const item = { type: 3, voice_item: { text: 'transcribed', media: {} } }
    expect(extractText([item])).toBe('transcribed')
  })

  it('returns empty for a voice item without transcription', () => {
    expect(extractText([{ type: 3, voice_item: { media: {} } }])).toBe('')
  })

  it('adds the ref_msg quote prefix', () => {
    const item = {
      type: 1,
      text_item: { text: 'my reply' },
      ref_msg: { title: 'original', message_item: { type: 1, text_item: { text: 'original' } } },
    }
    expect(extractText([item])).toBe('[引用: original | original]\nmy reply')
  })

  it('adds the media-quote prefix', () => {
    const item = {
      type: 1,
      text_item: { text: 'about the pic' },
      ref_msg: { title: 'photo.jpg', message_item: { type: 2, image_item: {} } },
    }
    expect(extractText([item])).toBe('[引用媒体: photo.jpg]\nabout the pic')
  })
})

describe('MessageDeduplicator', () => {
  it('dedupes ids within the TTL window', () => {
    let now = 1000
    const dedup = new MessageDeduplicator(300, 2000, () => now)
    expect(dedup.isDuplicate('m1')).toBe(false)
    expect(dedup.isDuplicate('m1')).toBe(true)
    now += 301
    expect(dedup.isDuplicate('m1')).toBe(false)
  })
})

describe('processInbound pipeline', () => {
  it('drops empty senders and self messages', async () => {
    const dedup = new MessageDeduplicator()
    const empty = await processInbound({ from_user_id: '' }, { accountId: ACCOUNT, config: config(), dedup, sessionKeyFor: keyFor })
    expect(empty.kind).toBe('drop')
    const self = await processInbound({ from_user_id: ACCOUNT }, { accountId: ACCOUNT, config: config(), dedup, sessionKeyFor: keyFor })
    expect(self.kind).toBe('drop')
  })

  it('drops duplicate message ids and content fingerprints', async () => {
    const dedup = new MessageDeduplicator()
    const first = await processInbound(dmMessage({ message_id: 'm1' }), { accountId: ACCOUNT, config: config(), dedup, sessionKeyFor: keyFor })
    expect(first.kind).toBe('message')
    const second = await processInbound(dmMessage({ message_id: 'm1' }), { accountId: ACCOUNT, config: config(), dedup, sessionKeyFor: keyFor })
    expect(second.kind).toBe('drop')
    // same content, different id → fingerprint dedup
    const third = await processInbound(dmMessage({ message_id: 'm2' }), { accountId: ACCOUNT, config: config(), dedup, sessionKeyFor: keyFor })
    expect(third.kind).toBe('drop')
  })

  it('gates by DM policy', async () => {
    const dedup = new MessageDeduplicator()
    const denied = await processInbound(dmMessage({ message_id: 'g1', item_list: [{ type: 1, text_item: { text: 'one' } }] }), {
      accountId: ACCOUNT,
      config: config({ dmPolicy: 'disabled' }),
      dedup,
      sessionKeyFor: keyFor,
    })
    expect(denied.kind).toBe('denied')
    const allowlisted = await processInbound(dmMessage({ message_id: 'g2', item_list: [{ type: 1, text_item: { text: 'two' } }] }), {
      accountId: ACCOUNT,
      config: config({ dmPolicy: 'allowlist', allowedUsers: ['peer1@im.wechat'] }),
      dedup,
      sessionKeyFor: keyFor,
    })
    expect(allowlisted.kind).toBe('message')
    const notAllowed = await processInbound(dmMessage({ message_id: 'g3', item_list: [{ type: 1, text_item: { text: 'three' } }], from_user_id: 'other@im.wechat' }), {
      accountId: ACCOUNT,
      config: config({ dmPolicy: 'allowlist', allowedUsers: ['peer1@im.wechat'] }),
      dedup,
      sessionKeyFor: keyFor,
    })
    expect(notAllowed.kind).toBe('denied')
  })

  it('offers pairing codes to strangers and admits approved users', async () => {
    const dedup = new MessageDeduplicator()
    const stranger = await processInbound(dmMessage({ message_id: 'p1', item_list: [{ type: 1, text_item: { text: 'one' } }] }), {
      accountId: ACCOUNT,
      config: config({ dmPolicy: 'pairing' }),
      dedup,
      sessionKeyFor: keyFor,
      isApproved: () => false,
    })
    expect(stranger).toMatchObject({ kind: 'pairing', senderId: 'peer1@im.wechat', contextToken: 'CT-1' })
    const approved = await processInbound(dmMessage({ message_id: 'p2', item_list: [{ type: 1, text_item: { text: 'two' } }] }), {
      accountId: ACCOUNT,
      config: config({ dmPolicy: 'pairing' }),
      dedup,
      sessionKeyFor: keyFor,
      isApproved: () => true,
    })
    expect(approved.kind).toBe('message')
  })

  it('drops group messages under groupPolicy disabled', async () => {
    const dedup = new MessageDeduplicator()
    const group = await processInbound(dmMessage({ message_id: 'r1', item_list: [{ type: 1, text_item: { text: 'one' } }], room_id: 'room@chatroom' }), {
      accountId: ACCOUNT,
      config: config(),
      dedup,
      sessionKeyFor: keyFor,
    })
    expect(group.kind).toBe('denied')
    const open = await processInbound(dmMessage({ message_id: 'r2', item_list: [{ type: 1, text_item: { text: 'two' } }], room_id: 'room@chatroom' }), {
      accountId: ACCOUNT,
      config: config({ groupPolicy: 'open' }),
      dedup,
      sessionKeyFor: keyFor,
    })
    expect(open.kind).toBe('message')
  })

  it('carries the context token and normalized fields on the event', async () => {
    const dedup = new MessageDeduplicator()
    const verdict = await processInbound(dmMessage(), { accountId: ACCOUNT, config: config(), dedup, sessionKeyFor: keyFor })
    expect(verdict.kind).toBe('message')
    if (verdict.kind === 'message') {
      expect(verdict.event).toMatchObject({
        sessionKey: 'weixin:dm:peer1@im.wechat',
        text: 'hello',
        chatType: 'dm',
        chatId: 'peer1@im.wechat',
        senderId: 'peer1@im.wechat',
        contextToken: 'CT-1',
      })
    }
  })

  it('downloads and decrypts inbound media into the cache', async () => {
    const key = randomBytes(16)
    const plaintext = new TextEncoder().encode('photo-bytes')
    const ciphertext = aes128EcbEncrypt(plaintext, key)
    const aesKeyB64 = Buffer.from(Buffer.from(key).toString('hex'), 'ascii').toString('base64')
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      fetchImpl: (async (url: RequestInfo | URL) => {
        expect(String(url)).toContain('/download?encrypted_query_param=')
        return new Response(ciphertext as unknown as BodyInit, { status: 200 })
      }) as typeof fetch,
    })
    const cacheDir = mkdtempSync(join(tmpdir(), 'wechat-media-'))
    try {
      const verdict = await processInbound(dmMessage({
        item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'enc', aes_key: aesKeyB64 } } }],
      }), {
        accountId: ACCOUNT,
        config: config(),
        dedup: new MessageDeduplicator(),
        media: { client, cacheDir },
        sessionKeyFor: keyFor,
      })
      expect(verdict.kind).toBe('message')
      if (verdict.kind === 'message') {
        expect(verdict.event.mediaPaths).toHaveLength(1)
        const cached = readFileSync(verdict.event.mediaPaths[0]!)
        expect(new Uint8Array(cached)).toEqual(plaintext)
        expect(verdict.event.text).toContain('[Media:')
      }
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('does not download voice items that carry a transcription', async () => {
    let downloads = 0
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: (async () => {
        downloads += 1
        return new Response('x', { status: 200 })
      }) as typeof fetch,
    })
    const verdict = await processInbound(dmMessage({
      item_list: [{ type: 3, voice_item: { text: 'transcribed voice', media: { encrypt_query_param: 'e' } } }],
    }), {
      accountId: ACCOUNT,
      config: config(),
      dedup: new MessageDeduplicator(),
      media: { client, cacheDir: mkdtempSync(join(tmpdir(), 'wechat-media-')) },
      sessionKeyFor: keyFor,
    })
    expect(verdict.kind).toBe('message')
    if (verdict.kind === 'message') {
      expect(verdict.event.text).toBe('transcribed voice')
      expect(verdict.event.mediaPaths).toHaveLength(0)
    }
    expect(downloads).toBe(0)
  })
})

describe('TextDebouncer', () => {
  it('merges rapid texts and dispatches once after the quiet period', async () => {
    vi.useFakeTimers()
    try {
      const dispatched: string[] = []
      const debouncer = new TextDebouncer({
        quietSeconds: 3,
        splitQuietSeconds: 5,
        splitThreshold: 1800,
        dispatch: (event) => { dispatched.push(event.text) },
      })
      const base = { sessionKey: 'weixin:dm:p', chatType: 'dm' as const, chatId: 'p', senderId: 'p', mediaPaths: [], mediaTypes: [] }
      debouncer.enqueue({ ...base, text: 'one' })
      debouncer.enqueue({ ...base, text: 'two' })
      expect(dispatched).toEqual([])
      await vi.advanceTimersByTimeAsync(3000)
      expect(dispatched).toEqual(['one\ntwo'])
      expect(debouncer.pendingCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the longer quiet period when the last chunk is large', async () => {
    vi.useFakeTimers()
    try {
      const dispatched: string[] = []
      const debouncer = new TextDebouncer({
        quietSeconds: 3,
        splitQuietSeconds: 5,
        splitThreshold: 1800,
        dispatch: (event) => { dispatched.push(event.text) },
      })
      debouncer.enqueue({ sessionKey: 'k', chatType: 'dm', chatId: 'p', senderId: 'p', text: 'x'.repeat(1900), mediaPaths: [], mediaTypes: [] })
      await vi.advanceTimersByTimeAsync(3500)
      expect(dispatched).toEqual([])
      await vi.advanceTimersByTimeAsync(2000)
      expect(dispatched).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush dispatches immediately and clears the timer', async () => {
    vi.useFakeTimers()
    try {
      const dispatched: string[] = []
      const debouncer = new TextDebouncer({
        quietSeconds: 3, splitQuietSeconds: 5, splitThreshold: 1800,
        dispatch: (event) => { dispatched.push(event.text) },
      })
      debouncer.enqueue({ sessionKey: 'k', chatType: 'dm', chatId: 'p', senderId: 'p', text: 'go', mediaPaths: [], mediaTypes: [] })
      debouncer.flush('k')
      expect(dispatched).toEqual(['go'])
      await vi.advanceTimersByTimeAsync(5000)
      expect(dispatched).toEqual(['go'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('collectMediaTypes', () => {
  it('maps item types to media types', () => {
    expect(collectMediaTypes([
      { type: 2 },
      { type: 5 },
      { type: 4 },
      { type: 3 },
    ])).toEqual(['image/jpeg', 'video/mp4', 'application/octet-stream', 'audio/silk'])
  })
})

describe('config strict keys (regression)', () => {
  it('rejects unknown keys via invariant validateConfig', async () => {
    const { validateConfig } = await import('../src/invariant.ts')
    const failures: string[] = []
    validateConfig({ dmPolicyy: 'open' as unknown }, (message: string) => { failures.push(message) })
    expect(failures.some((f) => f.includes('unknown config key "dmPolicyy"'))).toBe(true)
  })
})

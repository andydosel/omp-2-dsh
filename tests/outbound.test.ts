import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ILinkClient } from '../src/ilink/client.ts'
import { SendExhaustedError, splitText, TypingTicketCache, WeChatOutbound, type OutboundOptions } from '../src/outbound.ts'
import { ContextTokenStore } from '../src/state.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wechat-outbound-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ACCOUNT = 'c5610f3ce386@im.bot'

function options(overrides: Partial<OutboundOptions> = {}): OutboundOptions {
  return {
    accountId: ACCOUNT,
    sendChunkDelaySeconds: 0,
    sendChunkRetries: 2,
    sendChunkRetryDelaySeconds: 0,
    splitMultilineMessages: false,
    ...overrides,
  }
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch
}

function makeOutbound(handler: (url: string, init?: RequestInit) => Promise<Response>, overrides: Partial<OutboundOptions> = {}) {
  const client = new ILinkClient({
    baseUrl: 'https://ilink.test',
    token: `${ACCOUNT}:secret`,
    cdnBaseUrl: 'https://cdn.test',
    fetchImpl: fakeFetch(handler),
  })
  const tokenStore = new ContextTokenStore(join(dir, 'accounts'))
  const outbound = new WeChatOutbound({ client, tokenStore, options: options(overrides) })
  return { client, tokenStore, outbound }
}

describe('splitText', () => {
  it('keeps a short message as a single chunk', () => {
    expect(splitText('short')).toEqual(['short'])
  })

  it('packs an over-long message into <= 2000-char chunks', () => {
    const content = 'line '.repeat(600) // 3000 chars
    const chunks = splitText(content)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000)
    expect(chunks.join('')).toContain('line')
  })

  it('keeps fenced code blocks intact', () => {
    const code = '```\n' + 'x\n'.repeat(100) + '```'
    const content = `intro\n${code}\noutro`
    const chunks = splitText(content)
    const joined = chunks.join('\n')
    expect(joined).toContain('```\nx')
    expect(joined).toContain('```')
  })

  it('splits short chatty multiline blocks into bubbles (compact mode)', () => {
    const content = 'hey\nhow are you\ngood?'
    const chunks = splitText(content)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('per-line legacy mode splits every top-level line', () => {
    const content = 'a\nb\nc'
    expect(splitText(content, 2000, true)).toEqual(['a', 'b', 'c'])
  })
})

describe('sendTextChunk', () => {
  it('echoes the context_token and reports ret=0 as success', async () => {
    let sentToken: string | undefined
    const { outbound } = makeOutbound(async (_url, init) => {
      const msg = JSON.parse(String(init?.body))['msg']
      sentToken = msg['context_token']
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    })
    await outbound.sendTextChunk('peer@im.wechat', 'hi', 'CT-1')
    expect(sentToken).toBe('CT-1')
  })

  it('downgrades once on -14 (drops the token, clears the cache) and succeeds', async () => {
    const calls: (string | undefined)[] = []
    const { outbound, tokenStore } = makeOutbound(async (_url, init) => {
      const msg = JSON.parse(String(init?.body))['msg']
      calls.push(msg['context_token'])
      if (calls.length === 1) return new Response(JSON.stringify({ ret: -14, errmsg: 'expired' }), { status: 200 })
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    })
    tokenStore.set(ACCOUNT, 'peer@im.wechat', 'CT-1')
    await outbound.sendTextChunk('peer@im.wechat', 'hi', 'CT-1')
    expect(calls).toEqual(['CT-1', undefined])
    expect(tokenStore.get(ACCOUNT, 'peer@im.wechat')).toBeUndefined()
  })

  it('treats -2 with "unknown error" as session expiry (downgrade, not backoff)', async () => {
    const calls: (string | undefined)[] = []
    const { outbound } = makeOutbound(async (_url, init) => {
      const msg = JSON.parse(String(init?.body))['msg']
      calls.push(msg['context_token'])
      if (calls.length === 1) return new Response(JSON.stringify({ ret: -2, errmsg: 'unknown error' }), { status: 200 })
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    })
    await outbound.sendTextChunk('peer@im.wechat', 'hi', 'CT-1')
    expect(calls).toEqual(['CT-1', undefined])
  })

  it('backs off and retries on a genuine -2 rate limit', async () => {
    const calls: string[] = []
    const { outbound } = makeOutbound(async (_url, init) => {
      calls.push(String(init?.body))
      return new Response(JSON.stringify({ ret: -2, errmsg: 'freq limit' }), { status: 200 })
    }, { sendChunkRetries: 2 })
    await expect(outbound.sendTextChunk('peer@im.wechat', 'hi', 'CT-1')).rejects.toBeInstanceOf(SendExhaustedError)
    expect(calls).toHaveLength(3) // initial + 2 retries
  })

  it('retries on transport errors', async () => {
    const calls: string[] = []
    const { outbound } = makeOutbound(async () => {
      calls.push('x')
      if (calls.length === 1) throw new Error('network down')
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    })
    await outbound.sendTextChunk('peer@im.wechat', 'hi', 'CT-1')
    expect(calls).toHaveLength(2)
  })
})

describe('sendText chunk delay', () => {
  it('waits sendChunkDelaySeconds between chunks', async () => {
    vi.useFakeTimers()
    try {
      const sent: string[] = []
      const { outbound } = makeOutbound(async (_url, init) => {
        const msg = JSON.parse(String(init?.body))['msg']
        sent.push(msg['item_list'][0]['text_item']['text'])
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
      }, { sendChunkDelaySeconds: 1.5 })
      const long = ('x'.repeat(100) + '\n').repeat(25) // > 2000 chars → multiple chunks
      const promise = outbound.sendText('peer@im.wechat', long, undefined)
      await vi.advanceTimersByTimeAsync(100)
      const first = sent.length
      expect(first).toBe(1)
      await vi.advanceTimersByTimeAsync(1600)
      expect(sent.length).toBeGreaterThan(first)
      await promise
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sendContent media-first', () => {
  it('delivers MEDIA: tags before text and strips the tags', async () => {
    const imagePath = join(dir, 'pic.png')
    writeFileSync(imagePath, 'png-bytes')
    const calls: string[] = []
    let uploads = 0
    const { outbound } = makeOutbound(async (url, init) => {
      if (url.startsWith('https://ilink.test/ilink/bot/getuploadurl')) {
        return new Response(JSON.stringify({ upload_param: 'UP', upload_full_url: 'https://cdn.test/full' }), { status: 200 })
      }
      if (url.startsWith('https://cdn.test')) {
        uploads += 1
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'ENC' } })
      }
      const msg = JSON.parse(String(init?.body))['msg']
      const text = msg['item_list'][0]?.['text_item']?.['text']
      calls.push(text ?? `media:${msg['item_list'][0]?.['type']}`)
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    })
    await outbound.sendContent('peer@im.wechat', `MEDIA:${imagePath}\nsee the picture`, undefined)
    expect(uploads).toBe(1)
    expect(calls).toEqual(['media:2', 'see the picture'])
  })

  it('falls back to file attachment for audio MEDIA: tags', async () => {
    const audioPath = join(dir, 'note.ogg')
    writeFileSync(audioPath, 'ogg-bytes')
    const sentItems: unknown[] = []
    const { outbound } = makeOutbound(async (url) => {
      if (url.startsWith('https://ilink.test/ilink/bot/getuploadurl')) {
        return new Response(JSON.stringify({ upload_full_url: 'https://cdn.test/full' }), { status: 200 })
      }
      if (url.startsWith('https://cdn.test')) {
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'ENC' } })
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    })
    // spy on sendMessage to capture items
    const spy = vi.spyOn((outbound as unknown as { client: { sendMessage: () => Promise<unknown>; sendMediaMessage: (o: { item: unknown }) => Promise<unknown> } }).client, 'sendMediaMessage')
      .mockImplementation(async (o) => { sentItems.push(o.item); return { ret: 0 } })
    await outbound.sendContent('peer@im.wechat', `[[audio_as_voice]]\nMEDIA:${audioPath}`, undefined)
    expect(sentItems).toHaveLength(1)
    // force_file_attachment → file item (type 4), not voice
    expect((sentItems[0] as { type: number }).type).toBe(4)
    spy.mockRestore()
  })
})

describe('TypingTicketCache', () => {
  it('respects the 600s TTL', () => {
    let now = 0
    const cache = new TypingTicketCache(600, () => now)
    cache.set('peer@im.wechat', 'ticket-1')
    expect(cache.get('peer@im.wechat')).toBe('ticket-1')
    now = 599
    expect(cache.get('peer@im.wechat')).toBe('ticket-1')
    now = 600
    expect(cache.get('peer@im.wechat')).toBeUndefined()
  })
})

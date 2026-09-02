import { describe, expect, it, vi } from 'vitest'
import {
  apiHeaders,
  assertCdnUrl,
  cdnDownloadUrl,
  cdnUploadUrl,
  ILinkClient,
  ILinkHttpError,
  isRateLimited,
  isSessionExpired,
  isStaleSessionRet,
  randomWechatUin,
} from '../src/ilink/client.ts'

/** Build a fake fetch impl from per-URL handlers. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch
}

describe('error classification', () => {
  it('classifies -14 as session expired', () => {
    expect(isSessionExpired(-14, 0, '')).toBe(true)
    expect(isSessionExpired(0, -14, '')).toBe(true)
    expect(isSessionExpired(-14, undefined, undefined)).toBe(true)
  })

  it('classifies -2 with "unknown error" as stale session, not rate limit', () => {
    expect(isStaleSessionRet(-2, undefined, 'unknown error')).toBe(true)
    expect(isStaleSessionRet(undefined, -2, 'unknown error')).toBe(true)
    expect(isSessionExpired(undefined, -2, 'unknown error')).toBe(true)
    expect(isRateLimited(undefined, -2, 'unknown error')).toBe(false)
  })

  it('classifies -2 with a real message as rate limited', () => {
    expect(isRateLimited(-2, undefined, 'freq limit')).toBe(true)
    expect(isRateLimited(undefined, -2, '')).toBe(true)
    expect(isSessionExpired(-2, undefined, 'freq limit')).toBe(false)
  })
})

describe('headers', () => {
  it('includes all iLink auth headers', () => {
    const body = JSON.stringify({ a: 1 })
    const headers = apiHeaders('acct:secret', body)
    expect(headers['Authorization']).toBe('Bearer acct:secret')
    expect(headers['AuthorizationType']).toBe('ilink_bot_token')
    expect(headers['iLink-App-Id']).toBe('bot')
    expect(headers['iLink-App-ClientVersion']).toBe(String((2 << 16) | (2 << 8) | 0))
    expect(headers['Content-Length']).toBe(String(Buffer.byteLength(body)))
    expect(headers['X-WECHAT-UIN']).toBeTruthy()
  })

  it('omits Authorization without a token', () => {
    const headers = apiHeaders(undefined, '{}')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('X-WECHAT-UIN is random per call', () => {
    expect(randomWechatUin()).not.toBe(randomWechatUin())
  })
})

describe('ILinkClient.postJson', () => {
  it('posts JSON with base_info and returns parsed response', async () => {
    let capturedBody = ''
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 'acct:secret',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async (url, init) => {
        expect(url).toBe('https://ilink.test/ilink/bot/sendmessage')
        expect(init?.method).toBe('POST')
        capturedBody = String(init?.body)
        return new Response(JSON.stringify({ ret: 0, msg_id: 'm1' }), { status: 200 })
      }),
    })
    const response = await client.postJson('ilink/bot/sendmessage', { hello: 'world' }, 1000)
    expect(response).toEqual({ ret: 0, msg_id: 'm1' })
    const parsed = JSON.parse(capturedBody)
    expect(parsed['hello']).toBe('world')
    expect(parsed['base_info']).toEqual({ channel_version: '2.2.0' })
  })

  it('raises ILinkHttpError on non-ok status', async () => {
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async () => new Response('nope', { status: 403 })),
    })
    await expect(client.postJson('ilink/bot/getconfig', {}, 1000)).rejects.toBeInstanceOf(ILinkHttpError)
  })
})

describe('getUpdates long-poll', () => {
  it('returns msgs and the new cursor', async () => {
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async () => new Response(JSON.stringify({
        ret: 0,
        msgs: [{ message_id: '1' }],
        get_updates_buf: 'buf2',
      }))),
    })
    const result = await client.getUpdates('buf1', 35_000)
    expect(result.msgs).toEqual([{ message_id: '1' }])
    expect(result.get_updates_buf).toBe('buf2')
    expect(result.ret).toBe(0)
  })

  it('returns an empty result with the old cursor on timeout', async () => {
    let aborted = false
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async (_url, init) => {
        // simulate a long-poll that never answers: reject on abort
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('The operation timed out.', 'TimeoutError'))
          })
        })
      }),
      // shorten the timeout so the test does not wait 35s
      signalFactory: (ms) => AbortSignal.timeout(Math.min(ms, 50)),
    })
    const result = await client.getUpdates('buf1', 35_000)
    expect(result).toEqual({ ret: 0, msgs: [], get_updates_buf: 'buf1' })
    expect(aborted).toBe(true)
  })

  it('honors an external abort signal (graceful stop)', async () => {
    const controller = new AbortController()
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })),
    })
    const pending = client.getUpdates('buf1', 35_000, controller.signal)
    const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await expectation
  })
})

describe('sendMessage payload', () => {
  it('builds the bot text message with context_token and client_id', async () => {
    let captured: { url: string; body: string; headers: Record<string, string> } | undefined
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async (url, init) => {
        captured = { url, body: String(init?.body), headers: Object.fromEntries(new Headers(init?.headers).entries()) }
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
      }),
    })
    await client.sendMessage({ to: 'peer@im.wechat', text: 'hi', contextToken: 'tok-1', clientId: 'c-1' })
    const msg = JSON.parse(captured!.body)['msg']
    expect(msg['to_user_id']).toBe('peer@im.wechat')
    expect(msg['from_user_id']).toBe('')
    expect(msg['message_type']).toBe(2)
    expect(msg['message_state']).toBe(2)
    expect(msg['client_id']).toBe('c-1')
    expect(msg['context_token']).toBe('tok-1')
    expect(msg['item_list']).toEqual([{ type: 1, text_item: { text: 'hi' } }])
  })

  it('omits context_token when absent', async () => {
    let msg: Record<string, unknown> | undefined
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async (_url, init) => {
        msg = JSON.parse(String(init?.body))['msg']
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
      }),
    })
    await client.sendMessage({ to: 'p', text: 'x', clientId: 'c-2' })
    expect(msg!['context_token']).toBeUndefined()
  })

  it('rejects empty text like hermes', async () => {
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test', token: 't', cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async () => new Response('{}', { status: 200 })),
    })
    await expect(client.sendMessage({ to: 'p', text: '  ', clientId: 'c' })).rejects.toThrow(/must not be empty/)
  })
})

describe('CDN URLs and SSRF', () => {
  it('builds download and upload URLs like hermes', () => {
    expect(cdnDownloadUrl('https://novac2c.cdn.weixin.qq.com/c2c/', 'a/b c'))
      .toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Fb%20c')
    expect(cdnUploadUrl('https://novac2c.cdn.weixin.qq.com/c2c', 'param', 'filekey'))
      .toBe('https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=param&filekey=filekey')
  })

  it('asserts the CDN allowlist', () => {
    expect(() => assertCdnUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?x=1')).not.toThrow()
    expect(() => assertCdnUrl('https://evil.example.com/path')).toThrow(/allowlist/)
    expect(() => assertCdnUrl('file:///etc/passwd')).toThrow(/disallowed scheme/)
    expect(() => assertCdnUrl('not a url')).toThrow(/Unparseable/)
  })
})

describe('cdnUpload', () => {
  it('returns the x-encrypted-param header', async () => {
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async (_url, init) => {
        expect(init?.method).toBe('POST') // POST, not PUT — documented gotcha
        expect(init?.headers).toMatchObject({ 'Content-Type': 'application/octet-stream' })
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'enc-1' } })
      }),
    })
    await expect(client.cdnUpload('https://cdn.test/upload', new Uint8Array([1, 2]))).resolves.toBe('enc-1')
  })

  it('throws when the header is missing', async () => {
    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async () => new Response('', { status: 200 })),
    })
    await expect(client.cdnUpload('https://cdn.test/upload', new Uint8Array([1]))).rejects.toThrow(/x-encrypted-param/)
  })
})

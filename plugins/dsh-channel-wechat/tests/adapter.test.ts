import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/config.ts'
import { pickChannelSession, WeChatAdapter, type ChannelSessionSource } from '../src/adapter.ts'
import type { WeChatSessionManager } from '../src/session-map.ts'
import { ILinkClient } from '../src/ilink/client.ts'
import { WeChatOutbound } from '../src/outbound.ts'
import { PairingStore } from '../src/pairing.ts'
import { AccountStore, ContextTokenStore, SyncStore } from '../src/state.ts'

const ACCOUNT = 'c5610f3ce386@im.bot'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wechat-adapter-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

/** A fetch stub that only settles when the request signal aborts (graceful stop). */
function hangFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  }))
}

function okJson(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
}

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
    sendChunkDelaySeconds: 0,
    sendChunkRetries: 1,
    sendChunkRetryDelaySeconds: 0,
    splitMultilineMessages: false,
    textBatchDelaySeconds: 3.0,
    textBatchSplitDelaySeconds: 5.0,
    groupSessionsPerUser: true,
    threadSessionsPerUser: false,
    stateDir: dir,
    ...overrides,
  }
}

interface Harness {
  adapter: WeChatAdapter
  client: ILinkClient
  tokenStore: ContextTokenStore
  syncStore: SyncStore
  pairingStore: PairingStore
  outbound: WeChatOutbound
  sessionManager: { followup: ReturnType<typeof vi.fn> }
  fetchImpl: ReturnType<typeof vi.fn>
}

function makeHarness(
  overrides: Partial<Config> = {},
  fetchImpl?: ReturnType<typeof vi.fn>,
  outboundOverride?: WeChatOutbound,
  ctxOverride?: { sessions?: ChannelSessionSource },
): Harness {
  const impl = fetchImpl ?? hangFetch()
  const client = new ILinkClient({
    baseUrl: 'https://ilink.test',
    token: `${ACCOUNT}:secret`,
    cdnBaseUrl: 'https://cdn.test',
    fetchImpl: impl,
    signalFactory: () => new AbortController().signal,
  })
  const accountsDir = join(dir, 'accounts')
  const tokenStore = new ContextTokenStore(accountsDir)
  const syncStore = new SyncStore(accountsDir)
  const pairingStore = new PairingStore(join(dir, 'pairing'))
  const outbound = outboundOverride ?? new WeChatOutbound({
    client,
    tokenStore,
    options: {
      accountId: ACCOUNT,
      sendChunkDelaySeconds: 0,
      sendChunkRetries: 1,
      sendChunkRetryDelaySeconds: 0,
      splitMultilineMessages: false,
    },
  })
  const sessionManager = {
    followup: vi.fn().mockResolvedValue(undefined),
    managedSessionIds: vi.fn((): string[] => []),
  } as unknown as WeChatSessionManager
  const adapter = new WeChatAdapter({
    ctx: (ctxOverride ?? {}) as never,
    config: config(overrides),
    client,
    accountStore: new AccountStore(accountsDir),
    tokenStore,
    syncStore,
    pairingStore,
    outbound,
    sessionManager,
    logger: () => undefined,
  })
  return { adapter, client, tokenStore, syncStore, pairingStore, outbound, sessionManager, fetchImpl: impl }
}

function dmMsg(id: string, text: string): Record<string, unknown> {
  return {
    from_user_id: 'peer1@im.wechat',
    to_user_id: ACCOUNT,
    msg_type: 1,
    message_id: id,
    context_token: `CT-${id}`,
    item_list: [{ type: 1, text_item: { text } }],
  }
}

describe('poll loop', () => {
  it('persists the cursor and dispatches messages through the debounce', async () => {
    vi.useFakeTimers()
    const { adapter, sessionManager, fetchImpl, syncStore } = makeHarness()
    fetchImpl
      .mockResolvedValueOnce(okJson({ ret: 0, msgs: [dmMsg('m1', 'hello')], get_updates_buf: 'NEW-BUF' }))
      .mockImplementation(hangFetch())
    adapter.connect()
    await vi.advanceTimersByTimeAsync(3300) // debounce quiet period 3s
    expect(syncStore.load(ACCOUNT)).toBe('NEW-BUF')
    expect(sessionManager.followup).toHaveBeenCalledWith('weixin:dm:peer1@im.wechat', 'hello')
    expect(adapter.pollState.messagesProcessed).toBe(1)
    await adapter.disconnect()
  })

  it('reconnects with backoff after a transport failure', async () => {
    vi.useFakeTimers()
    const { adapter, fetchImpl, syncStore } = makeHarness()
    fetchImpl
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okJson({ ret: 0, msgs: [], get_updates_buf: 'AFTER-ERROR' }))
      .mockImplementation(hangFetch())
    adapter.connect()
    await vi.advanceTimersByTimeAsync(2500) // retry delay 2s
    expect(syncStore.load(ACCOUNT)).toBe('AFTER-ERROR')
    expect(adapter.pollState.consecutiveFailures).toBe(0)
    await adapter.disconnect()
  })

  it('stops gracefully: aborts the in-flight long poll', async () => {
    const { adapter } = makeHarness()
    adapter.connect()
    expect(adapter.pollState.running).toBe(true)
    await adapter.disconnect()
    expect(adapter.pollState.running).toBe(false)
  })

  it('adopts the server-suggested longpolling_timeout_ms without erroring', async () => {
    vi.useFakeTimers()
    const { adapter, fetchImpl } = makeHarness()
    fetchImpl
      .mockResolvedValueOnce(okJson({ ret: 0, msgs: [], longpolling_timeout_ms: 42_000, get_updates_buf: 'B2' }))
      .mockImplementation(hangFetch())
    adapter.connect()
    await vi.advanceTimersByTimeAsync(100)
    expect(adapter.pollState.lastPollAt).toBeTypeOf('number')
    expect(adapter.pollState.lastError).toBeUndefined()
    await adapter.disconnect()
  })
})

describe('inbound pipeline through the adapter', () => {
  it('routes a DM through to the peer agent session and stores the context token', async () => {
    vi.useFakeTimers()
    const { adapter, sessionManager, fetchImpl, tokenStore } = makeHarness({ dmPolicy: 'open' })
    fetchImpl
      .mockResolvedValueOnce(okJson({ ret: 0, msgs: [dmMsg('m1', 'hi')], get_updates_buf: 'B' }))
      .mockImplementation(hangFetch())
    adapter.connect()
    await vi.advanceTimersByTimeAsync(3300)
    expect(sessionManager.followup).toHaveBeenCalledWith('weixin:dm:peer1@im.wechat', 'hi')
    expect(tokenStore.get(ACCOUNT, 'peer1@im.wechat')).toBe('CT-m1')
    await adapter.disconnect()
  })

  it('offers a pairing code to an unknown user under dmPolicy pairing', async () => {
    vi.useFakeTimers()
    const sendText = vi.fn().mockResolvedValue(undefined)
    const outboundStub = { hasTypingTicket: () => true, sendText } as unknown as WeChatOutbound
    const { adapter, pairingStore, fetchImpl } = makeHarness({ dmPolicy: 'pairing' }, undefined, outboundStub)
    fetchImpl
      .mockResolvedValueOnce(okJson({ ret: 0, msgs: [dmMsg('m1', 'hi')], get_updates_buf: 'B' }))
      .mockImplementation(hangFetch())
    adapter.connect()
    await vi.advanceTimersByTimeAsync(100)
    expect(sendText).toHaveBeenCalledTimes(1)
    const [chatId, content] = sendText.mock.calls[0]!
    expect(chatId).toBe('peer1@im.wechat')
    expect(String(content)).toContain('pairing code')
    expect(String(content)).toContain('/wechat pairing approve')
    expect(pairingStore.isRateLimited('weixin', 'peer1@im.wechat')).toBe(true)
    await adapter.disconnect()
  })

  it('skips the pairing offer for rate-limited repeat offenders', async () => {
    vi.useFakeTimers()
    const sendText = vi.fn().mockResolvedValue(undefined)
    const outboundStub = { hasTypingTicket: () => true, sendText } as unknown as WeChatOutbound
    const { adapter, pairingStore, fetchImpl } = makeHarness({ dmPolicy: 'pairing' }, undefined, outboundStub)
    pairingStore.recordRateLimitFor('weixin', 'peer1@im.wechat')
    fetchImpl
      .mockResolvedValueOnce(okJson({ ret: 0, msgs: [dmMsg('m1', 'hi')], get_updates_buf: 'B' }))
      .mockImplementation(hangFetch())
    adapter.connect()
    await vi.advanceTimersByTimeAsync(100)
    expect(sendText).not.toHaveBeenCalled()
    await adapter.disconnect()
  })

  it('dedupes repeated messages across polls', async () => {
    vi.useFakeTimers()
    const { adapter, sessionManager, fetchImpl } = makeHarness()
    const same = dmMsg('m1', 'hello')
    fetchImpl
      .mockResolvedValueOnce(okJson({ ret: 0, msgs: [same], get_updates_buf: 'B1' }))
      .mockResolvedValueOnce(okJson({ ret: 0, msgs: [same], get_updates_buf: 'B2' }))
      .mockImplementation(hangFetch())
    adapter.connect()
    await vi.advanceTimersByTimeAsync(3300)
    expect(sessionManager.followup).toHaveBeenCalledTimes(1)
    await adapter.disconnect()
  })
})

describe('send + chat info', () => {
  it('send returns failure when not connected', async () => {
    const { adapter } = makeHarness()
    const result = await adapter.send('peer@im.wechat', 'hello')
    expect(result.success).toBe(false)
    expect(result.error).toBe('Not connected')
  })

  it('getChatInfo classifies @chatroom ids as groups', () => {
    const { adapter } = makeHarness()
    expect(adapter.getChatInfo('room@chatroom').type).toBe('group')
    expect(adapter.getChatInfo('peer@im.wechat').type).toBe('dm')
    expect(adapter.getChatInfo('peer@im.wechat').chat_id).toBe('peer@im.wechat')
  })

  it('enqueueSend serializes per-peer delivery in order', async () => {
    const { adapter, fetchImpl } = makeHarness()
    fetchImpl.mockImplementation(hangFetch())
    adapter.connect()
    const order: string[] = []
    vi.spyOn(adapter, 'send').mockImplementation(async (chatId: string, content: string) => {
      await new Promise((resolve) => setTimeout(resolve, content === 'slow' ? 30 : 1))
      order.push(`${chatId}:${content}`)
      return { success: true }
    })
    adapter.enqueueSend('p1', 'slow')
    adapter.enqueueSend('p1', 'fast')
    adapter.enqueueSend('p2', 'other')
    await new Promise((resolve) => setTimeout(resolve, 120))
    // per-peer order is guaranteed; cross-peer order is not
    expect(order).toContain('p1:slow')
    expect(order).toContain('p1:fast')
    expect(order.indexOf('p1:slow')).toBeLessThan(order.indexOf('p1:fast'))
    expect(order).toContain('p2:other')
    await adapter.disconnect()
  })
})

describe('state files written by the adapter', () => {
  it('writes hermes-format context tokens and sync cursor under stateDir', async () => {
    vi.useFakeTimers()
    const { adapter, fetchImpl } = makeHarness()
    fetchImpl
      .mockResolvedValueOnce(okJson({ ret: 0, msgs: [dmMsg('m1', 'hi')], get_updates_buf: 'SYNC-BUF' }))
      .mockImplementation(hangFetch())
    adapter.connect()
    await vi.advanceTimersByTimeAsync(3300)
    await adapter.disconnect()
    expect(existsSync(join(dir, 'accounts', `${ACCOUNT}.sync.json`))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'accounts', `${ACCOUNT}.sync.json`), 'utf-8'))['get_updates_buf']).toBe('SYNC-BUF')
    expect(JSON.parse(readFileSync(join(dir, 'accounts', `${ACCOUNT}.context-tokens.json`), 'utf-8')))
      .toEqual({ 'peer1@im.wechat': 'CT-m1' })
  })
})

describe('pickChannelSession', () => {
  function source(sessions: readonly Session[]): ChannelSessionSource {
    return {
      get: (id) => sessions.find(session => String(session.id) === id),
      list: () => sessions,
    }
  }

  it('prefers the channel’s most recent mapped session', () => {
    const wechat = Session.create(SessionId('weixin:dm:peer1'))
    const other = Session.create(SessionId('primary'))
    const pick = pickChannelSession(source([wechat, other]), ['weixin:dm:peer1'])
    expect(String(pick?.id)).toBe('weixin:dm:peer1')
  })

  it('falls back to the most recent live session when the channel has none', () => {
    const first = Session.create(SessionId('a'))
    const last = Session.create(SessionId('b'))
    const pick = pickChannelSession(source([first, last]), [])
    expect(String(pick?.id)).toBe('b')
  })

  it('returns undefined when no session can be chosen', () => {
    expect(pickChannelSession(source([]), [])).toBeUndefined()
    expect(pickChannelSession(undefined, [])).toBeUndefined()
  })
})

describe('wechat channel status (plugin-owned state)', () => {
  it('reports connected on connect and disconnected on disconnect', async () => {
    const session = Session.create(SessionId('primary'))
    const { adapter } = makeHarness({}, undefined, undefined, {
      sessions: { get: () => session, list: () => [session] },
    })
    adapter.connect()
    expect(adapter.status()).toEqual({ connected: true, account: ACCOUNT })
    await adapter.disconnect()
    expect(adapter.status()).toEqual({ connected: false, account: ACCOUNT })
  })

  it('stays disconnected when the poll loop never starts', async () => {
    const { adapter } = makeHarness({}, undefined, undefined, { sessions: { get: () => undefined, list: () => [] } })
    expect(adapter.status()).toEqual({ connected: false, account: ACCOUNT })
    adapter.connect()
    expect(adapter.pollState.running).toBe(true)
  })
})

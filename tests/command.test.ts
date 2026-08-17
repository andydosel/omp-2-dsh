import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.ts'
import { handleWechatCommand } from '../src/index.ts'
import type { WechatCommandContext } from '../src/index.ts'
import { PairingStore } from '../src/pairing.ts'
import type { WeChatAdapter } from '../src/adapter.ts'
import type { WeChatSessionManager } from '../src/session-map.ts'
import { ContextTokenStore, SyncStore } from '../src/state.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ACCOUNT = 'c5610f3ce386@im.bot'

function config(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    accountId: ACCOUNT,
    token: `${ACCOUNT}:secret`,
    baseUrl: 'https://ilink.test',
    cdnBaseUrl: 'https://cdn.test',
    dmPolicy: 'pairing',
    allowedUsers: [],
    groupPolicy: 'disabled',
    groupAllowedUsers: [],
    homeChannel: 'peer@im.wechat',
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

function makeContext(): WechatCommandContext {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-cmd-'))
  const pairingStore = new PairingStore(join(dir, 'pairing'))
  const tokenStore = new ContextTokenStore(join(dir, 'accounts'))
  const syncStore = new SyncStore(join(dir, 'accounts'))
  return {
    config: config(),
    stateDir: dir,
    adapter: {
      pollState: {
        running: true,
        lastPollAt: 1_700_000_000_000,
        consecutiveFailures: 0,
        syncBufLength: 12,
        messagesProcessed: 7,
      },
    } as unknown as WeChatAdapter,
    sessionManager: {
      size: 1,
      managedSessionIds: () => ['weixin:dm:peer@im.wechat'] as never,
    } as unknown as WeChatSessionManager,
    pairingStore,
    tokenStore,
    syncStore,
    accountId: ACCOUNT,
  }
}

describe('/wechat command handlers', () => {
  it('reports status', async () => {
    const result = await handleWechatCommand('status', makeContext())
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain(ACCOUNT)
      expect(result.text).toContain('poll: running')
      expect(result.text).toContain('sessions: 1')
      expect(result.text).toContain('weixin:dm:peer@im.wechat')
      expect(result.text).toContain('dmPolicy: pairing')
    }
  })

  it('defaults to status when no subcommand is given', async () => {
    const result = await handleWechatCommand('', makeContext())
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('WeChat (iLink) channel')
  })

  it('reports the effective config with a redacted token', async () => {
    const result = await handleWechatCommand('config', makeContext())
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain(`accountId: ${ACCOUNT}`)
      expect(result.text).not.toContain(`${ACCOUNT}:secret`)
      expect(result.text).toContain('pairing')
    }
  })

  it('approves a pairing code and lists the result', async () => {
    const ctx = makeContext()
    const code = await ctx.pairingStore.generateCode('weixin', 'newuser@im.wechat', 'New User')
    const approved = await handleWechatCommand(`pairing approve ${code}`, ctx)
    expect(approved.kind).toBe('success')
    const list = await handleWechatCommand('pairing list', ctx)
    expect(list.kind).toBe('success')
    if (list.kind === 'success') {
      expect(list.text).toContain('newuser@im.wechat')
      expect(list.text).toContain('New User')
    }
  })

  it('rejects an invalid pairing code', async () => {
    const result = await handleWechatCommand('pairing approve WRONG123', makeContext())
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toMatch(/Invalid or expired/)
  })

  it('lists pending with code prefixes and clears pending', async () => {
    const ctx = makeContext()
    const code = await ctx.pairingStore.generateCode('weixin', 'u1@im.wechat')
    expect(code).toBeTruthy()
    const pending = await handleWechatCommand('pairing pending', ctx)
    expect(pending.kind).toBe('success')
    if (pending.kind === 'success') {
      expect(pending.text).toContain('u1@im.wechat')
      expect(pending.text).not.toContain(code!) // never leaks the plaintext code
    }
    const cleared = await handleWechatCommand('pairing clear-pending', ctx)
    expect(cleared.kind).toBe('success')
    const empty = await handleWechatCommand('pairing pending', ctx)
    if (empty.kind === 'success') expect(empty.text).toContain('No pending')
  })

  it('revokes an approved user', async () => {
    const ctx = makeContext()
    const code = await ctx.pairingStore.generateCode('weixin', 'u2@im.wechat')
    await ctx.pairingStore.approveCode('weixin', code!)
    const revoked = await handleWechatCommand('pairing revoke u2@im.wechat', ctx)
    expect(revoked.kind).toBe('success')
    const again = await handleWechatCommand('pairing revoke u2@im.wechat', ctx)
    expect(again.kind).toBe('error')
  })

  it('returns usage for unknown subcommands', async () => {
    const result = await handleWechatCommand('frobnicate', makeContext())
    expect(result.kind).toBe('error')
  })
})

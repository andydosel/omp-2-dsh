import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore, ContextTokenStore, hermesTimestamp, resolvePairingDir, SyncStore } from '../src/state.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wechat-state-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ACCOUNT = 'c5610f3ce386@im.bot'

describe('AccountStore (hermes accounts/<id>.json format)', () => {
  it('writes the exact hermes credential shape', () => {
    const store = new AccountStore(join(dir, 'accounts'))
    store.save(ACCOUNT, {
      token: `${ACCOUNT}:secret`,
      base_url: 'https://ilinkai.weixin.qq.com',
      user_id: 'o9cq80_-Utaxv32K7SKRJQTZu76A@im.wechat',
    }, new Date('2026-05-10T15:55:52Z'))
    const raw = JSON.parse(readFileSync(join(dir, 'accounts', `${ACCOUNT}.json`), 'utf-8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['base_url', 'saved_at', 'token', 'user_id'])
    expect(raw['saved_at']).toBe('2026-05-10T15:55:52Z')
    const loaded = store.load(ACCOUNT)
    expect(loaded).toEqual({
      token: `${ACCOUNT}:secret`,
      base_url: 'https://ilinkai.weixin.qq.com',
      user_id: 'o9cq80_-Utaxv32K7SKRJQTZu76A@im.wechat',
      saved_at: '2026-05-10T15:55:52Z',
    })
  })

  it('returns undefined for missing/corrupt files', () => {
    const store = new AccountStore(join(dir, 'accounts'))
    expect(store.load('nope@im.bot')).toBeUndefined()
  })
})

describe('hermesTimestamp', () => {
  it('formats %Y-%m-%dT%H:%M:%SZ', () => {
    expect(hermesTimestamp(new Date('2026-05-10T15:55:52Z'))).toBe('2026-05-10T15:55:52Z')
    expect(hermesTimestamp(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05Z')
  })
})

describe('ContextTokenStore (hermes context-tokens.json format)', () => {
  it('persists per-account files keyed by peer id', () => {
    const store = new ContextTokenStore(join(dir, 'accounts'))
    store.set(ACCOUNT, 'peer1@im.wechat', 'TOKEN-1')
    store.set(ACCOUNT, 'peer2@im.wechat', 'TOKEN-2')
    const raw = JSON.parse(readFileSync(join(dir, 'accounts', `${ACCOUNT}.context-tokens.json`), 'utf-8'))
    expect(raw).toEqual({ 'peer1@im.wechat': 'TOKEN-1', 'peer2@im.wechat': 'TOKEN-2' })
  })

  it('isolates accounts in the same file namespace', () => {
    const store = new ContextTokenStore(join(dir, 'accounts'))
    store.set(ACCOUNT, 'peer@im.wechat', 'T1')
    store.set('other@im.bot', 'peer@im.wechat', 'T2')
    expect(store.get(ACCOUNT, 'peer@im.wechat')).toBe('T1')
    expect(store.get('other@im.bot', 'peer@im.wechat')).toBe('T2')
  })

  it('restores from disk on a fresh instance', () => {
    const store = new ContextTokenStore(join(dir, 'accounts'))
    store.set(ACCOUNT, 'peer@im.wechat', 'TOKEN')
    const fresh = new ContextTokenStore(join(dir, 'accounts'))
    fresh.restore(ACCOUNT)
    expect(fresh.get(ACCOUNT, 'peer@im.wechat')).toBe('TOKEN')
  })

  it('clear drops one peer and persists', () => {
    const store = new ContextTokenStore(join(dir, 'accounts'))
    store.set(ACCOUNT, 'a@im.wechat', 'T1')
    store.set(ACCOUNT, 'b@im.wechat', 'T2')
    store.clear(ACCOUNT, 'a@im.wechat')
    expect(store.get(ACCOUNT, 'a@im.wechat')).toBeUndefined()
    const fresh = new ContextTokenStore(join(dir, 'accounts'))
    fresh.restore(ACCOUNT)
    expect(fresh.get(ACCOUNT, 'b@im.wechat')).toBe('T2')
  })
})

describe('SyncStore (hermes sync.json format)', () => {
  it('round-trips the get_updates_buf cursor', () => {
    const store = new SyncStore(join(dir, 'accounts'))
    expect(store.load(ACCOUNT)).toBe('')
    store.save(ACCOUNT, 'ChEIiwUQmf+W/IA0GOjg6pThMxI6YzU2MTBmM2NlMzg2QGltLmJvdA==')
    expect(store.load(ACCOUNT)).toBe('ChEIiwUQmf+W/IA0GOjg6pThMxI6YzU2MTBmM2NlMzg2QGltLmJvdA==')
    const raw = JSON.parse(readFileSync(join(dir, 'accounts', `${ACCOUNT}.sync.json`), 'utf-8'))
    expect(raw).toEqual({ get_updates_buf: 'ChEIiwUQmf+W/IA0GOjg6pThMxI6YzU2MTBmM2NlMzg2QGltLmJvdA==' })
  })
})

describe('resolvePairingDir (hermes home compatibility)', () => {
  it('defaults to stateDir/pairing', () => {
    expect(resolvePairingDir(join(dir, 'wechat'))).toBe(join(dir, 'wechat', 'pairing'))
  })

  it('shares the hermes home pairing/ dir when stateDir IS hermes weixin/', () => {
    const hermesHome = join(dir, 'hermes-home')
    const weixinDir = join(hermesHome, 'weixin')
    // fresh hermes home has no pairing dir yet → primary
    expect(resolvePairingDir(weixinDir)).toBe(join(weixinDir, 'pairing'))
  })

  it('prefers an existing hermes-home pairing/ sibling over a fresh primary', () => {
    const hermesHome = join(dir, 'hermes-home')
    const weixinDir = join(hermesHome, 'weixin')
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(join(hermesHome, 'pairing'), { recursive: true })
    mkdirSync(join(hermesHome, 'weixin'), { recursive: true })
    expect(resolvePairingDir(weixinDir)).toBe(join(hermesHome, 'pairing'))
    // but an existing stateDir/pairing wins
    mkdirSync(join(weixinDir, 'pairing'), { recursive: true })
    expect(resolvePairingDir(weixinDir)).toBe(join(weixinDir, 'pairing'))
  })
})

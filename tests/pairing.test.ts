import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALPHABET,
  CODE_LENGTH,
  CODE_TTL_SECONDS,
  generateRandomCode,
  hashCode,
  MAX_FAILED_ATTEMPTS,
  MAX_PENDING_PER_PLATFORM,
  PairingStore,
  RATE_LIMIT_SECONDS,
} from '../src/pairing.ts'

let dir: string
let store: PairingStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wechat-pairing-'))
  store = new PairingStore(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const USER = 'peer1@im.wechat'

describe('code generation', () => {
  it('generates 8-char codes from the unambiguous alphabet', () => {
    const code = generateRandomCode()
    expect(code).toHaveLength(CODE_LENGTH)
    for (const char of code) expect(ALPHABET).toContain(char)
    // alphabet excludes 0/O/1/I
    for (const forbidden of ['0', 'O', '1', 'I']) expect(ALPHABET).not.toContain(forbidden)
  })

  it('stores only a salted hash, never the plaintext code (hermes format)', async () => {
    const code = await store.generateCode('weixin', USER)
    expect(code).toHaveLength(CODE_LENGTH)
    const pending = JSON.parse(readFileSync(join(dir, 'weixin-pending.json'), 'utf-8')) as Record<string, Record<string, unknown>>
    const entries = Object.values(pending)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry['hash']).toBe(hashCode(code!, Buffer.from(String(entry['salt']), 'hex')))
    expect(entry['salt']).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(pending)).not.toContain(code!)
  })

  it('rate-limits repeat requests per user (10 minutes)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(1_000_000))
      await store.generateCode('weixin', USER)
      const again = await store.generateCode('weixin', USER)
      expect(again).toBeUndefined()
      vi.advanceTimersByTime(RATE_LIMIT_SECONDS * 1000)
      const later = await store.generateCode('weixin', USER)
      expect(later).toHaveLength(CODE_LENGTH)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps pending codes per platform', async () => {
    for (let i = 0; i < MAX_PENDING_PER_PLATFORM; i++) {
      const code = await store.generateCode('weixin', `user-${i}@im.wechat`)
      expect(code).toHaveLength(CODE_LENGTH)
    }
    const overflow = await store.generateCode('weixin', 'user-x@im.wechat')
    expect(overflow).toBeUndefined()
  })
})

describe('approval', () => {
  it('approves the matching code and writes the hermes approved format', async () => {
    const code = await store.generateCode('weixin', USER, 'Peer One')
    const result = await store.approveCode('weixin', code!)
    expect(result).toEqual({ user_id: USER, user_name: 'Peer One' })
    const approved = JSON.parse(readFileSync(join(dir, 'weixin-approved.json'), 'utf-8'))
    expect(Object.keys(approved)).toEqual([USER])
    expect(typeof approved[USER]['approved_at']).toBe('number')
    expect(approved[USER]['user_name']).toBe('Peer One')
    expect(store.isApproved('weixin', USER)).toBe(true)
    // pending entry consumed
    const pending = JSON.parse(readFileSync(join(dir, 'weixin-pending.json'), 'utf-8'))
    expect(Object.keys(pending)).toHaveLength(0)
  })

  it('is case-insensitive and whitespace-tolerant', async () => {
    const code = await store.generateCode('weixin', USER)
    const result = await store.approveCode('weixin', `  ${code!.toLowerCase()} `)
    expect(result?.user_id).toBe(USER)
  })

  it('records failed attempts and locks out after 5 failures', async () => {
    const code = await store.generateCode('weixin', USER)
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      const result = await store.approveCode('weixin', 'WRONGCODE')
      expect(result).toBeUndefined()
    }
    expect(store.isLockedOut('weixin')).toBe(true)
    // even the valid code is rejected during lockout (brute-force protection)
    const duringLockout = await store.approveCode('weixin', code!)
    expect(duringLockout).toBeUndefined()
    // and generation is blocked too
    const generated = await store.generateCode('weixin', 'other@im.wechat')
    expect(generated).toBeUndefined()
    const limits = JSON.parse(readFileSync(join(dir, '_rate_limits.json'), 'utf-8'))
    expect(typeof limits['_lockout:weixin']).toBe('number')
  })

  it('expires codes after 1 hour', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(1_000_000_000_000))
      const code = await store.generateCode('weixin', USER)
      vi.advanceTimersByTime(CODE_TTL_SECONDS * 1000 + 1000)
      const result = await store.approveCode('weixin', code!)
      expect(result).toBeUndefined()
      expect(store.isApproved('weixin', USER)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('revoke / list / clear', () => {
  it('revokes an approved user', async () => {
    const code = await store.generateCode('weixin', USER)
    await store.approveCode('weixin', code!)
    expect(store.isApproved('weixin', USER)).toBe(true)
    expect(await store.revoke('weixin', USER)).toBe(true)
    expect(store.isApproved('weixin', USER)).toBe(false)
    expect(await store.revoke('weixin', USER)).toBe(false)
  })

  it('lists pending with hashed code prefixes only (no plaintext)', async () => {
    const code = await store.generateCode('weixin', USER, 'Peer')
    const pending = await store.listPending('weixin')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.user_id).toBe(USER)
    expect(pending[0]!.code).toHaveLength(8)
    expect(pending[0]!.code).not.toBe(code)
  })

  it('clearPending empties the file and returns the count', async () => {
    await store.generateCode('weixin', 'a@im.wechat')
    await store.generateCode('weixin', 'b@im.wechat')
    expect(await store.clearPending('weixin')).toBe(2)
    expect(await store.listPending('weixin')).toHaveLength(0)
  })
})

describe('hermes file-format compatibility', () => {
  it('reads a hermes-written approved file', () => {
    const hermesApproved = {
      'o9cq80_-Utaxv32K7SKRJQTZu76A@im.wechat': {
        user_name: 'o9cq80_-Utaxv32K7SKRJQTZu76A@im.wechat',
        approved_at: 1778428671.3127685,
      },
    }
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'weixin-approved.json'), JSON.stringify(hermesApproved), 'utf-8')
    expect(store.isApproved('weixin', 'o9cq80_-Utaxv32K7SKRJQTZu76A@im.wechat')).toBe(true)
    expect(store.listApproved('weixin')).toEqual([{
      user_id: 'o9cq80_-Utaxv32K7SKRJQTZu76A@im.wechat',
      user_name: 'o9cq80_-Utaxv32K7SKRJQTZu76A@im.wechat',
      approved_at: 1778428671.3127685,
    }])
  })
})

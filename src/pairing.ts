/**
 * DM pairing-code approval, mirroring hermes `gateway/pairing.py` 1:1
 * (same alphabet, hashing, TTLs, rate limits, lockout, and on-disk formats
 * under `pairing/`).
 *
 * Security (per hermes docstring): 8-char codes from a 32-char unambiguous
 * alphabet (no 0/O/1/I), cryptographic randomness, 1h expiry, max 3 pending
 * per platform, 1 request per user per 10 minutes, lockout after 5 failed
 * approvals for 1h, codes stored only as salted SHA-256 hashes.
 * @module @dsh-plugin/dsh-channel-wechat/pairing
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Unambiguous alphabet — excludes 0/O, 1/I (hermes `ALPHABET`). */
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8

export const CODE_TTL_SECONDS = 3600
export const RATE_LIMIT_SECONDS = 600
export const LOCKOUT_SECONDS = 3600
export const MAX_PENDING_PER_PLATFORM = 3
export const MAX_FAILED_ATTEMPTS = 5

/** Pending entry shape (`{platform}-pending.json`). */
export interface PendingEntry {
  hash: string
  salt: string
  user_id: string
  user_name: string
  created_at: number
}

/** Approved entry shape (`{platform}-approved.json`). */
export interface ApprovedEntry {
  user_name: string
  approved_at: number
}

/** Success result of `approveCode`. */
export interface ApproveResult {
  user_id: string
  user_name: string
}

/** Async mutex serializing read-modify-write cycles (hermes `threading.RLock`). */
class AsyncLock {
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => T): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/** Hash a code with a salt using SHA-256 (hermes `_hash_code`). */
export function hashCode(code: string, salt: Uint8Array): string {
  return createHash('sha256').update(Buffer.concat([Buffer.from(salt), Buffer.from(code, 'utf-8')])).digest('hex')
}

/** Generate `CODE_LENGTH` random chars from the unambiguous alphabet. */
export function generateRandomCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)]!
  }
  return code
}

/** Pairing store with hermes-compatible files. */
export class PairingStore {
  private readonly lock = new AsyncLock()
  private readonly pairingDir: string

  constructor(pairingDir: string) {
    this.pairingDir = pairingDir
    mkdirSync(pairingDir, { recursive: true })
  }

  private pendingPath(platform: string): string {
    return join(this.pairingDir, `${platform}-pending.json`)
  }

  private approvedPath(platform: string): string {
    return join(this.pairingDir, `${platform}-approved.json`)
  }

  private rateLimitPath(): string {
    return join(this.pairingDir, '_rate_limits.json')
  }

  private loadJson(path: string): Record<string, unknown> {
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      if (typeof data === 'object' && data !== null) return data as Record<string, unknown>
      return {}
    } catch {
      return {}
    }
  }

  private saveJson(path: string, data: Record<string, unknown>): void {
    const tmp = join(this.pairingDir, `.${path.split(/[\\/]/).pop()}_${Math.random().toString(36).slice(2, 8)}.tmp`)
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, path)
  }

  // ----- Approved users -----

  isApproved(platform: string, user_id: string): boolean {
    const approved = this.loadJson(this.approvedPath(platform))
    return Object.prototype.hasOwnProperty.call(approved, user_id)
  }

  listApproved(platform: string): { user_id: string; user_name: string; approved_at: number }[] {
    const approved = this.loadJson(this.approvedPath(platform))
    return Object.entries(approved).map(([user_id, info]) => {
      const entry = (typeof info === 'object' && info !== null ? info : {}) as Partial<ApprovedEntry>
      return {
        user_id,
        user_name: entry.user_name ?? user_id,
        approved_at: typeof entry.approved_at === 'number' ? entry.approved_at : 0,
      }
    })
  }

  revoke(platform: string, user_id: string): Promise<boolean> {
    return this.lock.run(() => {
      const path = this.approvedPath(platform)
      const approved = this.loadJson(path)
      if (Object.prototype.hasOwnProperty.call(approved, user_id)) {
        delete approved[user_id]
        this.saveJson(path, approved)
        return true
      }
      return false
    })
  }

  // ----- Pending codes -----

  /**
   * Generate a pairing code for a new user. Returns the code, or `undefined`
   * when rate-limited, at the pending cap, or in lockout.
   */
  generateCode(platform: string, user_id: string, user_name = ''): Promise<string | undefined> {
    return this.lock.run(() => {
      this.cleanupExpired(platform)
      if (this.isLockedOut(platform)) return undefined
      if (this.isRateLimited(platform, user_id)) return undefined

      const pending = this.loadJson(this.pendingPath(platform))
      if (Object.keys(pending).length >= MAX_PENDING_PER_PLATFORM) return undefined

      const code = generateRandomCode()
      const salt = randomBytes(16)
      const entryId = randomBytes(8).toString('hex')
      const entry: PendingEntry = {
        hash: hashCode(code, salt),
        salt: Buffer.from(salt).toString('hex'),
        user_id,
        user_name,
        created_at: Date.now() / 1000,
      }
      pending[entryId] = entry
      this.saveJson(this.pendingPath(platform), pending)
      this.recordRateLimit(platform, user_id)
      return code
    })
  }

  /**
   * Approve a pairing code. Returns `{user_id, user_name}` on success,
   * `undefined` when the code is invalid/expired OR the platform is locked
   * out (mirror hermes; disambiguate with `isLockedOut`).
   */
  approveCode(platform: string, code: string): Promise<ApproveResult | undefined> {
    return this.lock.run(() => {
      this.cleanupExpired(platform)
      const normalized = code.trim().toUpperCase()

      // Lockout check must precede the pending lookup so a valid pending code
      // cannot be accepted once the lockout fires (hermes behavior).
      if (this.isLockedOut(platform)) return undefined

      const pending = this.loadJson(this.pendingPath(platform))
      let matchedKey: string | undefined
      let matchedEntry: PendingEntry | undefined
      for (const [entryId, entry] of Object.entries(pending)) {
        if (typeof entry !== 'object' || entry === null) continue
        const candidate = entry as Partial<PendingEntry>
        if (typeof candidate.salt !== 'string' || typeof candidate.hash !== 'string') continue
        let salt: Uint8Array
        try {
          salt = Uint8Array.from(Buffer.from(candidate.salt, 'hex'))
        } catch {
          continue
        }
        const candidateHash = hashCode(normalized, salt)
        if (timingSafeEqualHex(candidateHash, candidate.hash)) {
          matchedKey = entryId
          matchedEntry = candidate as PendingEntry
          break
        }
      }

      if (matchedKey === undefined || matchedEntry === undefined) {
        this.recordFailedAttempt(platform)
        return undefined
      }

      delete pending[matchedKey]
      this.saveJson(this.pendingPath(platform), pending)
      this.approveUser(platform, matchedEntry.user_id, matchedEntry.user_name ?? '')
      return { user_id: matchedEntry.user_id, user_name: matchedEntry.user_name ?? '' }
    })
  }

  listPending(platform: string): Promise<{ code: string; user_id: string; user_name: string; age_minutes: number }[]> {
    return this.lock.run(() => {
      this.cleanupExpired(platform)
      const pending = this.loadJson(this.pendingPath(platform))
      const now = Date.now() / 1000
      return Object.values(pending).flatMap((info) => {
        if (typeof info !== 'object' || info === null) return []
        const entry = info as Partial<PendingEntry>
        if (typeof entry.created_at !== 'number') return []
        const ageMinutes = Math.max(0, Math.floor((now - entry.created_at) / 60))
        const hashVal = entry.hash
        return [{
          code: typeof hashVal === 'string' ? hashVal.slice(0, 8) : 'legacy',
          user_id: entry.user_id ?? '',
          user_name: entry.user_name ?? '',
          age_minutes: ageMinutes,
        }]
      })
    })
  }

  clearPending(platform: string): Promise<number> {
    return this.lock.run(() => {
      const pending = this.loadJson(this.pendingPath(platform))
      const count = Object.keys(pending).length
      if (count > 0) this.saveJson(this.pendingPath(platform), {})
      return count
    })
  }

  // ----- Rate limiting and lockout -----

  isRateLimited(platform: string, user_id: string): boolean {
    const limits = this.loadJson(this.rateLimitPath())
    const key = `${platform}:${user_id}`
    const lastRequest = typeof limits[key] === 'number' ? limits[key] as number : 0
    return Date.now() / 1000 - lastRequest < RATE_LIMIT_SECONDS
  }

  /** Public wrapper for hermes's `_record_rate_limit` (used by the pairing-offer rejection path). */
  recordRateLimitFor(platform: string, user_id: string): void {
    this.recordRateLimit(platform, user_id)
  }

  private recordRateLimit(platform: string, user_id: string): void {
    const limits = this.loadJson(this.rateLimitPath())
    limits[`${platform}:${user_id}`] = Date.now() / 1000
    this.saveJson(this.rateLimitPath(), limits)
  }

  isLockedOut(platform: string): boolean {
    const limits = this.loadJson(this.rateLimitPath())
    const lockoutUntil = typeof limits[`_lockout:${platform}`] === 'number'
      ? limits[`_lockout:${platform}`] as number
      : 0
    return Date.now() / 1000 < lockoutUntil
  }

  private recordFailedAttempt(platform: string): void {
    const limits = this.loadJson(this.rateLimitPath())
    const failKey = `_failures:${platform}`
    const fails = (typeof limits[failKey] === 'number' ? limits[failKey] as number : 0) + 1
    limits[failKey] = fails
    if (fails >= MAX_FAILED_ATTEMPTS) {
      limits[`_lockout:${platform}`] = Date.now() / 1000 + LOCKOUT_SECONDS
      limits[failKey] = 0
    }
    this.saveJson(this.rateLimitPath(), limits)
  }

  private approveUser(platform: string, user_id: string, user_name: string): void {
    const approved = this.loadJson(this.approvedPath(platform))
    approved[user_id] = { user_name, approved_at: Date.now() / 1000 } satisfies ApprovedEntry
    this.saveJson(this.approvedPath(platform), approved)
  }

  private cleanupExpired(platform: string): void {
    const pending = this.loadJson(this.pendingPath(platform))
    const now = Date.now() / 1000
    let changed = false
    for (const [entryId, info] of Object.entries(pending)) {
      if (typeof info !== 'object' || info === null) {
        delete pending[entryId]
        changed = true
        continue
      }
      const createdAt = (info as Partial<PendingEntry>).created_at
      if (typeof createdAt !== 'number' || now - createdAt > CODE_TTL_SECONDS) {
        delete pending[entryId]
        changed = true
      }
    }
    if (changed) this.saveJson(this.pendingPath(platform), pending)
  }
}

/** Constant-time hex comparison via node:crypto timingSafeEqual. */
function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

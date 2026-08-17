/**
 * Hermes-compatible on-disk state for the WeChat channel.
 *
 * File formats mirror hermes's runtime data 1:1 so `stateDir` can point at
 * hermes's `weixin/` directory and take over the same account (design §3,
 * §5.4; research §4):
 *
 * - `accounts/<id>.json`                 `{token, base_url, user_id, saved_at}`
 * - `accounts/<id>.context-tokens.json`  `{peer_user_id: context_token}`
 * - `accounts/<id>.sync.json`            `{get_updates_buf}`
 *
 * `pairing/` files live beside `accounts/` under `stateDir`; when `stateDir`
 * IS hermes's `weixin/` dir (basename `weixin`), pairing data is resolved to
 * the hermes home's `pairing/` sibling so DM approvals stay shared.
 *
 * All writes are atomic (temp file + rename), mirroring hermes's
 * `atomic_json_write` / `_secure_write`.
 * @module @dsh-plugin/dsh-channel-wechat/state
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/** UTF-8 JSON with 2-space indent — matches hermes file bytes. */
export function jsonPretty(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

/** Atomic JSON write: temp file in the same dir + rename (hermes `atomic_json_write`). */
export function atomicJsonWrite(path: string, data: unknown): void {
  const dir = resolve(dirOf(path))
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}_${randomSuffix()}.tmp`)
  try {
    writeFileSync(tmp, jsonPretty(data), 'utf-8')
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best-effort temp cleanup
    }
    throw error
  }
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  const idx2 = path.lastIndexOf('\\')
  const cut = Math.max(idx, idx2)
  return cut >= 0 ? path.slice(0, cut) : '.'
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Read a JSON file, tolerating absence/corruption like hermes. */
export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

/** Account credentials file (`accounts/<id>.json`). */
export interface AccountCredentials {
  token: string
  base_url: string
  user_id: string
  saved_at: string
}

/** UTC timestamp in hermes's `%Y-%m-%dT%H:%M:%SZ` format. */
export function hermesTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
}

/** Credentials store (hermes `save_weixin_account` / `load_weixin_account`). */
export class AccountStore {
  constructor(private readonly accountsDir: string) {}

  private pathFor(accountId: string): string {
    return join(this.accountsDir, `${accountId}.json`)
  }

  save(accountId: string, credentials: Omit<AccountCredentials, 'saved_at'>, now: Date = new Date()): void {
    atomicJsonWrite(this.pathFor(accountId), {
      ...credentials,
      saved_at: hermesTimestamp(now),
    })
  }

  load(accountId: string): AccountCredentials | undefined {
    const data = readJsonFile(this.pathFor(accountId))
    if (typeof data !== 'object' || data === null) return undefined
    const record = data as Record<string, unknown>
    const token = record['token']
    const baseUrl = record['base_url']
    const userId = record['user_id']
    if (typeof token !== 'string' || typeof baseUrl !== 'string') return undefined
    return {
      token,
      base_url: baseUrl,
      user_id: typeof userId === 'string' ? userId : '',
      saved_at: typeof record['saved_at'] === 'string' ? record['saved_at'] : '',
    }
  }
}

/**
 * Per-account context-token cache (`<id>.context-tokens.json`), mirroring
 * hermes `ContextTokenStore` (`weixin.py:268-315`): file keys are peer ids,
 * in-memory keys are `account:peer`.
 */
export class ContextTokenStore {
  private readonly cache = new Map<string, string>()

  constructor(private readonly accountsDir: string) {}

  private pathFor(accountId: string): string {
    return join(this.accountsDir, `${accountId}.context-tokens.json`)
  }

  private static key(accountId: string, userId: string): string {
    return `${accountId}:${userId}`
  }

  /** Load the file for `accountId` into memory (hermes `restore`). */
  restore(accountId: string): void {
    const data = readJsonFile(this.pathFor(accountId))
    if (typeof data !== 'object' || data === null) return
    for (const [userId, token] of Object.entries(data as Record<string, unknown>)) {
      if (typeof token === 'string' && token) {
        this.cache.set(ContextTokenStore.key(accountId, userId), token)
      }
    }
  }

  get(accountId: string, userId: string): string | undefined {
    return this.cache.get(ContextTokenStore.key(accountId, userId))
  }

  /** Number of cached tokens across accounts. */
  get size(): number {
    return this.cache.size
  }

  set(accountId: string, userId: string, token: string): void {
    this.cache.set(ContextTokenStore.key(accountId, userId), token)
    this.persist(accountId)
  }

  /** Drop one peer's token (hermes -14 session-expired handling). */
  clear(accountId: string, userId: string): void {
    if (this.cache.delete(ContextTokenStore.key(accountId, userId))) {
      this.persist(accountId)
    }
  }

  private persist(accountId: string): void {
    const prefix = `${accountId}:`
    const payload: Record<string, string> = {}
    for (const [key, value] of this.cache) {
      if (key.startsWith(prefix)) payload[key.slice(prefix.length)] = value
    }
    atomicJsonWrite(this.pathFor(accountId), payload)
  }
}

/** Long-poll cursor store (`<id>.sync.json`, hermes `_load_sync_buf`/`_save_sync_buf`). */
export class SyncStore {
  constructor(private readonly accountsDir: string) {}

  private pathFor(accountId: string): string {
    return join(this.accountsDir, `${accountId}.sync.json`)
  }

  load(accountId: string): string {
    const data = readJsonFile(this.pathFor(accountId))
    if (typeof data === 'object' && data !== null) {
      const buf = (data as Record<string, unknown>)['get_updates_buf']
      if (typeof buf === 'string') return buf
    }
    return ''
  }

  save(accountId: string, syncBuf: string): void {
    atomicJsonWrite(this.pathFor(accountId), { get_updates_buf: syncBuf })
  }
}

/** Resolve the pairing dir: `stateDir/pairing`, or hermes home `pairing/` sibling when stateDir is hermes's `weixin/` dir. */
export function resolvePairingDir(stateDir: string): string {
  const primary = join(stateDir, 'pairing')
  const resolved = resolve(stateDir)
  if (basename(resolved) === 'weixin') {
    const parentPairing = join(resolved, '..', 'pairing')
    if (existsSync(primary)) return primary
    if (existsSync(parentPairing)) return parentPairing
  }
  return primary
}

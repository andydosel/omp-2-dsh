/**
 * Plugin-owned compact-mode state: the `active` flag per session, replacing
 * the `compact/mode` session event. The flag lives in-memory (the mutex and
 * the UI read it) and is snapshotted to a plugin JSON file so it survives a
 * restart for the UI; a `/compact restore` re-applies it and re-enters review.
 *
 * The loop-pause/review state stays in the in-memory Reviews Map (unchanged);
 * only the log-only mode flag moved here.
 *
 * @module @dsh-plugin/dsh-compact-mode/state-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The per-session compact mode state. */
export interface CompactSessionState {
  active: boolean
}

/** Cap for the plugin-owned JSON snapshot. */
const STORE_MAX_BYTES = 4 * 1024 * 1024

/** Default plugin-owned JSON path (mirrors the review-tree path). */
function defaultStatePath(): string {
  const dshHome = process.env.DSH_HOME
  if (dshHome !== undefined && dshHome.length > 0) {
    return `${dshHome.replace(/[\\/]+$/, '')}/storages/compact-mode-state.json`
  }
  return './.compact-mode-state.json'
}

/**
 * Minimal one-file JSON store for the per-session compact mode flag. The
 * in-memory map is the synchronous source of truth; the JSON file is a
 * best-effort restart snapshot.
 */
export class CompactModeStore {
  private readonly sessions = new Map<string, CompactSessionState>()
  private latest: CompactSessionState = { active: false }
  private loaded = false
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly path: string = defaultStatePath()) {}

  /** Read one session's state (defaults to inactive). */
  get(sessionId: string): CompactSessionState {
    return this.sessions.get(sessionId) ?? { active: false }
  }

  /** The last-written state (the projection's read). */
  current(): CompactSessionState {
    return this.latest
  }

  /** Set one session's active flag and snapshot. */
  setActive(sessionId: string, active: boolean): void {
    const next: CompactSessionState = { active }
    this.write(sessionId, next)
  }

  /** Load the persisted snapshot into the in-memory map (idempotent). */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`dsh-compact-mode: state file ${this.path} is unreadable: ${String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`dsh-compact-mode: state file ${this.path} is corrupt: ${String(error)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`dsh-compact-mode: state file ${this.path} is not a JSON object`)
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const state = value as Partial<CompactSessionState> | undefined
      if (state === undefined || typeof state !== 'object') continue
      const normalized: CompactSessionState = { active: state.active === true }
      this.sessions.set(key, normalized)
      this.latest = normalized
    }
  }

  private write(sessionId: string, state: CompactSessionState): void {
    this.sessions.set(sessionId, state)
    this.latest = state
    const serialized = JSON.stringify(Object.fromEntries(this.sessions), null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > STORE_MAX_BYTES) return
    const write = this.persist(serialized)
    this.writeTail = this.writeTail.then(() => write).catch(() => {})
  }

  private async persist(serialized: string): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, serialized, { mode: 0o600 })
      await rename(tmp, this.path)
    } catch {
      // Best-effort snapshot: a failed write must never reject the caller.
    }
  }
}

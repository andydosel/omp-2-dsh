/**
 * Plugin-owned vibe-mode state: the active flag and the worker roster, keyed
 * by director session id. Replaces the `vibe/mode` / `vibe/workers` session
 * events: the state lives here (in-memory) and is snapshotted to a plugin
 * JSON file so it survives a restart for the UI, while a one-click
 * `/vibe restore` re-applies the runtime scope.
 *
 * The store is deliberately tiny (the `ReviewTreeJsonFile` pattern from
 * dsh-compact-mode): lazy async load, in-memory map, atomic fire-and-forget
 * writes, and a `current()` accessor for the session-agnostic projection.
 *
 * @module @dsh-plugin/dsh-vibe-mode/state-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { VibeWorkerView } from './types.ts'

/** The whole per-session vibe state (active flag + worker roster). */
export interface VibeSessionState {
  active: boolean
  workers: VibeWorkerView[]
}

/** Cap for the plugin-owned JSON snapshot. */
const STORE_MAX_BYTES = 4 * 1024 * 1024

/** Default plugin-owned JSON path (mirrors dsh-compact-mode's review-tree path). */
function defaultStatePath(): string {
  const dshHome = process.env.DSH_HOME
  if (dshHome !== undefined && dshHome.length > 0) {
    return `${dshHome.replace(/[\\/]+$/, '')}/storages/vibe-mode-state.json`
  }
  return './.vibe-mode-state.json'
}

/**
 * Minimal one-file JSON store for the per-session vibe state. The in-memory
 * map is the synchronous source of truth (the projection and the mutex read
 * it); the JSON file is a best-effort restart snapshot written atomically.
 */
export class VibeModeStore {
  private readonly sessions = new Map<string, VibeSessionState>()
  /** The last-written state — the projection's session-agnostic read. */
  private latest: VibeSessionState = { active: false, workers: [] }
  private loaded = false
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly path: string = defaultStatePath()) {}

  /** Read one session's state (defaults to inactive with no roster). */
  get(sessionId: string): VibeSessionState {
    return this.sessions.get(sessionId) ?? { active: false, workers: [] }
  }

  /** The last-written state (the projection's read). */
  current(): VibeSessionState {
    return this.latest
  }

  /** Set one session's active flag and snapshot. */
  setActive(sessionId: string, active: boolean): void {
    const next: VibeSessionState = { ...this.get(sessionId), active }
    this.write(sessionId, next)
  }

  /** Set one session's worker roster and snapshot. */
  setWorkers(sessionId: string, workers: VibeWorkerView[]): void {
    const next: VibeSessionState = { ...this.get(sessionId), workers }
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
      throw new Error(`dsh-vibe-mode: state file ${this.path} is unreadable: ${String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`dsh-vibe-mode: state file ${this.path} is corrupt: ${String(error)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`dsh-vibe-mode: state file ${this.path} is not a JSON object`)
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const state = value as Partial<VibeSessionState> | undefined
      if (state === undefined || typeof state !== 'object') continue
      const normalized: VibeSessionState = {
        active: state.active === true,
        workers: Array.isArray(state.workers) ? state.workers as VibeWorkerView[] : [],
      }
      this.sessions.set(key, normalized)
      this.latest = normalized
    }
  }

  private write(sessionId: string, state: VibeSessionState): void {
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

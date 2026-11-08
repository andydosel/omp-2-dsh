/**
 * Plugin-owned advisor state: the `enabled` flag and live reviewer count,
 * replacing the `advisor/status` session event. The advisor is a single-primary
 * runtime, so the state is one global record (not per-session). It is
 * snapshotted to a plugin JSON file so the UI badge survives a restart.
 *
 * @module @dsh-plugin/dsh-advisor/state-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * The advisor runtime's whole state (what the header badge and its panel show).
 *
 * `model` is the reviewer model route: `provider/model`, or a bare model id
 * (the primary's provider is reused), or `''` for "follow the primary
 * conversation's model". It is the effective route — a runtime override chosen
 * in the UI panel wins over the plugin config, so a restart restores the
 * user's pick without a config edit.
 */
export interface AdvisorState {
  enabled: boolean
  reviewers: number
  /** Effective reviewer model route; empty = follow the primary model. */
  model: string
}

/** Cap for the plugin-owned JSON snapshot. */
const STORE_MAX_BYTES = 4 * 1024 * 1024

/** Default plugin-owned JSON path. */
function defaultStatePath(): string {
  const dshHome = process.env.DSH_HOME
  if (dshHome !== undefined && dshHome.length > 0) {
    return `${dshHome.replace(/[\\/]+$/, '')}/storages/advisor-state.json`
  }
  return './.advisor-state.json'
}

/**
 * Minimal one-file JSON store for the advisor state. The in-memory record is
 * the synchronous source of truth; the JSON file is a best-effort restart
 * snapshot.
 */
export class AdvisorStore {
  /** Whether a persisted snapshot was actually loaded (not a fresh start). */
  hasSnapshot = false

  private latest: AdvisorState = { enabled: false, reviewers: 0, model: '' }
  private loaded = false
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly path: string = defaultStatePath()) {}

  /** The last-written state (the projection's read). */
  current(): AdvisorState {
    return this.latest
  }

  /** Set the whole state and snapshot. */
  set(state: AdvisorState): void {
    this.latest = state
    const serialized = JSON.stringify(state, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > STORE_MAX_BYTES) return
    const write = this.persist(serialized)
    this.writeTail = this.writeTail.then(() => write).catch(() => {})
  }

  /** Load the persisted snapshot (idempotent). */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`dsh-advisor: state file ${this.path} is unreadable: ${String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`dsh-advisor: state file ${this.path} is corrupt: ${String(error)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`dsh-advisor: state file ${this.path} is not a JSON object`)
    }
    const state = parsed as Partial<AdvisorState>
    this.latest = {
      enabled: state.enabled === true,
      reviewers: typeof state.reviewers === 'number' ? state.reviewers : 0,
      model: typeof state.model === 'string' ? state.model : '',
    }
    this.hasSnapshot = true
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

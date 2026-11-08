/**
 * Structural view of the web app's per-session model directory
 * (`ctx.modelDirectories`, owned by the `ui-model-selection` client plugin).
 *
 * The advisor bundle must stay installable on its own, so it may not take a
 * runtime dependency on that package: the picker is a convenience, and a
 * profile without model selection must still render a working badge. This
 * module narrows the unknown service value structurally and normalizes its
 * snapshot into the two fields the panel renders. When nothing matches, the
 * panel degrades to a hint and the badge keeps working.
 *
 * @module @dsh-plugin/dsh-advisor/client/badge/model-directory
 */

/** One selectable model row. */
export interface ModelChoice {
  readonly id: string
  readonly name: string
}

/** One provider group, display name included. */
export interface ModelProviderChoice {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelChoice[]
}

/** The slice of `ModelDirectoryState` the panel renders. */
export interface ModelDirectorySnapshot {
  readonly groups: readonly ModelProviderChoice[]
  /** `idle` | `loading` | `ready` | `selecting` | `error` */
  readonly status: string
  readonly error: string | null
}

/** What the panel needs from a model directory; identity-stable per session. */
export interface ModelDirectoryFace {
  subscribe(listener: () => void): () => void
  getSnapshot(): ModelDirectorySnapshot
  /** Kick the lazy catalog load; failures are the snapshot's business. */
  load(): void
}

/** Served while no directory is resolvable, and until the first snapshot lands. */
export const EMPTY_DIRECTORY_SNAPSHOT: ModelDirectorySnapshot = { groups: [], status: 'idle', error: null }

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalizeModels(raw: unknown): readonly ModelChoice[] {
  if (!Array.isArray(raw)) return []
  const models: ModelChoice[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = asString(record['id'])
    if (id === undefined || id === '') continue
    models.push({ id, name: asString(record['name']) ?? id })
  }
  return models
}

function normalizeGroups(raw: unknown): readonly ModelProviderChoice[] {
  if (!Array.isArray(raw)) return []
  const groups: ModelProviderChoice[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = asString(record['id'])
    if (id === undefined || id === '') continue
    const models = normalizeModels(record['models'])
    if (models.length === 0) continue
    groups.push({ id, name: asString(record['name']) ?? id, models })
  }
  return groups
}

/**
 * Normalize one raw `ModelDirectoryState` into the panel's view model.
 * Unknown shapes collapse to the empty snapshot rather than throwing.
 */
export function normalizeDirectory(raw: unknown): ModelDirectorySnapshot {
  if (raw === null || typeof raw !== 'object') return EMPTY_DIRECTORY_SNAPSHOT
  const record = raw as Record<string, unknown>
  return {
    groups: normalizeGroups(record['groups']),
    status: asString(record['status']) ?? 'idle',
    error: asString(record['error']) ?? null,
  }
}

/**
 * Adapt a resolved `ModelDirectory` (or anything shaped like one) into the
 * panel face. The snapshot memo keeps `getSnapshot()` referentially stable
 * between store notifications, which `useSyncExternalStore` requires.
 * @param candidate - the value returned by `modelDirectories.directoryFor(id)`.
 * @returns the face, or undefined when the value is not a model directory.
 */
export function adaptModelDirectory(candidate: unknown): ModelDirectoryFace | undefined {
  if (candidate === null || typeof candidate !== 'object') return undefined
  const store = (candidate as { store?: unknown }).store
  if (store === null || typeof store !== 'object') return undefined
  const readRaw = (store as { getSnapshot?: unknown }).getSnapshot
  const subscribeRaw = (store as { subscribe?: unknown }).subscribe
  if (typeof readRaw !== 'function' || typeof subscribeRaw !== 'function') return undefined
  const readSnapshot = readRaw as (this: unknown) => unknown
  const subscribe = subscribeRaw as (this: unknown, listener: () => void) => () => void
  const load = (candidate as { load?: unknown }).load
  // The directory's load() asserts availability against itself, so it keeps
  // its receiver.
  const runLoad = typeof load === 'function' ? (load as (this: unknown) => unknown).bind(candidate) : undefined

  let memoRaw: unknown
  let memoView: ModelDirectorySnapshot = EMPTY_DIRECTORY_SNAPSHOT
  let primed = false

  return {
    subscribe: (listener) => subscribe.call(store, listener),
    getSnapshot: () => {
      const raw = readSnapshot.call(store)
      if (primed && raw === memoRaw) return memoView
      primed = true
      memoRaw = raw
      memoView = normalizeDirectory(raw)
      return memoView
    },
    load: () => {
      if (runLoad === undefined) return
      void Promise.resolve(runLoad()).catch(() => {})
    },
  }
}

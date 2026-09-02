/**
 * Review tree wiring: persists and queries the instruction/draft review tree
 * through `@dsh-plugin/tree-engine` (workspace dependency).
 *
 * Storage follows the design's two routes:
 * - `'domain'` (preferred): a `compact-review` domain opened on
 *   `ctx.storageDomain`, records keyed by sessionId, physically separated from
 *   session logs (`$DSH_HOME/storages/compact-review.json` with storage-json).
 *   Falls back to the plugin-owned JSON file when no storage services exist.
 * - `'file'`: a plugin-owned JSON file (dsh-personal-memory pattern: atomic
 *   write + loud size gate), also keyed by sessionId.
 *
 * Cross-plugin note: `@dsh-plugin/tree-engine` is developed in parallel. The
 * contract this module compiles against (TreeEngine, InMemoryStorage,
 * JsonFileStorage, TreeStorage, SerializedTree, error classes) must be
 * re-verified after tree-engine lands.
 *
 * @module @dsh-plugin/dsh-compact-mode/tree
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  DuplicateNodeError,
  InMemoryStorage,
  JsonFileStorage,
  TreeEngine,
  TreeEngineError,
  UnknownNodeError,
} from '@dsh-plugin/tree-engine'
import type { SerializedTree, TreeStorage, TreeNode } from '@dsh-plugin/tree-engine'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { ResolvedConfig } from './config.ts'

/** One review node's structured content (the tree engine's opaque `M`). */
export interface ReviewNodeContent {
  /** The instruction that produced this draft ('' for the seed draft). */
  instruction: string
  /** The revised draft text. */
  draft: string
  /** Node id of the draft this one revises, or null for the seed. */
  sourceDraftId: string | null
  /** Revision-call provider route, when recorded. */
  provider?: string
  /** Revision-call model, when recorded. */
  model?: string
  /** Revision-call token usage, when recorded. */
  usage?: TokenUsage
}

/** Storage handle resolving a per-session review tree. */
export interface ReviewTreeHandle {
  /** The tree-engine instance (all methods async per the tree-engine contract). */
  engine: TreeEngine<ReviewNodeContent>
  /** Delete the persisted tree record (lifecycle: apply destroys, context change deletes). */
  destroy(): Promise<void>
}

/** Whether the plugin-owned JSON file route is in use (for diagnostics). */
export type ReviewTreeRoute = 'domain' | 'file'

/** Resolved review-tree storage backend (domain or plugin-owned file). */
export interface ResolvedTreeStorage {
  readonly route: ReviewTreeRoute
  /** Storage factory bound to one session id. */
  forSession(sessionId: string): TreeStorage<ReviewNodeContent>
  /** Delete one session's persisted record. */
  deleteSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

/** Key under which every session's tree lives in the JSON fallback file. */
const FILE_STORE_NAME = 'compact-review'

/** Cap for the plugin-owned JSON fallback (dsh-personal-memory pattern). */
const FILE_STORE_MAX_BYTES = 32 * 1024 * 1024

/**
 * Domain-backed storage. The `compact-review` domain declares one table
 * (`trees`) keyed by sessionId; each record is the full `SerializedTree`
 * produced by the tree engine.
 */
class DomainTreeStorage implements TreeStorage<ReviewNodeContent> {
  constructor(
    private readonly table: { get(key: string): unknown; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean> },
    private readonly sessionId: string,
  ) {}

  async load(): Promise<SerializedTree<ReviewNodeContent>> {
    const record = this.table.get(this.sessionId)
    return (record as SerializedTree<ReviewNodeContent> | undefined) ?? emptySerialized()
  }

  async save(tree: SerializedTree<ReviewNodeContent>): Promise<void> {
    await this.table.put(this.sessionId, tree)
  }

  async delete(): Promise<void> {
    await this.table.delete(this.sessionId)
  }
}

/** File-backed storage: one plugin-owned JSON file, atomic writes, loud gate. */
class FileTreeStorage implements TreeStorage<ReviewNodeContent> {
  constructor(
    private readonly store: { get(sessionId: string): unknown; set(sessionId: string, value: unknown): Promise<void>; delete(sessionId: string): Promise<void> },
    private readonly sessionId: string,
  ) {}

  async load(): Promise<SerializedTree<ReviewNodeContent>> {
    const record = this.store.get(this.sessionId)
    return (record as SerializedTree<ReviewNodeContent> | undefined) ?? emptySerialized()
  }

  async save(tree: SerializedTree<ReviewNodeContent>): Promise<void> {
    await this.store.set(this.sessionId, tree)
  }

  async delete(): Promise<void> {
    await this.store.delete(this.sessionId)
  }
}

/** A fresh, empty serialized tree (contract mirror of tree-engine's emptyTree). */
export function emptySerialized(): SerializedTree<ReviewNodeContent> {
  return { nodes: [], labels: [], leafId: null, seq: 0 }
}

/** Zod schema for one review node's content (validates stored records). */
const reviewNodeContentSchema = z.object({
  instruction: z.string(),
  draft: z.string(),
  sourceDraftId: z.string().nullable(),
  provider: z.string().optional(),
  model: z.string().optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
  }).optional(),
})

/** Zod schema for the tree-engine serialized state (validates stored records). */
const serializedTreeSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    content: reviewNodeContentSchema,
    createdAt: z.number(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })),
  labels: z.array(z.object({
    nodeId: z.string(),
    label: z.string().nullable(),
    createdAt: z.number(),
  })),
  leafId: z.string().nullable(),
  seq: z.number(),
})

/**
 * The `compact-review` storage domain: one table (`trees`) keyed by
 * sessionId, each record the full serialized review tree. Physically separate
 * from session logs (`$DSH_HOME/storages/compact-review.json` under
 * storage-json).
 */
export const reviewTreeDomainSpec: DomainSpec = defineDomain({
  name: 'compact_review',
  version: 1,
  tables: {
    trees: domainTable(serializedTreeSchema),
  },
})

/**
 * Open the storage backend for review trees.
 *
 * @param ctx - context providing optional storage services.
 * @param config - resolved config (`reviewTree` selects the route).
 * @param filePath - explicit plugin-owned JSON path (for tests / override);
 *   defaults to `<dshHome>/storages/compact-review.json` or
 *   `./.dsh-compact-review.json` when `dshHome` is unavailable.
 * @returns a resolved storage backend.
 */
export async function resolveTreeStorage(
  ctx: Context,
  config: ResolvedConfig,
  filePath?: string,
): Promise<ResolvedTreeStorage> {
  if (config.reviewTree === 'domain') {
    const facility = ctx.get('storageDomain')
    if (facility !== undefined) {
      const domain = await facility.open(reviewTreeDomainSpec)
      const table = domain.table('trees')
      return {
        route: 'domain',
        forSession: sessionId => new DomainTreeStorage(
          {
            get: key => table.get(key),
            put: (key, value) => table.put(key, value as never),
            delete: key => table.delete(key),
          },
          sessionId,
        ),
        deleteSession: async sessionId => {
          await table.delete(sessionId)
        },
        close: async () => {
          await domain.close()
        },
      }
    }
    ctx.logger.info('dsh-compact-mode: no storage-domain service; falling back to the plugin-owned review-tree file')
  }
  // File route (explicit or fallback).
  const path = filePath ?? defaultReviewTreePath()
  const store = new ReviewTreeJsonFile(path)
  await store.init()
  return {
    route: 'file',
    forSession: sessionId => new FileTreeStorage(
      {
        get: key => store.get(key),
        set: (key, value) => store.set(key, value),
        delete: key => store.delete(key),
      },
      sessionId,
    ),
    deleteSession: async sessionId => {
      await store.delete(sessionId)
    },
    close: async () => {},
  }
}

/** Default plugin-owned JSON path. */
function defaultReviewTreePath(): string {
  const dshHome = process.env.DSH_HOME
  if (dshHome !== undefined && dshHome.length > 0) {
    return `${dshHome.replace(/[\\/]+$/, '')}/storages/${FILE_STORE_NAME}.json`
  }
  return `./.${FILE_STORE_NAME}.json`
}

/**
 * Minimal one-file JSON key-value store (dsh-personal-memory pattern): lazy
 * load, in-memory map, serialized atomic writes, loud size gate. The file is
 * physically separate from session logs by construction.
 */
class ReviewTreeJsonFile {
  private data = new Map<string, unknown>()
  private loaded = false
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    await this.load()
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const { readFile } = await import('node:fs/promises')
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      throw new Error(`dsh-compact-mode: review-tree file ${this.path} is unreadable: ${String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`dsh-compact-mode: review-tree file ${this.path} is corrupt: ${String(error)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`dsh-compact-mode: review-tree file ${this.path} is not a JSON object`)
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      this.data.set(key, value)
    }
  }

  get(key: string): unknown {
    return this.data.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    const { writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write')
    this.data.set(key, value)
    const serialized = JSON.stringify(Object.fromEntries(this.data), null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > FILE_STORE_MAX_BYTES) {
      throw new Error(`dsh-compact-mode: review-tree file ${this.path} exceeds ${FILE_STORE_MAX_BYTES} bytes`)
    }
    const write = writeFileAtomic(this.path, serialized, { mode: 0o600 })
    this.tail = this.tail.then(() => write)
    await this.tail
  }

  async delete(key: string): Promise<void> {
    if (!this.data.delete(key)) return
    const { writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write')
    const serialized = JSON.stringify(Object.fromEntries(this.data), null, 2)
    const write = writeFileAtomic(this.path, serialized, { mode: 0o600 })
    this.tail = this.tail.then(() => write)
    await this.tail
  }
}

/**
 * Create one session's review-tree handle: a TreeEngine bound to a
 * per-session storage adapter. The engine lazily loads persisted state, so a
 * preserved tree (after abort) resumes on re-entry.
 *
 * @param storage - resolved storage backend.
 * @param session - the owning session.
 * @returns a handle exposing the engine and destroy.
 */
export async function createReviewTree(
  storage: ResolvedTreeStorage,
  session: Session,
): Promise<ReviewTreeHandle> {
  const engine = new TreeEngine<ReviewNodeContent>({
    storage: storage.forSession(session.id),
    searchableText: (node) => `${node.content.instruction}\n${node.content.draft}`,
  })
  await engine.ready()
  return {
    engine,
    destroy: async () => {
      await storage.deleteSession(session.id)
    },
  }
}

/**
 * Delete the persisted review tree for one session (lifecycle: context change
 * after abort, or apply).
 *
 * @param storage - resolved storage backend.
 * @param session - the owning session.
 */
export async function deleteReviewTree(storage: ResolvedTreeStorage, session: Session): Promise<void> {
  await storage.deleteSession(session.id)
}

export { DuplicateNodeError, InMemoryStorage, JsonFileStorage, TreeEngine, TreeEngineError, UnknownNodeError }
export type { TreeNode }

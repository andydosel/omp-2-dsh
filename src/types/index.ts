/**
 * Core data model for the dsh tree engine.
 *
 * Mirrors omp's tree CORE semantics: nodes form an append-only forest where
 * every node carries an explicit `parentId`, a `leaf` pointer marks the
 * "current position", and branching = moving the leaf pointer (never
 * rewriting history). This package ships no UI and no framework.
 */

/** A single tree node. `parentId === null` marks a root. */
export interface TreeNode<M = unknown> {
  /** Unique node id. */
  id: string;
  /** Parent node id, or `null` for a root. */
  parentId: string | null;
  /** Opaque node payload (e.g. the review draft). */
  content: M;
  /** Epoch milliseconds at creation. */
  createdAt: number;
  /** Optional opaque metadata (e.g. token usage). */
  meta?: Record<string, unknown>;
}

/** Input accepted by `TreeEngine#append`. The engine assigns parentId/leaf. */
export interface AppendInput<M = unknown> {
  /** Unique node id. Duplicate ids throw {@link DuplicateNodeError}. */
  id: string;
  /** Opaque node payload. */
  content: M;
  /** Optional opaque metadata (e.g. token usage). */
  meta?: Record<string, unknown>;
  /** Creation timestamp; defaults to `Date.now()`. */
  createdAt?: number;
}

/** A single append-only label record. `label === null` is a removal tombstone. */
export interface LabelRecord {
  /** Node the label is attached to. */
  nodeId: string;
  /** Label value; `null` records removal. */
  label: string | null;
  /** Epoch milliseconds when the record was appended. */
  createdAt: number;
}

/** Full serializable engine state. */
export interface SerializedTree<M = unknown> {
  /** All nodes, in append order. */
  nodes: TreeNode<M>[];
  /** All label records, in append order (append-only history). */
  labels: LabelRecord[];
  /** Current leaf node id, or `null` when the tree is empty. */
  leafId: string | null;
  /** Monotonic mutation counter (incremented on every mutation). */
  seq: number;
}

/**
 * Storage abstraction the engine persists through. The compact plugin can
 * plug its own domain-backed storage by implementing this interface.
 */
export interface TreeStorage<M = unknown> {
  /** Load full engine state. */
  load(): Promise<SerializedTree<M>>;
  /** Persist full engine state. */
  save(tree: SerializedTree<M>): Promise<void>;
}

/** A tree node with its nested `children` attached (result of `getTree`). */
export interface TreeNodeWithChildren<M = unknown> extends TreeNode<M> {
  children: TreeNodeWithChildren<M>[];
}

/** Derives the searchable text for a node. */
export type SearchableTextFn<M> = (
  node: TreeNode<M>,
  context: { label: string | null },
) => string;

/** Options for `TreeEngine#search`. */
export interface SearchOptions {
  /** Maximum number of matched nodes to return. */
  limit?: number;
  /** When true, matching is case-sensitive (default: false). */
  caseSensitive?: boolean;
}

/** Options for the {@link TreeEngine} constructor. */
export interface TreeEngineOptions<M = unknown> {
  /**
   * Persistence backend. When omitted the engine runs purely in memory
   * (state is still fully queryable/mutable, nothing is written).
   */
  storage?: TreeStorage<M>;
  /**
   * Per-node searchable text accessor. Defaults to
   * `JSON.stringify([content, meta, label])`.
   */
  searchableText?: SearchableTextFn<M>;
}

/** A fresh, empty serialized tree. */
export function emptyTree<M = unknown>(): SerializedTree<M> {
  return { nodes: [], labels: [], leafId: null, seq: 0 };
}

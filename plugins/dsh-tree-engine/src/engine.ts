import { DuplicateNodeError, UnknownNodeError } from './errors.js';
import { isSubsequence, tokenize } from './search.js';
import type {
  AppendInput,
  LabelRecord,
  SearchOptions,
  SearchableTextFn,
  SerializedTree,
  TreeNode,
  TreeNodeWithChildren,
  TreeEngineOptions,
  TreeStorage,
} from './types/index.js';
import { parseSerialized } from './validate.js';

const defaultSearchableText = <M>(
  node: TreeNode<M>,
  context: { label: string | null },
): string => JSON.stringify([node.content, node.meta, context.label]);

/**
 * Append-only tree engine mirroring omp's tree CORE data model.
 *
 * - Nodes are never rewritten: appends attach to the current leaf, branching
 *   moves the leaf pointer, labels are append-only records resolved at read
 *   time.
 * - All mutations and reads are async; state is lazily loaded from the
 *   optional {@link TreeStorage} on first use and saved after every mutation
 *   through a serialized write chain (call {@link flush} to await writes).
 *
 * @typeParam M - opaque node content type (e.g. the review draft).
 */
export class TreeEngine<M = unknown> {
  private readonly storage?: TreeStorage<M>;
  private readonly searchableText: SearchableTextFn<M>;

  private nodes = new Map<string, TreeNode<M>>();
  /** Node ids in append order (stable child ordering). */
  private order: string[] = [];
  private labelRecords: LabelRecord[] = [];
  private leafId: string | null = null;
  private seq = 0;

  private readyPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private lastSaveError: unknown = null;

  constructor(options: TreeEngineOptions<M> = {}) {
    this.storage = options.storage;
    this.searchableText = options.searchableText ?? defaultSearchableText;
  }

  /** Build a fully hydrated engine from serialized state (no storage). */
  static create<M = unknown>(serialized: SerializedTree<M>): TreeEngine<M> {
    const engine = new TreeEngine<M>();
    engine.replaceState(serialized);
    return engine;
  }

  // ------------------------------------------------------------------ state

  private ensureReady(): Promise<void> {
    if (this.readyPromise === null) {
      this.readyPromise = this.init().catch((err: unknown) => {
        // Allow a retry after a failed initial load.
        this.readyPromise = null;
        throw err;
      });
    }
    return this.readyPromise;
  }

  private async init(): Promise<void> {
    if (this.storage !== undefined) {
      const serialized = await this.storage.load();
      this.replaceState(serialized);
    }
  }

  private replaceState(serialized: SerializedTree<M>): void {
    const parsed = parseSerialized(serialized as unknown);
    this.nodes = new Map(parsed.nodes.map((n) => [n.id, n as TreeNode<M>]));
    this.order = parsed.nodes.map((n) => n.id);
    this.labelRecords = parsed.labels;
    this.leafId = parsed.leafId;
    this.seq = parsed.seq;
  }

  private assertNodeExists(nodeId: string): TreeNode<M> {
    const node = this.nodes.get(nodeId);
    if (node === undefined) throw new UnknownNodeError(nodeId);
    return node;
  }

  // -------------------------------------------------------------- lifecycle

  /** Resolve once initial state has been loaded from storage. */
  async ready(): Promise<void> {
    await this.ensureReady();
  }

  /**
   * Replace the entire engine state with validated serialized state.
   * Does not write back to storage; subsequent mutations will persist.
   */
  async load(serialized: SerializedTree<M>): Promise<void> {
    await this.ensureReady();
    this.replaceState(serialized);
  }

  /** Current state as a fresh structure (shares node references). */
  async serialize(): Promise<SerializedTree<M>> {
    await this.ensureReady();
    return {
      nodes: this.order.map((id) => {
        const node = this.nodes.get(id)!;
        return { ...node };
      }),
      labels: [...this.labelRecords],
      leafId: this.leafId,
      seq: this.seq,
    };
  }

  /** Deep copy of the current state (via structuredClone). */
  async snapshot(): Promise<SerializedTree<M>> {
    await this.ensureReady();
    return structuredClone(await this.serialize());
  }

  /** Await completion of all pending storage writes. */
  async flush(): Promise<void> {
    await this.writeChain;
    if (this.lastSaveError !== null) {
      const err = this.lastSaveError;
      this.lastSaveError = null;
      throw err;
    }
  }

  private enqueueSave(): void {
    const storage = this.storage;
    if (storage === undefined) return;
    this.writeChain = this.writeChain
      .catch(() => {
        // Never poison the chain: a failed write must not block later ones.
      })
      .then(async () => storage.save(await this.serialize()))
      .catch((err: unknown) => {
        this.lastSaveError = err;
      });
  }

  // --------------------------------------------------------------- mutations

  /**
   * Append a node as a child of the current leaf (or as a new root when the
   * tree has no leaf). The new node becomes the current leaf.
   */
  async append(input: AppendInput<M>): Promise<TreeNode<M>> {
    await this.ensureReady();
    if (this.nodes.has(input.id)) throw new DuplicateNodeError(input.id);
    const node: TreeNode<M> = {
      id: input.id,
      parentId: this.leafId,
      content: input.content,
      createdAt: input.createdAt ?? Date.now(),
    };
    if (input.meta !== undefined) node.meta = input.meta;
    this.nodes.set(node.id, node);
    this.order.push(node.id);
    this.leafId = node.id;
    this.seq += 1;
    this.enqueueSave();
    return node;
  }

  /**
   * Move the leaf pointer to an existing node (any depth). Future appends
   * attach there. History is never rewritten.
   */
  async moveLeaf(nodeId: string): Promise<void> {
    await this.ensureReady();
    this.assertNodeExists(nodeId);
    if (this.leafId !== nodeId) {
      this.leafId = nodeId;
      this.seq += 1;
      this.enqueueSave();
    }
  }

  /**
   * Non-destructive branch: move the leaf to an existing node and append
   * nothing — the caller's next `append` creates the first node of the new
   * branch. Old branches remain fully reachable in the tree.
   */
  async branchTo(nodeId: string): Promise<void> {
    await this.moveLeaf(nodeId);
  }

  /**
   * Append a label record (append-only). `null` records removal; the
   * effective label is resolved at read time via {@link getLabel}.
   */
  async setLabel(nodeId: string, label: string | null): Promise<void> {
    await this.ensureReady();
    this.assertNodeExists(nodeId);
    this.labelRecords.push({ nodeId, label, createdAt: Date.now() });
    this.seq += 1;
    this.enqueueSave();
  }

  // ---------------------------------------------------------------- queries

  /** Current leaf node id, or `null` when the tree is empty. */
  async getLeaf(): Promise<string | null> {
    await this.ensureReady();
    return this.leafId;
  }

  /** Current leaf node, or `null` when the tree is empty. */
  async getLeafNode(): Promise<TreeNode<M> | null> {
    await this.ensureReady();
    return this.leafId === null ? null : this.nodes.get(this.leafId) ?? null;
  }

  /** Look up a node by id; `undefined` when it does not exist. */
  async getNode(nodeId: string): Promise<TreeNode<M> | undefined> {
    await this.ensureReady();
    return this.nodes.get(nodeId);
  }

  /**
   * Root → node path (inclusive). With no argument, the path to the current
   * leaf; an empty array when the tree has no leaf.
   */
  async getBranch(nodeId?: string): Promise<TreeNode<M>[]> {
    await this.ensureReady();
    const target = nodeId ?? this.leafId;
    if (target === null) return [];
    this.assertNodeExists(target);
    const path: TreeNode<M>[] = [];
    let current: TreeNode<M> | undefined = this.nodes.get(target);
    while (current !== undefined) {
      path.unshift(current);
      current = current.parentId === null ? undefined : this.nodes.get(current.parentId);
    }
    return path;
  }

  /** Ancestors of a node, ordered root-first, excluding the node itself. */
  async getAncestors(nodeId: string): Promise<TreeNode<M>[]> {
    const path = await this.getBranch(nodeId);
    return path.slice(0, -1);
  }

  /** Direct children of a parent (or all roots for `null`), in append order. */
  async getChildren(parentId: string | null): Promise<TreeNode<M>[]> {
    await this.ensureReady();
    const children: TreeNode<M>[] = [];
    for (const id of this.order) {
      const node = this.nodes.get(id)!;
      if (node.parentId === parentId) children.push(node);
    }
    return children;
  }

  /** All root nodes, in append order. */
  async getRoots(): Promise<TreeNode<M>[]> {
    return this.getChildren(null);
  }

  /** Number of nodes. */
  async getSize(): Promise<number> {
    await this.ensureReady();
    return this.nodes.size;
  }

  /** Nested tree: roots with their transitive children attached. */
  async getTree(): Promise<TreeNodeWithChildren<M>[]> {
    await this.ensureReady();
    const result: TreeNodeWithChildren<M>[] = [];
    const index = new Map<string, TreeNodeWithChildren<M>>();
    for (const id of this.order) {
      const node = this.nodes.get(id)!;
      index.set(id, { ...node, children: [] });
    }
    for (const id of this.order) {
      const decorated = index.get(id)!;
      const parentId = this.nodes.get(id)!.parentId;
      if (parentId === null) {
        result.push(decorated);
      } else {
        index.get(parentId)!.children.push(decorated);
      }
    }
    return result;
  }

  // ----------------------------------------------------------------- labels

  private resolveLabel(nodeId: string): string | null {
    let resolved: string | null = null;
    for (const record of this.labelRecords) {
      if (record.nodeId === nodeId) resolved = record.label;
    }
    return resolved;
  }

  /** Effective (runtime-resolved) label for a node; `null` when unlabeled. */
  async getLabel(nodeId: string): Promise<string | null> {
    await this.ensureReady();
    return this.resolveLabel(nodeId);
  }

  /** Map of nodeId → effective label for all currently labeled nodes. */
  async getLabels(): Promise<Map<string, string>> {
    await this.ensureReady();
    const result = new Map<string, string>();
    for (const record of this.labelRecords) {
      if (record.label === null) {
        result.delete(record.nodeId);
      } else {
        result.set(record.nodeId, record.label);
      }
    }
    return result;
  }

  /** Full append-only label history for a node (oldest first). */
  async getLabelHistory(nodeId: string): Promise<LabelRecord[]> {
    await this.ensureReady();
    return this.labelRecords.filter((r) => r.nodeId === nodeId);
  }

  // ----------------------------------------------------------------- search

  /**
   * Fuzzy subsequence search over each node's searchable text. All
   * whitespace-delimited query tokens must match (AND); matching is
   * case-insensitive by default. Results are in append order.
   */
  async search(query: string, options: SearchOptions = {}): Promise<TreeNode<M>[]> {
    await this.ensureReady();
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const caseSensitive = options.caseSensitive ?? false;
    const limit = options.limit;
    const results: TreeNode<M>[] = [];
    for (const id of this.order) {
      const node = this.nodes.get(id)!;
      const text = this.searchableText(node, { label: this.resolveLabel(node.id) });
      if (tokens.every((t) => isSubsequence(t, text, caseSensitive))) {
        results.push(node);
        if (limit !== undefined && results.length >= limit) break;
      }
    }
    return results;
  }
}

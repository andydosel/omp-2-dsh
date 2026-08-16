import type { SerializedTree, TreeStorage } from '../types/index.js';

/**
 * In-memory {@link TreeStorage} — the default persistence backend. Loads
 * return a deep copy of the stored state; saves store a deep copy, so the
 * engine and the storage never share mutable references.
 */
export class InMemoryStorage<M = unknown> implements TreeStorage<M> {
  private state: SerializedTree<M>;

  constructor(initial?: SerializedTree<M>) {
    this.state = initial === undefined ? { nodes: [], labels: [], leafId: null, seq: 0 } : structuredClone(initial);
  }

  async load(): Promise<SerializedTree<M>> {
    return structuredClone(this.state);
  }

  async save(tree: SerializedTree<M>): Promise<void> {
    this.state = structuredClone(tree);
  }

  /** Current stored state (deep copy) — test/observation convenience. */
  peek(): SerializedTree<M> {
    return structuredClone(this.state);
  }
}

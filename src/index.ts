/**
 * @dsh-plugin/tree-engine — standalone, dependency-free append-only tree
 * engine mirroring omp's tree CORE data model (no UI, no framework).
 *
 * Used as the foundation of the dsh compact review tree.
 */
export { TreeEngine } from './engine.js';
export {
  TreeEngineError,
  UnknownNodeError,
  DuplicateNodeError,
  InvalidTreeError,
} from './errors.js';
export { isSubsequence, tokenize, matchQuery } from './search.js';
export { parseSerialized } from './validate.js';
export { InMemoryStorage, JsonFileStorage } from './storage/index.js';
export type {
  AppendInput,
  LabelRecord,
  SearchableTextFn,
  SearchOptions,
  SerializedTree,
  TreeNode,
  TreeNodeWithChildren,
  TreeEngineOptions,
  TreeStorage,
} from './types/index.js';
export { emptyTree } from './types/index.js';

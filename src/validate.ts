import { InvalidTreeError } from './errors.js';
import type { LabelRecord, SerializedTree, TreeNode } from './types/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new InvalidTreeError(message);
}

function parseNode(value: unknown): TreeNode {
  if (!isRecord(value)) fail(`invalid tree: node is not an object`);
  if (typeof value.id !== 'string' || value.id.length === 0) {
    fail(`invalid tree: node.id must be a non-empty string`);
  }
  if (value.parentId !== null && typeof value.parentId !== 'string') {
    fail(`invalid tree: node ${JSON.stringify(value.id)} parentId must be a string or null`);
  }
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    fail(`invalid tree: node ${JSON.stringify(value.id)} createdAt must be a finite number`);
  }
  if (!('content' in value)) {
    fail(`invalid tree: node ${JSON.stringify(value.id)} missing content`);
  }
  if (value.meta !== undefined && !isRecord(value.meta)) {
    fail(`invalid tree: node ${JSON.stringify(value.id)} meta must be an object`);
  }
  const node: TreeNode = {
    id: value.id,
    parentId: value.parentId as string | null,
    content: value.content,
    createdAt: value.createdAt,
  };
  if (value.meta !== undefined) node.meta = value.meta as Record<string, unknown>;
  return node;
}

function parseLabel(value: unknown): LabelRecord {
  if (!isRecord(value)) fail(`invalid tree: label is not an object`);
  if (typeof value.nodeId !== 'string') fail(`invalid tree: label.nodeId must be a string`);
  if (value.label !== null && typeof value.label !== 'string') {
    fail(`invalid tree: label for ${JSON.stringify(value.nodeId)} must be a string or null`);
  }
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    fail(`invalid tree: label for ${JSON.stringify(value.nodeId)} createdAt must be a finite number`);
  }
  return {
    nodeId: value.nodeId,
    label: value.label as string | null,
    createdAt: value.createdAt,
  };
}

/**
 * Validate an unknown value as a {@link SerializedTree}, throwing
 * {@link InvalidTreeError} on any structural problem. Returns the narrowed
 * value. Used by `TreeEngine#load` and `JsonFileStorage#load`.
 */
export function parseSerialized(value: unknown): SerializedTree {
  if (!isRecord(value)) fail(`invalid tree: serialized tree must be an object`);
  if (!Array.isArray(value.nodes)) fail(`invalid tree: nodes must be an array`);
  if (!Array.isArray(value.labels)) fail(`invalid tree: labels must be an array`);
  if (value.leafId !== null && typeof value.leafId !== 'string') {
    fail(`invalid tree: leafId must be a string or null`);
  }
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0) {
    fail(`invalid tree: seq must be a non-negative integer`);
  }

  const nodes = value.nodes.map(parseNode);
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) fail(`invalid tree: duplicate node id ${JSON.stringify(node.id)}`);
    ids.add(node.id);
  }
  for (const node of nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) {
      fail(`invalid tree: node ${JSON.stringify(node.id)} references unknown parent ${JSON.stringify(node.parentId)}`);
    }
  }
  if (value.leafId !== null && !ids.has(value.leafId)) {
    fail(`invalid tree: leafId ${JSON.stringify(value.leafId)} does not reference an existing node`);
  }

  const labels = value.labels.map(parseLabel);
  for (const label of labels) {
    if (!ids.has(label.nodeId)) {
      fail(`invalid tree: label references unknown node ${JSON.stringify(label.nodeId)}`);
    }
  }

  return { nodes, labels, leafId: value.leafId as string | null, seq: value.seq };
}

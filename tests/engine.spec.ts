import { describe, expect, it } from 'vitest';
import {
  DuplicateNodeError,
  TreeEngine,
  UnknownNodeError,
  InvalidTreeError,
} from '../src/index.js';

describe('append', () => {
  it('creates a root when the tree has no leaf', async () => {
    const tree = new TreeEngine();
    const node = await tree.append({ id: 'a', content: 'v1' });
    expect(node).toEqual({
      id: 'a',
      parentId: null,
      content: 'v1',
      createdAt: expect.any(Number),
    });
    expect(await tree.getLeaf()).toBe('a');
    expect(await tree.getRoots()).toEqual([node]);
  });

  it('chains children under the current leaf', async () => {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'v1' });
    await tree.append({ id: 'b', content: 'v2' });
    const c = await tree.append({ id: 'c', content: 'v3' });
    expect(c.parentId).toBe('b');
    expect(await tree.getLeaf()).toBe('c');
    expect((await tree.getBranch()).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserves meta and honors explicit createdAt', async () => {
    const tree = new TreeEngine();
    const node = await tree.append({
      id: 'x',
      content: 'v',
      meta: { tokens: 42 },
      createdAt: 1234,
    });
    expect(node.meta).toEqual({ tokens: 42 });
    expect(node.createdAt).toBe(1234);
  });

  it('rejects duplicate ids and leaves state unchanged', async () => {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'v1' });
    await expect(tree.append({ id: 'a', content: 'v2' })).rejects.toBeInstanceOf(
      DuplicateNodeError,
    );
    expect(await tree.getSize()).toBe(1);
    expect((await tree.getNode('a'))!.content).toBe('v1');
    expect(await tree.getLeaf()).toBe('a');
  });
});

describe('leaf semantics / moveLeaf', () => {
  it('moves the leaf to any existing node; future appends attach there', async () => {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'v1' });
    await tree.append({ id: 'b', content: 'v2' });
    await tree.append({ id: 'c', content: 'v3' });
    await tree.moveLeaf('a');
    expect(await tree.getLeaf()).toBe('a');
    const d = await tree.append({ id: 'd', content: 'v4' });
    expect(d.parentId).toBe('a');
  });

  it('throws UnknownNodeError on unknown id', async () => {
    const tree = new TreeEngine();
    await expect(tree.moveLeaf('nope')).rejects.toBeInstanceOf(UnknownNodeError);
  });

  it('leaves history intact after moving', async () => {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'v1' });
    await tree.append({ id: 'b', content: 'v2' });
    await tree.moveLeaf('a');
    expect(await tree.getSize()).toBe(2);
    expect((await tree.getBranch('b')).map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('getLeafNode follows the leaf', async () => {
    const tree = new TreeEngine();
    expect(await tree.getLeafNode()).toBeNull();
    await tree.append({ id: 'a', content: 'v1' });
    expect((await tree.getLeafNode())!.id).toBe('a');
  });
});

describe('branchTo (non-destructive)', () => {
  it('branches from an ancestor and keeps the old branch reachable', async () => {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'v1' });
    await tree.append({ id: 'b', content: 'v2' });
    await tree.append({ id: 'c', content: 'v3' });
    await tree.branchTo('b');
    expect(await tree.getLeaf()).toBe('b');
    await tree.append({ id: 'd', content: 'v4' });

    // Old branch remains fully reachable — nothing was rewritten or deleted.
    expect((await tree.getBranch('c')).map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect((await tree.getBranch('d')).map((n) => n.id)).toEqual(['a', 'b', 'd']);
    expect(await tree.getSize()).toBe(4);

    // Both branches appear in the nested tree view.
    const view = await tree.getTree();
    expect(view).toHaveLength(1);
    expect(view[0]!.children.map((n) => n.id)).toEqual(['b']);
    expect(view[0]!.children[0]!.children.map((n) => n.id)).toEqual(['c', 'd']);
  });

  it('throws UnknownNodeError on unknown id', async () => {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'v1' });
    await expect(tree.branchTo('nope')).rejects.toBeInstanceOf(UnknownNodeError);
  });

  it('deep branching keeps every intermediate branch', async () => {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'v1' });
    await tree.append({ id: 'b', content: 'v2' });
    await tree.append({ id: 'c', content: 'v3' });
    await tree.branchTo('a'); // jump to root
    await tree.append({ id: 'd', content: 'v4' });
    await tree.branchTo('d'); // move forward to d
    await tree.append({ id: 'e', content: 'v5' });
    expect((await tree.getBranch()).map((n) => n.id)).toEqual(['a', 'd', 'e']);
    expect((await tree.getBranch('c')).map((n) => n.id)).toEqual(['a', 'b', 'c']);
    const view = await tree.getTree();
    expect(view[0]!.children.map((n) => n.id)).toEqual(['b', 'd']);
    expect(view[0]!.children[1]!.children.map((n) => n.id)).toEqual(['e']);
  });
});

describe('traversal', () => {
  async function makeTree(): Promise<TreeEngine> {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'v1' });
    await tree.append({ id: 'b', content: 'v2' });
    await tree.append({ id: 'c', content: 'v3' });
    await tree.branchTo('a');
    await tree.append({ id: 'd', content: 'v4' });
    return tree;
  }

  it('getChildren returns direct children in append order', async () => {
    const tree = await makeTree();
    expect((await tree.getChildren('a')).map((n) => n.id)).toEqual(['b', 'd']);
    expect((await tree.getChildren('b')).map((n) => n.id)).toEqual(['c']);
    expect(await tree.getChildren('c')).toEqual([]);
    expect(await tree.getChildren('nope')).toEqual([]);
  });

  it('getAncestors excludes the node itself, ordered root-first', async () => {
    const tree = await makeTree();
    expect((await tree.getAncestors('d')).map((n) => n.id)).toEqual(['a']);
    expect((await tree.getAncestors('c')).map((n) => n.id)).toEqual(['a', 'b']);
    expect(await tree.getAncestors('a')).toEqual([]);
  });

  it('getBranch on the leaf equals ancestors + leaf', async () => {
    const tree = await makeTree();
    expect((await tree.getBranch('d')).map((n) => n.id)).toEqual(['a', 'd']);
    const ancestors = await tree.getAncestors('d');
    const branch = await tree.getBranch('d');
    expect(branch.slice(0, -1)).toEqual(ancestors);
  });

  it('getRoots returns all roots in append order', async () => {
    const tree = TreeEngine.create({
      nodes: [
        { id: 'r1', parentId: null, content: 'x', createdAt: 1 },
        { id: 'r2', parentId: null, content: 'y', createdAt: 2 },
        { id: 'k', parentId: 'r2', content: 'z', createdAt: 3 },
      ],
      labels: [],
      leafId: 'k',
      seq: 3,
    });
    expect((await tree.getRoots()).map((n) => n.id)).toEqual(['r1', 'r2']);
  });

  it('getBranch throws on unknown id; empty tree returns []', async () => {
    const tree = new TreeEngine();
    expect(await tree.getBranch()).toEqual([]);
    await expect(tree.getBranch('nope')).rejects.toBeInstanceOf(UnknownNodeError);
  });

  it('getNode returns undefined for unknown id', async () => {
    const tree = await makeTree();
    expect(await tree.getNode('nope')).toBeUndefined();
    expect((await tree.getNode('c'))!.content).toBe('v3');
  });
});

describe('serialize / snapshot / load / seq', () => {
  it('seq increments on every effective mutation', async () => {
    const tree = new TreeEngine();
    expect((await tree.serialize()).seq).toBe(0);
    await tree.append({ id: 'a', content: 'v1' });
    await tree.append({ id: 'b', content: 'v2' });
    await tree.moveLeaf('a');
    await tree.setLabel('a', 'draft');
    expect((await tree.serialize()).seq).toBe(4);
    // No-op move to the current leaf is not a mutation.
    await tree.moveLeaf('a');
    expect((await tree.serialize()).seq).toBe(4);
  });

  it('snapshot is a deep copy isolated from the engine', async () => {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: { text: 'v1' } });
    const snap = await tree.snapshot();
    (snap.nodes[0]!.content as { text: string }).text = 'mutated';
    snap.nodes[0]!.id = 'mutated-id';
    expect((await tree.getNode('a'))!.content).toEqual({ text: 'v1' });
    expect(await tree.getNode('mutated-id')).toBeUndefined();
  });

  it('load replaces state after validation', async () => {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'v1' });
    await tree.load({
      nodes: [{ id: 'x', parentId: null, content: 'new', createdAt: 1 }],
      labels: [],
      leafId: 'x',
      seq: 5,
    });
    expect(await tree.getSize()).toBe(1);
    expect((await tree.getNode('x'))!.content).toBe('new');
    expect((await tree.serialize()).seq).toBe(5);

    await expect(
      tree.load({
        nodes: [{ id: 'x', parentId: null, content: 'new', createdAt: 1 }],
        labels: [],
        leafId: 'missing',
        seq: 5,
      }),
    ).rejects.toBeInstanceOf(InvalidTreeError);
    // Failed load leaves previous state intact.
    expect((await tree.getNode('x'))!.content).toBe('new');
  });

  it('TreeEngine.create hydrates synchronously from serialized state', async () => {
    const serialized = {
      nodes: [
        { id: 'a', parentId: null, content: 'v1', createdAt: 1 },
        { id: 'b', parentId: 'a', content: 'v2', createdAt: 2 },
      ],
      labels: [],
      leafId: 'b',
      seq: 2,
    };
    const tree = TreeEngine.create(serialized);
    expect(await tree.getLeaf()).toBe('b');
    expect((await tree.getBranch()).map((n) => n.id)).toEqual(['a', 'b']);
    expect((await tree.serialize()).seq).toBe(2);
  });
});

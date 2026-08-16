import { describe, expect, it } from 'vitest';
import { TreeEngine, UnknownNodeError } from '../src/index.js';

describe('labels', () => {
  async function makeTree(): Promise<TreeEngine> {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'v1' });
    await tree.append({ id: 'b', content: 'v2' });
    await tree.append({ id: 'c', content: 'v3' });
    return tree;
  }

  it('sets and resolves a label', async () => {
    const tree = await makeTree();
    expect(await tree.getLabel('b')).toBeNull();
    await tree.setLabel('b', 'draft');
    expect(await tree.getLabel('b')).toBe('draft');
  });

  it('overwrites and removes via null (append-only records)', async () => {
    const tree = await makeTree();
    await tree.setLabel('b', 'draft');
    await tree.setLabel('b', 'final');
    expect(await tree.getLabel('b')).toBe('final');
    await tree.setLabel('b', null);
    expect(await tree.getLabel('b')).toBeNull();
  });

  it('getLabels returns only currently-labeled nodes', async () => {
    const tree = await makeTree();
    await tree.setLabel('a', 'one');
    await tree.setLabel('b', 'two');
    await tree.setLabel('b', null);
    expect([...await tree.getLabels()]).toEqual([['a', 'one']]);
  });

  it('getLabelHistory is an append-only audit trail', async () => {
    const tree = await makeTree();
    await tree.setLabel('b', 'draft');
    await tree.setLabel('b', 'final');
    await tree.setLabel('b', null);
    const history = await tree.getLabelHistory('b');
    expect(history.map((r) => r.label)).toEqual(['draft', 'final', null]);
    expect(history.map((r) => r.nodeId)).toEqual(['b', 'b', 'b']);
    expect(history.every((r) => typeof r.createdAt === 'number')).toBe(true);
  });

  it('labels survive branching and serialization', async () => {
    const tree = await makeTree();
    await tree.setLabel('b', 'branch-point');
    await tree.branchTo('b');
    await tree.append({ id: 'd', content: 'v4' });
    expect(await tree.getLabel('b')).toBe('branch-point');
    const serialized = await tree.serialize();
    const reloaded = TreeEngine.create(serialized);
    expect(await reloaded.getLabel('b')).toBe('branch-point');
    expect(serialized.labels).toHaveLength(1);
  });

  it('setLabel on an unknown node throws', async () => {
    const tree = await makeTree();
    await expect(tree.setLabel('nope', 'x')).rejects.toBeInstanceOf(UnknownNodeError);
  });

  it('getLabel on an unknown node is lenient (null)', async () => {
    const tree = await makeTree();
    expect(await tree.getLabel('nope')).toBeNull();
  });
});

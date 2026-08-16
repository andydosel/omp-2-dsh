import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryStorage,
  InvalidTreeError,
  JsonFileStorage,
  TreeEngine,
} from '../src/index.js';

describe('InMemoryStorage', () => {
  it('round-trips engine state through a shared storage instance', async () => {
    const storage = new InMemoryStorage();
    const engine = new TreeEngine({ storage });
    await engine.append({ id: 'a', content: 'v1' });
    await engine.append({ id: 'b', content: 'v2' });
    await engine.setLabel('b', 'draft');
    await engine.flush();

    const engine2 = new TreeEngine({ storage });
    expect(await engine2.serialize()).toEqual(await engine.serialize());
    expect(await engine2.getLabel('b')).toBe('draft');
    expect((await engine2.getBranch()).map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('initializes from a serialized tree', async () => {
    const storage = new InMemoryStorage({
      nodes: [{ id: 'a', parentId: null, content: 'v1', createdAt: 1 }],
      labels: [{ nodeId: 'a', label: 'root', createdAt: 2 }],
      leafId: 'a',
      seq: 1,
    });
    const engine = new TreeEngine({ storage });
    expect(await engine.getLeaf()).toBe('a');
    expect(await engine.getLabel('a')).toBe('root');
  });

  it('deep-copies state: engine and storage never share references', async () => {
    const storage = new InMemoryStorage();
    const engine = new TreeEngine({ storage });
    await engine.append({ id: 'a', content: { text: 'v1' } });
    await engine.flush();

    const stored = storage.peek();
    (stored.nodes[0]!.content as { text: string }).text = 'tampered';
    stored.leafId = 'evil';

    expect((await engine.getNode('a'))!.content).toEqual({ text: 'v1' });
    expect(await engine.getLeaf()).toBe('a');
  });
});

describe('JsonFileStorage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tree-engine-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a branched, labeled tree through a JSON file', async () => {
    const file = join(dir, 'tree.json');
    const engine = new TreeEngine({ storage: new JsonFileStorage(file) });
    await engine.append({ id: 'a', content: 'v1' });
    await engine.append({ id: 'b', content: 'v2' });
    await engine.branchTo('a');
    await engine.append({ id: 'c', content: 'v3' });
    await engine.setLabel('c', 'final');
    await engine.flush();

    const engine2 = new TreeEngine({ storage: new JsonFileStorage(file) });
    expect(await engine2.serialize()).toEqual(await engine.serialize());
    expect((await engine2.getBranch()).map((n) => n.id)).toEqual(['a', 'c']);
    expect(await engine2.getLabel('c')).toBe('final');
    expect(await engine2.getSize()).toBe(3);
  });

  it('writes atomically: full content on disk, no temp files left behind', async () => {
    const file = join(dir, 'tree.json');
    const engine = new TreeEngine({ storage: new JsonFileStorage(file) });
    await engine.append({ id: 'a', content: 'v1' });
    await engine.flush();

    expect(await readdir(dir)).toEqual(['tree.json']);
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed.nodes).toEqual([
      { id: 'a', parentId: null, content: 'v1', createdAt: expect.any(Number) },
    ]);
    expect(parsed.leafId).toBe('a');
    expect(parsed.labels).toEqual([]);
    expect(parsed.seq).toBe(1);

    // Overwrite repeatedly: still atomic, still no leftovers.
    await engine.append({ id: 'b', content: 'v2' });
    await engine.flush();
    expect(await readdir(dir)).toEqual(['tree.json']);
    const parsed2 = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed2.nodes).toHaveLength(2);
    expect(parsed2.leafId).toBe('b');
  });

  it('creates parent directories on save', async () => {
    const file = join(dir, 'nested', 'deep', 'tree.json');
    const engine = new TreeEngine({ storage: new JsonFileStorage(file) });
    await engine.append({ id: 'a', content: 'v1' });
    await engine.flush();
    const reloaded = new TreeEngine({ storage: new JsonFileStorage(file) });
    expect(await reloaded.getLeaf()).toBe('a');
  });

  it('loads an empty tree when the file does not exist', async () => {
    const engine = new TreeEngine({ storage: new JsonFileStorage(join(dir, 'missing.json')) });
    expect(await engine.serialize()).toEqual({ nodes: [], labels: [], leafId: null, seq: 0 });
    expect(await engine.getSize()).toBe(0);
  });

  it('rejects invalid JSON on load', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(file, '{ not json', 'utf8');
    const engine = new TreeEngine({ storage: new JsonFileStorage(file) });
    await expect(engine.ready()).rejects.toBeInstanceOf(InvalidTreeError);
    // A subsequent operation surfaces the same error.
    await expect(engine.append({ id: 'a', content: 'x' })).rejects.toBeInstanceOf(
      InvalidTreeError,
    );
  });

  it('rejects malformed tree shape on load', async () => {
    const file = join(dir, 'bad-shape.json');
    await writeFile(
      file,
      JSON.stringify({
        nodes: [{ id: 'a', parentId: 'zzz', content: 'x', createdAt: 1 }],
        labels: [],
        leafId: null,
        seq: 0,
      }),
      'utf8',
    );
    const engine = new TreeEngine({ storage: new JsonFileStorage(file) });
    await expect(engine.ready()).rejects.toBeInstanceOf(InvalidTreeError);
  });

  it('rejects leafId referencing a missing node on load', async () => {
    const file = join(dir, 'bad-leaf.json');
    await writeFile(
      file,
      JSON.stringify({
        nodes: [{ id: 'a', parentId: null, content: 'x', createdAt: 1 }],
        labels: [],
        leafId: 'nope',
        seq: 1,
      }),
      'utf8',
    );
    const engine = new TreeEngine({ storage: new JsonFileStorage(file) });
    await expect(engine.ready()).rejects.toBeInstanceOf(InvalidTreeError);
  });

  it('save refuses to write malformed state', async () => {
    const storage = new JsonFileStorage(join(dir, 'x.json'));
    await expect(
      storage.save({
        nodes: [{ id: 'a', parentId: null, content: 'x', createdAt: 1 }],
        labels: [],
        leafId: 'nope',
        seq: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidTreeError);
  });
});

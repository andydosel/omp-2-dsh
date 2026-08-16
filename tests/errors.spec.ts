import { describe, expect, it } from 'vitest';
import {
  DuplicateNodeError,
  InvalidTreeError,
  TreeEngineError,
  UnknownNodeError,
  parseSerialized,
} from '../src/index.js';

describe('error classes', () => {
  it('shares the TreeEngineError base', () => {
    expect(new UnknownNodeError('a')).toBeInstanceOf(TreeEngineError);
    expect(new DuplicateNodeError('a')).toBeInstanceOf(TreeEngineError);
    expect(new InvalidTreeError('bad')).toBeInstanceOf(TreeEngineError);
    expect(new UnknownNodeError('a')).toBeInstanceOf(Error);
  });

  it('sets the concrete class name', () => {
    expect(new UnknownNodeError('a').name).toBe('UnknownNodeError');
    expect(new DuplicateNodeError('a').name).toBe('DuplicateNodeError');
    expect(new InvalidTreeError('bad').name).toBe('InvalidTreeError');
  });

  it('includes the offending id in messages', () => {
    expect(new UnknownNodeError('nope').message).toContain('nope');
    expect(new DuplicateNodeError('dup').message).toContain('dup');
  });
});

describe('parseSerialized validation', () => {
  const valid = {
    nodes: [{ id: 'a', parentId: null, content: 'v1', createdAt: 1 }],
    labels: [],
    leafId: 'a',
    seq: 1,
  };

  it('accepts a valid serialized tree', () => {
    expect(parseSerialized(valid)).toEqual(valid);
  });

  it('rejects non-object roots and wrong array types', () => {
    expect(() => parseSerialized(null)).toThrow(InvalidTreeError);
    expect(() => parseSerialized('x')).toThrow(InvalidTreeError);
    expect(() => parseSerialized({ ...valid, nodes: 'nope' })).toThrow(InvalidTreeError);
    expect(() => parseSerialized({ ...valid, labels: 'nope' })).toThrow(InvalidTreeError);
  });

  it('rejects missing/invalid fields on nodes', () => {
    const base = { nodes: [{}], labels: [], leafId: null, seq: 0 };
    expect(() => parseSerialized(base)).toThrow(InvalidTreeError); // no id
    expect(() =>
      parseSerialized({
        nodes: [{ id: 'a', parentId: 'p', content: 'x', createdAt: 1 }],
        labels: [],
        leafId: null,
        seq: 0,
      }),
    ).toThrow(InvalidTreeError); // unknown parent
    expect(() =>
      parseSerialized({
        nodes: [{ id: 'a', parentId: null, content: 'x', createdAt: 'yesterday' }],
        labels: [],
        leafId: null,
        seq: 0,
      }),
    ).toThrow(InvalidTreeError);
    expect(() =>
      parseSerialized({
        nodes: [{ id: 'a', parentId: null, createdAt: 1 }],
        labels: [],
        leafId: null,
        seq: 0,
      }),
    ).toThrow(InvalidTreeError); // missing content
  });

  it('rejects duplicate ids and negative seq', () => {
    const dup = {
      nodes: [
        { id: 'a', parentId: null, content: 'x', createdAt: 1 },
        { id: 'a', parentId: null, content: 'y', createdAt: 2 },
      ],
      labels: [],
      leafId: null,
      seq: 2,
    };
    expect(() => parseSerialized(dup)).toThrow(InvalidTreeError);
    expect(() => parseSerialized({ ...valid, seq: -1 })).toThrow(InvalidTreeError);
  });

  it('rejects labels referencing unknown nodes', () => {
    expect(() =>
      parseSerialized({
        ...valid,
        labels: [{ nodeId: 'ghost', label: 'x', createdAt: 1 }],
      }),
    ).toThrow(InvalidTreeError);
  });
});

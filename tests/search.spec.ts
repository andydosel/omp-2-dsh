import { describe, expect, it } from 'vitest';
import {
  isSubsequence,
  matchQuery,
  tokenize,
  TreeEngine,
} from '../src/index.js';

describe('fuzzy matching primitives', () => {
  it('isSubsequence matches in-order characters skipping gaps', () => {
    expect(isSubsequence('abc', 'aXbYc')).toBe(true);
    expect(isSubsequence('abc', 'a1b2c3')).toBe(true);
    expect(isSubsequence('v2', 'version 2')).toBe(true);
  });

  it('isSubsequence rejects wrong order and missing chars', () => {
    expect(isSubsequence('abc', 'acb')).toBe(false);
    expect(isSubsequence('abc', 'ab')).toBe(false);
    expect(isSubsequence('xyz', 'aXbYc')).toBe(false);
  });

  it('isSubsequence is case-insensitive by default, case-sensitive on demand', () => {
    expect(isSubsequence('abc', 'ABC')).toBe(true);
    expect(isSubsequence('abc', 'ABC', true)).toBe(false);
    expect(isSubsequence('ABC', 'abc', true)).toBe(false);
    expect(isSubsequence('Bc', 'aBc', true)).toBe(true);
  });

  it('isSubsequence: empty token always matches', () => {
    expect(isSubsequence('', 'anything')).toBe(true);
  });

  it('tokenize splits on whitespace and drops empties', () => {
    expect(tokenize('  ab   cd ')).toEqual(['ab', 'cd']);
    expect(tokenize('   ')).toEqual([]);
  });

  it('matchQuery requires ALL tokens (AND) case-insensitively', () => {
    expect(matchQuery('ab cd', 'aXb cD')).toBe(true);
    expect(matchQuery('ab cd', 'aXb only')).toBe(false);
    expect(matchQuery('AB cd', 'ab cd')).toBe(true);
    expect(matchQuery('ab cd', 'ab cd', { caseSensitive: true })).toBe(true);
    expect(matchQuery('AB cd', 'ab cd', { caseSensitive: true })).toBe(false);
    expect(matchQuery('', 'anything')).toBe(true);
  });
});

describe('TreeEngine.search', () => {
  /** a: content + meta; b: fuzzy demo; c: label demo; d: nothing interesting. */
  async function makeTree(): Promise<TreeEngine> {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'review version one', meta: { tokens: 120 } });
    await tree.append({ id: 'b', content: 'a1b2c3', meta: { tokens: 777 } });
    await tree.append({ id: 'c', content: 'final summary', meta: { tokens: 77 } });
    await tree.setLabel('c', 'approved');
    await tree.append({ id: 'd', content: 'wip', meta: { tokens: 50 } });
    return tree;
  }

  it('matches exact and fuzzy subsequences over content', async () => {
    const tree = await makeTree();
    expect((await tree.search('a1b2c3')).map((n) => n.id)).toEqual(['b']);
    // 'abc' is a subsequence of 'a1b2c3' but not a substring.
    expect((await tree.search('abc')).map((n) => n.id)).toEqual(['b']);
  });

  it('is case-insensitive by default and respects caseSensitive option', async () => {
    const tree = await makeTree();
    expect((await tree.search('ABC')).map((n) => n.id)).toEqual(['b']);
    expect(await tree.search('ABC', { caseSensitive: true })).toEqual([]);
    expect((await tree.search('final', { caseSensitive: true })).map((n) => n.id)).toEqual(['c']);
  });

  it('ANDs all query tokens', async () => {
    const tree = await makeTree();
    expect((await tree.search('version one')).map((n) => n.id)).toEqual(['a']);
    // 'abc' matches b, 'final' matches c — no single node has both.
    expect(await tree.search('abc final')).toEqual([]);
    expect((await tree.search('review summary')).map((n) => n.id)).toEqual([]);
  });

  it('searches labels and meta by default', async () => {
    const tree = await makeTree();
    expect((await tree.search('approved')).map((n) => n.id)).toEqual(['c']);
    expect((await tree.search('120')).map((n) => n.id)).toEqual(['a']);
  });

  it('honors a custom searchableText accessor', async () => {
    const tree = new TreeEngine({ searchableText: (node) => String(node.content) });
    await tree.append({ id: 'a', content: 'alpha', meta: { tokens: 120 } });
    await tree.append({ id: 'b', content: 'beta' });
    // meta no longer searched
    expect(await tree.search('120')).toEqual([]);
    // content-only fuzzy match
    expect((await tree.search('alp')).map((n) => n.id)).toEqual(['a']);
  });

  it('honors the label context in searchableText', async () => {
    const tree = new TreeEngine({
      searchableText: (node, { label }) => `${String(node.content)} ${label ?? ''}`,
    });
    await tree.append({ id: 'a', content: 'alpha' });
    await tree.append({ id: 'b', content: 'alpha' });
    await tree.setLabel('b', 'approved');
    expect((await tree.search('approved')).map((n) => n.id)).toEqual(['b']);
  });

  it('respects limit and returns results in append order', async () => {
    const tree = new TreeEngine();
    await tree.append({ id: 'a', content: 'alpha one' });
    await tree.append({ id: 'b', content: 'gamma' });
    await tree.append({ id: 'c', content: 'alpha two' });
    expect((await tree.search('alpha')).map((n) => n.id)).toEqual(['a', 'c']);
    expect((await tree.search('alpha', { limit: 1 })).map((n) => n.id)).toEqual(['a']);
    expect(await tree.search('zzz')).toEqual([]);
    expect(await tree.search('   ')).toEqual([]);
  });
});

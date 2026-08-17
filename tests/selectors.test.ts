import { describe, expect, it } from 'vitest'
import { parseSelectors, mergeRanges } from '../src/read/selectors.ts'

describe('parseSelectors', () => {
  it('returns plain for a bare path', () => {
    expect(parseSelectors('src/main.ts')).toEqual({ base: 'src/main.ts', selector: { kind: 'plain' } })
  })

  it('parses :raw as a whole-file raw read', () => {
    expect(parseSelectors('foo.txt:raw')).toEqual({ base: 'foo.txt', selector: { kind: 'raw' } })
  })

  it('parses :N as a single-line range', () => {
    expect(parseSelectors('foo.txt:42')).toEqual({ base: 'foo.txt', selector: { kind: 'range', start: 42, end: 42 } })
  })

  it('parses :A-B as a range', () => {
    expect(parseSelectors('foo.txt:10-20')).toEqual({ base: 'foo.txt', selector: { kind: 'range', start: 10, end: 20 } })
  })

  it('parses :A+C as C lines from A', () => {
    expect(parseSelectors('foo.txt:40+15')).toEqual({ base: 'foo.txt', selector: { kind: 'range', start: 40, end: 54 } })
  })

  it('parses comma-separated multi-ranges', () => {
    expect(parseSelectors('foo.txt:1-3,5-7')).toEqual({
      base: 'foo.txt',
      selector: { kind: 'ranges', ranges: [{ start: 1, end: 3 }, { start: 5, end: 7 }] },
    })
  })

  it('parses :range:raw and :N:raw', () => {
    expect(parseSelectors('foo.txt:10-20:raw')).toEqual({
      base: 'foo.txt',
      selector: { kind: 'range', start: 10, end: 20, raw: true },
    })
    expect(parseSelectors('foo.txt:7:raw')).toEqual({
      base: 'foo.txt',
      selector: { kind: 'range', start: 7, end: 7, raw: true },
    })
  })

  it('parses multi-range :raw', () => {
    expect(parseSelectors('foo.txt:1-3,5-7:raw').selector).toEqual({
      kind: 'ranges',
      ranges: [{ start: 1, end: 3 }, { start: 5, end: 7 }],
      raw: true,
    })
  })

  it('throws on :0', () => {
    expect(() => parseSelectors('foo.txt:0')).toThrow(/line numbers are 1-based/)
  })

  it('throws on inverted ranges', () => {
    expect(() => parseSelectors('foo.txt:20-10')).toThrow(/start must not exceed end/)
    expect(() => parseSelectors('foo.txt:0-5')).toThrow(/1-based/)
  })

  it('throws on :N+0', () => {
    expect(() => parseSelectors('foo.txt:5+0')).toThrow(/1-based/)
  })

  it('falls through unknown tails to the path (archive/sqlite selectors)', () => {
    expect(parseSelectors('archive.zip:src/main.ts')).toEqual({ base: 'archive.zip:src/main.ts', selector: { kind: 'plain' } })
    // :table tails parse as plain; a trailing :N key WOULD parse as a line
    // selector, but the SQLite branch runs before file selectors ever see it.
    expect(parseSelectors('data.db:users')).toEqual({ base: 'data.db:users', selector: { kind: 'plain' } })
    expect(parseSelectors('data.db:users?limit=5')).toEqual({ base: 'data.db:users?limit=5', selector: { kind: 'plain' } })
    expect(parseSelectors('data.db:users:42')).toEqual({ base: 'data.db:users', selector: { kind: 'range', start: 42, end: 42 } })
  })

  it('keeps a Windows drive-letter path intact', () => {
    expect(parseSelectors('C:\\repo\\src\\main.ts:10-20')).toEqual({
      base: 'C:\\repo\\src\\main.ts',
      selector: { kind: 'range', start: 10, end: 20 },
    })
    expect(parseSelectors('C:\\repo\\data.db:users')).toEqual({ base: 'C:\\repo\\data.db:users', selector: { kind: 'plain' } })
  })

  it('keeps a colon in the middle of a filename when the tail is not a selector', () => {
    expect(parseSelectors('notes:2024-08.md')).toEqual({ base: 'notes:2024-08.md', selector: { kind: 'plain' } })
  })

  it('returns plain for a colon-less raw-only path edge (":raw" alone)', () => {
    // ":raw" strips to an empty base → falls through to the whole string.
    expect(parseSelectors(':raw')).toEqual({ base: ':raw', selector: { kind: 'plain' } })
  })
})

describe('mergeRanges', () => {
  it('merges overlapping and adjacent ranges', () => {
    expect(mergeRanges([{ start: 5, end: 10 }, { start: 1, end: 3 }, { start: 3, end: 4 }, { start: 20, end: 25 }]))
      .toEqual([{ start: 1, end: 10 }, { start: 20, end: 25 }])
  })

  it('keeps an empty list empty', () => {
    expect(mergeRanges([])).toEqual([])
  })
})

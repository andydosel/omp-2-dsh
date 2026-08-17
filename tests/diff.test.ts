import { describe, expect, it } from 'vitest'
import { computeHunkDiffs, diffsFromMeta } from '../src/diff.ts'

describe('computeHunkDiffs', () => {
  it('returns empty for identical texts', () => {
    expect(computeHunkDiffs('a.txt', 'same\ncontent', 'same\ncontent')).toEqual([])
  })

  it('produces one hunk with 3 context lines each side', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7'].join('\n')
    const after = ['1', '2', '3', 'X', '5', '6', '7'].join('\n')
    const diffs = computeHunkDiffs('a.txt', before, after)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.path).toBe('a.txt')
    // 3 context lines before and after the change, clamped at file bounds.
    expect(diffs[0]!.oldText).toBe('1\n2\n3\n4\n5\n6\n7')
    expect(diffs[0]!.newText).toBe('1\n2\n3\nX\n5\n6\n7')
  })

  it('uses oldText null for pure insertions with no prior context', () => {
    const diffs = computeHunkDiffs('a.txt', '', 'x\ny')
    expect(diffs[0]!.oldText).toBeNull()
    expect(diffs[0]!.newText).toBe('x\ny')
  })

  it('splits far-apart changes into separate hunks', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n')
    const after = before.replace('l3', 'L3').replace('l15', 'L15')
    const diffs = computeHunkDiffs('a.txt', before, after)
    expect(diffs.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps adjacent changes in one hunk', () => {
    const diffs = computeHunkDiffs('a.txt', 'a\nb\nc\nd\ne', 'a\nX\nY\nd\ne')
    expect(diffs).toHaveLength(1)
  })

  it('degrades to a whole-text diff above the LCS cap', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')
    const after = `${before}\nappended`
    const diffs = computeHunkDiffs('a.txt', before, after)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.oldText).not.toBeNull()
  })
})

describe('diffsFromMeta', () => {
  it('narrows valid metadata and rejects malformed data', () => {
    expect(diffsFromMeta({ diffs: [{ path: 'a', oldText: 'x', newText: 'y' }] }))
      .toEqual([{ path: 'a', oldText: 'x', newText: 'y' }])
    expect(diffsFromMeta({ diffs: [] })).toBeUndefined()
    expect(diffsFromMeta(null)).toBeUndefined()
    expect(diffsFromMeta({ diffs: [{ path: 1, oldText: 'x', newText: 'y' }] })).toBeUndefined()
    expect(diffsFromMeta({ nope: true })).toBeUndefined()
  })
})

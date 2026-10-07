import { describe, expect, it } from 'vitest'
import {
  countSeverities,
  estimateTokens,
  findingKey,
  mergeFindings,
  parseReviewerReport,
  partitionFindings,
  renderFinding,
  tally,
  type Finding,
  type RawFinding,
} from '../src/findings.ts'

/** One parsed finding for the union helpers. */
function p0(summary: string): RawFinding {
  return { severity: 'P0', summary }
}

describe('reviewer report parsing', () => {
  it('parses a fenced JSON report and normalizes severities', () => {
    const reply = 'Here is my review:\n```json\n{"findings":[{"severity":"p0","summary":"  the lock leaks  ","evidence":"a.ts:3"},{"severity":"P2","summary":"naming"}]}\n```\nDone.'
    expect(parseReviewerReport(reply)).toEqual([
      { severity: 'P0', summary: 'the lock leaks', evidence: 'a.ts:3' },
      { severity: 'P2', summary: 'naming' },
    ])
  })

  it('accepts a bare report object and a bare findings array, including an empty one', () => {
    expect(parseReviewerReport('{"findings":[]}')).toEqual([])
    expect(parseReviewerReport('[{"severity":"P1","summary":"slow query"}]')).toEqual([
      { severity: 'P1', summary: 'slow query' },
    ])
    expect(parseReviewerReport('Nothing to report.\n{"findings": []}')).toEqual([])
  })

  it('fails closed on any malformed entry instead of dropping it', () => {
    expect(parseReviewerReport('{"findings":[{"severity":"P0"}]}')).toBeUndefined()
    expect(parseReviewerReport('{"findings":[{"severity":"P9","summary":"x"}]}')).toBeUndefined()
    expect(parseReviewerReport('{"findings":[{"severity":"P0","summary":"ok"}, 7]}')).toBeUndefined()
    expect(parseReviewerReport('{"findings":[{"severity":"P0","summary":"   "}]}')).toBeUndefined()
  })

  it('returns undefined when there is no usable report at all', () => {
    expect(parseReviewerReport('I reviewed it and it looks fine.')).toBeUndefined()
    expect(parseReviewerReport('{"findings": "not-an-array"}')).toBeUndefined()
    expect(parseReviewerReport('{oops')).toBeUndefined()
    expect(parseReviewerReport(`{"findings":[{"severity":"P0","summary":"${'x'.repeat(200_001)}"}]}`)).toBeUndefined()
  })

  it('bounds an over-long summary instead of rejecting the report', () => {
    const parsed = parseReviewerReport(`{"findings":[{"severity":"P1","summary":"${'y'.repeat(5000)}"}]}`)
    expect(parsed?.[0]?.summary.length).toBe(2000)
  })
})

describe('finding union arithmetic', () => {
  it('deduplicates by normalized severity + summary and keeps the first round as provenance', () => {
    const round1 = mergeFindings([], [p0('Lock Leaks   memory'), { severity: 'P1', summary: 'slow' }], 1)
    expect(round1).toHaveLength(2)
    const round2 = mergeFindings(round1, [p0('lock leaks memory'), { severity: 'P2', summary: 'naming' }], 2)
    expect(round2).toHaveLength(3)
    expect(round2.map(finding => finding.sourceRound)).toEqual([1, 1, 2])
    expect(findingKey(p0('  A  b '))).toBe(findingKey({ severity: 'P0', summary: 'a B' }))
  })

  it('partitions the union by key and counts severities', () => {
    const union: Finding[] = [
      { severity: 'P0', summary: 'one', sourceRound: 1 },
      { severity: 'P1', summary: 'two', sourceRound: 1 },
      { severity: 'P1', summary: 'three', sourceRound: 2 },
    ]
    const { removed, kept } = partitionFindings(union, new Set([findingKey({ severity: 'P1', summary: 'two' })]))
    expect(removed.map(finding => finding.summary)).toEqual(['two'])
    expect(kept.map(finding => finding.summary)).toEqual(['one', 'three'])
    expect(countSeverities(union)).toEqual({ P0: 1, P1: 2, P2: 0, P3: 0 })
  })

  it('counts a clean verdict only from a round that actually reported without failures', () => {
    const clean = tally([{ severity: 'P2', summary: 'nit', sourceRound: 1 }], 1, 3, 0)
    expect(clean).toMatchObject({ rounds: 1, reviewers: 3, failures: 0, zeroP0: true })
    // No reviewer ever reported: not clean, however empty the union is.
    expect(tally([], 0, 0, 0).zeroP0).toBe(false)
    // A crashed reviewer must never read as "no P0".
    expect(tally([], 1, 2, 1).zeroP0).toBe(false)
    // One accepted P0 blocks the verdict.
    expect(tally([{ severity: 'P0', summary: 'bad', sourceRound: 1 }], 1, 3, 0).zeroP0).toBe(false)
  })

  it('estimates effort at four characters per token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('renders a finding with and without round provenance', () => {
    expect(renderFinding({ severity: 'P0', summary: 'leak', sourceRound: 2 })).toBe('P0 (round 2): leak')
    expect(renderFinding({ severity: 'P1', summary: 'slow' })).toBe('P1: slow')
  })
})

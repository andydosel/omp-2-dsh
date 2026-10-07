import { describe, expect, it } from 'vitest'
import { renderCompletionReport, renderLoopMethodology, renderReviewerBrief, renderReviewerRole } from '../src/briefs.ts'

describe('reviewer prompts', () => {
  it('states the read-only role and the exact JSON answer contract', () => {
    const role = renderReviewerRole()
    expect(role).toMatch(/one-shot independent reviewer/)
    expect(role).toMatch(/READ-ONLY/)
    expect(role).toMatch(/\{"findings":\[\{"severity":"P0\|P1\|P2\|P3"/)
    expect(role).toMatch(/P0 — the objective is not met/)
  })

  it('hands one reviewer only the plan, the code references, and the focus', () => {
    const brief = renderReviewerBrief({ round: 2, index: 1, total: 3, plan: '  rewrite the parser  ', files: ['src/a.ts'] })
    expect(brief).toMatch(/<review_task round="2" reviewer="1 of 3">/)
    expect(brief).toMatch(/rewrite the parser/)
    expect(brief).toMatch(/- src\/a\.ts/)
    expect(brief).not.toMatch(/Focus:/)
    expect(renderReviewerBrief({ round: 1, index: 2, total: 2, plan: 'p', files: [], focus: 'the lock' })).toMatch(/Focus: the lock/)
  })
})

describe('review-work methodology', () => {
  it('carries the fixed procedure, both exits, and the count rule', () => {
    const prompt = renderLoopMethodology({
      objective: 'harden the parser',
      plan: 'split the lexer',
      files: ['src/parser.ts'],
      reviewersPerRound: 3,
      maxGoalRounds: 12,
      zeroP0Approach: 'count',
    })
    expect(prompt).toMatch(/Objective: harden the parser/)
    expect(prompt).toMatch(/split the lexer/)
    expect(prompt).toMatch(/- src\/parser\.ts/)
    expect(prompt).toMatch(/3 fresh reviewers/)
    expect(prompt).toMatch(/EXIT A/)
    expect(prompt).toMatch(/EXIT B/)
    expect(prompt).toMatch(/review_finish\(\)/)
    expect(prompt).toMatch(/review_complete\(\)/)
    expect(prompt).toMatch(/review_block\(\{code, message\}\)/)
    expect(prompt).toMatch(/review_resume\(\)/)
    expect(prompt).toMatch(/already created it/)
    expect(prompt).toMatch(/count \(a numeric count of the accepted union, not a feeling\)/)
    expect(prompt).toMatch(/round cap is 12/)
  })
})

describe('completion report', () => {
  it('summarizes the rounds, the counts, and where the transcript lives', () => {
    const report = renderCompletionReport({
      objective: 'harden the parser',
      rounds: 4,
      reviewers: 12,
      failures: 0,
      counts: { P0: 0, P1: 1, P2: 2, P3: 0 },
      filtered: 1,
      summary: 'shipped the lexer split',
      carrierId: 'carrier-1',
    })
    expect(report).toMatch(/review loop complete/)
    expect(report).toMatch(/Rounds: 4 · reviewers: 12 \(failures 0\) · accepted findings: P0=0 P1=1 P2=2 P3=0 · filtered as false positive: 1/)
    expect(report).toMatch(/Outcome: shipped the lexer split/)
    expect(report).toMatch(/agent:\/\/carrier-1/)
  })
})

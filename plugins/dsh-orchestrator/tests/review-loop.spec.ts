import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { ReviewLoop } from '../src/loop.ts'
import { renderFinding, type RawFinding } from '../src/findings.ts'
import { makeAgent, makeHarness, type FakeAgent, type Harness } from './harness.ts'

/** One raw finding for a scripted reviewer report. */
function finding(severity: 'P0' | 'P1' | 'P2' | 'P3', summary: string): RawFinding {
  return { severity, summary }
}

/** Start a loop in the harness and return the carrier + signal. */
async function startLoop(harness: Harness): Promise<{ lead: FakeAgent; carrier: FakeAgent; signal: AbortSignal }> {
  const lead = harness.addAgent(makeAgent('lead'))
  const carrier = harness.addAgent(makeAgent('carrier-1', lead))
  await harness.runtime.startLoop(lead, { objective: 'harden the parser', files: ['src/parser.ts'] }, new AbortController().signal)
  return { lead, carrier, signal: new AbortController().signal }
}

describe('loop start', () => {
  it('spawns the review-work subagent, creates the goal on ITS session, and never on the lead', async () => {
    const harness = makeHarness({ reviewersPerRound: 3, maxGoalRounds: 12 })
    const { lead, carrier } = await startLoop(harness)
    expect(harness.starts).toHaveLength(1)
    expect(harness.starts[0]).toMatchObject({ provider: 'spawn', parentId: 'lead' })
    expect(harness.starts[0]!.label).toMatch(/^review loop: harden the parser/)
    expect(harness.starts[0]!.prompt).toMatch(/review_round/)
    // The carrier is a worker, but its envelope must still carry the loop's
    // OWN controls — otherwise a restricted carrier cannot run a round or exit.
    expect(carrier.restricts[0]).toEqual(expect.arrayContaining([
      'read', 'write', 'edit', 'subtask_parallel',
      'review_round', 'review_filter', 'review_finish', 'review_complete', 'review_block', 'review_resume',
    ]))
    expect(harness.goals.calls).toEqual([
      { op: 'create', agentId: 'carrier-1', detail: { objective: 'harden the parser', maxGoalRounds: 12 } },
    ])
    expect(harness.runtime.status().loops).toEqual([expect.objectContaining({
      loopId: 'loop-carrier-1',
      carrierId: 'carrier-1',
      leadId: 'lead',
      status: 'reviewing',
      round: 0,
      P0: 0,
      zeroP0: false,
    })])
    // The lead carries no goal of its own.
    expect(harness.goals.views.has(lead.id)).toBe(false)
  })

  it('refuses an empty objective and does not spawn anything', async () => {
    const harness = makeHarness()
    const lead = harness.addAgent(makeAgent('lead'))
    await expect(harness.runtime.startLoop(lead, { objective: '   ' }, new AbortController().signal))
      .rejects.toThrow(/non-empty objective/)
    expect(harness.starts).toHaveLength(0)
  })

  it('parks the carrier when the goal could not be created', async () => {
    const harness = makeHarness()
    const lead = harness.addAgent(makeAgent('lead'))
    harness.addAgent(makeAgent('carrier-1', lead))
    harness.goals.failNext = new Error('goal store offline')
    await expect(harness.runtime.startLoop(lead, { objective: 'x' }, new AbortController().signal))
      .rejects.toThrow(/could not create the review goal/)
    expect(harness.runtime.loopCount).toBe(0)
  })
})

describe('review rounds', () => {
  it('dispatches the configured reviewer count and unions the reports across rounds', async () => {
    const harness = makeHarness({ reviewersPerRound: 2 })
    const { carrier, signal } = await startLoop(harness)
    harness.dispatcher.queueFindings([finding('P0', 'the lock leaks'), finding('P1', 'slow query')])
    harness.dispatcher.queueFindings([finding('P1', 'SLOW   query'), finding('P2', 'naming')])
    const first = await harness.runtime.round(carrier, { plan: 'split the lexer' }, signal)
    expect(first.record).toMatchObject({ round: 1, dispatched: 2, completed: 2, failures: 0, raised: 3, zeroP0: false })
    expect(first.record.counts).toEqual({ P0: 1, P1: 1, P2: 1, P3: 0 })
    expect(harness.dispatcher.requests.map(request => request.role)).toEqual(['reviewer', 'reviewer'])
    expect(harness.dispatcher.requests[0]!.brief).toMatch(/round="1" reviewer="1 of 2"/)
    expect(harness.dispatcher.requests[0]!.brief).toMatch(/split the lexer/)

    // A clean round does not erase the cumulative union.
    harness.dispatcher.queueFindings([])
    harness.dispatcher.queueFindings([])
    const second = await harness.runtime.round(carrier, { plan: 'split the lexer, v2' }, signal)
    expect(second.record).toMatchObject({ round: 2, raised: 0, zeroP0: false })
    expect(second.loop.findings).toHaveLength(3)
    expect(renderFinding(second.loop.findings[0]!)).toBe('P0 (round 1): the lock leaks')
  })

  it('clamps the per-round reviewer count to the deployment bound and refuses junk', async () => {
    const harness = makeHarness({ reviewersPerRound: 2 })
    const { carrier, signal } = await startLoop(harness)
    for (let index = 0; index < 4; index += 1) harness.dispatcher.queueFindings([])
    const result = await harness.runtime.round(carrier, { plan: 'p', reviewers: 9 }, signal)
    expect(result.record.dispatched).toBe(2)
    const smaller = await harness.runtime.round(carrier, { plan: 'p', reviewers: 1 }, signal)
    expect(smaller.record.dispatched).toBe(1)
    await expect(harness.runtime.round(carrier, { plan: 'p', reviewers: 0 }, signal)).rejects.toThrow(/positive whole number/)
    await expect(harness.runtime.round(carrier, { plan: '   ' }, signal)).rejects.toThrow(/plan text/)
  })

  it('takes --workers from the ORIGINATING session, never from the carrier', async () => {
    const harness = makeHarness({ reviewersPerRound: 3 })
    const { carrier, signal } = await startLoop(harness)
    let flagged = 5
    const seen: string[] = []
    harness.ctx.provide('reviewGate', {
      stateOf: (session: { id: string }) => {
        seen.push(String(session.id))
        // The carrier's own gate says 0: only the lead's flag may count.
        return { reviewers: String(session.id) === 'lead' ? flagged : 0 }
      },
    } as never)
    for (let index = 0; index < 8; index += 1) harness.dispatcher.queueFindings([])
    // The human's flag wins over the deployment default...
    expect((await harness.runtime.round(carrier, { plan: 'p' }, signal)).record.dispatched).toBe(5)
    expect(seen).toContain('lead')
    expect(seen).not.toContain('carrier-1')
    // ...but a model-requested count stays bounded by the deployment default.
    expect((await harness.runtime.round(carrier, { plan: 'p', reviewers: 9 }, signal)).record.dispatched).toBe(3)
    // A gate with no explicit flag (0) falls back to the default.
    flagged = 0
    expect((await harness.runtime.round(carrier, { plan: 'p' }, signal)).record.dispatched).toBe(3)
  })

  it('keeps the round uncertified when a reviewer fails, and recovers on a rerun', async () => {
    const harness = makeHarness({ reviewersPerRound: 2 })
    const { carrier, signal } = await startLoop(harness)
    harness.dispatcher.script.push({ status: 'completed', findings: [] }, { status: 'timeout', error: 'budget expired' })
    const broken = await harness.runtime.round(carrier, { plan: 'p' }, signal)
    expect(broken.record).toMatchObject({ completed: 1, failures: 1, zeroP0: false })
    expect(() => harness.runtime.finish(carrier)).toThrow(/1 reviewer\(s\) failed/)
    harness.dispatcher.queueFindings([])
    harness.dispatcher.queueFindings([])
    const recovered = await harness.runtime.round(carrier, { plan: 'p' }, signal)
    // This round was clean, but the loop's cumulative tally still carries the
    // earlier failed reviewer: the round's verdict stays false.
    expect(recovered.record).toMatchObject({ completed: 2, failures: 0, zeroP0: false })
    expect(recovered.loop.tally).toMatchObject({ rounds: 2, reviewers: 3, failures: 1 })
    expect(() => harness.runtime.finish(carrier)).toThrow(/failed, timed out/)
  })
})

describe('the zero-P0 exit', () => {
  it('refuses the completion gate while a P0 stands, then completes and reports', async () => {
    const harness = makeHarness({ reviewersPerRound: 1 })
    const { carrier, signal } = await startLoop(harness)
    harness.dispatcher.queueFindings([finding('P0', 'the lock leaks'), finding('P2', 'naming')])
    await harness.runtime.round(carrier, { plan: 'p' }, signal)

    expect(() => harness.runtime.finish(carrier)).toThrow(/1 P0 finding\(s\) remain — the lock leaks/)
    await expect(harness.runtime.complete(carrier)).rejects.toThrow(/close the review phase with review_finish/)
    expect(harness.sent).toHaveLength(0)

    const filtered = harness.runtime.filter(carrier, [{ severity: 'P0', summary: 'the lock leaks', reason: 'resolved' }])
    expect(filtered.removed).toEqual([expect.objectContaining({ severity: 'P0', summary: 'the lock leaks', reason: 'resolved' })])
    expect(filtered.loop.tally.counts.P0).toBe(0)
    expect(filtered.loop.filtered).toHaveLength(1)

    const finished = harness.runtime.finish(carrier)
    expect(finished.loop.status).toBe('cleared')
    expect(finished.verdict).toMatchObject({ rounds: 1, reviewers: 1, failures: 0, zeroP0: true })

    const completed = await harness.runtime.complete(carrier, 'split the lexer and shipped it')
    expect(completed.goal).toEqual({ id: 'goal-carrier-1', phase: 'complete' })
    expect(completed.loop.status).toBe('complete')
    expect(completed.reported).toBe(true)
    expect(harness.goals.ops()).toEqual(['create', 'get', 'complete'])
    expect(harness.sent).toHaveLength(1)
    expect(harness.sent[0]).toMatchObject({ senderId: 'carrier-1', targetId: 'lead' })
    expect(harness.sent[0]!.text).toMatch(/review loop complete/)
    expect(harness.sent[0]!.text).toMatch(/Outcome: split the lexer and shipped it/)
  })

  it('never re-adds a finding its lead removed, so a later round can read clean', async () => {
    const harness = makeHarness({ reviewersPerRound: 1 })
    const { carrier, signal } = await startLoop(harness)
    harness.dispatcher.queueFindings([finding('P0', 'stale claim')])
    await harness.runtime.round(carrier, { plan: 'p' }, signal)
    harness.runtime.filter(carrier, [{ severity: 'P0', summary: 'stale claim' }])
    harness.dispatcher.queueFindings([finding('P0', 'stale claim')])
    const second = await harness.runtime.round(carrier, { plan: 'p2' }, signal)
    expect(second.loop.tally).toMatchObject({ rounds: 2, reviewers: 2, failures: 0, zeroP0: true })
    expect(harness.runtime.finish(carrier).loop.status).toBe('cleared')
  })

  it('lets the delegating lead filter false positives and writes rounds/findings to its board', async () => {
    const harness = makeHarness({ reviewersPerRound: 1 })
    const { lead, carrier, signal } = await startLoop(harness)
    const updates: Array<{ sessionId: string; id: string; patch: Record<string, unknown> }> = []
    harness.ctx.provide('taskBoard', {
      list: () => [{ id: 'task-1', revision: 2, status: 'in_progress' }],
      update: (session: { id: string }, id: string, patch: Record<string, unknown>) => {
        updates.push({ sessionId: String(session.id), id, patch })
        return { id, revision: 3, status: 'in_progress' }
      },
    } as never)

    harness.dispatcher.queueFindings([finding('P0', 'stale claim'), finding('P1', 'slow query')])
    await harness.runtime.round(carrier, { plan: 'p' }, signal)
    expect(updates[0]).toMatchObject({
      sessionId: 'lead',
      id: 'task-1',
      patch: {
        reviewRound: 1,
        findings: [
          { severity: 'P0', summary: 'stale claim', sourceRound: 1 },
          { severity: 'P1', summary: 'slow query', sourceRound: 1 },
        ],
      },
    })

    // The LEAD (not only the carrier) may remove a finding.
    const filtered = harness.runtime.filter(lead, [{ severity: 'P0', summary: 'stale claim' }])
    expect(filtered.removed).toHaveLength(1)
    expect(updates.at(-1)?.patch).toMatchObject({
      findings: [{ severity: 'P1', summary: 'slow query', sourceRound: 1 }],
      filteredFindings: [{ severity: 'P0', summary: 'stale claim', sourceRound: 1 }],
    })
    // An unrelated agent still cannot filter.
    const stranger = harness.addAgent(makeAgent('stranger'))
    expect(() => harness.runtime.filter(stranger, [{ severity: 'P1', summary: 'slow query' }]))
      .toThrow(/not carrying or leading/)
  })

  it('creates the lead\'s task row when the board has none, then accumulates findings across rounds', async () => {
    const harness = makeHarness({ reviewersPerRound: 1 })
    const { lead, carrier, signal } = await startLoop(harness)
    const creates: Array<{ sessionId: string; subject: string; owner?: string }> = []
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    let rows: Array<{ id: string; revision: number; status: string }> = []
    harness.ctx.provide('taskBoard', {
      list: () => rows,
      create: (session: { id: string }, input: { subject: string; owner?: string }) => {
        creates.push({ sessionId: String(session.id), ...input })
        const created = { id: 'task-9', revision: 1, status: 'pending' }
        rows = [created]
        return created
      },
      update: (_session: { id: string }, id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch })
        const current = rows.find(row => row.id === id)!
        const next = { ...current, revision: current.revision + 1, status: (patch.status as string | undefined) ?? current.status }
        rows = [next]
        return next
      },
    } as never)

    harness.dispatcher.queueFindings([finding('P0', 'first')])
    await harness.runtime.round(carrier, { plan: 'p1' }, signal)
    expect(creates).toEqual([{ sessionId: 'lead', subject: 'harden the parser', owner: 'lead' }])
    expect(updates[0]!.patch).toMatchObject({ reviewRound: 1, findings: [{ summary: 'first', sourceRound: 1 }] })

    harness.dispatcher.queueFindings([finding('P1', 'second')])
    await harness.runtime.round(carrier, { plan: 'p2' }, signal)
    // One task row, and the union of both rounds (cross-round accumulation).
    expect(creates).toHaveLength(1)
    expect(updates.at(-1)!.patch).toMatchObject({
      reviewRound: 2,
      findings: [
        { severity: 'P0', summary: 'first', sourceRound: 1 },
        { severity: 'P1', summary: 'second', sourceRound: 2 },
      ],
    })
    expect(lead.id).toBe('lead')
  })

  it('reports an unmatched rejection instead of silently dropping it', async () => {
    const harness = makeHarness({ reviewersPerRound: 1 })
    const { carrier, signal } = await startLoop(harness)
    harness.dispatcher.queueFindings([finding('P1', 'real')])
    await harness.runtime.round(carrier, { plan: 'p' }, signal)
    const result = harness.runtime.filter(carrier, [{ severity: 'P0', summary: 'never reported' }])
    expect(result.removed).toHaveLength(0)
    expect(result.unmatched).toEqual([{ severity: 'P0', summary: 'never reported' }])
    expect(result.loop.tally.counts.P1).toBe(1)
  })

  it('leaves the loop cleared when the goal service rejects the completion', async () => {
    const harness = makeHarness({ reviewersPerRound: 1 })
    const { carrier, signal } = await startLoop(harness)
    harness.dispatcher.queueFindings([])
    await harness.runtime.round(carrier, { plan: 'p' }, signal)
    harness.runtime.finish(carrier)
    harness.goals.failNext = new Error('stale goal revision')
    await expect(harness.runtime.complete(carrier)).rejects.toThrow(/stale goal revision/)
    expect(harness.runtime.status().loops[0]?.status).toBe('cleared')
  })
})

describe('the human-decision exit', () => {
  it('blocks the goal, refuses rounds while waiting, and resumes', async () => {
    const harness = makeHarness({ reviewersPerRound: 1 })
    const { carrier, signal } = await startLoop(harness)
    const blocked = await harness.runtime.block(carrier, { code: 'scope-tradeoff', message: 'drop feature X?' })
    expect(blocked.goal).toEqual({ id: 'goal-carrier-1', phase: 'blocked' })
    expect(blocked.loop.status).toBe('blocked')
    expect(blocked.loop.blockedReason).toEqual({ code: 'scope-tradeoff', message: 'drop feature X?' })
    expect(blocked.reported).toBe(true)
    expect(harness.goals.ops()).toEqual(['create', 'get', 'block'])
    // Exit B relays the decision to the delegating session (the carrier's parent).
    expect(harness.sent.at(-1)).toMatchObject({ senderId: 'carrier-1', targetId: 'lead' })
    expect(harness.sent.at(-1)!.text).toMatch(/drop feature X\?/)
    expect(harness.sent.at(-1)!.text).toMatch(/scope-tradeoff/)

    expect(() => harness.runtime.finish(carrier)).toThrow(/is blocked/)
    await expect(harness.runtime.round(carrier, { plan: 'p' }, signal)).rejects.toThrow(/blocked/)
    await expect(harness.runtime.block(carrier, { code: 'again', message: 'x' })).rejects.toThrow(/already blocked/)

    const resumed = harness.runtime.resume(carrier)
    expect(resumed.goal.phase).toBe('active')
    expect(resumed.loop.status).toBe('reviewing')
    harness.dispatcher.queueFindings([])
    await expect(harness.runtime.round(carrier, { plan: 'p' }, signal)).resolves.toBeDefined()
  })

  it('refuses a resume that was never blocked', async () => {
    const harness = makeHarness()
    const { carrier } = await startLoop(harness)
    expect(() => harness.runtime.resume(carrier)).toThrow(/no blocked decision/)
  })
})

describe('authority', () => {
  it('refuses every loop tool for an agent that carries no loop', async () => {
    const harness = makeHarness()
    const { lead, carrier, signal } = await startLoop(harness)
    const stranger = harness.addAgent(makeAgent('stranger'))
    for (const agent of [lead, stranger]) {
      expect(() => harness.runtime.finish(agent)).toThrow(/not carrying a review loop/)
      await expect(harness.runtime.block(agent, { code: 'x', message: 'y' })).rejects.toThrow(/not carrying a review loop/)
      await expect(harness.runtime.round(agent, { plan: 'p' }, signal)).rejects.toThrow(/not carrying a review loop/)
    }
    // The LEAD may filter (the business filter belongs to the delegating
    // session), but an unrelated agent may not.
    expect(() => harness.runtime.filter(stranger, [finding('P0', 'x')])).toThrow(/not carrying or leading/)
    expect(() => harness.runtime.filter(lead, [finding('P0', 'x')])).not.toThrow()
    // The carrier itself is accepted.
    harness.dispatcher.queueFindings([])
    await expect(harness.runtime.round(carrier, { plan: 'p' }, signal)).resolves.toBeDefined()
  })

  it('refuses a loop whose carrier is no longer live', async () => {
    const harness = makeHarness()
    const { carrier, signal } = await startLoop(harness)
    harness.dispatcher.queueFindings([])
    await harness.runtime.round(carrier, { plan: 'p' }, signal)
    harness.runtime.dispose()
    expect(harness.runtime.loopCount).toBe(0)
  })
})

describe('configuration', () => {
  it('fails loud on an unknown key instead of silently merging it', () => {
    expect(() => resolveConfig({ reviewrTools: ['read'] } as never)).toThrow(/unknown key/)
  })
})

describe('ReviewLoop state machine (pure)', () => {
  const init = { loopId: 'loop-1', carrierId: 'carrier-1' as SessionId, leadId: 'lead' as SessionId, objective: 'o', goalId: 'g1' }

  it('reopens the review phase when a later round runs after a clearance', () => {
    const loop = new ReviewLoop(init)
    loop.recordRound({ round: 1, dispatched: 1, outcomes: [{ status: 'completed', findings: [] }] })
    expect(loop.clear().zeroP0).toBe(true)
    expect(loop.currentStatus).toBe('cleared')
    loop.recordRound({ round: 2, dispatched: 1, outcomes: [{ status: 'completed', findings: [finding('P1', 'new')] }] })
    expect(loop.currentStatus).toBe('reviewing')
    expect(() => loop.assertCompletable()).toThrow(/close the review phase/)
  })

  it('tags each accepted finding with the round that first raised it', () => {
    const loop = new ReviewLoop(init)
    loop.recordRound({ round: 1, dispatched: 1, outcomes: [{ status: 'completed', findings: [finding('P1', 'a')] }] })
    loop.recordRound({ round: 2, dispatched: 1, outcomes: [{ status: 'completed', findings: [finding('P1', 'a'), finding('P2', 'b')] }] })
    expect(loop.snapshot().findings.map(item => item.sourceRound)).toEqual([1, 2])
    expect(loop.snapshot().rounds.map(record => record.raised)).toEqual([1, 1])
  })

  it('counts a completed-but-unparseable reviewer as a failure, never as a clean round', () => {
    const loop = new ReviewLoop(init)
    const record = loop.recordRound({
      round: 1,
      dispatched: 2,
      outcomes: [{ status: 'completed', findings: [] }, { status: 'completed' }],
    })
    expect(record).toMatchObject({ completed: 1, failures: 1, zeroP0: false })
  })
})

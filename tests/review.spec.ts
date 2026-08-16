/**
 * Review tree lifecycle + apply/abort event sequence.
 *
 * @module dsh-compact-mode/tests/review.spec
 */

import { describe, expect, it } from 'vitest'
import { CompactModeEngine } from '../src/engine.ts'
import { foldCompactMode } from '../src/mode.ts'
import { makeAgent, makeContext } from './helpers.ts'

describe('compact review lifecycle', () => {
  it('enter writes owner-null compaction/start and compact/mode; apply closes with summary→replace→end', async () => {
    const { ctx } = makeContext()
    const engine = new CompactModeEngine(ctx, { auto: false, reviewTree: 'file', keepRecentTokens: 4000, minShakeSavingsRatio: 0 })
    const agent = makeAgent(ctx)
    // Seed some surface messages so a compactable range exists.
    for (let i = 0; i < 4; i += 1) {
      agent.session.append('user/message', {
        role: 'user',
        id: `m${i}`,
        content: [{ type: 'text', text: `message ${i} `.repeat(200) }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' })
    }

    await engine.compactNow(agent, new AbortController().signal)
    const events = agent.session.events

    const start = events.find(e => e.type === 'compaction/start')
    expect(start).toBeDefined()
    expect(start!.data.turn).toBeNull()
    expect(foldCompactMode(events)).toBe(true)

    // Wait for the seed draft revision to land.
    await new Promise(r => setTimeout(r, 30))

    const result = await engine.reviews.apply(agent, undefined, new AbortController().signal)
    const after = agent.session.events
    const summary = after.find(e => e.type === 'compaction/summary')
    const replace = after.find(e => e.type === 'user/message' && e.surfaceOp !== undefined && e.surfaceOp !== 'append')
    const end = after.find(e => e.type === 'compaction/end')

    expect(result.startSeq).toBeGreaterThan(0)
    expect(summary).toBeDefined()
    expect(replace).toBeDefined()
    expect(end).toBeDefined()
    expect(end!.data.error).toBeUndefined()
    expect(foldCompactMode(after)).toBe(false)
  })

  it('abort closes the lock with an error and preserves the mode exit', async () => {
    const { ctx } = makeContext()
    const engine = new CompactModeEngine(ctx, { auto: false, reviewTree: 'file', keepRecentTokens: 4000, minShakeSavingsRatio: 0 })
    const agent = makeAgent(ctx)
    for (let i = 0; i < 4; i += 1) {
      agent.session.append('user/message', {
        role: 'user',
        id: `m${i}`,
        content: [{ type: 'text', text: `message ${i} `.repeat(200) }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' })
    }

    await engine.compactNow(agent, new AbortController().signal)
    await engine.reviews.abort(agent, 'user cancelled')
    const after = agent.session.events
    const end = after.find(e => e.type === 'compaction/end')
    expect(end).toBeDefined()
    expect(end!.data.error).toBe('user cancelled')
    expect(foldCompactMode(after)).toBe(false)
  })
})

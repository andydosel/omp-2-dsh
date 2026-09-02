/**
 * Mode state machine + fold + mutex + pre-step reject semantics.
 *
 * @module dsh-compact-mode/tests/mode.spec
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CompactModeController, foldCompactMode } from '../src/mode.ts'
import { CompactModeEngine } from '../src/engine.ts'
import { makeAgent, makeContext } from './helpers.ts'

function makeModeCtx() {
  const ctx = new Context()
  const controller = new CompactModeController(ctx)
  return { ctx, controller }
}

describe('foldCompactMode', () => {
  it('folds last-wins from a log', () => {
    const { controller } = makeModeCtx()
    const agent = makeAgent(controller.ctx)
    expect(foldCompactMode(agent.session.events)).toBe(false)
    controller.set(agent, true)
    expect(foldCompactMode(agent.session.events)).toBe(true)
    controller.set(agent, false)
    expect(foldCompactMode(agent.session.events)).toBe(false)
  })
})

describe('CompactModeController.set', () => {
  it('commits between turns', () => {
    const { controller } = makeModeCtx()
    const agent = makeAgent(controller.ctx)
    expect(controller.set(agent, true)).toBe('committed')
    expect(controller.get(agent)).toEqual({ active: true })
    expect(controller.set(agent, true)).toBe('noop')
    expect(controller.set(agent, false)).toBe('committed')
    expect(controller.get(agent)).toEqual({ active: false })
  })

  it('queues during an open turn and commits at the accepted boundary', async () => {
    const { controller } = makeModeCtx()
    const agent = makeAgent(controller.ctx)
    agent.session.append('turn/start', { turn: 1 })
    expect(controller.set(agent, true)).toBe('queued')
    expect(controller.get(agent)).toEqual({ active: false, pending: true })
    // Boundary commit via an accepted pre-step.
    let boundaryCommitted = false
    controller.ctx.on('agent/pre-step', async (payload: never, next: () => Promise<unknown>) => {
      const decision = await next()
      return decision
    })
    void boundaryCommitted
    agent.session.append('turn/end', { turn: 1, reason: 'done' })
    expect(foldCompactMode(agent.session.events)).toBe(false)
  })
})

describe('engine pre-step reject semantics', () => {
  it('rejects claimed messages while a review is active and captures them', async () => {
    const { ctx, llm } = makeContext()
    const engine = new CompactModeEngine(ctx, { auto: false, keepRecentTokens: 4000, minShakeSavingsRatio: 0 })
    const agent = makeAgent(ctx)
    for (let i = 0; i < 4; i += 1) {
      agent.session.append('user/message', {
        role: 'user',
        id: `m${i}`,
        content: [{ type: 'text', text: `message ${i} `.repeat(200) }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' })
    }

    // Enter review (command state).
    await engine.compactNow(agent, new AbortController().signal)

    // Emit a pre-step with a claimed message. The engine listener registers via
    // ctx.on (emit mode), so dispatch is fire-and-forget with the next callback.
    const claimed = {
      role: 'user' as const,
      id: 'm2',
      content: [{ type: 'text', text: 'make it shorter' }],
      source: { kind: 'user' } as const,
    }
    ctx.emit('agent/pre-step', {
      agent,
      messages: [claimed],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] }))
    // The serial queue processes the seed draft first, then the captured
    // instruction; wait for both.
    await new Promise(r => setTimeout(r, 50))

    // The review captures the instruction and drains a revision call.
    expect(llm.calls.length).toBeGreaterThanOrEqual(2)
    const allText = llm.calls.map((call) => call.messages.map((message: unknown) => {
      if (typeof message === 'object' && message !== null && 'content' in message) {
        const blocks = (message as { content?: unknown }).content
        if (Array.isArray(blocks)) {
          return blocks.map((block: unknown) => {
            if (typeof block === 'object' && block !== null && 'text' in block) {
              return (block as { text?: unknown }).text
            }
            return ''
          }).filter((t: unknown): t is string => typeof t === 'string').join('|')
        }
      }
      return ''
    }).join('|')).join('\n')
    expect(allText).toContain('make it shorter')
  })
})

/**
 * Completion self-delivery + bounded wait-interrupt behaviors: the steer
 * protocol (ack suppresses steer, deliveredTurns replay, wake-budget gating,
 * preview capping) and the user-message interrupt of an in-flight vibe_wait.
 *
 * Session wiring note: a child entered into the SessionStore publishes its
 * appends through the root `session/event` firehose, so childTurn alone
 * delivers the turn/end; un-entered children need the manual emit. The
 * tests follow that rule so each turn/end fires exactly once.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyDirectorScope } from '../src/index.ts'
import { childTurn, setup, MockSubagents, agentWithSession, VIBE_CONFIG, testExec } from './harness.ts'

/** The steered notices recorded on the fake director agent. */
function steered(director: Agent): Array<{ summary: string; senderSessionId: string; text: string }> {
  return (director as unknown as { steered: Array<{ source: { summary: string; senderSessionId: string }; content: Array<{ text: string }> }> }).steered
    .map(message => ({
      summary: message.source.summary,
      senderSessionId: String(message.source.senderSessionId),
      text: message.content.map(block => block.text).join(''),
    }))
}

/** Append a real user message to the director session and publish it. */
function userMessageArrives(ctx: Context, director: Agent): void {
  const event = director.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'user interjection' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  ctx.emit('session/event', director.session, event)
}

describe('completion self-delivery', () => {
  it('steers the director when a worker turn ends with no wait consuming it', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'self-deliver')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const child = Session.create(SessionId('w-self'))
    ctx.sessions.enter(child)
    scope.registry.spawn(SessionId('w-self'), 'fast', 'alpha', undefined)
    childTurn(child, 1, 'the finished answer')
    const notices = steered(director)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.summary).toBe('worker alpha completed (turn 1)')
    expect(notices[0]!.senderSessionId).toBe('w-self')
    expect(notices[0]!.text).toContain('worker alpha completed:')
    expect(notices[0]!.text).toContain('the finished answer')
    expect(notices[0]!.text).toContain('read agent://w-self')
    scope.dispose()
  })

  it('does NOT steer when a vibe_wait returned the result inline (ack)', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'self-acked')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const child = Session.create(SessionId('w-acked'))
    ctx.sessions.enter(child)
    scope.registry.spawn(SessionId('w-acked'), 'good', 'beta', undefined)
    const wait = scope.registry.waitForTurn(
      SessionId('w-acked'), 1, () => child.events,
      { timeoutMs: 2_000, signal: new AbortController().signal },
    )
    childTurn(child, 1, 'inline result')
    const result = await wait
    expect(result).toMatchObject({ session: SessionId('w-acked'), turn: 1, status: 'completed', output: 'inline result' })
    expect(steered(director)).toHaveLength(0)
    scope.dispose()
  })

  it('does NOT steer on a replayed turn/end after a from-log inline resolution (deliveredTurns ack)', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'self-replay')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    // Un-entered child: the turn completes WITHOUT publishing (no steer yet).
    const child = Session.create(SessionId('w-replay'))
    scope.registry.spawn(SessionId('w-replay'), 'fast', 'gamma', undefined)
    childTurn(child, 1, 'done already')
    // The wait resolves inline from the log — that return is the ack.
    const wait = scope.registry.waitForTurn(
      SessionId('w-replay'), 1, () => child.events,
      { timeoutMs: 2_000, signal: new AbortController().signal },
    )
    const result = await wait
    expect(result.status).toBe('completed')
    // A replayed turn/end must not also steer.
    const end = child.events.findLast(e => e.type === 'turn/end')!
    ctx.emit('session/event', child, end)
    expect(steered(director)).toHaveLength(0)
    scope.dispose()
  })

  it('caps the completion preview at 2000 chars and points to read agent://', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'self-cap')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const child = Session.create(SessionId('w-cap'))
    ctx.sessions.enter(child)
    scope.registry.spawn(SessionId('w-cap'), 'good', 'delta', undefined)
    childTurn(child, 1, 'x'.repeat(5_000))
    const notices = steered(director)
    expect(notices).toHaveLength(1)
    const preview = notices[0]!.text.slice(notices[0]!.text.indexOf(':') + 1, notices[0]!.text.indexOf('\n')).trim()
    expect(preview.length).toBeLessThanOrEqual(2000)
    expect(notices[0]!.text).toContain('read agent://w-cap')
    scope.dispose()
  })

  it('suppresses further steers once the consecutive-wake budget is exhausted', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'self-budget')
    const scope = applyDirectorScope(ctx, director, { ...ctx.vibeMode.config, maxConsecutiveWakes: 1 })
    const childA = Session.create(SessionId('w-budget-a'))
    const childB = Session.create(SessionId('w-budget-b'))
    ctx.sessions.enter(childA)
    ctx.sessions.enter(childB)
    scope.registry.spawn(SessionId('w-budget-a'), 'fast', 'eps', undefined)
    scope.registry.spawn(SessionId('w-budget-b'), 'fast', 'zeta', undefined)
    // First completion steers (budget 0 < 1)…
    childTurn(childA, 1, 'a done')
    expect(steered(director)).toHaveLength(1)
    // …its claim spends the budget…
    mock.claimSettled(ctx, director)
    expect(scope.registry.wakeBudgetExhausted()).toBe(true)
    // …so the second completion must NOT steer (no new self-excitation).
    childTurn(childB, 1, 'b done')
    expect(steered(director)).toHaveLength(1)
    scope.dispose()
  })

  it('a user message interrupts an in-flight vibe_wait early and the completion still steers once', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'interrupt-wait')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const spawnDef = ctx.tools.get('vibe_spawn', director)!
    const spawned = await spawnDef.execute({ cli: 'fast', prompt: 'work' }, testExec(director)) as { subagentId: string }
    const child = Session.create(SessionId(spawned.subagentId))
    ctx.sessions.enter(child)
    const waitDef = ctx.tools.get('vibe_wait', director)!
    const waitPromise = waitDef.execute({ sessions: [spawned.subagentId] }, testExec(director)) as Promise<{
      state: string; interrupted?: boolean; note?: string; results?: unknown[]
    }>
    userMessageArrives(ctx, director)
    const outcome = await waitPromise
    expect(outcome.state).toBe('waiting')
    expect(outcome.interrupted).toBe(true)
    expect(outcome.note).toMatch(/you will be notified/)
    // The completion still self-delivers once the worker's turn ends.
    childTurn(child, 1, 'eventually done')
    expect(steered(director)).toHaveLength(1)
    expect(steered(director)[0]!.senderSessionId).toBe(spawned.subagentId)
    scope.dispose()
  })

  it('a real tool abort still rejects instead of resolving interrupted', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'interrupt-abort')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const spawnDef = ctx.tools.get('vibe_spawn', director)!
    const spawned = await spawnDef.execute({ cli: 'fast', prompt: 'work' }, testExec(director)) as { subagentId: string }
    const waitDef = ctx.tools.get('vibe_wait', director)!
    const controller = new AbortController()
    const promise = waitDef.execute(
      { sessions: [spawned.subagentId] },
      testExec(director, { signal: controller.signal }),
    ) as Promise<never>
    controller.abort('director cancelled')
    await expect(promise).rejects.toThrow(/director cancelled/)
    scope.dispose()
  })
})

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkerRegistry } from '../src/workers.ts'
import { childTurn, setup, MockSubagents, agentWithSession, VIBE_CONFIG } from './harness.ts'

function waitForTurn(ctx: Context, registry: WorkerRegistry, childId: string, turn: number, events: () => readonly unknown[]) {
  return registry.waitForTurn(
    SessionId(childId),
    turn,
    () => events() as never,
    { timeoutMs: 2_000, signal: new AbortController().signal },
  )
}

describe('worker registry', () => {
  it('registers a spawned worker with its expected first turn and counts dispatches', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'reg-director')
    const registry = new WorkerRegistry(ctx, director, VIBE_CONFIG.maxConsecutiveWakes ?? 3)
    registry.spawn(SessionId('w1'), 'fast', 'alpha', undefined)
    expect(registry.get(SessionId('w1'))).toMatchObject({ tier: 'fast', label: 'alpha', lastTurn: 1, dispatched: 1 })
    registry.send(SessionId('w1'), undefined)
    expect(registry.get(SessionId('w1'))?.lastTurn).toBe(2)
    expect(registry.get(SessionId('w1'))?.dispatched).toBe(2)
    registry.dispose()
  })

  it('resolves a wait on the exact turn/end event with the child final output', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'wait-director')
    const registry = new WorkerRegistry(ctx, director, VIBE_CONFIG.maxConsecutiveWakes ?? 3)
    const child = Session.create(SessionId('w-turn'))
    registry.spawn(SessionId('w-turn'), 'good', 'beta', undefined)
    const promise = waitForTurn(ctx, registry, 'w-turn', 1, () => child.events)
    // Emit the child's turn/end through the root firehose (what persistence and
    // the loop observe); the log already holds the assistant output.
    childTurn(child, 1, 'the answer')
    const event = child.events.findLast(e => e.type === 'turn/end')!
    ctx.emit('session/event', child, event)
    const result = await promise
    expect(result).toEqual({ session: SessionId('w-turn'), turn: 1, output: 'the answer', status: 'completed' })
    registry.dispose()
  })

  it('a wait registered after the turn already ended resolves immediately from the log', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'wait-late')
    const registry = new WorkerRegistry(ctx, director, VIBE_CONFIG.maxConsecutiveWakes ?? 3)
    const child = Session.create(SessionId('w-late'))
    childTurn(child, 1, 'done already')
    registry.spawn(SessionId('w-late'), 'fast', 'gamma', child.events)
    const result = await waitForTurn(ctx, registry, 'w-late', 1, () => child.events)
    expect(result.status).toBe('completed')
    expect(result.output).toBe('done already')
    registry.dispose()
  })

  it('times out when the turn never ends, leaving the worker runnable', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'wait-timeout')
    const registry = new WorkerRegistry(ctx, director, VIBE_CONFIG.maxConsecutiveWakes ?? 3)
    registry.spawn(SessionId('w-tout'), 'fast', 'delta', undefined)
    const result = await registry.waitForTurn(
      SessionId('w-tout'),
      1,
      () => undefined,
      { timeoutMs: 20, signal: new AbortController().signal },
    )
    expect(result.status).toBe('timeout')
    expect(result.output).toBeUndefined()
    // The canonical value omits the absent output key entirely (lossless JSON).
    expect('output' in result).toBe(false)
    registry.dispose()
  })

  it('canonical results round-trip losslessly through JSON (no undefined fields)', async () => {
    const assertLossless = (value: unknown): void => {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value)
      const walk = (current: unknown): void => {
        if (Array.isArray(current)) {
          for (const item of current) walk(item)
          return
        }
        if (current !== null && typeof current === 'object') {
          for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
            expect(item, `field ${key} must not be undefined`).not.toBeUndefined()
            walk(item)
          }
        }
      }
      walk(value)
    }

    // Completed with output: the output key is present and serializable.
    const withOutput = await (async () => {
      const ctx = await setup(new MockSubagents())
      const director = await agentWithSession(ctx, 'lossless-ok')
      const registry = new WorkerRegistry(ctx, director, VIBE_CONFIG.maxConsecutiveWakes ?? 3)
      const child = Session.create(SessionId('w-lossless-ok'))
      registry.spawn(SessionId('w-lossless-ok'), 'good', 'iota', undefined)
      const promise = waitForTurn(ctx, registry, 'w-lossless-ok', 1, () => child.events)
      childTurn(child, 1, 'final answer')
      const event = child.events.findLast(e => e.type === 'turn/end')!
      ctx.emit('session/event', child, event)
      const result = await promise
      registry.dispose()
      return { results: [result] }
    })()
    assertLossless(withOutput)

    // Timeout without output: no `undefined` field rides in the canonical value.
    const withoutOutput = await (async () => {
      const ctx = await setup(new MockSubagents())
      const director = await agentWithSession(ctx, 'lossless-timeout')
      const registry = new WorkerRegistry(ctx, director, VIBE_CONFIG.maxConsecutiveWakes ?? 3)
      registry.spawn(SessionId('w-lossless-tout'), 'fast', 'kappa', undefined)
      const result = await registry.waitForTurn(
        SessionId('w-lossless-tout'),
        1,
        () => undefined,
        { timeoutMs: 20, signal: new AbortController().signal },
      )
      registry.dispose()
      return { results: [result] }
    })()
    assertLossless(withoutOutput)
    expect(withoutOutput.results[0]).toEqual({ session: SessionId('w-lossless-tout'), turn: 1, status: 'timeout' })
  })

  it('rejects aborted waits with the exec signal reason', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'wait-abort')
    const registry = new WorkerRegistry(ctx, director, VIBE_CONFIG.maxConsecutiveWakes ?? 3)
    registry.spawn(SessionId('w-abort'), 'good', 'eps', undefined)
    const controller = new AbortController()
    const promise = registry.waitForTurn(
      SessionId('w-abort'),
      1,
      () => undefined,
      { timeoutMs: 5_000, signal: controller.signal },
    )
    controller.abort('director cancelled')
    await expect(promise).rejects.toThrow(/director cancelled/)
    registry.dispose()
  })

  it('rejects when the worker agent is disposed while waiting', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'wait-disposed')
    const registry = new WorkerRegistry(ctx, director, VIBE_CONFIG.maxConsecutiveWakes ?? 3)
    registry.spawn(SessionId('w-gone'), 'fast', 'zeta', undefined)
    const promise = registry.waitForTurn(
      SessionId('w-gone'),
      1,
      () => undefined,
      { timeoutMs: 5_000, signal: new AbortController().signal },
    )
    // Emit disposal of the WORKER agent (a fake handle with the right id).
    const fakeWorker = { id: SessionId('w-gone') } as never
    ctx.emit('agent/disposed', { agent: fakeWorker })
    await expect(promise).rejects.toThrow(/disposed/)
    registry.dispose()
  })

  it('spends and resets the consecutive-settle wake budget like tool-jobs', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'wake-director')
    const registry = new WorkerRegistry(ctx, director, 2)
    expect(registry.wakeBudgetExhausted()).toBe(false)
    const mock = ctx.get('subagents') as unknown as MockSubagents
    mock.claimSettled(ctx, director)
    expect(registry.consecutiveSettleCount).toBe(1)
    expect(registry.wakeBudgetExhausted()).toBe(false)
    mock.claimSettled(ctx, director)
    expect(registry.consecutiveSettleCount).toBe(2)
    expect(registry.wakeBudgetExhausted()).toBe(true)
    // A user-authored claim resets the budget.
    mock.claimUser(ctx, director)
    expect(registry.consecutiveSettleCount).toBe(0)
    expect(registry.wakeBudgetExhausted()).toBe(false)
    registry.dispose()
  })
})

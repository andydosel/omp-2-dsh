import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkerRegistry } from '../src/workers.ts'
import { childTurn, claimSettled, claimUser, makeHarness, makeSpawner } from './harness.ts'

function waitForTurn(
  registry: WorkerRegistry,
  childId: string,
  turn: number,
  events: () => readonly SessionEvent[] | undefined,
  timeoutMs = 2_000,
) {
  return registry.waitForTurn(SessionId(childId), turn, events, {
    timeoutMs,
    signal: new AbortController().signal,
  })
}

describe('worker registry', () => {
  it('exposes the running roster state across turns, seeding it on spawn before the firehose turn/start', () => {
    const ctx = new Context()
    const spawner = makeSpawner('roster-spawner')
    const harness = makeHarness(ctx, spawner)
    const child = Session.create(SessionId('w-roster'))
    const lastRosterState = (): string | undefined => harness.last()?.[0]?.state
    // Real race: startActivation dispatches the child's first turn/start
    // BEFORE registry.spawn registers the record, so the firehose listener
    // misses it. Seeding from the live log must surface `running`, not
    // 'starting' -> 'idle'.
    child.append('turn/start', { turn: 1 })
    harness.registry.spawn(SessionId('w-roster'), 'good', 'roster-alpha', child.snapshotEvents())
    expect(harness.registry.get(SessionId('w-roster'))?.state).toBe('running')
    expect(lastRosterState()).toBe('running')

    // turn/end -> idle (and publishes the roster to the sink).
    const end = child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.emit('session/event', child, end)
    expect(harness.registry.get(SessionId('w-roster'))?.state).toBe('idle')
    expect(lastRosterState()).toBe('idle')

    // A second turn (a follow-up send) -> running again.
    const start2 = child.append('turn/start', { turn: 2 })
    ctx.emit('session/event', child, start2)
    expect(harness.registry.get(SessionId('w-roster'))?.state).toBe('running')
    expect(lastRosterState()).toBe('running')
    harness.registry.dispose()
  })

  it('resolves a wait on the exact turn/end event with the child final output', async () => {
    const ctx = new Context()
    const spawner = makeSpawner('wait-spawner')
    const harness = makeHarness(ctx, spawner)
    const child = Session.create(SessionId('w-turn'))
    harness.registry.spawn(SessionId('w-turn'), 'good', 'beta', undefined)
    const promise = waitForTurn(harness.registry, 'w-turn', 1, () => child.snapshotEvents())
    // Emit the child's turn/end through the root firehose (what persistence and
    // the loop observe); the log already holds the assistant output.
    childTurn(child, 1, 'the answer')
    const event = child.snapshotEvents().filter(e => e.type === 'turn/end').at(-1)!
    ctx.emit('session/event', child, event)
    const result = await promise
    expect(result).toEqual({ session: SessionId('w-turn'), turn: 1, output: 'the answer', status: 'completed' })
    harness.registry.dispose()
  })

  it('a wait registered after the turn already ended resolves immediately from the log', async () => {
    const ctx = new Context()
    const spawner = makeSpawner('wait-late')
    const harness = makeHarness(ctx, spawner)
    const child = Session.create(SessionId('w-late'))
    childTurn(child, 1, 'done already')
    harness.registry.spawn(SessionId('w-late'), 'fast', 'gamma', child.snapshotEvents())
    const result = await waitForTurn(harness.registry, 'w-late', 1, () => child.snapshotEvents())
    expect(result.status).toBe('completed')
    expect(result.output).toBe('done already')
    harness.registry.dispose()
  })

  it('times out when the turn never ends, leaving the worker runnable', async () => {
    const ctx = new Context()
    const spawner = makeSpawner('wait-timeout')
    const harness = makeHarness(ctx, spawner)
    harness.registry.spawn(SessionId('w-tout'), 'fast', 'delta', undefined)
    const result = await waitForTurn(harness.registry, 'w-tout', 1, () => undefined, 20)
    expect(result.status).toBe('timeout')
    expect(result.output).toBeUndefined()
    // The canonical value omits the absent output key entirely (lossless JSON).
    expect('output' in result).toBe(false)
    harness.registry.dispose()
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

    const ctx = new Context()
    const spawner = makeSpawner('lossless-spawner')
    const harness = makeHarness(ctx, spawner)
    const child = Session.create(SessionId('w-lossless-ok'))
    harness.registry.spawn(SessionId('w-lossless-ok'), 'good', 'iota', undefined)
    const promise = waitForTurn(harness.registry, 'w-lossless-ok', 1, () => child.snapshotEvents())
    childTurn(child, 1, 'final answer')
    const event = child.snapshotEvents().filter(e => e.type === 'turn/end').at(-1)!
    ctx.emit('session/event', child, event)
    const withOutput = { results: [await promise] }
    assertLossless(withOutput)

    harness.registry.spawn(SessionId('w-lossless-tout'), 'fast', 'kappa', undefined)
    const withoutOutput = { results: [await waitForTurn(harness.registry, 'w-lossless-tout', 1, () => undefined, 20)] }
    assertLossless(withoutOutput)
    expect(withoutOutput.results[0]).toEqual({ session: SessionId('w-lossless-tout'), turn: 1, status: 'timeout' })
    harness.registry.dispose()
  })

  it('rejects aborted waits with the caller signal reason', async () => {
    const ctx = new Context()
    const spawner = makeSpawner('wait-abort')
    const harness = makeHarness(ctx, spawner)
    harness.registry.spawn(SessionId('w-abort'), 'good', 'eps', undefined)
    const controller = new AbortController()
    const promise = harness.registry.waitForTurn(
      SessionId('w-abort'),
      1,
      () => undefined,
      { timeoutMs: 5_000, signal: controller.signal },
    )
    controller.abort('caller cancelled')
    await expect(promise).rejects.toThrow(/caller cancelled/)
    harness.registry.dispose()
  })

  it('rejects when the worker agent is disposed while waiting', async () => {
    const ctx = new Context()
    const spawner = makeSpawner('wait-disposed')
    const harness = makeHarness(ctx, spawner)
    harness.registry.spawn(SessionId('w-gone'), 'fast', 'zeta', undefined)
    const promise = harness.registry.waitForTurn(
      SessionId('w-gone'),
      1,
      () => undefined,
      { timeoutMs: 5_000, signal: new AbortController().signal },
    )
    // Emit disposal of the WORKER agent (a fake handle with the right id).
    const fakeWorker = { id: SessionId('w-gone') } as never
    ctx.emit('agent/disposed', { agent: fakeWorker })
    await expect(promise).rejects.toThrow(/disposed/)
    harness.registry.dispose()
  })

  it('self-delivers an unconsumed completion as a subagent-settled steer', async () => {
    const ctx = new Context()
    const spawner = makeSpawner('steer-spawner')
    const harness = makeHarness(ctx, spawner)
    const child = Session.create(SessionId('w-steer'))
    harness.registry.spawn(SessionId('w-steer'), 'good', 'theta', undefined)
    ctx.provide('sessions', { get: () => child } as never)
    childTurn(child, 1, 'steer me')
    const event = child.snapshotEvents().filter(e => e.type === 'turn/end').at(-1)!
    ctx.emit('session/event', child, event)
    expect(spawner.steered).toHaveLength(1)
    expect(spawner.steered[0]?.source).toMatchObject({
      kind: 'subagent-settled',
      form: 'notice',
      senderSessionId: SessionId('w-steer'),
    })
    expect(JSON.stringify(spawner.steered[0]?.content)).toContain('steer me')
    harness.registry.dispose()
  })

  it('spends and resets the consecutive-settle wake budget', () => {
    const ctx = new Context()
    const spawner = makeSpawner('wake-spawner')
    const harness = makeHarness(ctx, spawner, 2)
    expect(harness.registry.wakeBudgetExhausted()).toBe(false)
    claimSettled(ctx, spawner)
    expect(harness.registry.consecutiveSettleCount).toBe(1)
    expect(harness.registry.wakeBudgetExhausted()).toBe(false)
    claimSettled(ctx, spawner)
    expect(harness.registry.consecutiveSettleCount).toBe(2)
    expect(harness.registry.wakeBudgetExhausted()).toBe(true)
    // A user-authored claim resets the budget.
    claimUser(ctx, spawner)
    expect(harness.registry.consecutiveSettleCount).toBe(0)
    expect(harness.registry.wakeBudgetExhausted()).toBe(false)
    harness.registry.dispose()
  })

  it('seeds a persisted roster parked and parks every live worker on parkAll', () => {
    const ctx = new Context()
    const spawner = makeSpawner('seed-spawner')
    const harness = makeHarness(ctx, spawner)
    harness.registry.seed([{ id: 'w-seeded', name: 'persisted', tier: 'good', state: 'idle', turn: 4 }])
    expect(harness.registry.get(SessionId('w-seeded'))?.state).toBe('parked')
    harness.registry.spawn(SessionId('w-live'), 'fast', 'live', undefined)
    harness.registry.parkAll()
    expect(harness.registry.list().map(record => record.state)).toEqual(['parked', 'parked'])
    harness.registry.park(SessionId('w-live'))
    expect(harness.registry.get(SessionId('w-live'))?.state).toBe('parked')
    harness.registry.forget(SessionId('w-live'))
    expect(harness.registry.list()).toHaveLength(1)
    harness.registry.dispose()
  })
})

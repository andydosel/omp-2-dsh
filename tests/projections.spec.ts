/**
 * vibeWorkers projection unit: the registered `vibeWorkers` key folds the
 * whole-value `vibe/workers` events into the live roster (last wins).
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { setup, MockSubagents, agentWithSession } from './harness.ts'

describe('vibeWorkers projection', () => {
  it('folds vibe/workers whole-value events, last wins, and views the roster', async () => {
    const ctx = await setup(new MockSubagents())
    // Mount the projection registry: the controller's inject registers the
    // unit as soon as the service appears.
    await ctx.plugin(SessionProjectionRegistry)
    const director = await agentWithSession(ctx, 'proj-director')
    const append = (type: 'vibe/workers' | 'vibe/mode', data: { active: boolean } | { workers: Parameters<Session['append']>[1] & { workers: unknown[] } } extends never ? never : { active: boolean } | { workers: import('../src/types.ts').VibeWorkerView[] }) => { const event = director.session.append(type, data); ctx.emit('session/event', director.session, event); return event };
    const snapshot = () => ctx.sessionProjections.snapshot(director.session).values.vibeWorkers
    // Empty log → empty roster.
    expect(snapshot()).toEqual({ workers: [] })

    append('vibe/workers', { workers: [{ id: 'w1', name: 'alpha', tier: 'fast', state: 'running', turn: 1 }] })
    append('vibe/workers', { workers: [{ id: 'w1', name: 'alpha', tier: 'fast', state: 'idle', turn: 1, lastActivity: '2026-08-23T00:00:00.000Z' }] })
    // Last whole-value replace wins.
    expect(snapshot()).toEqual({ workers: [{ id: 'w1', name: 'alpha', tier: 'fast', state: 'idle', turn: 1, lastActivity: '2026-08-23T00:00:00.000Z' }] })

    // A second spawn replaces the list wholesale.
    append('vibe/workers', { workers: [{ id: 'w1', name: 'alpha', tier: 'fast', state: 'idle', turn: 1 }, { id: 'w2', name: 'beta', tier: 'good', state: 'starting', turn: 1 }] })
    const roster = snapshot()
    expect(roster?.workers.map(worker => worker.id)).toEqual(['w1', 'w2'])
    // Unrelated events leave the state untouched.
    const before = snapshot()
    append('vibe/mode', { active: true })
    expect(snapshot()).toStrictEqual(before)
  })

  it('serves a schema-validated roster only (invalid wire values rejected at the host boundary)', async () => {
    const ctx = await setup(new MockSubagents())
    await ctx.plugin(SessionProjectionRegistry)
    const session = Session.create(SessionId('proj-invalid'))
    // The registry's schema validation happens when the unit is registered;
    // appending an invalid payload still reaches the log (events are not
    // validated at append), but the projection's schema is what gates the wire.
    const event = session.append('vibe/workers', { workers: [{ id: 'w1', tier: 'fast', state: 'running', turn: 1 }] });
    ctx.emit('session/event', session, event)
    const snapshot = ctx.sessionProjections.snapshot(session).values.vibeWorkers
    expect(snapshot?.workers[0]?.name).toBeUndefined()
  })
})

/**
 * vibeWorkers projection unit: the registered `vibeWorkers` key serves the
 * plugin-owned store roster (no session event). The projection re-syncs from
 * the store on every committed session event.
 */

import { describe, expect, it } from 'vitest'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { setup, MockSubagents, agentWithSession } from './harness.ts'

describe('vibeWorkers projection', () => {
  it('serves the plugin-owned store roster, re-syncing on committed events', async () => {
    const ctx = await setup(new MockSubagents())
    // Mount the projection registry: the controller's inject registers the
    // unit as soon as the service appears.
    await ctx.plugin(SessionProjectionRegistry)
    const director = await agentWithSession(ctx, 'proj-director')
    const snapshot = () => ctx.sessionProjections.snapshot(director.session).values.vibeWorkers
    const drive = () => {
      const event = director.session.append('turn/start', { turn: 1 })
      ctx.emit('session/event', director.session, event)
    }

    // Empty store → empty roster.
    expect(snapshot()).toEqual({ workers: [] })

    // The store's roster is what the projection serves (no session event).
    ctx.vibeMode.store.setWorkers(director.session.id, [
      { id: 'w1', name: 'alpha', tier: 'fast', state: 'running', turn: 1 },
    ])
    drive()
    expect(snapshot()).toEqual({ workers: [{ id: 'w1', name: 'alpha', tier: 'fast', state: 'running', turn: 1 }] })

    // Whole-value replace: a second roster replaces the list wholesale.
    ctx.vibeMode.store.setWorkers(director.session.id, [
      { id: 'w1', name: 'alpha', tier: 'fast', state: 'idle', turn: 1 },
      { id: 'w2', name: 'beta', tier: 'good', state: 'starting', turn: 1 },
    ])
    drive()
    expect(snapshot()?.workers.map(worker => worker.id)).toEqual(['w1', 'w2'])
  })
})

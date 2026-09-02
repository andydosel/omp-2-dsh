import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyDirectorScope } from '../src/index.ts'
import { childTurn, setup, MockSubagents, agentWithSession, VIBE_CONFIG, visibleToolNames, testExec } from './harness.ts'

async function runTool<T>(ctx: Context, name: string, args: Record<string, unknown>, agent: Agent): Promise<T> {
  const def = ctx.tools.get(name, agent)
  if (!def) throw new Error(`no tool ${name}`)
  return await def.execute(args, testExec(agent)) as T
}

describe('vibe tools', () => {
  it('vibe_spawn starts a continuable child with tier routing and registers the worker', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'tools-director')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const result = await runTool<{ subagentId: string }>(ctx, 'vibe_spawn', { cli: 'fast', prompt: 'list files' }, director)
    expect(result.subagentId).toMatch(/^child-/)
    expect(mock.spawnCalls).toHaveLength(1)
    expect(mock.spawnCalls[0]).toMatchObject({ provider: 'spawn', promptText: 'list files' })
    // fast tier routes to the configured model override.
    expect(mock.spawnCalls[0]!.agentOptions).toEqual({ provider: 'mock', model: 'fast-model' })
    expect(scope.registry.get(SessionId(result.subagentId))?.tier).toBe('fast')
    scope.dispose()
  })

  it('vibe_spawn with empty tier inherits the director route (no agentOptions override)', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock, { ...VIBE_CONFIG, tiers: {} })
    const director = await agentWithSession(ctx, 'tools-inherit')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    await runTool<{ subagentId: string }>(ctx, 'vibe_spawn', { cli: 'good', prompt: 'do the thing' }, director)
    expect(mock.spawnCalls[0]!.agentOptions).toBeUndefined()
    scope.dispose()
  })

  it('vibe_send follows up and advances the worker turn counter', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'tools-send')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const spawned = await runTool<{ subagentId: string }>(ctx, 'vibe_spawn', { cli: 'good', prompt: 'start' }, director)
    await runTool(ctx, 'vibe_send', { session: spawned.subagentId, message: 'next step' }, director)
    expect(mock.followupCalls).toEqual([{ childId: spawned.subagentId, text: 'next step' }])
    expect(scope.registry.get(SessionId(spawned.subagentId))?.dispatched).toBe(2)
    scope.dispose()
  })

  it('vibe_wait pairs spawn->send with the exact turn/end and returns the worker output', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'tools-wait')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const spawned = await runTool<{ subagentId: string }>(ctx, 'vibe_spawn', { cli: 'good', prompt: 'research' }, director)
    await runTool(ctx, 'vibe_send', { session: spawned.subagentId, message: 'next step' }, director)
    // The worker completes turn 1 (spawn) then turn 2 (send) with outputs.
    const child = Session.create(SessionId(spawned.subagentId))
    ctx.sessions.enter(child)
    childTurn(child, 1, 'first result')
    childTurn(child, 2, 'second result')
    const promise = runTool<{ results: Array<{ session: string; turn: number; output?: string; status: string }> }>(
      ctx, 'vibe_wait', { sessions: [spawned.subagentId] }, director,
    )
    const end = child.events.findLast(e => e.type === 'turn/end')!
    ctx.emit('session/event', child, end)
    const result = await promise
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ session: spawned.subagentId, turn: 2, status: 'completed', output: 'second result' })
    scope.dispose()
  })

  it('vibe_wait without sessions waits for every worker of the director', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'tools-wait-all')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const a = await runTool<{ subagentId: string }>(ctx, 'vibe_spawn', { cli: 'fast', prompt: 'a' }, director)
    const b = await runTool<{ subagentId: string }>(ctx, 'vibe_spawn', { cli: 'fast', prompt: 'b' }, director)
    const childA = Session.create(SessionId(a.subagentId))
    const childB = Session.create(SessionId(b.subagentId))
    ctx.sessions.enter(childA)
    ctx.sessions.enter(childB)
    childTurn(childA, 1, 'A done')
    childTurn(childB, 1, 'B done')
    const promise = runTool<{ results: Array<{ session: string; turn: number; status: string }> }>(
      ctx, 'vibe_wait', {}, director,
    )
    ctx.emit('session/event', childA, childA.events.findLast(e => e.type === 'turn/end')!)
    ctx.emit('session/event', childB, childB.events.findLast(e => e.type === 'turn/end')!)
    const result = await promise
    expect(result.results.map(r => r.session).sort()).toEqual([a.subagentId, b.subagentId].sort())
    expect(result.results.every(r => r.status === 'completed')).toBe(true)
    scope.dispose()
  })

  it('vibe_kill parks the worker via interrupt with ancestor authority', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'tools-kill')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const spawned = await runTool<{ subagentId: string }>(ctx, 'vibe_spawn', { cli: 'fast', prompt: 'work' }, director)
    const result = await runTool<{ parked: boolean }>(ctx, 'vibe_kill', { session: spawned.subagentId }, director)
    expect(result.parked).toBe(true)
    expect(mock.interruptCalls).toEqual([spawned.subagentId])
    scope.dispose()
  })

  it('vibe_list reports registered workers with tier, turns, and live status', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'tools-list')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    const a = await runTool<{ subagentId: string }>(ctx, 'vibe_spawn', { cli: 'fast', prompt: 'a', name: 'alpha' }, director)
    const b = await runTool<{ subagentId: string }>(ctx, 'vibe_spawn', { cli: 'good', prompt: 'b', name: 'beta' }, director)
    const result = await runTool<{ workers: Array<{ session: string; tier: string; label: string; turns: number; status: string }> }>(
      ctx, 'vibe_list', {}, director,
    )
    expect(result.workers).toHaveLength(2)
    const alpha = result.workers.find(w => w.session === a.subagentId)!
    expect(alpha).toMatchObject({ tier: 'fast', label: 'alpha', turns: 1, status: 'inactive' })
    const beta = result.workers.find(w => w.session === b.subagentId)!
    expect(beta).toMatchObject({ tier: 'good', label: 'beta', turns: 1 })
    scope.dispose()
  })

  it('vibe tools are registered on the director scope and visible only to the director', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'tools-scope')
    const other = await agentWithSession(ctx, 'tools-other')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config)
    for (const name of ['vibe_spawn', 'vibe_send', 'vibe_wait', 'vibe_kill', 'vibe_list']) {
      expect(visibleToolNames(ctx, director)).toContain(name)
      expect(ctx.tools.get(name, other)).toBeUndefined()
    }
    scope.dispose()
    for (const name of ['vibe_spawn', 'vibe_send', 'vibe_wait', 'vibe_kill', 'vibe_list']) {
      expect(ctx.tools.get(name, director)).toBeUndefined()
    }
  })
})

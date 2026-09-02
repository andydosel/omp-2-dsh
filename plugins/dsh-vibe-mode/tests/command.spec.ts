import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { foldVibeMode } from '../src/index.ts'
import { agentWithSession, setup, MockSubagents, visibleToolNames, testExec } from './harness.ts'

const READ_ONLY = ['read', 'glob', 'grep', 'read_image', 'todo_write']
const VIBE_TOOLS = ['vibe_spawn', 'vibe_send', 'vibe_wait', 'vibe_kill', 'vibe_list']
const ALL_TOOLS = ['read', 'glob', 'grep', 'read_image', 'todo_write', 'write', 'bash']

/** Run the registered `/vibe` command exactly as the UI dispatches it. */
async function runVibe(ctx: Context, agent: Agent, line: string) {
  const command = ctx.commands.find(agent, 'vibe')
  if (!command) throw new Error('no /vibe command registered')
  return await command.handler({
    agent,
    rawInput: line,
    commandId: CommandId('cmd-test'),
    attachments: [],
    signal: new AbortController().signal,
  })
}

/** Spawn one worker through the real vibe_spawn tool. */
async function spawnWorker(ctx: Context, agent: Agent, cli: 'fast' | 'good' = 'fast'): Promise<string> {
  const def = ctx.tools.get('vibe_spawn', agent)!
  const result = await def.execute(
    { cli, prompt: 'do work' },
    testExec(agent),
  ) as { subagentId: string }
  return result.subagentId
}

describe('/vibe command lifecycle', () => {
  it('enters mode: narrows the director, registers tools, and logs vibe/mode', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'cmd-on')
    const result = await runVibe(ctx, director, '')
    expect(result.kind).toBe('success')
    expect(foldVibeMode(director.session.events)).toBe(true)
    const names = visibleToolNames(ctx, director)
    expect(names.sort()).toEqual([...READ_ONLY, ...VIBE_TOOLS].sort())
  })

  it('entering while plan mode is active reports a conflict error', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'cmd-mutex')
    ctx.provide('planMode', { get: () => ({ active: true }) } as never)
    const result = await runVibe(ctx, director, '')
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/plan mode/)
    expect(foldVibeMode(director.session.events)).toBe(false)
  })

  it('/vibe off parks every live worker and restores the full catalog', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'cmd-off')
    await runVibe(ctx, director, '')
    // Spawn two workers through the real tool so the registry tracks them.
    const a = await spawnWorker(ctx, director, 'fast')
    const b = await spawnWorker(ctx, director, 'good')
    const result = await runVibe(ctx, director, 'off')
    expect(result.kind).toBe('success')
    expect(result.text).toMatch(/parked/)
    expect(mock.interruptCalls.sort()).toEqual([a, b].sort())
    expect(foldVibeMode(director.session.events)).toBe(false)
    expect(visibleToolNames(ctx, director).sort()).toEqual([...ALL_TOOLS].sort())
  })

  it('/vibe off --terminate drains the worker forest instead of parking', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'cmd-terminate')
    await runVibe(ctx, director, '')
    await spawnWorker(ctx, director, 'fast')
    const result = await runVibe(ctx, director, 'off --terminate')
    expect(result.kind).toBe('success')
    expect(result.text).toMatch(/terminated/)
    expect(mock.interruptCalls).toEqual([])
    expect(mock.drainCalls).toEqual([[director.id]])
    expect(foldVibeMode(director.session.events)).toBe(false)
  })

  it('agent disposal drains the worker forest as the fallback', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'cmd-disposed')
    await runVibe(ctx, director, '')
    await spawnWorker(ctx, director, 'fast')
    ctx.emit('agent/disposed', { agent: director })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(mock.drainCalls.some(calls => calls.includes(director.id))).toBe(true)
  })

  it('re-entering after off re-applies the narrowing (fresh scope)', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'cmd-reenter')
    await runVibe(ctx, director, '')
    await runVibe(ctx, director, 'off')
    await runVibe(ctx, director, 'on')
    expect(foldVibeMode(director.session.events)).toBe(true)
    const names = visibleToolNames(ctx, director)
    expect(names.sort()).toEqual([...READ_ONLY, ...VIBE_TOOLS].sort())
  })

  it('a spawned worker survives /vibe off parked and is listed on re-entry', async () => {
    const mock = new MockSubagents()
    const ctx = await setup(mock)
    const director = await agentWithSession(ctx, 'cmd-park-resume')
    await runVibe(ctx, director, '')
    const spawned = await spawnWorker(ctx, director, 'fast')
    await runVibe(ctx, director, 'off')
    expect(mock.interruptCalls).toEqual([spawned])
    // Re-enter and list: the parked worker is still a child of the director.
    await runVibe(ctx, director, 'on')
    const listDef = ctx.tools.get('vibe_list', director)!
    const listed = await listDef.execute(
      {},
      testExec(director),
    ) as { workers: Array<{ session: string }> }
    expect(listed.workers.map(worker => worker.session)).toContain(spawned)
  })
})

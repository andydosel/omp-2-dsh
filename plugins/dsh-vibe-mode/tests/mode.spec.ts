import { describe, expect, it } from 'vitest'
import { DEFAULT_DIRECTOR_SECTION, VibeModeConflictError, resolveConfig } from '../src/index.ts'
import {
  VIBE_CONFIG, MockSubagents, agentWithSession, boundary, closeTurn, noticeTexts, openTurn, setup,
} from './harness.ts'

describe('vibe mode state machine', () => {
  it('set between turns commits immediately and is idempotent', async () => {
    const ctx = await setup(new MockSubagents())
    const agent = await agentWithSession(ctx, 'mode-idle')
    expect(ctx.vibeMode.set(agent, true)).toBe('committed')
    expect(ctx.vibeMode.store.get(agent.session.id).active).toBe(true)
    expect(ctx.vibeMode.get(agent)).toEqual({ active: true })
    expect(ctx.vibeMode.set(agent, true)).toBe('noop')
    expect(ctx.vibeMode.set(agent, false)).toBe('committed')
    expect(ctx.vibeMode.store.get(agent.session.id).active).toBe(false)
  })

  it('set during an open turn queues until the accepted pre-step boundary', async () => {
    const ctx = await setup(new MockSubagents())
    const agent = await agentWithSession(ctx, 'mode-open')
    openTurn(agent.session)
    expect(ctx.vibeMode.set(agent, true)).toBe('queued')
    expect(ctx.vibeMode.get(agent)).toEqual({ active: false, pending: true })
    // The boundary commits the selection and narration lands.
    await boundary(ctx, agent, 'step-start')
    expect(ctx.vibeMode.store.get(agent.session.id).active).toBe(true)
    expect(ctx.vibeMode.get(agent)).toEqual({ active: true })
  })

  it('an opposite pending selection cancels before the boundary', async () => {
    const ctx = await setup(new MockSubagents())
    const agent = await agentWithSession(ctx, 'mode-cancel')
    openTurn(agent.session)
    expect(ctx.vibeMode.set(agent, true)).toBe('queued')
    closeTurn(agent.session)
    // Back to the store state: the pending intent clears, nothing lands.
    expect(ctx.vibeMode.set(agent, false)).toBe('cancelled')
    expect(ctx.vibeMode.store.get(agent.session.id).active).toBe(false)
    expect(ctx.vibeMode.get(agent)).toEqual({ active: false })
    await boundary(ctx, agent, 'step-start')
    expect(ctx.vibeMode.store.get(agent.session.id).active).toBe(false)
  })

  it('a rejected step keeps the selection pending for a later accepted boundary', async () => {
    const ctx = await setup(new MockSubagents())
    const agent = await agentWithSession(ctx, 'mode-reject')
    openTurn(agent.session)
    ctx.vibeMode.set(agent, true)
    // Dispatch a pre-step whose next() rejects: nothing commits.
    const { agentEvents } = await import('@deepseek-ai/dsh-agent')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const events = agentEvents(ctx, agent)
    await events.waterfall(
      'agent/pre-step',
      { messages: [createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(ctx.vibeMode.store.get(agent.session.id).active).toBe(false)
    // The next accepted boundary still commits.
    await boundary(ctx, agent, 'step-start')
    expect(ctx.vibeMode.store.get(agent.session.id).active).toBe(true)
  })

  it('narrates a user flip on every mode change', async () => {
    const ctx = await setup(new MockSubagents())
    const agent = await agentWithSession(ctx, 'mode-narration')
    ctx.vibeMode.set(agent, true)
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to DIRECTOR (vibe) mode: your toolset is narrowed and you must delegate all work to vibe_* workers instead of doing it yourself.'])
    ctx.vibeMode.set(agent, false)
    expect(noticeTexts(agent.session)).toContain('The user switched this session back to the default mode.')
  })

  it('refuses to enter while plan mode is active (mutex)', async () => {
    const ctx = await setup(new MockSubagents())
    const agent = await agentWithSession(ctx, 'mutex-plan')
    // Simulate an active plan-mode sibling service through the structural probe.
    ctx.provide('planMode', { get: () => ({ active: true }) } as never)
    expect(() => ctx.vibeMode.set(agent, true)).toThrow(VibeModeConflictError)
    expect(() => ctx.vibeMode.set(agent, true)).toThrow(/plan mode/)
    expect(ctx.vibeMode.store.get(agent.session.id).active).toBe(false)
  })

  it('refuses to enter while compact mode is active (mutex)', async () => {
    const ctx = await setup(new MockSubagents())
    const agent = await agentWithSession(ctx, 'mutex-compact')
    ctx.provide('compactMode', { get: () => ({ active: true }) } as never)
    expect(() => ctx.vibeMode.set(agent, true)).toThrow(VibeModeConflictError)
    expect(() => ctx.vibeMode.set(agent, true)).toThrow(/compact mode/)
  })

  it('enters normally when the sibling services are absent', async () => {
    const ctx = await setup(new MockSubagents())
    const agent = await agentWithSession(ctx, 'mutex-none')
    expect(ctx.vibeMode.set(agent, true)).toBe('committed')
  })

  it('resolveConfig validates and defaults every field', () => {
    const resolved = resolveConfig(VIBE_CONFIG)
    expect(resolved.readOnlyTools).toEqual(['read', 'glob', 'grep', 'read_image', 'todo_write'])
    expect(resolved.provider).toBe('spawn')
    expect(resolved.waitTimeoutMs).toBe(5_000)
    expect(resolved.maxConsecutiveWakes).toBe(2)
    // A missing section inherits the shipped DIRECTOR default (single source
    // of truth); an explicitly blank one still fails loudly.
    expect(resolveConfig({}).section).toBe(DEFAULT_DIRECTOR_SECTION)
    expect(resolveConfig({}).section).toContain('MUST NOT')
    expect(() => resolveConfig({ section: '' })).toThrow(/non-empty/)
    expect(() => resolveConfig({ section: 'x', waitTimeoutMs: 99_000, maxWaitTimeoutMs: 10_000 })).toThrow(/exceeds/)
    expect(() => resolveConfig({ section: 'x', bogus: 1 } as never)).toThrow(/unknown key/)
  })
})

describe('closeTurn helper shapes', () => {
  it('closing the open turn leaves no pending selection', async () => {
    const ctx = await setup(new MockSubagents())
    const agent = await agentWithSession(ctx, 'close-shape')
    openTurn(agent.session)
    ctx.vibeMode.set(agent, true)
    closeTurn(agent.session)
    expect(ctx.vibeMode.set(agent, false)).toBe('cancelled')
    expect(ctx.vibeMode.store.get(agent.session.id).active).toBe(false)
  })
})

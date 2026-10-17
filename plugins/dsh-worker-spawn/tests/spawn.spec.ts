import { describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { drainWorkers, interruptWorker, sendWorkerMessage, startWorker, WORKER_INHERITED_TOOLS } from '../src/spawn.ts'
import { resolveWorkerSpawnConfig, tierAgentOptions } from '../src/types.ts'
import { makeSpawner } from './harness.ts'

interface StartCall {
  provider: string
  label: string
  prompt: string
  parentId: string
  delivery: 'parent' | 'caller'
  agentPreset?: string
  cwd?: string
  agentOptions?: { provider?: string; model?: string }
  aborted: boolean
}

/** A mock `ctx.subagents` recording every dispatch. */
class MockSubagents {
  readonly starts: StartCall[] = []
  readonly sends: Array<{ senderId: string; targetId: string; text: string; aborted: boolean }> = []
  readonly interrupts: Array<{ targetId: string; authorityKind: string; agentId: string }> = []
  readonly drains: string[][] = []
  private counter = 0

  async startActivation(spec: {
    provider: string
    label: string
    request: {
      prompt: ContentBlock[]
      parent: Agent
      agentPreset?: string
      cwd?: string
      agentOptions?: { provider?: string; model?: string }
    }
    delivery: 'parent' | 'caller'
    signal: AbortSignal
  }): Promise<{ childId: SessionId; messageId: MessageId }> {
    this.counter += 1
    const childId = SessionId(`child-${this.counter}`)
    this.starts.push({
      provider: spec.provider,
      label: spec.label,
      prompt: (spec.request.prompt[0] as { text?: string } | undefined)?.text ?? '',
      parentId: spec.request.parent.id,
      delivery: spec.delivery,
      ...spec.request.agentPreset === undefined ? {} : { agentPreset: spec.request.agentPreset },
      ...spec.request.cwd === undefined ? {} : { cwd: spec.request.cwd },
      ...spec.request.agentOptions === undefined ? {} : { agentOptions: spec.request.agentOptions },
      aborted: spec.signal.aborted,
    })
    return { childId, messageId: `msg-${this.counter}` as MessageId }
  }

  async sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: { signal: AbortSignal },
  ): Promise<MessageId> {
    this.sends.push({
      senderId: sender.id,
      targetId,
      text: (content[0] as { text?: string } | undefined)?.text ?? '',
      aborted: options.signal.aborted,
    })
    return `msg-send-${this.sends.length}` as MessageId
  }

  interrupt(targetId: SessionId, authority: { kind: string; agent: Agent }): void {
    this.interrupts.push({ targetId, authorityKind: authority.kind, agentId: authority.agent.id })
  }

  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    this.drains.push(parents.map(agent => agent.id))
  }
}

/** Mount the mock subagents service on a bare context. */
function withMock(child?: { restrict: Mock; schemas?: () => { name: string }[] }): { ctx: Context; mock: MockSubagents } {
  const ctx = new Context()
  const mock = new MockSubagents()
  ctx.provide('subagents', mock as never)
  ctx.provide('agents', {
    get: () => (child === undefined ? undefined : {
      ctx: { tools: { restrict: child.restrict, ...child.schemas === undefined ? {} : { schemas: child.schemas } } },
    }),
  } as never)
  return { ctx, mock }
}

describe('tier routing', () => {
  it('resolves each tier to the configured model route, or to no override', () => {
    const tiers = { fast: { provider: 'p', model: 'm' }, good: { provider: 'p' } }
    expect(tierAgentOptions('fast', tiers)).toEqual({ provider: 'p', model: 'm' })
    expect(tierAgentOptions('good', tiers)).toEqual({ provider: 'p' })
    expect(tierAgentOptions('good', { fast: { provider: 'p', model: 'm' } })).toBeUndefined()
    expect(tierAgentOptions('fast', { fast: {} })).toBeUndefined()
    expect(tierAgentOptions('fast', undefined)).toBeUndefined()
  })

  it('validates deployment config and rejects unknown keys', () => {
    expect(resolveWorkerSpawnConfig()).toEqual({ provider: 'spawn', tiers: {}, maxConsecutiveWakes: 3 })
    expect(resolveWorkerSpawnConfig({ provider: 'other', tiers: { fast: { model: 'm' } }, maxConsecutiveWakes: 0 }))
      .toEqual({ provider: 'other', tiers: { fast: { model: 'm' } }, maxConsecutiveWakes: 0 })
    expect(() => resolveWorkerSpawnConfig({ provider: '' })).toThrow(/provider/)
    expect(() => resolveWorkerSpawnConfig({ maxConsecutiveWakes: -1 })).toThrow(/maxConsecutiveWakes/)
    expect(() => resolveWorkerSpawnConfig({ nope: true } as never)).toThrow(/unknown key/)
    expect(() => resolveWorkerSpawnConfig({ tiers: { fast: { nope: 'x' } } as never })).toThrow(/unknown key/)
  })
})

describe('spawn-in-process dispatch', () => {
  it('starts a worker on the spawn provider with the tier route applied', async () => {
    const { ctx, mock } = withMock()
    const parent = makeSpawner('parent-1')
    const started = await startWorker(ctx, {
      parent,
      tier: 'fast',
      prompt: 'do the thing',
      tiers: { fast: { provider: 'mock', model: 'fast-model' } },
      signal: new AbortController().signal,
    })
    expect(started).toMatchObject({ childId: SessionId('child-1'), messageId: 'msg-1', tier: 'fast', label: 'fast worker' })
    expect(mock.starts).toEqual([{
      provider: 'spawn',
      label: 'fast worker',
      prompt: 'do the thing',
      parentId: 'parent-1',
      delivery: 'parent',
      agentOptions: { provider: 'mock', model: 'fast-model' },
      aborted: false,
    }])
  })

  it('omits agentOptions when the tier inherits the parent route, and honors a custom label/provider', async () => {
    const { ctx, mock } = withMock()
    const parent = makeSpawner('parent-2')
    await startWorker(ctx, {
      parent,
      tier: 'good',
      prompt: 'judge it',
      label: 'reviewer',
      provider: 'spawn',
      tiers: { fast: { provider: 'mock', model: 'fast-model' } },
      signal: new AbortController().signal,
    })
    expect(mock.starts[0]).toEqual({
      provider: 'spawn',
      label: 'reviewer',
      prompt: 'judge it',
      parentId: 'parent-2',
      delivery: 'parent',
      aborted: false,
    })
    expect(Object.hasOwn(mock.starts[0]!, 'agentOptions')).toBe(false)
  })

  it('forwards the 0.2.1 agentPreset/cwd request fields', async () => {
    const { ctx, mock } = withMock()
    const parent = makeSpawner('parent-preset')
    await startWorker(ctx, {
      parent,
      tier: 'good',
      prompt: 'work in the sandbox',
      agentPreset: 'standard',
      cwd: 'C:/work/tree',
      signal: new AbortController().signal,
    })
    expect(mock.starts[0]).toEqual({
      provider: 'spawn',
      label: 'good worker',
      prompt: 'work in the sandbox',
      parentId: 'parent-preset',
      delivery: 'parent',
      agentPreset: 'standard',
      cwd: 'C:/work/tree',
      aborted: false,
    })
  })

  it('restricts a local worker scope to implementation tools', async () => {
    const restrict = vi.fn()
    const { ctx } = withMock({ restrict })
    const parent = makeSpawner('parent-r')
    await startWorker(ctx, {
      parent,
      tier: 'good',
      prompt: 'implement it',
      signal: new AbortController().signal,
    })
    expect(restrict).toHaveBeenCalledTimes(1)
    expect(restrict).toHaveBeenCalledWith({ allow: WORKER_INHERITED_TOOLS })
    for (const tool of ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'lsp']) {
      expect(WORKER_INHERITED_TOOLS).toContain(tool)
    }
    for (const tool of ['peer_send', 'task_new', 'task_update', 'task_close', 'task_reopen', 'task_list', 'ask_question']) {
      expect(WORKER_INHERITED_TOOLS).not.toContain(tool)
    }
  })

  it('intersects the allow-list with the tools the child scope actually inherits', async () => {
    const restrict = vi.fn()
    const { ctx } = withMock({
      restrict,
      schemas: () => ['read', 'write', 'subtask_parallel'].map(name => ({ name })),
    })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const parent = makeSpawner('parent-i')
    await startWorker(ctx, {
      parent,
      tier: 'good',
      prompt: 'implement it',
      signal: new AbortController().signal,
    })
    expect(restrict).toHaveBeenCalledWith({ allow: ['read', 'write', 'subtask_parallel'] })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('does not inherit tool(s)'),
      expect.anything(),
      expect.stringContaining('lsp'),
      expect.anything(),
    )
  })

  it('honors a brief toolFilter (narrower than the worker vocabulary)', async () => {
    const restrict = vi.fn()
    const { ctx } = withMock({
      restrict,
      schemas: () => ['read', 'write', 'edit', 'bash', 'glob'].map(name => ({ name })),
    })
    const parent = makeSpawner('parent-f')
    await startWorker(ctx, {
      parent,
      tier: 'good',
      prompt: 'read only',
      toolFilter: ['read', 'glob', 'bash'],
      signal: new AbortController().signal,
    })
    expect(restrict).toHaveBeenCalledWith({ allow: ['read', 'glob', 'bash'] })
  })

  it('sends a follow-up turn with the live sender and no source descriptor', async () => {
    const { ctx, mock } = withMock()
    const parent = makeSpawner('parent-3')
    const messageId = await sendWorkerMessage(
      ctx,
      parent,
      SessionId('child-9'),
      [{ type: 'text', text: 'next step' }],
      new AbortController().signal,
    )
    expect(messageId).toBe('msg-send-1')
    expect(mock.sends).toEqual([{ senderId: 'parent-3', targetId: 'child-9', text: 'next step', aborted: false }])
  })

  it('interrupts under the live ancestor and drains descendants by exact parent', async () => {
    const { ctx, mock } = withMock()
    const parent = makeSpawner('parent-4')
    interruptWorker(ctx, parent, SessionId('child-9'))
    expect(mock.interrupts).toEqual([{ targetId: 'child-9', authorityKind: 'ancestor', agentId: 'parent-4' }])
    await drainWorkers(ctx, [parent])
    expect(mock.drains).toEqual([['parent-4']])
  })
})

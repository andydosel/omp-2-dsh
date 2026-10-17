import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createDispatcher } from '../src/dispatch.ts'
import type { DispatcherOptions } from '../src/dispatch.ts'
import { parseReviewerReport } from '../src/findings.ts'
import { makeAgent } from './harness.ts'

/** Append one complete child turn and emit its `turn/end` through the root firehose. */
function settleTurn(ctx: Context, session: Session, turn: number, output: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: output }], source: { provider: 'mock', model: 'mock' } }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  const end = session.append('turn/end', { turn, reason: { kind: 'completed' } })
  ctx.emit('session/event', session, end)
}

/** Recorded reviewer composition (what `composeReviewer` installed on the scope). */
interface ComposedScope {
  readonly restrictions: Array<{ allow?: readonly string[] }>
  readonly registered: string[]
  readonly sections: string[]
}

/** A mock `ctx.agents` + `ctx.subagents` with controllable child sessions. */
function makeHost() {
  const ctx = new Context()
  const live = new Map<string, Agent>()
  const sessions = new Map<string, Session>()
  const created = new Map<string, { delivered: UserMessage[] }>()
  const composed: ComposedScope[] = []
  const creates: Array<{ sessionId: string; cwd?: string }> = []
  const starts: Array<{ provider: string; label: string; prompt: string; agentOptions?: unknown }> = []
  const workerRestricts: string[][] = []
  const disposed: string[] = []
  /** When true, a spawned worker never settles its first turn (timeout path). */
  let silentSpawn = false

  ctx.provide('agents', {
    get: (id: SessionId) => live.get(id),
    create: async (options: { sessionId: SessionId; meta?: { cwd?: string }; setup?: (agentCtx: Context, agent: Agent) => void }) => {
      creates.push({ sessionId: options.sessionId, ...options.meta?.cwd === undefined ? {} : { cwd: options.meta.cwd } })
      const base = Session.create(options.sessionId)
      const session = options.meta?.cwd === undefined
        ? base
        : Session.create(options.sessionId, [], { ...base.header, cwd: options.meta.cwd })
      const delivered: UserMessage[] = []
      const agent = {
        id: options.sessionId,
        session,
        options: {},
        status: 'idle',
        followup: (message: UserMessage) => delivered.push(message),
        cancel: () => {},
        whenIdle: async () => {},
      } as unknown as Agent
      live.set(options.sessionId, agent)
      sessions.set(options.sessionId, session)
      created.set(options.sessionId, { delivered })
      const scope: ComposedScope = { restrictions: [], registered: [], sections: [] }
      composed.push(scope)
      const agentCtx = {
        get: () => undefined,
        tools: {
          schemas: () => [{ name: 'read' }, { name: 'grep' }, { name: 'glob' }, { name: 'write' }],
          restrict: (filter: { allow?: readonly string[] }) => {
            scope.restrictions.push(filter)
            return () => {}
          },
          register: (tool: { name: string }) => {
            scope.registered.push(tool.name)
            return () => {}
          },
        },
        systemPrompt: {
          section: (section: { name: string }) => {
            scope.sections.push(section.name)
            return () => {}
          },
        },
      } as unknown as Context
      options.setup?.(agentCtx, agent)
      return {
        agent,
        dispose: async () => {
          disposed.push(options.sessionId)
          live.delete(options.sessionId)
        },
      }
    },
  } as never)

  ctx.provide('subagents', {
    startActivation: async (spec: {
      provider: string
      label: string
      request: { prompt: readonly ContentBlock[]; parent: Agent; agentOptions?: unknown }
    }) => {
      const prompt = spec.request.prompt.map(block => (block.type === 'text' ? block.text : '')).join('')
      starts.push({
        provider: spec.provider,
        label: spec.label,
        prompt,
        ...spec.request.agentOptions === undefined ? {} : { agentOptions: spec.request.agentOptions },
      })
      const childId = SessionId('worker-1')
      const session = Session.create(childId)
      sessions.set(childId, session)
      live.set(childId, {
        id: childId,
        session,
        options: {},
        status: 'running',
        ctx: {
          tools: {
            schemas: () => ['read', 'grep', 'glob', 'write', 'todo_write'].map(name => ({ name })),
            restrict: (filter: { allow?: readonly string[] }) => {
              workerRestricts.push([...(filter.allow ?? [])])
              return () => {}
            },
          },
        },
      } as unknown as Agent)
      if (!silentSpawn) {
        // Real timing: the child's first turn settles AFTER the dispatcher
        // registered its wait, so the wait resolves on the firehose event.
        setTimeout(() => {
          settleTurn(ctx, session, 1, 'worker output')
        }, 0)
      }
      return { childId, messageId: 'message-1', dispose: async () => {} }
    },
    sendMessage: async () => 'message-2',
  } as never)

  return {
    ctx,
    composed,
    creates,
    starts,
    workerRestricts,
    disposed,
    sessions,
    created,
    set silentSpawn(value: boolean) {
      silentSpawn = value
    },
  }
}

/** The dispatcher options under test. */
function options(overrides: Partial<DispatcherOptions> = {}): DispatcherOptions {
  return {
    workerSpawn: { provider: 'spawn', tiers: { fast: { model: 'fast-model' } }, maxConsecutiveWakes: 3 },
    workerTimeoutMs: 2_000,
    reviewTimeoutMs: 2_000,
    reviewerTools: ['read', 'grep', 'glob'],
    warn: vi.fn(),
    ...overrides,
  }
}

describe('worker dispatch', () => {
  it('starts a tiered worker on the worker-spawn base and reads its first turn', async () => {
    const host = makeHost()
    const dispatcher = createDispatcher(host.ctx, makeAgent('carrier-1'), options())
    const outcome = await dispatcher.dispatch(
      { role: 'worker', tier: 'fast', brief: 'do the thing', label: 'subtask-1' },
      new AbortController().signal,
    )
    expect(outcome).toEqual({ role: 'worker', status: 'completed', output: 'worker output' })
    expect(host.starts).toEqual([{
      provider: 'spawn',
      label: 'subtask-1',
      prompt: 'do the thing',
      agentOptions: { model: 'fast-model' },
    }])
    dispatcher.dispose()
  })

  it('narrows a worker to the brief toolFilter, dropping non-worker and absent names', async () => {
    const host = makeHost()
    const dispatcher = createDispatcher(host.ctx, makeAgent('carrier-1'), options())
    const outcome = await dispatcher.dispatch(
      {
        role: 'worker',
        tier: 'good',
        brief: 'read and write only',
        label: 'subtask-f',
        toolFilter: ['read', 'peer_send', 'bash', 'write'],
      },
      new AbortController().signal,
    )
    expect(outcome.status).toBe('completed')
    // peer_send is outside the worker vocabulary; bash is absent from this
    // child's preset. Only the intersection reaches `tools.restrict`.
    expect(host.workerRestricts).toEqual([['read', 'write']])
    dispatcher.dispose()
  })

  it('reports a timed-out worker honestly instead of hanging the batch', async () => {
    const host = makeHost()
    host.silentSpawn = true
    const dispatcher = createDispatcher(host.ctx, makeAgent('carrier-1'), options({ workerTimeoutMs: 20 }))
    const outcome = await dispatcher.dispatch(
      { role: 'worker', tier: 'good', brief: 'stuck task', label: 'subtask-2' },
      new AbortController().signal,
    )
    expect(outcome).toEqual({ role: 'worker', status: 'timeout' })
    dispatcher.dispose()
  })
})

describe('reviewer dispatch', () => {
  it('composes a clean read-only reviewer, delivers the brief, and parses its report', async () => {
    const host = makeHost()
    const dispatcher = createDispatcher(host.ctx, makeAgent('carrier-1', undefined, 'C:/work'), options())
    const brief = 'Review plan P against src/a.ts and answer with the JSON report.'
    const report = '{"findings":[{"severity":"P0","summary":"the lock leaks","evidence":"src/a.ts:3"}]}'

    const promise = dispatcher.dispatch(
      { role: 'reviewer', tier: 'good', brief, label: 'review-r1-1' },
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(host.creates).toHaveLength(1))
    const reviewerId = host.creates[0]!.sessionId
    // The reviewer inherits the carrier's working directory.
    expect(host.creates[0]!.cwd).toBe('C:/work')
    // Wait for the brief to be delivered: the dispatcher registers the review
    // turn BEFORE it does, so its wait targets turn 1.
    await vi.waitFor(() => expect(host.created.get(reviewerId)!.delivered).toHaveLength(1))
    expect(host.created.get(reviewerId)!.delivered.map(message => message.content)).toEqual([
      [{ type: 'text', text: brief }],
    ])
    expect(host.created.get(reviewerId)!.delivered[0]!.source).toEqual({ kind: 'dsh-orchestrator', form: 'relay' })

    settleTurn(host.ctx, host.sessions.get(reviewerId)!, 1, report)
    const outcome = await promise

    expect(outcome).toMatchObject({ role: 'reviewer', status: 'completed', output: report })
    expect(outcome.findings).toEqual(parseReviewerReport(report))
    // Read-only envelope: the allow-list intersects the configured reviewer
    // tools with the reviewer's own toolset, so `write` is dropped.
    expect(host.composed[0]!.restrictions).toEqual([{ allow: ['read', 'grep', 'glob'] }])
    expect(host.composed[0]!.registered).toEqual(['advise'])
    expect(host.composed[0]!.sections).toEqual(['orchestrator:reviewer'])
    // The one-shot reviewer is disposed after its single turn.
    expect(host.disposed).toEqual([reviewerId])
    dispatcher.dispose()
  })

  it('reports a reviewer whose reply is not a usable report', async () => {
    const host = makeHost()
    const dispatcher = createDispatcher(host.ctx, makeAgent('carrier-1'), options())
    const promise = dispatcher.dispatch(
      { role: 'reviewer', tier: 'good', brief: 'review it', label: 'review-r1-2' },
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(host.created.get(host.creates[0]!.sessionId)!.delivered).toHaveLength(1))
    settleTurn(host.ctx, host.sessions.get(host.creates[0]!.sessionId)!, 1, 'looks fine to me, ship it')
    const outcome = await promise
    expect(outcome.status).toBe('completed')
    expect(outcome.findings).toBeUndefined()
    expect(outcome.error).toMatch(/not a usable findings report/)
    expect(host.disposed).toHaveLength(1)
    dispatcher.dispose()
  })

  it('reports a reviewer that produced no text at all', async () => {
    const host = makeHost()
    const dispatcher = createDispatcher(host.ctx, makeAgent('carrier-1'), options())
    const promise = dispatcher.dispatch(
      { role: 'reviewer', tier: 'good', brief: 'review it', label: 'review-r1-3' },
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(host.created.get(host.creates[0]!.sessionId)!.delivered).toHaveLength(1))
    settleTurn(host.ctx, host.sessions.get(host.creates[0]!.sessionId)!, 1, '   ')
    const outcome = await promise
    expect(outcome).toMatchObject({ status: 'completed', error: 'reviewer produced no final text' })
    dispatcher.dispose()
  })

  it('gives every reviewer its own session id and never reuses one', async () => {
    const host = makeHost()
    const dispatcher = createDispatcher(host.ctx, makeAgent('carrier-1'), options())
    for (let index = 0; index < 2; index += 1) {
      const promise = dispatcher.dispatch(
        { role: 'reviewer', tier: 'good', brief: 'review it', label: 'review-r1-1' },
        new AbortController().signal,
      )
      await vi.waitFor(() => expect(host.created.get(host.creates[index]!.sessionId)!.delivered).toHaveLength(1))
      settleTurn(host.ctx, host.sessions.get(host.creates[index]!.sessionId)!, 1, '{"findings":[]}')
      await promise
    }
    expect(host.creates[0]!.sessionId).not.toBe(host.creates[1]!.sessionId)
    expect(host.creates[0]!.sessionId).toMatch(/review-r1-1/)
    dispatcher.dispose()
  })
})

/**
 * Shared test harness: fake cordis context, fake agents, and real dsh-session
 * sessions so session-event-driven runtime behavior is exercised with real
 * event validation and surface projection.
 */

import { vi, type Mock } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'

/** One event listener registration on the fake context. */
export type Listener = (...args: unknown[]) => unknown

/** A reviewer created through the fake agent factory. */
export interface CreatedReviewer {
  readonly agent: Agent
  readonly session: Session
  readonly agentCtx: FakeAgentContext
  readonly dispose: Mock
}

/** Fake cordis context with emit support and a mock agent factory. */
export class FakeContext {
  readonly listeners = new Map<string, Listener[]>()
  readonly created: CreatedReviewer[] = []
  readonly createSpy = vi.fn()
  readonly listAgents: Agent[] = []
  readonly logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  readonly getMock = vi.fn((_name: string) => undefined)
  /** Tool names the composed reviewer scope exposes (defaults to the standard set). */
  reviewerToolNames: string[] | undefined

  constructor(readonly composedPreset = false) {}

  on(event: string, listener: Listener): () => void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return () => {
      const current = this.listeners.get(event)
      if (current === undefined) return
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
    }
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args)
    }
  }

  /** Fake `ctx.agents` registry. */
  readonly agents = {
    list: () => this.listAgents,
    create: async (options: {
      sessionId: SessionId
      meta?: { cwd?: string; origin?: 'subagent'; delegationDepth?: number }
      agentOptions?: Record<string, unknown>
      setup?: (agentCtx: FakeAgentContext, agent: Agent) => unknown
    }): Promise<AgentHandle> => {
      const session = Session.create(options.sessionId, undefined, {
        version: SESSION_FORMAT_VERSION,
        id: options.sessionId,
        createdAt: Date.now(),
        isSeeded: false,
        ...options.meta,
      })
      const agent = makeFakeReviewerAgent(options.sessionId, options.agentOptions ?? {}, session)
      const agentCtx = new FakeAgentContext(agent, {
        composedPreset: this.composedPreset,
        ...this.reviewerToolNames !== undefined ? { toolNames: this.reviewerToolNames } : {},
      })
      options.setup?.(agentCtx, agent)
      const entry: CreatedReviewer = {
        agent,
        session,
        agentCtx,
        dispose: vi.fn(async () => {}),
      }
      this.created.push(entry)
      this.createSpy(options)
      return { agent, dispose: entry.dispose }
    },
  }

  get(name: string): unknown {
    return this.getMock(name)
  }
}

/** Fake agent-scoped context handed to the reviewer setup. */
export class FakeAgentContext {
  readonly restrictSpy = vi.fn()
  readonly registerSpy = vi.fn()
  readonly sectionSpy = vi.fn()
  readonly schemasSpy = vi.fn()
  readonly agentPresetsMock: { composeFrom: Mock }
  private readonly composed: boolean

  constructor(
    readonly agent: Agent,
    options: { composedPreset?: boolean; toolNames?: string[] } = {},
  ) {
    this.composed = options.composedPreset ?? false
    this.agentPresetsMock = { composeFrom: vi.fn(() => 'preset-id') }
    // Tools the reviewer's composed scope would expose; the intersection fix
    // reads these before restricting. Defaults to the standard set so the
    // stock defaultTools survive intact.
    this.schemasSpy.mockReturnValue((options.toolNames ?? ['read', 'grep', 'glob']).map(name => ({ name })))
  }

  get(name: string): unknown {
    if (name === 'agentPresets') return this.composed ? this.agentPresetsMock : undefined
    return undefined
  }

  readonly tools = {
    restrict: (filter: { allow?: readonly string[]; deny?: readonly string[] }) => {
      this.restrictSpy(filter)
      return () => {}
    },
    register: (definition: { name: string }) => {
      this.registerSpy(definition)
      return () => {}
    },
    schemas: (scope?: unknown): Array<{ name: string }> => {
      this.schemasSpy(scope)
      return this.schemasSpy.mock.results.at(-1)!.value as Array<{ name: string }>
    },
  }

  readonly systemPrompt = {
    section: (section: { name: string; order: number; text: string }) => {
      this.sectionSpy(section)
      return () => {}
    },
  }
}

/** Build a fake agent over a real session. */
export function makeFakeAgent(
  id: string,
  session: Session,
  overrides: Partial<Pick<Agent, 'status'>> & {
    options?: Partial<Agent['options']>
  } = {},
): Agent {
  return {
    id: SessionId(id),
    session,
    status: overrides.status ?? 'idle',
    options: {
      provider: 'test-provider',
      model: 'primary-model',
      ...overrides.options,
    },
    inbox: { nextTurn: [], nextStep: [] },
    ctx: { get: () => undefined },
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    runMaintenance: vi.fn(),
    send: vi.fn(),
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
  } as unknown as Agent
}

/** Build a fake reviewer agent (same shape; used by the fake factory). */
export function makeFakeReviewerAgent(id: SessionId, options: Record<string, unknown>, session: Session): Agent {
  return makeFakeAgent(id, session, {
    options: {
      provider: options['provider'] as string | undefined,
      model: options['model'] as string | undefined,
      maxTokens: options['maxTokens'] as number | undefined,
    },
  })
}

/** Create a fresh primary agent with a real session. */
export function makePrimaryAgent(id = 'primary', status: Agent['status'] = 'idle'): Agent {
  return makeFakeAgent(id, Session.create(SessionId(id)), { status })
}

/** Append a user message to a session and return its event. */
export function appendUserMessage(
  session: Session,
  text: string,
  source: UserMessage['source'] = { kind: 'user' },
): SessionEvent {
  const message = createUserMessage({ content: [{ type: 'text', text }], source })
  return session.append('user/message', message, { surfaceOp: 'append' })
}

/** Append an assistant message to a session. */
export function appendAssistantMessage(session: Session, text: string): SessionEvent {
  const message = createAssistantMessage({ content: [{ type: 'text', text }], provider: 'test-provider', model: 'test-model' })
  return session.append('assistant/message', { turn: 1, step: 1, message, stream: [] }, { surfaceOp: 'append' })
}

/** Append a tool result to a session. */
export function appendToolResult(session: Session, callId: string, text: string): SessionEvent {
  const message = createToolResultMessage({
    callId: ToolCallId(callId),
    content: [{ type: 'text', text }],
    isError: false,
  })
  return session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
}

/**
 * Append the settle event of a PTC-bridged `advise` sub-call. In a PTC preset
 * the reviewer's only native tool is `run_code`; `advise` runs inside it and
 * logs a `tool/ptc-dispatch` (no `tool/call` + `tool/result` pair).
 * @param session - the reviewer session.
 * @param severity - advisory grade.
 * @param note - advisory note.
 * @param subCallId - opaque sub-call id.
 * @returns the appended settle event.
 */
export function appendPtcAdviseDispatch(
  session: Session,
  severity: string,
  note: string,
  subCallId = 'adv-ptc-1',
): SessionEvent {
  return session.append('tool/ptc-dispatch', {
    rootCallId: ToolCallId('run-1'),
    parentCallId: ToolCallId('run-1'),
    subCallId: ToolCallId(subCallId),
    name: 'advise',
    arguments: { severity, note },
    isError: false,
    content: [{ type: 'text', text: `Advisory recorded: ${severity}` }],
  })
}

/** Append a completed turn boundary pair (or just the end). */
export function appendTurnEnd(session: Session, turn = 1): SessionEvent {
  session.append('turn/start', { turn })
  return session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append an advise tool call + result pair to a reviewer session. */
export function appendAdviseCall(session: Session, severity: string, note: string, callId = 'adv-1'): { call: SessionEvent; result: SessionEvent } {
  const call = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: ToolCallId(callId),
    name: 'advise',
    arguments: JSON.stringify({ severity, note }),
  })
  const result = appendToolResult(session, callId, 'recorded')
  return { call, result }
}

/** Flush microtasks and timers so fire-and-forget async runtime work settles. */
export async function flush(times = 24): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
}

/** Extract the text of a fake agent's followup/steer/inject message argument. */
export function messageText(message: UserMessage): string {
  const block = message.content[0]
  if (block === undefined) return ''
  if (block.type === 'text') return block.text
  return ''
}

/** Whether a message is an advisory delivery. */
export function isAdvisory(message: UserMessage, severity: string): boolean {
  return messageText(message).includes(`<advisory severity="${severity}"`)
}

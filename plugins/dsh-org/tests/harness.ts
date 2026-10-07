/**
 * Local test harness: a fake cordis context over REAL dsh-session sessions
 * (real append validation) plus fake agent scopes that record the composition
 * calls a role envelope makes. Deliberately self-contained — it imports no
 * other plugin package's test helpers.
 */

import { vi, type Mock } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/** One registered event listener. */
export type Listener = (...args: unknown[]) => unknown

/** Sessions already routed onto the fake bus (a second connect only re-registers). */
const CONNECTED = new WeakSet<Session>()

/** The allow-list of the first recorded `restrict` call (narrowed, never assumed). */
export function allowList(spy: Mock): readonly string[] {
  const filter: unknown = spy.mock.calls[0]?.[0]
  if (typeof filter !== 'object' || filter === null || !('allow' in filter)) {
    throw new Error('restrict was not called with an allow list')
  }
  const { allow } = filter
  if (!Array.isArray(allow) || !allow.every(name => typeof name === 'string')) {
    throw new Error('the restrict allow list is not a string array')
  }
  return allow
}

/** The tool names registered through one spy, in registration order. */
export function registeredNames(spy: Mock): string[] {
  return spy.mock.calls.map((call) => {
    const definition: unknown = call[0]
    if (typeof definition !== 'object' || definition === null || !('name' in definition)) {
      throw new Error('a registered tool definition carries no name')
    }
    const { name } = definition
    if (typeof name !== 'string') throw new Error('a registered tool name is not a string')
    return name
  })
}

/** A lead created through the fake agent factory. */
export interface CreatedLead {
  sessionId: string
  agent: Agent
  agentCtx: FakeAgentCtx
  dispose: Mock
}

/** The composition surface a role envelope touches on one agent scope. */
export class FakeAgentCtx {
  readonly restrictSpy = vi.fn()
  readonly registerSpy = vi.fn()
  readonly sectionSpy = vi.fn()
  readonly listeners = new Map<string, Listener[]>()
  /** Every effect this scope was asked to unwind, in disposal order. */
  readonly disposed: string[] = []

  constructor(private readonly toolNames: readonly string[]) {}

  get(name: string): unknown {
    void name
    return undefined
  }

  readonly tools = {
    schemas: (): { name: string }[] => this.toolNames.map(name => ({ name })),
    restrict: (filter: { allow?: readonly string[] }) => {
      this.restrictSpy(filter)
      return () => { this.disposed.push('restrict') }
    },
    register: (definition: { name: string }) => {
      this.registerSpy(definition)
      return () => { this.disposed.push(`tool:${definition.name}`) }
    },
  }

  readonly systemPrompt = {
    section: (section: { name: string; order: number; text: string }) => {
      this.sectionSpy(section)
      return () => { this.disposed.push(`section:${section.name}`) }
    },
  }

  on(event: string, listener: Listener): () => void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return () => { this.disposed.push(`listener:${event}`) }
  }
}

/** Fake cordis context: session/agent registries, event bus, and registrations. */
export class FakeCtx {
  readonly listeners = new Map<string, Listener[]>()
  readonly sessionsById = new Map<string, Session>()
  readonly agentsById = new Map<string, Agent>()
  readonly created: CreatedLead[] = []
  readonly provides = new Map<string, unknown>()
  readonly logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  readonly reflect = { provide: vi.fn() }
  /** Inherited tool names handed to a composed lead scope. */
  leadToolNames: readonly string[] = ['read', 'read_image', 'glob', 'grep', 'lsp', 'write', 'edit', 'bash', 'subtask_parallel', 'peer_send', 'task_list', 'ask_question']

  /**
   * Register a real session and route its appends onto the fake bus, so the
   * organisation service folds live mutations exactly as it would under a
   * session store's publication hooks.
   */
  connectSession(session: Session): void {
    if (!CONNECTED.has(session)) {
      CONNECTED.add(session)
      // `append` is generic in the event key, so the rebound edge forwards the
      // erased signature verbatim; the prototype's own method is the target.
      const original = Object.getPrototypeOf(session) as { append: (...args: unknown[]) => SessionEvent }
      const append = original.append.bind(session)
      Object.defineProperty(session, 'append', {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          const event = append(...args)
          this.emit('session/event', session, event)
          return event
        },
      })
    }
    this.sessionsById.set(String(session.id), session)
  }

  /** Build and register a real session plus a fake agent; `toolNames` also binds a fake agent scope. */
  addAgent(id: string, toolNames?: readonly string[]): { session: Session; agent: Agent; agentCtx: FakeAgentCtx | undefined } {
    const session = Session.create(SessionId(id))
    this.connectSession(session)
    const agentCtx = toolNames === undefined ? undefined : new FakeAgentCtx(toolNames)
    const agent = makeAgent(id, session, agentCtx)
    this.agentsById.set(id, agent)
    return { session, agent, agentCtx }
  }

  get sessions(): {
    list: () => Session[]
    get: (id: SessionId) => Session | undefined
    create: (id: SessionId) => Session
  } {
    return {
      list: () => [...this.sessionsById.values()],
      get: (id: SessionId) => this.sessionsById.get(String(id)),
      create: (id: SessionId) => {
        const session = Session.create(id)
        this.connectSession(session)
        return session
      },
    }
  }

  get agents(): {
    list: () => Agent[]
    get: (id: SessionId) => Agent | undefined
    create: (options: {
      sessionId: SessionId
      meta?: { cwd?: string }
      setup?: (agentCtx: FakeAgentCtx, agent: Agent) => unknown
    }) => Promise<{ agent: Agent; dispose: () => Promise<void> }>
  } {
    return {
      list: () => [...this.agentsById.values()],
      get: (id: SessionId) => this.agentsById.get(String(id)),
      create: async (options) => {
        const session = Session.create(options.sessionId)
        this.connectSession(session)
        const agent = makeAgent(String(options.sessionId), session)
        const agentCtx = new FakeAgentCtx(this.leadToolNames)
        options.setup?.(agentCtx, agent)
        this.agentsById.set(String(options.sessionId), agent)
        const dispose = vi.fn(async () => {})
        this.created.push({ sessionId: String(options.sessionId), agent, agentCtx, dispose })
        return { agent, dispose }
      },
    }
  }

  on(event: string, listener: Listener): () => void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return () => {}
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  get(name: string): unknown {
    return this.provides.get(name)
  }

  /** The controller's optional-inject pattern: hand this context to the callback. */
  inject(_services: string[], callback: (ctx: Context) => void): void {
    callback(this as unknown as Context)
  }
}

/** Build a plain fake agent over a real session; `agentCtx` backs its scope when given. */
export function makeAgent(id: string, session: Session, agentCtx?: FakeAgentCtx): Agent {
  return {
    id: SessionId(id),
    session,
    status: 'idle',
    options: {},
    inbox: { nextTurn: [], nextStep: [] },
    ctx: agentCtx ?? { get: () => undefined },
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    runMaintenance: vi.fn(),
    send: vi.fn(),
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
  } as unknown as Agent
}

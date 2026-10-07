/**
 * Local test harness — deliberately local (never import another package's
 * harness). It fakes only the cordis seams `dsh-peers` probes: `on`/`emit`,
 * the service properties `sessions`/`agents`/`tools`/`sessionProjections`,
 * `get` (including the `org` probe), `inject`, `reflect.provide` (the one
 * member `Service`'s constructor calls), and `logger`. Sessions are real
 * objects so appends get real validation.
 *
 * @module @dsh-plugin/dsh-peers/tests/fake-context
 */

import { vi, type Mock } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OrgForbiddenProbe } from '../src/types.ts'

/** One listener registration on the fake context. */
export type Listener = (...args: unknown[]) => unknown

/** A projection unit as the harness sees it (opaque besides its key). */
export interface RegisteredProjection {
  key: string
}

/** A real-`Agent`-shaped fake whose delivery methods are typed mocks. */
export type FakeAgent = Agent & {
  readonly followup: Mock<(message: UserMessage) => void>
  readonly steer: Mock<(message: UserMessage) => void>
  readonly inject: Mock<(message: UserMessage) => void>
}

/** Fake cordis context exposing exactly the seams the plugin probes. */
export class FakeContext {
  readonly listeners = new Map<string, Listener[]>()
  readonly sessionMap = new Map<string, Session>()
  readonly agentMap = new Map<string, Agent>()
  readonly registeredTools: ToolDefinition[] = []
  readonly registeredProjections: RegisteredProjection[] = []
  orgProbe: OrgForbiddenProbe | undefined
  readonly logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  /** Services registered through `reflect.provide` (the only `reflect` member `Service`'s constructor calls). */
  readonly provided = new Map<string, unknown>()
  readonly reflect = { provide: (name: string, service: unknown): void => { this.provided.set(name, service) } }

  readonly sessions = {
    get: (id: SessionId): Session | undefined => this.sessionMap.get(String(id)),
    list: (): Session[] => [...this.sessionMap.values()],
  }

  readonly agents = {
    get: (id: SessionId): Agent | undefined => this.agentMap.get(String(id)),
    list: (): Agent[] => [...this.agentMap.values()],
  }

  readonly tools = {
    register: (definition: ToolDefinition): (() => void) => { this.registeredTools.push(definition); return () => {} },
  }

  readonly sessionProjections = {
    register: (definition: RegisteredProjection): (() => void) => { this.registeredProjections.push(definition); return () => {} },
  }

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
    for (const listener of [...this.listeners.get(event) ?? []]) listener(...args)
  }

  get(serviceName: string): unknown {
    switch (serviceName) {
      case 'sessions':
        return this.sessions
      case 'agents':
        return this.agents
      case 'tools':
        return this.tools
      case 'sessionProjections':
        return this.sessionProjections
      case 'org':
        return this.orgProbe
      default:
        return undefined
    }
  }

  inject(deps: readonly string[], callback: (ctx: FakeContext) => unknown): unknown {
    if (deps.some(dep => this.get(dep) === undefined)) return undefined
    return callback(this)
  }
}

/**
 * Build a fake agent over a real session.
 * @param id - the agent/session id.
 * @param session - the agent's real session.
 * @returns an agent-shaped object with spy `followup`/`steer`/`inject`.
 */
export function makeFakeAgent(id: string, session: Session): FakeAgent {
  // The harness supplies only the runtime face the plugin touches; the rest of
  // the Agent contract is loop-owned and never read here.
  return {
    id: SessionId(id),
    session,
    status: 'idle',
    followup: vi.fn<(message: UserMessage) => void>(),
    steer: vi.fn<(message: UserMessage) => void>(),
    inject: vi.fn<(message: UserMessage) => void>(),
    whenIdle: async () => {},
  } as unknown as FakeAgent
}

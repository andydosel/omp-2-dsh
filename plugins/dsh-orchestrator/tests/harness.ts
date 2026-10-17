/**
 * Shared orchestrator test harness: a bare cordis Context with the mocked
 * services the runtime touches (`agents`, `goals`, `subagents`), fake live
 * agents backed by REAL Sessions (so `session.header` walking and
 * `delegationDepthOf` behave), and a scripted `SubTaskDispatcher`.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubTaskDispatcher, SubTaskOutcome, SubTaskRequest } from '../src/dispatch.ts'
import type { ResolvedOrchestratorConfig, OrchestratorConfig } from '../src/config.ts'
import { resolveConfig } from '../src/config.ts'
import { OrchestratorRuntime } from '../src/runtime.ts'

/** A fake live agent with a real Session and the tool masks applied to its scope. */
export interface FakeAgent extends Agent {
  session: Session
  /** Every `tools.restrict({allow})` this agent's scope received, in order. */
  readonly restricts: string[][]
}

/** Create one fake live agent (optionally a delegable child of another, with a cwd). */
export function makeAgent(id: string, parent?: FakeAgent, cwd?: string): FakeAgent {
  const depth = parent === undefined ? 0 : (parent.session.header.delegationDepth ?? 0) + 1
  // A child session is a header override on a fresh log (the dsh test recipe):
  // the header is the authoritative depth/parent source `delegationDepthOf` and
  // the runtime's root walk read.
  const base = Session.create(SessionId(id))
  const session = parent === undefined && cwd === undefined
    ? base
    : Session.create(SessionId(id), [], {
      ...base.header,
      ...cwd === undefined ? {} : { cwd },
      ...parent === undefined ? {} : {
        parentSession: parent.id,
        isSeeded: false,
        origin: 'subagent' as const,
        delegationDepth: depth,
      },
    })
  const restricts: string[][] = []
  return {
    id: SessionId(id),
    session,
    restricts,
    options: parent === undefined ? {} : { subagentDepth: depth },
    status: 'idle',
    // A bare probe: the advisor's shared reviewer helper reads delegated policy
    // through `agent.ctx.get(...)`, which resolves to nothing here. The tools
    // seam lets the worker-spawn base restrict a dispatched child's scope.
    ctx: {
      get: () => undefined,
      tools: {
        restrict: (filter: { allow?: readonly string[] }) => {
          restricts.push([...(filter.allow ?? [])])
          return () => {}
        },
      },
    } as unknown as Context,
  } as unknown as FakeAgent
}

/** The goal record one mock goal view carries. */
export interface MockGoalView {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason?: { code: string; message: string }
  maxGoalRounds: number
  roundsStarted: number
  createdAt: number
  updatedAt: number
  activation: 'armed' | 'disarmed'
}

/** One recorded goal-service interaction. */
export interface GoalCall {
  readonly op: 'create' | 'get' | 'complete' | 'block' | 'resume' | 'disarm'
  readonly agentId: string
  readonly detail?: unknown
}

/** A minimal goal service recording its interactions while holding one goal per session. */
export class MockGoals {
  readonly calls: GoalCall[] = []
  readonly views = new Map<string, MockGoalView>()
  /** When set, the NEXT mutating call throws it (a failing goal service). */
  failNext: Error | undefined

  private guard(): void {
    if (this.failNext === undefined) return
    const failure = this.failNext
    this.failNext = undefined
    throw failure
  }

  private require(agent: Agent): MockGoalView {
    const view = this.views.get(agent.id)
    if (view === undefined) throw new Error(`mock goal service: no goal for ${agent.id}`)
    return view
  }

  get(agent: Agent): MockGoalView | undefined {
    this.calls.push({ op: 'get', agentId: agent.id })
    return this.views.get(agent.id)
  }

  create(agent: Agent, request: { objective: string; maxGoalRounds?: number }): MockGoalView {
    this.calls.push({ op: 'create', agentId: agent.id, detail: request })
    this.guard()
    const view: MockGoalView = {
      id: `goal-${agent.id}`,
      revision: 1,
      objective: request.objective,
      phase: 'active',
      maxGoalRounds: request.maxGoalRounds ?? 256,
      roundsStarted: 0,
      createdAt: 1,
      updatedAt: 1,
      activation: 'armed',
    }
    this.views.set(agent.id, view)
    return view
  }

  complete(agent: Agent, ref: { id: string; revision: number }): MockGoalView {
    this.calls.push({ op: 'complete', agentId: agent.id, detail: ref })
    this.guard()
    const view = this.require(agent)
    view.phase = 'complete'
    view.revision = ref.revision + 1
    view.activation = 'disarmed'
    return view
  }

  block(agent: Agent, ref: { id: string; revision: number }, reason: { code: string; message: string }): MockGoalView {
    this.calls.push({ op: 'block', agentId: agent.id, detail: reason })
    this.guard()
    const view = this.require(agent)
    view.phase = 'blocked'
    view.revision = ref.revision + 1
    view.blockedReason = reason
    view.activation = 'disarmed'
    return view
  }

  resume(agent: Agent, ref: { id: string; revision: number }): MockGoalView {
    this.calls.push({ op: 'resume', agentId: agent.id, detail: ref })
    this.guard()
    const view = this.require(agent)
    view.phase = 'active'
    view.revision = ref.revision + 1
    view.activation = 'armed'
    return view
  }

  disarm(agent: Agent): MockGoalView | undefined {
    this.calls.push({ op: 'disarm', agentId: agent.id })
    return this.views.get(agent.id)
  }

  /** The mutation ops recorded so far, in order. */
  ops(): string[] {
    return this.calls.map(call => call.op)
  }
}

/** A scripted sub-task dispatcher: one queued outcome per dispatch, in order. */
export class ScriptedDispatcher implements SubTaskDispatcher {
  readonly requests: SubTaskRequest[] = []
  /** Queued overrides, consumed in dispatch order. */
  readonly script: Array<Partial<SubTaskOutcome>> = []
  /** Set to make every dispatch throw (a broken dispatcher). */
  throws: Error | undefined
  disposed = false

  /** Queue one completed reviewer outcome carrying the given findings. */
  queueFindings(findings: SubTaskOutcome['findings']): void {
    this.script.push({ role: 'reviewer', status: 'completed', findings })
  }

  async dispatch(request: SubTaskRequest, _signal: AbortSignal): Promise<SubTaskOutcome> {
    const index = this.requests.length
    this.requests.push(request)
    if (this.throws !== undefined) throw this.throws
    const scripted = this.script[index] ?? {}
    return {
      role: request.role,
      status: 'completed',
      output: `output-${index + 1}`,
      ...scripted,
    } as SubTaskOutcome
  }

  dispose(): void {
    this.disposed = true
  }
}

/** The whole harness: a context, agents, goals, and the runtime under test. */
export interface Harness {
  readonly ctx: Context
  readonly goals: MockGoals
  readonly runtime: OrchestratorRuntime
  readonly config: ResolvedOrchestratorConfig
  readonly dispatcher: ScriptedDispatcher
  readonly sent: Array<{ senderId: string; targetId: string; text: string }>
  readonly starts: Array<{ provider: string; label: string; prompt: string; parentId: string }>
  /** The child id the mocked subagent provider hands back on the next spawn. */
  setNextChildId(id: string): void
  addAgent(agent: FakeAgent): FakeAgent
}

/** Build the harness (config overrides merge over the deployment defaults). */
export function makeHarness(config: OrchestratorConfig = {}): Harness {
  const ctx = new Context()
  const goals = new MockGoals()
  const live = new Map<string, Agent>()
  const sent: Harness['sent'] = []
  const starts: Harness['starts'] = []
  const dispatcher = new ScriptedDispatcher()
  let childId = 'carrier-1'

  ctx.provide('agents', { get: (id: SessionId) => live.get(id) } as never)
  ctx.provide('goals', goals as never)
  ctx.provide('subagents', {
    sendMessage: async (sender: Agent, targetId: SessionId, content: readonly ContentBlock[]) => {
      const text = content.map(block => (block.type === 'text' ? block.text : '')).join('')
      sent.push({ senderId: sender.id, targetId, text })
      return 'message-1'
    },
    startActivation: async (spec: {
      provider: string
      label: string
      request: { prompt: readonly ContentBlock[]; parent: Agent }
    }) => {
      const prompt = spec.request.prompt.map(block => (block.type === 'text' ? block.text : '')).join('')
      starts.push({ provider: spec.provider, label: spec.label, prompt, parentId: spec.request.parent.id })
      return { childId: SessionId(childId), messageId: 'message-1', dispose: async () => {} }
    },
  } as never)

  const resolved = resolveConfig(config)
  const runtime = new OrchestratorRuntime(ctx, resolved, () => dispatcher)

  return {
    ctx,
    goals,
    runtime,
    config: resolved,
    dispatcher,
    sent,
    starts,
    setNextChildId(id: string): void {
      childId = id
    },
    addAgent(agent: FakeAgent): FakeAgent {
      live.set(agent.id, agent)
      return agent
    },
  }
}

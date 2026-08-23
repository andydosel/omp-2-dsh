/**
 * Shared vibe-mode test harness: real SystemPrompt/ToolRuntime/CommandRuntime,
 * real Sessions and scoped agent.ctx, and a mock subagents provider. Mirrors
 * the plan-mode unit harness so mode state, tools, and narrowing are exercised
 * against the real services without any API key.
 */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, createAssistantMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Session, SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import VibeModeController from '../src/mode.ts'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { VibeModeConfig } from '../src/index.ts'

export const VIBE_CONFIG: VibeModeConfig = {
  section: 'You are the DIRECTOR. Delegate work to workers with vibe_spawn; collect results with vibe_wait.',
  readOnlyTools: ['read', 'glob', 'grep', 'read_image', 'todo_write'],
  provider: 'spawn',
  tiers: {
    fast: { provider: 'mock', model: 'fast-model' },
    good: { provider: 'mock', model: 'good-model' },
  },
  waitTimeoutMs: 5_000,
  maxWaitTimeoutMs: 10_000,
  maxConsecutiveWakes: 2,
}

/** A mock `ctx.subagents` recording every call. */
export class MockSubagents {
  readonly spawnCalls: Array<{ provider: string; label: string; promptText: string; agentOptions?: { provider?: string; model?: string } }> = []
  readonly followupCalls: Array<{ childId: string; text: string }> = []
  readonly interruptCalls: string[] = []
  readonly drainCalls: string[][] = []
  private readonly children = new Map<string, SubagentListEntry>()
  private nextId = 1

  constructor(ids: string[] = []) {
    for (const id of ids) this.addChild(id)
  }

  addChild(id: string, label = 'worker'): void {
    this.children.set(id, {
      kind: 'child',
      id: SessionId(id),
      activity: 'running',
      hasChildren: false,
      mode: 'continuable',
      label,
    })
  }

  /** Emit a fake `subagent-settled` notice for the director (wake-guard test). */
  claimSettled(ctx: Context, director: Agent): void {
    ctx.emit('agent/inbox/claimed', {
      agent: director,
      message: createUserMessage({
        content: [{ type: 'text', text: 'worker settled' }],
        source: { kind: 'subagent-settled', form: 'notice', summary: 'worker settled', senderSessionId: SessionId('child-1') },
      }),
      turn: 1,
    })
  }

  claimUser(ctx: Context, director: Agent): void {
    ctx.emit('agent/inbox/claimed', {
      agent: director,
      message: createUserMessage({ content: [{ type: 'text', text: 'user message' }], source: { kind: 'user' } }),
      turn: 1,
    })
  }

  async startContinuable(spec: { provider: string; label: string; request: { prompt: Array<{ type: string; text: string }>; parent: Agent; agentOptions?: { provider?: string; model?: string } } }): Promise<{ childId: SessionId; messageId: string }> {
    const id = `child-${this.nextId++}`
    this.children.set(id, { kind: 'child', id: SessionId(id), activity: 'running', hasChildren: false, mode: 'continuable', label: spec.label })
    this.spawnCalls.push({
      provider: spec.provider,
      label: spec.label,
      promptText: spec.request.prompt[0]?.text ?? '',
      agentOptions: spec.request.agentOptions,
    })
    return { childId: SessionId(id), messageId: `msg-${id}` }
  }

  async followup(
    _parent: Agent,
    childId: string,
    content: Array<{ type: string; text: string }>,
  ): Promise<string> {
    this.followupCalls.push({ childId, text: content[0]?.text ?? '' })
    return `msg-f-${childId}`
  }

  interrupt(targetSessionId: string, _authority: { kind: 'ancestor'; agent: Agent }): void {
    this.interruptCalls.push(targetSessionId)
  }

  async drainContinuableDescendants(parents: readonly Agent[]): Promise<void> {
    this.drainCalls.push(parents.map(agent => agent.id))
  }

  async listChildren(_parentSessionId: string): Promise<SubagentListEntry[]> {
    return [...this.children.values()]
  }
}

/** Mount the real services plus a mock subagents provider. */
export async function setup(mock: MockSubagents, config: VibeModeConfig = VIBE_CONFIG): Promise<Context> {
  return setupCtx(mock, config, false)
}

/** Like setup, but with a memory settings provider mounted before the vibe plugin. */
export async function setupWithSettings(
  mock: MockSubagents,
  config: VibeModeConfig = VIBE_CONFIG,
  doc: Record<string, unknown> = {},
): Promise<Context> {
  return setupCtx(mock, config, true, doc)
}

async function setupCtx(
  mock: MockSubagents,
  config: VibeModeConfig,
  withSettings: boolean,
  doc: Record<string, unknown> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionStore)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  if (withSettings) await ctx.plugin(MemorySettings, doc)
  ctx.provide('subagents', mock as never)
  await ctx.plugin(VibeModeController, config)
  for (const name of ['read', 'glob', 'grep', 'read_image', 'todo_write', 'write', 'bash']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `test tool ${name}`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
  return ctx
}

/**
 * Create a fake agent carrying a real Session and a real scoped `agent.ctx`
 * (through `createScope`, so scoped tool/restrict/section registrations
 * behave exactly as in the loop).
 */
export async function agentWithSession(
  ctx: Context,
  id = 'director-1',
  { active }: { active?: boolean } = {},
): Promise<Agent & { session: Session }> {
  const session = Session.create(SessionId(id))
  const agent = {
    id: SessionId(id),
    session,
    options: {},
    status: 'idle',
    inject(message: UserMessage) {
      session.append('user/message', message, { surfaceOp: 'append' })
    },
    // Completion self-delivery sink: records steered notices for assertions.
    steered: [] as UserMessage[],
    steer(message: UserMessage) {
      ;(agent as unknown as { steered: UserMessage[] }).steered.push(message)
    },
  } as unknown as Agent & { session: Session }
  let scoped!: Context
  await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, {
    inject: ['tools', 'systemPrompt'],
  }))
  ;(agent as { ctx?: Context }).ctx = scoped
  if (active !== undefined) session.append('vibe/mode', { active })
  const agents = ctx.get('agents')
  if (agents === undefined) {
    ctx.emit('agent/created', { agent })
  } else {
    agents.enter(agent, undefined)
    agents.announce(agent)
  }
  return agent
}

/** Assemble exactly as the loop does: the agent is both subject and scope. */
export function assembleFor(ctx: Context, agent: Agent) {
  return ctx.systemPrompt.assemble({ agent, scope: agent })
}
/** The names visible to one agent's catalog (native presentation). */
export function visibleToolNames(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name)
}

/** Dispatch pre-step processing and optionally its following step-start commit. */
export async function boundary(ctx: Context, agent: Agent & { session: Session }, type: 'pre-step' | 'step-start'): Promise<void> {
  const events = agentEvents(ctx, agent)
  const message = createUserMessage({
    content: [{ type: 'text', text: 'boundary probe' }],
    source: { kind: 'user' },
  })
  const signal = new AbortController().signal
  const decision = await events.waterfall(
    'agent/pre-step',
    { messages: [message], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages.slice(1)) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
  if (type === 'step-start') {
    const event = agent.session.append('step/start', { turn: 1, step: 1 })
    ctx.emit('session/event', agent.session, event)
  }
}

/** Open a turn so a selection queues for the boundary flush (the mid-turn shape). */
export function openTurn(session: Session, turn = 0): void {
  session.append('turn/start', { turn })
}

/** Close the open turn (the between-turns shape: selections commit immediately). */
export function closeTurn(session: Session, turn = 0): void {
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append a minimal `request/header` snapshot so the log has a "what the model was told" anchor. */
export function header(session: Session): void {
  session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' } }, reason: 'initial' })
}

export function noticeTexts(session: Session): string[] {
  return session.events
    .filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
    .map(event => (event.data as { content: { type: string; text?: string }[] }).content.map(block => block.text ?? '').join(''))
}

/** Append a complete child turn to a bare Session (for `finalAssistantOutput` reads). */
export function childTurn(session: Session, turn: number, outputText: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `prompt for turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const message = createAssistantMessage({
    content: [{ type: 'text', text: outputText }],
    source: { provider: 'mock', model: 'mock' },
  })
  session.append('assistant/message', { turn, step: 1, message }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** In-memory settings provider fixture (mirror of the settings package test fixture). */
export class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, doc: Record<string, unknown> = {}) {
    super(ctx)
    this.doc = structuredClone(doc)
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected async persist(ns: string, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
  }
}

export function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

/**
 * A minimal `ToolRunContext` for driving a registered tool body directly
 * (callId/name/arguments/signal/deferContext/concludeTurn are the execution
 * surface the loop fills; tests only need agent + signal).
 */
export function testExec(agent: Agent, overrides: Partial<{ signal: AbortSignal; arguments: unknown }> = {}) {
  return {
    agent,
    signal: overrides.signal ?? new AbortController().signal,
    callId: 'test-call',
    rootCallId: undefined,
    name: 'test-tool',
    arguments: overrides.arguments ?? {},
    token: undefined,
    deferContext: () => {},
    concludeTurn: () => {},
  } as never
}

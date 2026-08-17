/**
 * Peer → dsh agent session mapping.
 *
 * Each WeChat peer maps to one stable dsh session id (our choice, stable per
 * peer): `weixin:dm:{userId}` / `weixin:group:{chatId}[:thread][:userId]`.
 * The plugin is a protocol driver: inbound messages become
 * `agent.followup(createUserMessage(...))`, and agent output is observed via
 * the `session/event` firehose (assistant/message → outbound; turn/start →
 * typing start; turn/end → typing stop) — the same pattern the ACP bridge
 * (`@deepseek-ai/dsh-acp`) uses.
 * @module @dsh-plugin/dsh-channel-wechat/session-map
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'

/** Build the peer-stable session key (group rules mirror hermes `build_session_key`). */
export function sessionKeyForPeer(
  chatType: 'dm' | 'group',
  chatId: string,
  senderId: string,
  message: Record<string, unknown>,
  options: { groupSessionsPerUser: boolean; threadSessionsPerUser: boolean },
): string {
  if (chatType === 'dm') return `weixin:dm:${chatId}`
  const parts = [`weixin:group:${chatId}`]
  const threadId = String(message['thread_id'] ?? '').trim()
  if (threadId) parts.push(threadId)
  let isolateUser = options.groupSessionsPerUser
  if (threadId && !options.threadSessionsPerUser) isolateUser = false
  if (isolateUser && senderId) parts.push(senderId)
  return parts.join(':')
}

/** Event hooks the plugin wires to the platform adapter. */
export interface SessionObservationHooks {
  /** Render one assembled assistant message (final-only; WeChat can't edit). */
  onAssistantMessage: (sessionId: SessionId, text: string) => void | Promise<void>
  /** Inbound turn started → sendtyping start. */
  onTurnStart: (sessionId: SessionId) => void | Promise<void>
  /** Turn settled → sendtyping stop. */
  onTurnEnd: (sessionId: SessionId) => void | Promise<void>
}

/**
 * Owns the live dsh agents for WeChat peers: create/resume per peer with a
 * stable session id, followup delivery, and `session/event` observation for
 * outbound rendering.
 */
export class WeChatSessionManager {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly sessionIds = new Set<SessionId>()
  private readonly disposeSessionEvent: () => void

  constructor(
    private readonly ctx: Context,
    private readonly hooks: SessionObservationHooks,
    private readonly agentOptions: AgentOptions = {},
  ) {
    this.disposeSessionEvent = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (!this.sessionIds.has(session.id)) return
      switch (event.type) {
        case 'assistant/message': {
          const text = renderAssistantText(event.data.message)
          if (text) void this.hooks.onAssistantMessage(session.id, text)
          break
        }
        case 'turn/start':
          void this.hooks.onTurnStart(session.id)
          break
        case 'turn/end':
          void this.hooks.onTurnEnd(session.id)
          break
        default:
          break
      }
    })
  }

  /** The live agent for a peer key, if any. */
  liveAgent(peerKey: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(peerKey))
  }

  /**
   * Resolve (get → resume → create) the agent for a peer and deliver the
   * inbound text as a user message.
   */
  async followup(peerKey: string, text: string): Promise<void> {
    const agent = await this.resolveAgent(peerKey)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(message)
  }

  /** Get the live agent, or resume/create it under the plugin's ownership. */
  async resolveAgent(peerKey: string): Promise<Agent> {
    const existing = this.ctx.agents.get(SessionId(peerKey))
    if (existing !== undefined) return existing

    const handle = await this.acquire(peerKey)
    return handle.agent
  }

  private async acquire(peerKey: string): Promise<AgentHandle> {
    const sessionId = SessionId(peerKey)
    // Resume first: loads the persisted per-peer history when session
    // persistence is mounted (dsh-session-persistence-*).
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions,
      })
      this.register(peerKey, handle)
      return handle
    } catch {
      // No persistence backend, or the session does not exist yet → create.
    }
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions,
    })
    this.register(peerKey, handle)
    return handle
  }

  private register(peerKey: string, handle: AgentHandle): void {
    this.handles.set(peerKey, handle)
    this.sessionIds.add(handle.agent.session.id)
  }

  /** Number of live per-peer agents. */
  get size(): number {
    return this.handles.size
  }

  /** All managed session ids. */
  managedSessionIds(): readonly SessionId[] {
    return [...this.sessionIds]
  }

  /** Tear down every owned agent (plugin dispose). */
  async dispose(): Promise<void> {
    this.disposeSessionEvent()
    const handles = [...this.handles.values()]
    this.handles.clear()
    this.sessionIds.clear()
    await Promise.allSettled(handles.map((handle) => handle.dispose()))
  }
}

/** Extract the user-visible text of an assistant message (text blocks joined). */
export function renderAssistantText(message: { content: readonly { type: string; text?: string }[] }): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Shared question-board test harness: real `Session` objects (so the durable
 * append + fold are exercised with event validation) and a recording fake
 * agent for the delivery seam.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { applyQuestionEvent } from '../src/board.ts'
import type { QuestionBoardHost } from '../src/service.ts'
import type { QuestionSnapshot } from '../src/types.ts'

/** A fake agent that records every delivered message. */
export interface RecordingAgent extends Agent {
  readonly steered: UserMessage[]
  readonly followedUp: UserMessage[]
  readonly injected: UserMessage[]
}

/** Build a fake agent at a lifecycle status, recording steer/followup/inject. */
export function recordingAgent(id: string, status: Agent['status']): RecordingAgent {
  const agent = {
    id: SessionId(id),
    status,
    steered: [] as UserMessage[],
    followedUp: [] as UserMessage[],
    injected: [] as UserMessage[],
    steer(message: UserMessage) { agent.steered.push(message) },
    followup(message: UserMessage) { agent.followedUp.push(message) },
    inject(message: UserMessage) { agent.injected.push(message) },
  } as unknown as RecordingAgent
  return agent
}

/** A host whose folded board is `applyQuestionEvent` over the session's own log. */
export function foldingHost(agents: ReadonlyMap<string, Agent> = new Map()): QuestionBoardHost {
  return {
    agent: sessionId => agents.get(sessionId),
    board: session => session.snapshotEvents().reduce<QuestionSnapshot[]>(applyQuestionEvent, []),
  }
}

/** Create a session whose header marks it as a delegated subagent child. */
export function subagentSession(id = 'child'): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: 1,
  })
}

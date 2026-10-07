/**
 * Shared worker-spawn test harness: real Sessions and a fake spawning Agent,
 * plus recording sinks. The registry needs nothing else — `childSessionEvents`
 * degrades to `undefined` when no `agents`/`sessions` service is mounted.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { WorkerView } from '../src/types.ts'
import { WorkerRegistry } from '../src/workers.ts'

/** A fake spawning agent carrying a real Session and recording steered notices. */
export interface TestSpawner extends Agent {
  session: Session
  steered: UserMessage[]
}

/** Create a fake spawning agent with a real session. */
export function makeSpawner(id = 'spawner-1'): TestSpawner {
  const session = Session.create(SessionId(id))
  const agent = {
    id: SessionId(id),
    session,
    options: {},
    status: 'idle',
    inject: (message: UserMessage) => {
      session.append('user/message', message, { surfaceOp: 'append' })
    },
    steered: [] as UserMessage[],
    steer(message: UserMessage) {
      ;(agent as unknown as TestSpawner).steered.push(message)
    },
  } as unknown as TestSpawner
  return agent
}

/** A registry plus the roster snapshots its sink recorded. */
export interface Harness {
  readonly registry: WorkerRegistry
  readonly rosters: WorkerView[][]
  /** The most recent roster snapshot (undefined before the first emission). */
  last(): WorkerView[] | undefined
}

/** Build a registry whose roster sink records every published snapshot. */
export function makeHarness(ctx: Context, spawner: TestSpawner, wakeBudget = 2): Harness {
  const rosters: WorkerView[][] = []
  const registry = new WorkerRegistry(ctx, spawner, wakeBudget, (workers) => {
    rosters.push(workers)
  })
  return { registry, rosters, last: () => rosters.at(-1) }
}

/** Emit a fake `subagent-settled` claim for the spawning agent (wake-budget spend). */
export function claimSettled(ctx: Context, spawner: TestSpawner): void {
  ctx.emit('agent/inbox/claimed', {
    agent: spawner,
    message: createUserMessage({
      content: [{ type: 'text', text: 'worker settled' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'worker settled', senderSessionId: SessionId('child-1') },
    }),
    turn: 1,
  })
}

/** Emit a fake user-authored claim for the spawning agent (wake-budget reset). */
export function claimUser(ctx: Context, spawner: TestSpawner): void {
  ctx.emit('agent/inbox/claimed', {
    agent: spawner,
    message: createUserMessage({ content: [{ type: 'text', text: 'user message' }], source: { kind: 'user' } }),
    turn: 1,
  })
}

/** Append one complete child turn to a session (for turn/end waits and output reads). */
export function childTurn(session: Session, turn: number, outputText: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `prompt for turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: outputText }],
      source: { provider: 'mock', model: 'mock' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

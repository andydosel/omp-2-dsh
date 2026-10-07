/**
 * Shared task-board test harness: a real host stack (system prompt, tool
 * runtime, agent registry, session store, projection registry, and the plugin
 * itself) so every test drives the durable append → fold → work-set path end
 * to end instead of a stub fold.
 */

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionStore, type Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { TaskBoardService, type TaskBoardConfig } from '../src/service.ts'
import { EMPTY_TASK_BOARD, applyTaskEvent } from '../src/projection.ts'
import type { TaskBoardState } from '../src/types.ts'

/** A mounted plugin plus its live session. */
export interface BoardHarness {
  /** Root context with the whole stack mounted. */
  readonly ctx: Context
  /** The service under test (also reachable as `ctx.taskBoard`). */
  readonly board: TaskBoardService
  /** A live, publishing session. */
  readonly session: Session
}

let sessionCounter = 0

/** Mount the stack and create one live session that publishes `session/event`. */
export async function boardHarness(config: TaskBoardConfig = {}): Promise<BoardHarness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TaskBoardService, config)
  sessionCounter += 1
  const session = ctx.sessions.create(SessionId(`board-${sessionCounter}`))
  return { ctx, board: ctx.taskBoard, session }
}

/**
 * The minimal Agent face a direct `ctx.tools.execute()` needs (the real loop
 * supplies it), optionally carrying an agent-scoped context for the prompt
 * section tests — the cast is the documented seam for a partial Agent.
 */
export function fakeAgent(session: Session, id = 'fake-agent', agentCtx?: Context): Agent {
  return { id: SessionId(id), session, ...agentCtx === undefined ? {} : { ctx: agentCtx } } as unknown as Agent
}

/** The board a session's log folds to, independent of the registry (replay check). */
export function foldedBoard(session: Session): TaskBoardState {
  return session.snapshotEvents().reduce(applyTaskEvent, EMPTY_TASK_BOARD)
}

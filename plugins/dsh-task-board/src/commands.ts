/**
 * `/task` commands: `list | close <id> | reopen <id> | focus <id> | unfocus <id>`.
 *
 * The model-facing `task_*` tools are the coordinator's surface; `/task` is the
 * USER's surface — it is what the Web task-board panel's per-row buttons call
 * (`ctx.remote.commands.execute(sessionId, '/task close task-3')`, the
 * plan-chip / `/org` interaction pattern). A plugin-owned client Remote is not
 * available out of tree: the client bundle purity gate rejects every
 * `@deepseek-ai/*` value import outside the platform table, and a
 * typert-generated `@dsh-plugin/* /remote` module is not in that table either,
 * so the command registry is the one client→host action channel.
 *
 * The handler takes the live board and the invocation explicitly, so it is
 * unit-testable without a command registry.
 *
 * @module @dsh-plugin/dsh-task-board/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { TaskBoardHost } from './service.ts'

/** The slice of a command invocation the `/task` handler needs. */
export interface TaskCommandInvocation {
  readonly rawInput: string
  readonly agent: Agent
}

/** The usage line returned for every unrecognized input. */
export const TASK_USAGE = 'usage: /task [list|close <id>|reopen <id>|focus <id>|unfocus <id>]'

/** One board row rendered as a command result line (`[x]` = in the work set). */
function taskLine(task: { id: string; status: string; inContext: boolean; subject: string }): string {
  return `${task.inContext ? '[x]' : '[ ]'} ${task.id} ${task.status} — ${task.subject}`
}

/**
 * Handle one `/task` invocation.
 * @param board - the live task board.
 * @param invocation - the raw input and the invoking agent (its session owns the board).
 * @returns the command result rendered by the dispatching UI.
 */
export function taskCommandHandler(board: TaskBoardHost, invocation: TaskCommandInvocation): CommandResult {
  const parts = invocation.rawInput.trim().split(/\s+/).filter(part => part !== '')
  const verb = parts[0]
  const argument = parts[1]
  const session = invocation.agent.session
  switch (verb) {
    case '': {
      return { kind: 'error', text: TASK_USAGE }
    }
    case 'list': {
      const tasks = board.list(session)
      if (tasks.length === 0) return { kind: 'success', text: 'task board: no tasks' }
      return { kind: 'success', text: tasks.map(taskLine).join('\n') }
    }
    case 'close':
    case 'reopen':
    case 'focus':
    case 'unfocus': {
      if (argument === undefined) return { kind: 'error', text: TASK_USAGE }
      try {
        if (verb === 'close') board.close(session, argument)
        else if (verb === 'reopen') board.reopen(session, argument)
        else board.update(session, argument, { inContext: verb === 'focus' })
      } catch (error) {
        return { kind: 'error', text: `task ${verb}: ${error instanceof Error ? error.message : String(error)}` }
      }
      const done = verb === 'close'
        ? 'closed'
        : verb === 'reopen' ? 'reopened' : verb === 'focus' ? 'added to the work set' : 'removed from the work set'
      return { kind: 'success', text: `${argument} ${done}.` }
    }
    default:
      return { kind: 'error', text: TASK_USAGE }
  }
}

/**
 * Register `/task` when a command registry is composed (the command child
 * activates only when one exists — plan-mode precedent).
 * @param ctx - the plugin context.
 * @param board - the live task board the command drives.
 */
export function registerTaskCommands(ctx: Context, board: TaskBoardHost): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'task',
      description: 'List, close, reopen, or (un)focus the session task board',
      input: { hint: '[list|close <id>|reopen <id>|focus <id>|unfocus <id>]' },
      handler: ({ rawInput, agent }) => taskCommandHandler(board, { rawInput, agent }),
    })
  })
}

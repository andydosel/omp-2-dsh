/**
 * The panel's write path: `/answer_question` and `/dismiss_question`.
 *
 * The browser half cannot reach `ctx.questionBoard` (host services are absent
 * from the client module table, and an out-of-tree package has no typert
 * `/remote` contribution to add one), so a panel action rides the one
 * client→host channel dsh exposes out of tree: `ctx.remote.commands`. Each
 * command is a thin, framework-free wrapper over one service method, so the
 * panel never re-implements inbox policy — it only names the question and the
 * answer.
 *
 * The handler takes the service slice and the invocation explicitly, so it is
 * unit-testable without a command registry (same seam as `dsh-org`'s `/org`).
 *
 * @module @dsh-plugin/dsh-question-board/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { describeError } from '@dsh-plugin/dsh-util/error'

/** Answer one pending question; the panel's primary action. */
export const ANSWER_QUESTION_COMMAND = 'answer_question'

/** Dismiss one pending question without answering it. */
export const DISMISS_QUESTION_COMMAND = 'dismiss_question'

/** Which service method one panel command drives. */
export type QuestionCommand = 'answer' | 'dismiss'

/** The usage line of each panel command, returned when its arguments are missing. */
export const QUESTION_COMMAND_USAGE: Readonly<Record<QuestionCommand, string>> = {
  answer: `usage: /${ANSWER_QUESTION_COMMAND} <questionId> <answer>`,
  dismiss: `usage: /${DISMISS_QUESTION_COMMAND} <questionId>`,
}

/** The `ctx.questionBoard` slice the panel commands write through. */
export interface QuestionCommandDeps {
  /**
   * Answer a pending question.
   * @param session - the session that owns the question.
   * @param id - question id.
   * @param answer - human answer.
   * @returns whether the question transitioned to answered.
   */
  answer(session: Session, id: string, answer: string | string[]): boolean
  /**
   * Dismiss a pending question.
   * @param session - the session that owns the question.
   * @param id - question id.
   * @returns whether the question transitioned to dismissed.
   */
  dismiss(session: Session, id: string): boolean
}

/** One parsed panel command. */
export interface QuestionCommandInvocation {
  /** Everything after the command name, verbatim. */
  readonly rawInput: string
  /** The invoking session: the asker owns the inbox the question lives in. */
  readonly session: Session
}

/**
 * Handle one `/answer_question` or `/dismiss_question` invocation.
 * @param deps - the live inbox service slice.
 * @param command - which panel command was invoked.
 * @param invocation - the raw input and the invoking session.
 * @returns the command result rendered by the dispatching UI.
 */
export function questionCommandHandler(
  deps: QuestionCommandDeps,
  command: QuestionCommand,
  invocation: QuestionCommandInvocation,
): CommandResult {
  const name = command === 'answer' ? ANSWER_QUESTION_COMMAND : DISMISS_QUESTION_COMMAND
  const trimmed = invocation.rawInput.trim()
  const separator = trimmed.search(/\s/)
  // Only the id is a token; the rest is the human's free text, kept verbatim
  // (inner whitespace included) so an answer reaches the asker as written.
  const id = separator === -1 ? trimmed : trimmed.slice(0, separator)
  const answer = separator === -1 ? '' : trimmed.slice(separator + 1).trim()
  if (id === '' || (command === 'answer' && answer === '')) {
    return { kind: 'error', text: QUESTION_COMMAND_USAGE[command] }
  }
  try {
    const transitioned = command === 'answer'
      ? deps.answer(invocation.session, id, answer)
      : deps.dismiss(invocation.session, id)
    // Unknown and already-terminal questions both land here: only a pending
    // question can be transitioned, and the panel lists exactly those.
    if (!transitioned) return { kind: 'error', text: `/${name}: ${id} is not a pending question` }
  } catch (error) {
    return { kind: 'error', text: `/${name}: ${describeError(error)}` }
  }
  return {
    kind: 'success',
    text: command === 'answer' ? `Answered ${id}: ${answer}` : `Dismissed ${id}.`,
  }
}

/**
 * Register the panel commands when a command registry is composed.
 * @param ctx - the plugin context.
 * @param deps - the live inbox service slice.
 */
export function registerQuestionBoardCommands(ctx: Context, deps: QuestionCommandDeps): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: ANSWER_QUESTION_COMMAND,
      description: 'Answer one question from the session question inbox',
      input: { hint: '<questionId> <answer>' },
      handler: ({ rawInput, agent }) => questionCommandHandler(deps, 'answer', { rawInput, session: agent.session }),
    })
    commandCtx.commands.register({
      name: DISMISS_QUESTION_COMMAND,
      description: 'Dismiss one question from the session question inbox without answering it',
      input: { hint: '<questionId>' },
      handler: ({ rawInput, agent }) => questionCommandHandler(deps, 'dismiss', { rawInput, session: agent.session }),
    })
  })
}

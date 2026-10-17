/**
 * The model-facing `ask_question` tool. It registers a question into the
 * calling session's durable inbox and returns only its id — the tool never
 * prints the (potentially long) question back, and it never blocks the turn.
 * The answer is delivered to the asker later by {@link QuestionBoardService}
 * (followup/steer for a blocking question, inject otherwise).
 *
 * @module @dsh-plugin/dsh-question-board/tool
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AskQuestionRequest } from './types.ts'

/** The tool's registered name. */
export const ASK_QUESTION_TOOL = 'ask_question'

/** Canonical value returned by the tool. */
export interface AskQuestionValue {
  /** The registered question's session-local id. */
  id: string
  /** The human's answer, present only after a truly blocking ask returned. */
  answer?: string
}

/** The service slice the tool writes through. */
export interface AskQuestionDeps {
  /**
   * Register a question for one session and return its id.
   * @param session - the asking session.
   * @param request - question body, options, and blocking intent.
   * @returns the new question's id.
   */
  ask(session: Session, request: AskQuestionRequest): string
  /**
   * Pause the calling turn until the human answers (blocking asks only):
   * `ctx.userQuestions` when composed, else `ctx.approval`.
   * @param session - the asking session (the durable inbox already has `id`).
   * @param id - the registered question id.
   * @param request - the same request the inbox recorded.
   * @param agent - the calling agent (human interaction needs the live root).
   * @param signal - caller cancellation.
   * @returns the answer text.
   */
  askBlocking?(
    session: Session,
    id: string,
    request: AskQuestionRequest,
    agent: Agent | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string>
}

/**
 * Build the `ask_question` tool definition.
 * @param deps - the question-board write seam.
 * @returns the tool definition registered on the global tool layer.
 */
export function defineAskQuestionTool(deps: AskQuestionDeps): ToolDefinition {
  return defineTool({
    name: ASK_QUESTION_TOOL,
    description: 'Ask the human a question through the question inbox. '
      + 'By default this registers the question and returns immediately with its id; '
      + 'do NOT inline a long question into your reply — the human answers from the inbox, out of band. '
      + 'Set blocking=true only when you cannot proceed without the answer: the question is still registered, and this '
      + 'call then PAUSES through ctx.userQuestions (or ctx.approval when user questions are unavailable) until the '
      + 'human answers, returning the answer with the id.',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'The question to ask the human, concise and self-contained.',
      },
      options: {
        type: 'array',
        description: 'Optional structured choices; the human may still answer with free text.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: 'The choice text shown to the human.' },
            description: { type: 'string', description: 'Optional longer explanation of the choice.' },
          },
        },
      },
      blocking: {
        type: 'boolean',
        description: 'true to pause this session until the human answers (followup/steer wake); false (default) to continue without waiting.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true, description: 'The registered question id.' },
          answer: { type: 'string', description: 'The human answer, present after a blocking ask returned.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.answer === undefined
          ? `Question ${value.id} registered in the question inbox.`
          : `Question ${value.id} answered: ${value.answer}`,
      }],
    },
    execute: async (args, exec): Promise<AskQuestionValue> => {
      const session = exec.agent?.session
      if (session === undefined) {
        throw new Error('ask_question: no calling agent session to register the question on')
      }
      const request = {
        content: [{ type: 'text' as const, text: args.content }],
        ...args.options === undefined ? {} : { options: args.options },
        ...args.blocking === undefined ? {} : { blocking: args.blocking },
      }
      const id = deps.ask(session, request)
      if (request.blocking !== true) return { id }
      // A blocking ask must actually pause the turn. `ask` above recorded the
      // durable inbox row; the provider wait below is the synchronous branch
      // design §5.4 requires (userQuestions, with approval as the fallback).
      if (deps.askBlocking === undefined) {
        throw new Error('ask_question: blocking=true needs ctx.userQuestions or ctx.approval, which are not composed')
      }
      return { id, answer: await deps.askBlocking(session, id, request, exec.agent, exec.signal) }
    },
  })
}

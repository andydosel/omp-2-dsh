/**
 * The model-facing `ask_question` tool. It registers a question into the
 * calling session's durable inbox and returns only its id — the tool never
 * prints the (potentially long) question back, and it never blocks the turn.
 * The answer is delivered to the asker later by {@link QuestionBoardService}
 * (followup/steer for a blocking question, inject otherwise).
 *
 * @module @dsh-plugin/dsh-question-board/tool
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AskQuestionRequest } from './types.ts'

/** The tool's registered name. */
export const ASK_QUESTION_TOOL = 'ask_question'

/** Canonical value returned by the tool. */
export interface AskQuestionValue {
  /** The registered question's session-local id. */
  id: string
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
}

/**
 * Build the `ask_question` tool definition.
 * @param deps - the question-board write seam.
 * @returns the tool definition registered on the global tool layer.
 */
export function defineAskQuestionTool(deps: AskQuestionDeps): ToolDefinition {
  return defineTool({
    name: ASK_QUESTION_TOOL,
    description: 'Ask the human a question asynchronously and keep working. '
      + 'The question is registered in the question inbox and this returns immediately with its id; '
      + 'do NOT inline a long question into your reply — the human answers from the inbox, out of band. '
      + 'Set blocking=true only when you cannot proceed without the answer (you pause and are woken when answered); '
      + 'leave it false (default) to keep going and receive the answer alongside your next steps.',
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
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Question ${value.id} registered in the question inbox.`,
      }],
    },
    execute: async (args, exec): Promise<AskQuestionValue> => {
      const session = exec.agent?.session
      if (session === undefined) {
        throw new Error('ask_question: no calling agent session to register the question on')
      }
      return {
        id: deps.ask(session, {
          content: [{ type: 'text', text: args.content }],
          ...args.options === undefined ? {} : { options: args.options },
          ...args.blocking === undefined ? {} : { blocking: args.blocking },
        }),
      }
    },
  })
}

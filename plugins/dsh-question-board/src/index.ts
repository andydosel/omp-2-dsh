/**
 * dsh-question-board: the asynchronous, non-blocking question inbox
 * (DESIGN-COORDINATOR-SUITE.md §5.4 / §13.2).
 *
 * - durable events: `question/asked`, `question/answered`, `question/dismissed`
 * - tool: `ask_question({content, options?, blocking?}) -> {id}` — registers
 *   into the inbox and returns at once; it never prints a long question
 * - service: `ctx.questionBoard.runtime.ask/answer/dismiss/list`
 * - projection: `questionBoard` (a `QuestionSnapshot[]`, whole-value fold over
 *   `question/*`) with a client wire view
 * - delivery: a blocking answer wakes the asker (`steer` while running,
 *   `followup` while idle); a non-blocking answer rides along (`inject`)
 * - commands: `/answer_question <id> <answer>` and `/dismiss_question <id>` —
 *   the Web panel's write path (`ctx.remote.commands` is the only client→host
 *   channel available out of tree)
 *
 * The asker identity is the asking session, so a delegated subagent that must
 * reach the human relays through its parent (design §5.7) — `ask` refuses a
 * blocking ask from a subagent session with `DELEGATED_CALLER` rather than
 * deadlocking on a wake that can never arrive.
 *
 * The client face (`./client`) registers the `question-board`
 * `ConversationNodeDefinition` — one keyed node per asker, anchored at that
 * asker's first question — plus the keyed `conversation.chat.node` renderer
 * behind the same kind. The renderer reads the asker's pending questions from
 * the host-folded `questionBoard` projection (zero client-side folding, so a
 * replayed history and a live inbox agree) and answers in batches by
 * dispatching the commands above.
 *
 * @module @dsh-plugin/dsh-question-board
 */

import { QuestionBoardService } from './service.ts'

export const name = 'dsh-question-board'

export { QuestionBoardService }
export default QuestionBoardService

export { QuestionBoardError, QuestionBoardRuntime } from './service.ts'
export type { QuestionBoardHost } from './service.ts'

export { ASK_QUESTION_TOOL, defineAskQuestionTool } from './tool.ts'
export type { AskQuestionDeps, AskQuestionValue } from './tool.ts'

export {
  ANSWER_QUESTION_COMMAND,
  DISMISS_QUESTION_COMMAND,
  QUESTION_COMMAND_USAGE,
  questionCommandHandler,
  registerQuestionBoardCommands,
} from './commands.ts'
export type {
  QuestionCommand,
  QuestionCommandDeps,
  QuestionCommandInvocation,
} from './commands.ts'

export {
  applyQuestionEvent,
  groupQuestionsByAsker,
  pendingQuestions,
  plainQuestionText,
  renderAnswer,
} from './board.ts'

export {
  questionBoardProjection,
  questionBoardStateSchema,
  questionBoardViewSchema,
  questionSnapshotSchema,
  viewQuestionBoard,
} from './projection.ts'

export type {
  AskQuestionRequest,
  QuestionAskedData,
  QuestionBlocking,
  QuestionBoardView,
  QuestionGroup,
  QuestionOption,
  QuestionSnapshot,
  QuestionStatus,
} from './types.ts'

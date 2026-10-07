/**
 * The `questionBoard` session-projection unit: validates the persisted fold
 * state, folds every committed `question/*` event through the pure
 * {@link applyQuestionEvent}, and publishes the inbox to clients.
 *
 * @module @dsh-plugin/dsh-question-board/projection
 */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { applyQuestionEvent } from './board.ts'
import type { QuestionBoardView, QuestionSnapshot } from './types.ts'

/**
 * Validate one snapshot. `content` stays loose (`unknown[]`) so any future
 * ContentBlock variant round-trips through a persisted fold unchanged; the
 * typed fields are the ones the fold and the renderer depend on.
 */
const questionSnapshotSchema = zod.object({
  id: zod.string(),
  asker: zod.string(),
  content: zod.array(zod.unknown()),
  options: zod.array(zod.object({
    label: zod.string(),
    description: zod.string().optional(),
  })).optional(),
  blocking: zod.enum(['blocking', 'non-blocking']),
  status: zod.enum(['pending', 'answered', 'dismissed']),
  answer: zod.union([zod.string(), zod.array(zod.string())]).optional(),
}) as unknown as ZodType<QuestionSnapshot>

/** Validate the whole persisted inbox. */
const questionBoardStateSchema = zod.array(questionSnapshotSchema) as unknown as ZodType<QuestionSnapshot[]>

/** The wire schema reuses the state schema: the served value IS the folded inbox. */
const questionBoardViewSchema = questionBoardStateSchema as unknown as ZodType<QuestionBoardView>

/**
 * State → wire payload. Returning the fold state reference is intentional: the
 * registry compares the raw view result with `Object.is`, and the fold already
 * reuses its reference unless a `question/*` event changed it.
 * @param state - the current inbox.
 * @returns the inbox as served to clients.
 */
export function viewQuestionBoard(state: QuestionSnapshot[]): QuestionBoardView {
  return state
}

/**
 * The registered unit with its client view REQUIRED (the `wire` property is
 * optional on the bare interface, so a `satisfies`-only literal would erase
 * `init`'s and `wire`'s declared shapes from the exported type).
 */
export type QuestionBoardProjection = ProjectionDefinition<'questionBoard', QuestionSnapshot[]> & {
  wire: NonNullable<ProjectionDefinition<'questionBoard', QuestionSnapshot[]>['wire']>
}

/** The `questionBoard` projection unit, registered on `ctx.sessionProjections`. */
export const questionBoardProjection: QuestionBoardProjection = {
  key: 'questionBoard',
  stateSchema: questionBoardStateSchema,
  init: () => [],
  apply: applyQuestionEvent,
  wire: { viewSchema: questionBoardViewSchema, view: viewQuestionBoard },
  stateVersion: 1,
}

export { questionBoardStateSchema, questionBoardViewSchema, questionSnapshotSchema }

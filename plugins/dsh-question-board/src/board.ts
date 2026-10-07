/**
 * Pure `questionBoard` fold plus the inbox helpers the tool, service, and the
 * (future) keyed client renderer share. Everything here is synchronous and
 * side-effect free, so the projection unit can run it on every committed event
 * and unit tests can replay a real Session log without a framework.
 *
 * Whole-value rule: `applyQuestionEvent` returns the SAME state reference for
 * every event it does not change, which is what suppresses downstream
 * projection publication (`Object.is` gate).
 *
 * @module @dsh-plugin/dsh-question-board/board
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { QuestionGroup, QuestionSnapshot, QuestionStatus } from './types.ts'

/** Extract the plain text of a question body (non-text blocks are ignored). */
export function plainQuestionText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Apply one committed Session event to a session's question inbox.
 * @param state - inbox before the event.
 * @param event - next committed Session event.
 * @returns the next inbox; the same reference when the event is not a
 *   `question/*` event or does not change the state (idempotent duplicates).
 */
export function applyQuestionEvent(state: QuestionSnapshot[], event: SessionEvent): QuestionSnapshot[] {
  switch (event.type) {
    case 'question/asked': {
      const asked = event.data
      // First-write-wins: a duplicate id never resurrects an answered question.
      if (state.some(question => question.id === asked.id)) return state
      const snapshot: QuestionSnapshot = {
        id: asked.id,
        asker: asked.asker,
        content: asked.content,
        ...asked.options === undefined ? {} : { options: asked.options },
        blocking: asked.blocking,
        status: 'pending',
      }
      return [...state, snapshot]
    }
    case 'question/answered':
      return transition(state, event.data.id, 'answered', event.data.answer)
    case 'question/dismissed':
      return transition(state, event.data.id, 'dismissed', undefined)
    default:
      return state
  }
}

/** Move one question to a terminal status; unchanged reference when it is unknown or already there. */
function transition(
  state: QuestionSnapshot[],
  id: string,
  status: Exclude<QuestionStatus, 'pending'>,
  answer: string | string[] | undefined,
): QuestionSnapshot[] {
  const index = state.findIndex(question => question.id === id)
  const current = index === -1 ? undefined : state[index]
  if (current === undefined || current.status === status) return state
  // An answer only exists on an answered question; dismissing drops a staler one.
  const next: QuestionSnapshot = { ...current, status }
  if (answer === undefined) delete next.answer
  else next.answer = answer
  const result = state.slice()
  result[index] = next
  return result
}

/** The inbox's still-unanswered questions, in ask order. */
export function pendingQuestions(state: readonly QuestionSnapshot[]): QuestionSnapshot[] {
  return state.filter(question => question.status === 'pending')
}

/**
 * Group an inbox by asker, preserving ask order within each group and the
 * first-seen order of the groups. This is the keyed renderer's input for
 * "按 asker 分组、可乱序/一次多答" (design §5.4): each group is one keyed node,
 * each question a keyed child, so out-of-order and multi-answer batches stay
 * addressable by question id.
 * @param questions - a session's questions in ask order.
 * @returns one group per asker, in first-seen order.
 */
export function groupQuestionsByAsker(questions: readonly QuestionSnapshot[]): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>()
  for (const question of questions) {
    const existing = groups.get(question.asker)
    if (existing !== undefined) existing.questions.push(question)
    else groups.set(question.asker, { asker: question.asker, questions: [question] })
  }
  return [...groups.values()]
}

/**
 * Render the wake/context message delivered to the asker once a question is
 * answered. Compact JSON keeps the delivered turn cheap and self-describing.
 * @param question - the answered question.
 * @param answer - the human answer.
 * @returns the one-block text content.
 */
export function renderAnswer(question: QuestionSnapshot, answer: string | string[]): string {
  return JSON.stringify({
    kind: 'question_answered',
    id: question.id,
    blocking: question.blocking,
    question: plainQuestionText(question.content),
    answer,
  })
}

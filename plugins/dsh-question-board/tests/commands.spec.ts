/**
 * Panel command tests: `/answer_question` and `/dismiss_question` over the
 * real inbox runtime, plus the argument and terminal-state failures the panel
 * relies on for its failure line.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ANSWER_QUESTION_COMMAND,
  DISMISS_QUESTION_COMMAND,
  QUESTION_COMMAND_USAGE,
  questionCommandHandler,
  type QuestionCommandDeps,
} from '../src/commands.ts'
import { QuestionBoardRuntime } from '../src/service.ts'
import { foldingHost, recordingAgent, type RecordingAgent } from './harness.ts'

/** A runtime that folds the session log and resolves the given live agents. */
function runtime(agents: ReadonlyArray<RecordingAgent> = []): QuestionBoardRuntime {
  return new QuestionBoardRuntime(foldingHost(new Map(agents.map(agent => [agent.id, agent]))))
}

/** A session with one registered question, and that question's id. */
function asked(
  runtime: QuestionBoardRuntime,
  id = 's',
  text = 'Ship it?',
  blocking = false,
): { session: Session; question: string } {
  const session = Session.create(SessionId(id))
  return { session, question: runtime.ask(session, { content: [{ type: 'text', text }], blocking }) }
}

describe('questionCommandHandler answer', () => {
  it('answers the question, wakes the blocking asker, and echoes the id and answer', () => {
    const agent = recordingAgent('s1', 'running')
    const board = runtime([agent])
    const { session, question } = asked(board, 's1', 'Ship the release?', true)

    const result = questionCommandHandler(board, 'answer', { rawInput: `${question} ship it`, session })

    expect(result).toEqual({ kind: 'success', text: 'Answered q-0: ship it' })
    expect(board.list(session)[0]).toMatchObject({ status: 'answered', answer: 'ship it' })
    expect(agent.steered).toHaveLength(1)
  })

  it('keeps the answer verbatim, whitespace included', () => {
    const board = runtime()
    const { session, question } = asked(board, 's2')

    const result = questionCommandHandler(board, 'answer', { rawInput: `  ${question}   use  option B  `, session })

    expect(result.kind).toBe('success')
    expect(board.list(session)[0]?.answer).toBe('use  option B')
  })

  it('returns the usage line when the id or the answer is missing', () => {
    const board = runtime()
    const { session } = asked(board, 's3')

    expect(questionCommandHandler(board, 'answer', { rawInput: '', session }))
      .toEqual({ kind: 'error', text: QUESTION_COMMAND_USAGE.answer })
    expect(questionCommandHandler(board, 'answer', { rawInput: 'q-0   ', session }))
      .toEqual({ kind: 'error', text: QUESTION_COMMAND_USAGE.answer })
    expect(board.list(session)[0]?.status).toBe('pending')
  })

  it('reports an unknown or already-terminal question without touching the inbox', () => {
    const board = runtime()
    const { session, question } = asked(board, 's4')

    expect(questionCommandHandler(board, 'answer', { rawInput: 'ghost yes', session }))
      .toEqual({ kind: 'error', text: `/${ANSWER_QUESTION_COMMAND}: ghost is not a pending question` })
    questionCommandHandler(board, 'answer', { rawInput: `${question} first`, session })
    expect(questionCommandHandler(board, 'answer', { rawInput: `${question} second`, session }))
      .toEqual({ kind: 'error', text: `/${ANSWER_QUESTION_COMMAND}: ${question} is not a pending question` })
    expect(board.list(session)[0]?.answer).toBe('first')
  })

  it('surfaces a service rejection as the command failure', () => {
    const session = Session.create(SessionId('s5'))
    const deps: QuestionCommandDeps = {
      answer: () => { throw new Error('answer must be a non-empty string') },
      dismiss: () => false,
    }

    expect(questionCommandHandler(deps, 'answer', { rawInput: 'q-0 ok', session }))
      .toEqual({ kind: 'error', text: `/${ANSWER_QUESTION_COMMAND}: answer must be a non-empty string` })
  })
})

describe('questionCommandHandler dismiss', () => {
  it('dismisses the pending question and locks out a later dismiss', () => {
    const board = runtime()
    const { session, question } = asked(board, 's6')

    expect(questionCommandHandler(board, 'dismiss', { rawInput: `${question} `, session }))
      .toEqual({ kind: 'success', text: `Dismissed ${question}.` })
    expect(board.list(session)[0]).toMatchObject({ status: 'dismissed' })
    expect(questionCommandHandler(board, 'dismiss', { rawInput: question, session }))
      .toEqual({ kind: 'error', text: `/${DISMISS_QUESTION_COMMAND}: ${question} is not a pending question` })
  })

  it('returns the usage line when the id is missing', () => {
    const board = runtime()
    const session = Session.create(SessionId('s7'))
    expect(questionCommandHandler(board, 'dismiss', { rawInput: '   ', session }))
      .toEqual({ kind: 'error', text: QUESTION_COMMAND_USAGE.dismiss })
  })

  it('ignores trailing arguments a stale panel may still send', () => {
    const board = runtime()
    const { session, question } = asked(board, 's8')
    expect(questionCommandHandler(board, 'dismiss', { rawInput: `${question} because`, session }).kind).toBe('success')
  })
})

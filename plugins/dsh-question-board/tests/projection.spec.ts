/**
 * `questionBoard` fold tests: the pure transition over real appended Session
 * events, the reference-identity gate, and the projection unit's init/apply/
 * wire/schema round trip.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { applyQuestionEvent, groupQuestionsByAsker, pendingQuestions } from '../src/board.ts'
import { questionBoardProjection, questionBoardStateSchema } from '../src/projection.ts'
import type { QuestionSnapshot } from '../src/types.ts'

const EMPTY: QuestionSnapshot[] = []

/** Fold a session's own committed events through the pure transition. */
function fold(session: Session): QuestionSnapshot[] {
  return session.snapshotEvents().reduce<QuestionSnapshot[]>(applyQuestionEvent, [])
}

/** One asked event appended to a fresh session. */
function askOn(session: Session, id: string, blocking: 'blocking' | 'non-blocking' = 'non-blocking') {
  return session.append('question/asked', {
    id,
    asker: session.id,
    content: [{ type: 'text', text: `question ${id}` }],
    options: [{ label: 'yes' }, { label: 'no', description: 'decline' }],
    blocking,
  })
}

describe('applyQuestionEvent', () => {
  it('folds an ask into a pending snapshot and keeps unrelated events by reference', () => {
    const session = Session.create(SessionId('s1'))
    const asked = askOn(session, 'q-0', 'blocking')
    const state = applyQuestionEvent(EMPTY, asked)
    expect(state).toEqual([{
      id: 'q-0',
      asker: session.id,
      content: [{ type: 'text', text: 'question q-0' }],
      options: [{ label: 'yes' }, { label: 'no', description: 'decline' }],
      blocking: 'blocking',
      status: 'pending',
    }])

    const unrelated = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent
    expect(applyQuestionEvent(state, unrelated)).toBe(state)
  })

  it('folds an answer onto the pending snapshot', () => {
    const session = Session.create(SessionId('s2'))
    const pending = applyQuestionEvent(EMPTY, askOn(session, 'q-1'))
    const answered = applyQuestionEvent(pending, session.append('question/answered', { id: 'q-1', answer: ['yes'] }))
    expect(answered).not.toBe(pending)
    expect(answered[0]).toEqual({ ...pending[0], status: 'answered', answer: ['yes'] })
  })

  it('drops a stale answer when a question is dismissed', () => {
    const session = Session.create(SessionId('s3'))
    const pending = applyQuestionEvent(EMPTY, askOn(session, 'q-2'))
    const answered = applyQuestionEvent(pending, session.append('question/answered', { id: 'q-2', answer: 'yes' }))
    const dismissed = applyQuestionEvent(answered, session.append('question/dismissed', { id: 'q-2' }))
    expect(dismissed[0]?.status).toBe('dismissed')
    expect(dismissed[0] !== undefined && 'answer' in dismissed[0]).toBe(false)
  })

  it('is a no-op for unknown ids, duplicate terminal events, and duplicate asks', () => {
    const session = Session.create(SessionId('s4'))
    expect(applyQuestionEvent(EMPTY, session.append('question/answered', { id: 'ghost', answer: 'x' }))).toBe(EMPTY)
    const pending = applyQuestionEvent(EMPTY, askOn(session, 'q-3'))
    expect(applyQuestionEvent(pending, askOn(session, 'q-3'))).toBe(pending)
    const answered = applyQuestionEvent(pending, session.append('question/answered', { id: 'q-3', answer: 'yes' }))
    expect(applyQuestionEvent(answered, session.append('question/answered', { id: 'q-3', answer: 'no' }))).toBe(answered)
  })
})

describe('questionBoard projection unit', () => {
  it('starts empty, folds ask then answer, and serves the folded state', () => {
    const session = Session.create(SessionId('s5'))
    const id = 'q-4'
    session.append('question/asked', {
      id,
      asker: session.id,
      content: [{ type: 'text', text: 'Ship it?' }],
      blocking: 'blocking',
    })

    let state = questionBoardProjection.init(session.header, SessionLogOffset(0))
    expect(state).toEqual([])
    for (const event of session.snapshotEvents()) {
      state = questionBoardProjection.apply(state, event)
    }
    expect(state).toHaveLength(1)
    expect(state[0]?.status).toBe('pending')

    session.append('question/answered', { id, answer: 'ship' })
    for (const event of session.snapshotEvents().slice(-1)) {
      state = questionBoardProjection.apply(state, event)
    }
    expect(state[0]).toEqual({ ...state[0], status: 'answered', answer: 'ship' })
    expect(questionBoardProjection.wire.view(state)).toBe(state)
    expect(questionBoardStateSchema.parse(state)).toEqual(state)
  })
})

describe('inbox helpers', () => {
  it('groups by asker in first-seen order and filters pending questions', () => {
    const a = SessionId('asker-a')
    const b = SessionId('asker-b')
    const questions: QuestionSnapshot[] = [
      { id: 'q-0', asker: a, content: [{ type: 'text', text: 'a1' }], blocking: 'blocking', status: 'pending' },
      { id: 'q-1', asker: b, content: [{ type: 'text', text: 'b1' }], blocking: 'non-blocking', status: 'answered', answer: 'ok' },
      { id: 'q-2', asker: a, content: [{ type: 'text', text: 'a2' }], blocking: 'non-blocking', status: 'dismissed' },
    ]
    expect(groupQuestionsByAsker(questions).map(group => ({
      asker: group.asker,
      ids: group.questions.map(question => question.id),
    }))).toEqual([
      { asker: a, ids: ['q-0', 'q-2'] },
      { asker: b, ids: ['q-1'] },
    ])
    expect(pendingQuestions(questions).map(question => question.id)).toEqual(['q-0'])
  })

  it('folds a full ask/answer round trip through real sessions', () => {
    const session = Session.create(SessionId('s6'))
    const asked = askOn(session, 'q-5')
    expect(fold(session)).toEqual([{
      id: 'q-5',
      asker: session.id,
      content: [{ type: 'text', text: 'question q-5' }],
      options: [{ label: 'yes' }, { label: 'no', description: 'decline' }],
      blocking: 'non-blocking',
      status: 'pending',
    }])
    session.append('question/answered', { id: 'q-5', answer: 'yes' })
    expect(fold(session)[0]?.status).toBe('answered')
    expect(fold(session)[0]?.answer).toBe('yes')
    expect(asked.seq).toBe(0)
  })
})

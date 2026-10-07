/**
 * `QuestionBoardRuntime` tests: the ask/answer/dismiss/list service surface
 * over real Sessions, the blocking vs non-blocking delivery split, and the
 * delegated-asker / bad-answer guards.
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { QuestionBoardError, QuestionBoardRuntime } from '../src/service.ts'
import { foldingHost, recordingAgent, subagentSession } from './harness.ts'

/** A runtime whose host folds the session log and resolves the given live agents. */
function runtime(agents: ReadonlyArray<Agent> = []): QuestionBoardRuntime {
  return new QuestionBoardRuntime(foldingHost(new Map(agents.map(agent => [agent.id, agent]))))
}

describe('QuestionBoardRuntime.ask', () => {
  it('appends a durable asked event and lists the pending question', () => {
    const session = Session.create(SessionId('s1'))
    const board = runtime()
    const id = board.ask(session, { content: [{ type: 'text', text: 'Proceed?' }] })

    expect(id).toBe('q-0')
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['question/asked'])
    expect(board.list(session)).toMatchObject([{
      id: 'q-0',
      asker: session.id,
      content: [{ type: 'text', text: 'Proceed?' }],
      blocking: 'non-blocking',
      status: 'pending',
    }])
  })

  it('returns a copy so callers cannot mutate the folded inbox', () => {
    const session = Session.create(SessionId('s1b'))
    const board = runtime()
    board.ask(session, { content: [{ type: 'text', text: 'A' }] })
    board.list(session).pop()
    expect(board.list(session)).toHaveLength(1)
  })

  it('refuses a blocking ask from a delegated subagent and allows a non-blocking one', () => {
    const child = subagentSession('child')
    const board = runtime()
    expect(() => board.ask(child, { content: [{ type: 'text', text: 'Pick' }], blocking: true }))
      .toThrowError(expect.objectContaining({ code: 'DELEGATED_CALLER' }))
    expect(board.ask(child, { content: [{ type: 'text', text: 'FYI' }] })).toBe('q-0')
  })
})

describe('QuestionBoardRuntime.answer', () => {
  it('wakes an idle blocking asker with a followup carrying the answer', () => {
    const session = Session.create(SessionId('s2'))
    const agent = recordingAgent('s2', 'idle')
    const board = runtime([agent])
    const id = board.ask(session, { content: [{ type: 'text', text: 'Ship?' }], blocking: true })

    expect(board.answer(session, id, 'ship')).toBe(true)
    expect(agent.followedUp).toHaveLength(1)
    expect(agent.steered).toHaveLength(0)
    expect(agent.injected).toHaveLength(0)
    expect(agent.followedUp[0]?.source.kind).toBe('dsh-question-board')
    expect(agent.followedUp[0]?.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('"id":"q-0"'),
    })
    expect(board.list(session)[0]).toMatchObject({ status: 'answered', answer: 'ship' })
  })

  it('steers a running blocking asker instead of following up', () => {
    const session = Session.create(SessionId('s3'))
    const agent = recordingAgent('s3', 'running')
    const board = runtime([agent])
    const id = board.ask(session, { content: [{ type: 'text', text: 'Now?' }], blocking: true })

    board.answer(session, id, 'yes')
    expect(agent.steered).toHaveLength(1)
    expect(agent.followedUp).toHaveLength(0)
  })

  it('injects a non-blocking answer without waking the asker', () => {
    const session = Session.create(SessionId('s4'))
    const agent = recordingAgent('s4', 'idle')
    const board = runtime([agent])
    const id = board.ask(session, { content: [{ type: 'text', text: 'Later' }] })

    board.answer(session, id, ['yes', 'no'])
    expect(agent.injected).toHaveLength(1)
    expect(agent.followedUp).toHaveLength(0)
    expect(agent.steered).toHaveLength(0)
    expect(board.list(session)[0]?.answer).toEqual(['yes', 'no'])
  })

  it('records the answer but delivers nothing when the asker is not live', () => {
    const session = Session.create(SessionId('s5'))
    const board = runtime()
    const id = board.ask(session, { content: [{ type: 'text', text: 'Ping' }], blocking: true })
    expect(board.answer(session, id, 'pong')).toBe(true)
    expect(board.list(session)[0]).toMatchObject({ status: 'answered', answer: 'pong' })
  })

  it('rejects unknown and already-terminal questions', () => {
    const session = Session.create(SessionId('s6'))
    const board = runtime()
    expect(board.answer(session, 'ghost', 'x')).toBe(false)
    const id = board.ask(session, { content: [{ type: 'text', text: 'Once' }] })
    expect(board.answer(session, id, 'first')).toBe(true)
    expect(board.answer(session, id, 'second')).toBe(false)
    expect(board.list(session)[0]?.answer).toBe('first')
  })

  it('rejects an empty answer without appending an answered event', () => {
    const session = Session.create(SessionId('s7'))
    const board = runtime()
    const id = board.ask(session, { content: [{ type: 'text', text: 'Empty?' }] })
    expect(() => board.answer(session, id, '')).toThrowError(QuestionBoardError)
    expect(() => board.answer(session, id, ['ok', '  '])).toThrowError(expect.objectContaining({ code: 'BAD_ANSWER' }))
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['question/asked'])
    expect(board.list(session)[0]?.status).toBe('pending')
  })
})

describe('QuestionBoardRuntime.dismiss', () => {
  it('dismisses a pending question and locks out later answers', () => {
    const session = Session.create(SessionId('s8'))
    const board = runtime()
    const id = board.ask(session, { content: [{ type: 'text', text: 'Drop' }] })
    expect(board.dismiss(session, id)).toBe(true)
    expect(board.dismiss(session, id)).toBe(false)
    expect(board.answer(session, id, 'too late')).toBe(false)
    expect(board.list(session)[0]).toMatchObject({ status: 'dismissed' })
    expect(board.list(session)[0] !== undefined && 'answer' in board.list(session)[0]!).toBe(false)
  })
})

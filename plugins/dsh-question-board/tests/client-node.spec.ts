/**
 * `question-board` ConversationNode definition tests: the asker-keyed match,
 * the anchor that survives a later question, and the Chat view node the
 * Definition materializes. The Definition imports types only, so it runs in
 * plain Node with hand-built engine contexts (no client runtime needed).
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  QUESTION_BOARD_NODE_KIND,
  questionBoardDefinition,
  type QuestionBoardNodeState,
} from '../client/src/question-board-node.ts'

/** The engine reader a `start` may consult; this Definition never looks back. */
const NO_HISTORY = { previous: () => undefined }

/** A durable `question/asked` event as the asking session logs it. */
function askedEvent(asker: string, seq: number): SessionEvent<'question/asked'> {
  return {
    type: 'question/asked',
    seq: SessionSeq(seq),
    time: 0,
    data: {
      id: `q-${String(seq)}`,
      asker: SessionId(asker),
      content: [{ type: 'text', text: 'Ship it?' }],
      blocking: 'non-blocking',
    },
  }
}

/** A `question/answered` event: terminal, and the only routing evidence is the id. */
function answeredEvent(seq: number): SessionEvent<'question/answered'> {
  return { type: 'question/answered', seq: SessionSeq(seq), time: 0, data: { id: 'q-0', answer: 'ship it' } }
}

/** The start Match of one asker's first question. */
function startMatch(asker: string, seq: number): ConversationStartMatch {
  return { event: askedEvent(asker, seq), role: 'start', location: { kind: 'session' } }
}

/** The assembled Context the engine hands to `start`/`buildViewNode`. */
function contextOf(asker: string, seq: number): ConversationNodeContext<QuestionBoardNodeState> {
  const start = startMatch(asker, seq)
  return {
    key: `question-board:${asker}`,
    kind: QUESTION_BOARD_NODE_KIND,
    id: asker,
    matches: [start],
    start,
    state: undefined,
    current: new Map(),
  }
}

describe('questionBoardDefinition.match', () => {
  it('keys a question by its asker so one asker owns one node', () => {
    expect(questionBoardDefinition.match(askedEvent('coordinator', 3)))
      .toEqual({ id: 'coordinator', role: 'start' })
  })

  it('claims nothing else: terminal transitions arrive as projection updates', () => {
    expect(questionBoardDefinition.match(answeredEvent(4))).toBeNull()
  })

  it('refuses a payload that no longer names its asker', () => {
    const lossy = { type: 'question/asked', seq: SessionSeq(5), time: 0, data: { id: 'q-5' } }
    expect(questionBoardDefinition.match(lossy as unknown as SessionEvent<'question/asked'>)).toBeNull()
  })
})

describe('questionBoardDefinition.start', () => {
  it('reads the asker and the first question seq out of the start event', () => {
    const match = startMatch('coordinator', 7)
    expect(questionBoardDefinition.start(contextOf('coordinator', 7), match, NO_HISTORY))
      .toEqual({ data: { asker: SessionId('coordinator'), seq: 7 } })
  })

  it('rejects a non-asked start event', () => {
    const match: ConversationMatch = { event: answeredEvent(9), role: 'start', location: { kind: 'session' } }
    expect(() => questionBoardDefinition.start(contextOf('coordinator', 9), match, NO_HISTORY))
      .toThrowError('question-board start requires question/asked')
  })
})

describe('questionBoardDefinition.update', () => {
  it('keeps the earliest anchor when the same asker asks again', () => {
    const state = questionBoardDefinition.start(contextOf('coordinator', 2), startMatch('coordinator', 2), NO_HISTORY)
    const later = questionBoardDefinition.update(
      { ...contextOf('coordinator', 2), state, matches: [startMatch('coordinator', 11)] },
      startMatch('coordinator', 11),
    )
    expect(later).toBe(state)
  })
})

describe('questionBoardDefinition.buildViewNode', () => {
  it('materializes the keyed Chat row at the asker\'s first question', () => {
    const context = contextOf('coordinator', 6)
    const state = questionBoardDefinition.start(context, startMatch('coordinator', 6), NO_HISTORY)
    expect(questionBoardDefinition.buildViewNode({ ...context, state })).toEqual({
      key: 'question-board:coordinator',
      kind: QUESTION_BOARD_NODE_KIND,
      id: 'coordinator',
      target: 'chat',
      anchorSeq: 6,
      location: { kind: 'session' },
      visibility: 'visible',
      data: { asker: SessionId('coordinator'), seq: 6 },
    })
  })

  it('renders nothing before the engine adopts a state or a start', () => {
    const context = contextOf('coordinator', 6)
    expect(questionBoardDefinition.buildViewNode(context)).toBeNull()
    const state = questionBoardDefinition.start(context, startMatch('coordinator', 6), NO_HISTORY)
    expect(questionBoardDefinition.buildViewNode({ ...context, start: undefined, state })).toBeNull()
  })
})

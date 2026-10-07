/**
 * The durable half of the question panel: the `question-board`
 * ConversationNode definition.
 *
 * One keyed node per asker — the key is the asker's session id, so the row
 * appears in that session's transcript and stays put across the replay of its
 * window. The node itself carries nothing but the asker identity and the
 * anchor seq; the questions are read from the host-folded `questionBoard`
 * projection by the renderer, so a replayed window and a live inbox agree and
 * this face never re-folds `question/*` on the client.
 *
 * Every question of one asker shares the node anchored at that asker's FIRST
 * question (`update` deliberately keeps the earliest state): a panel that
 * jumped to whichever question arrived last would render at a different place
 * live than on replay. Terminal transitions arrive as projection updates, not
 * as node updates, which is also why `question/answered` and
 * `question/dismissed` are not matched here — neither event carries the asker
 * the engine would need to route them.
 *
 * @module @dsh-plugin/dsh-question-board/client/question-board-node
 */

import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the ChatNodeDataMap merge surface this face extends.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The keyed Chat renderer kind this face occupies (also the slot entry key). */
export const QUESTION_BOARD_NODE_KIND = 'question-board'

/** Final renderer payload: the asker whose pending inbox this row renders. */
export interface QuestionBoardChatData {
  /** The asking session; its inbox is the row's content. */
  readonly asker: SessionId
  /** Session seq of that asker's first question: the row's stable anchor. */
  readonly seq: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One asker's pending questions, grouped as keyed children of one row. */
    'question-board': QuestionBoardChatData
  }
}

/** Definition-owned state: the asker identity plus its stable anchor. */
export interface QuestionBoardNodeState {
  readonly data: QuestionBoardChatData
}

/** One asker's question inbox, rendered as a keyed Chat node. */
export const questionBoardDefinition: ConversationNodeDefinition<QuestionBoardNodeState> = {
  kind: QUESTION_BOARD_NODE_KIND,
  target: 'chat',
  match: (event) => {
    if (event.type !== 'question/asked') return null
    // `match` reads standard OR compact client history events: only a payload
    // that still names its asker can key a node.
    if (typeof event.data.asker !== 'string') return null
    return { id: event.data.asker, role: 'start' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'question/asked') throw new Error('question-board start requires question/asked')
    return { data: { asker: match.event.data.asker, seq: match.event.seq } }
  },
  // A later question from the same asker keeps the Context: the anchor must not
  // drift between a live window and the same window replayed.
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    const start = context.start
    const state = context.state
    if (start === undefined || state === undefined) return null
    return {
      key: context.key,
      kind: QUESTION_BOARD_NODE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: state.data.seq,
      location: start.location,
      visibility: 'visible',
      data: state.data,
    }
  },
}

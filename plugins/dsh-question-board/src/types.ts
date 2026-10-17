/**
 * dsh-question-board domain vocabulary: the durable `question/*` session
 * events, the `questionBoard` session-projection declaration, and the
 * snapshot shape shared by the service, the projection, and the client view.
 *
 * Design: DESIGN-COORDINATOR-SUITE.md §13.2 (question-board). Events stay
 * log-only (no `surfaceOp`): the inbox is an out-of-band side channel, so
 * folding `question/*` never rewrites the conversation surface.
 *
 * @module @dsh-plugin/dsh-question-board/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One structured choice offered with a question (advisory; free text is allowed). */
export interface QuestionOption {
  /** The displayed choice text. */
  label: string
  /** Optional longer explanation of the choice. */
  description?: string
}

/** Lifecycle of one question in the inbox. */
export type QuestionStatus = 'pending' | 'answered' | 'dismissed'

/**
 * How a question gates its asker.
 * - `blocking`: the asker has paused; the human answer wakes it (followup/steer).
 * - `non-blocking`: the asker keeps going; the answer rides along without a wake (inject).
 */
export type QuestionBlocking = 'blocking' | 'non-blocking'

/** Folded snapshot of one question in a session's inbox. */
export interface QuestionSnapshot {
  /** Session-local identity (`question asked` is `<id>`-keyed). */
  id: string
  /** Session that asked the question. */
  asker: SessionId
  /** Question body, exactly as asked. */
  content: ContentBlock[]
  /** Structured choices, when the asker offered any. */
  options?: QuestionOption[]
  /** Whether the asker paused on this question. */
  blocking: QuestionBlocking
  /** Current lifecycle state. */
  status: QuestionStatus
  /** Human answer, present only while `status === 'answered'`. */
  answer?: string | string[]
}

/** The `questionBoard` wire value: the session's questions in ask order. */
export type QuestionBoardView = readonly QuestionSnapshot[]

/**
 * The payload the `ask_question` tool registers: a question body plus its
 * structured options and blocking intent. The service mints the id and the
 * asker identity from the calling session.
 */
export interface AskQuestionRequest {
  /** Question body. */
  content: ContentBlock[]
  /** Structured choices, when any. */
  options?: QuestionOption[]
  /** Whether the asker pauses on this question (default `false` → non-blocking). */
  blocking?: boolean
}

/** One asker's questions, grouped for the keyed client renderer (design §5.4). */
export interface QuestionGroup {
  /** The asking session. */
  asker: SessionId
  /** That session's questions, in ask order. */
  questions: QuestionSnapshot[]
}

/**
 * Payload of the durable `question/asked` event. Named so the client node can
 * validate the payload it receives: a Definition's `match` reads standard OR
 * compact client history events, and only a payload that still names its asker
 * can key a node.
 */
export interface QuestionAskedData {
  /** Session-local identity (`question/asked` is `<id>`-keyed). */
  id: string
  /** Session that asked the question. */
  asker: SessionId
  /** Question body, exactly as asked. */
  content: ContentBlock[]
  /** Structured choices, when the asker offered any. */
  options?: QuestionOption[]
  /** Whether the asker paused on this question. */
  blocking: QuestionBlocking
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A new question entered the asker's session inbox. Log-only; the folded
     * value lives in the `questionBoard` projection. `asker` is redundant with
     * the owning session but keeps the snapshot self-describing.
     */
    'question/asked': QuestionAskedData
    /** A pending question was answered by the human. */
    'question/answered': { id: string; answer: string | string[] }
    /** A pending question was dismissed without an answer. */
    'question/dismissed': { id: string }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The session's question inbox folded from `question/*`. */
    questionBoard: QuestionBoardView
  }

  interface SessionProjectionStateMap {
    /** Host fold state of the `questionBoard` unit (ask order, whole values). */
    questionBoard: QuestionSnapshot[]
  }
}

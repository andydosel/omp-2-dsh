/**
 * `ctx.questionBoard`: the asynchronous question inbox service. `ask` records
 * a durable `question/asked` event in the asking session; `answer`/`dismiss`
 * record the terminal event and, for an answer, deliver it to the asker — a
 * blocking question wakes the asker (steer while running, followup while
 * idle), a non-blocking one rides along without a wake (`inject`). `list`
 * reads the folded `questionBoard` projection.
 *
 * The write/read logic lives in {@link QuestionBoardRuntime} over a small host
 * seam so it is unit-testable against real Sessions without a framework; the
 * cordis {@link QuestionBoardService} owns the framework wiring.
 *
 * @module @dsh-plugin/dsh-question-board/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { renderAnswer } from './board.ts'
import { registerQuestionBoardCommands } from './commands.ts'
import { questionBoardProjection } from './projection.ts'
import { defineAskQuestionTool } from './tool.ts'
import type { AskQuestionRequest, QuestionBlocking, QuestionSnapshot } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    questionBoard: QuestionBoardService
  }
}

// This plugin's own message-source kind (the shared `plugin` catch-all was
// removed in 0.2.0-rc.2): delivered answers are `{ kind: 'dsh-question-board' }`.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-question-board': { kind: 'dsh-question-board' } & ContextFormed
  }
}

/** Stable error taxonomy for question-board failures. */
export class QuestionBoardError extends Error {
  /** Machine-readable failure code. */
  readonly code: string

  /**
   * @param message - human-readable failure.
   * @param code - stable machine code (e.g. `DELEGATED_CALLER`, `BAD_ANSWER`).
   */
  constructor(message: string, code: string) {
    super(message)
    this.name = 'QuestionBoardError'
    this.code = code
  }
}

/** The framework seams {@link QuestionBoardRuntime} reads through. */
export interface QuestionBoardHost {
  /**
   * Resolve the live agent driving a session.
   * @param sessionId - the asking session id.
   * @returns the live agent, or undefined when the session is not live (cold).
   */
  agent(sessionId: SessionId): Agent | undefined
  /**
   * Read the folded inbox for one session.
   * @param session - the session whose `questionBoard` projection is read.
   * @returns the questions, or undefined when the projection is not registered.
   */
  board(session: Session): QuestionSnapshot[] | undefined
}

/**
 * The inbox write/read logic, framework-free. `Session.append` is the durable
 * log; the projection folds what we append, so `answer`/`dismiss` find the
 * question through {@link QuestionBoardHost.board}.
 */
export class QuestionBoardRuntime {
  readonly #host: QuestionBoardHost

  /** @param host - live-agent and folded-board seams. */
  constructor(host: QuestionBoardHost) {
    this.#host = host
  }

  /**
   * Register a question in the asking session's inbox.
   * @param session - the asking session.
   * @param request - question body, options, and blocking intent.
   * @returns the new question's id.
   * @throws {QuestionBoardError} `DELEGATED_CALLER` when a delegated subagent
   *   asks a blocking question (design §5.7: children relay through the parent).
   */
  ask(session: Session, request: AskQuestionRequest): string {
    const blocking: QuestionBlocking = request.blocking === true ? 'blocking' : 'non-blocking'
    const delegated = session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0
    if (blocking === 'blocking' && delegated) {
      throw new QuestionBoardError(
        'a delegated subagent cannot ask a blocking question; relay it to the parent session, which asks on the child\'s behalf (design §5.7)',
        'DELEGATED_CALLER')
    }
    const id = `q-${session.seq}`
    session.append('question/asked', {
      id,
      asker: session.id,
      content: request.content,
      ...request.options === undefined ? {} : { options: request.options },
      blocking,
    })
    return id
  }

  /**
   * Answer a pending question and deliver the answer to the asker.
   * @param session - the session that owns the question.
   * @param id - question id.
   * @param answer - human answer (single choice/text or a batch of labels).
   * @returns whether the question was pending and is now answered.
   * @throws {QuestionBoardError} `BAD_ANSWER` when the answer is empty.
   */
  answer(session: Session, id: string, answer: string | string[]): boolean {
    const question = this.#host.board(session)?.find(item => item.id === id)
    if (question === undefined || question.status !== 'pending') return false
    const values = Array.isArray(answer) ? answer : [answer]
    if (values.length === 0 || values.some(value => typeof value !== 'string' || value.trim() === '')) {
      throw new QuestionBoardError('answer must be a non-empty string or a non-empty array of non-empty strings', 'BAD_ANSWER')
    }
    session.append('question/answered', { id, answer })
    this.#deliver(session, question, answer)
    return true
  }

  /**
   * Dismiss a pending question without an answer.
   * @param session - the session that owns the question.
   * @param id - question id.
   * @returns whether the question was pending and is now dismissed.
   */
  dismiss(session: Session, id: string): boolean {
    const question = this.#host.board(session)?.find(item => item.id === id)
    if (question === undefined || question.status !== 'pending') return false
    session.append('question/dismissed', { id })
    return true
  }

  /**
   * The session's questions in ask order.
   * @param session - the session whose inbox is read.
   * @returns a fresh array of snapshots (empty when the projection is absent).
   */
  list(session: Session): QuestionSnapshot[] {
    const board = this.#host.board(session)
    return board === undefined ? [] : [...board]
  }

  /** Wake (blocking) or quietly inform (non-blocking) a live asker of its answer. */
  #deliver(session: Session, question: QuestionSnapshot, answer: string | string[]): void {
    const agent = this.#host.agent(session.id)
    if (agent === undefined) return
    const message = createUserMessage({
      content: [{ type: 'text', text: renderAnswer(question, answer) }],
      source: { kind: 'dsh-question-board' },
    })
    if (question.blocking !== 'blocking') {
      agent.inject(message)
      return
    }
    if (agent.status === 'running') agent.steer(message)
    else agent.followup(message)
  }
}

/**
 * The cordis entry: registers the `questionBoard` projection, the global
 * `ask_question` tool, and the panel's `/answer_question` /
 * `/dismiss_question` commands, and exposes the inbox as `ctx.questionBoard`.
 */
export class QuestionBoardService extends Service {
  static inject = ['sessionProjections'] as const

  /** The framework-free inbox logic (the test seam). */
  readonly runtime: QuestionBoardRuntime

  /** @param ctx - the plugin context (sessionProjections is injected). */
  constructor(ctx: Context) {
    super(ctx, 'questionBoard')
    this.runtime = new QuestionBoardRuntime({
      agent: sessionId => ctx.get('agents')?.get(sessionId),
      board: session => ctx.sessionProjections.stateOf(session, 'questionBoard'),
    })
    ctx.sessionProjections.register(questionBoardProjection)
    ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.tools.register(defineAskQuestionTool({ ask: (session, request) => this.runtime.ask(session, request) }))
    })
    registerQuestionBoardCommands(ctx, this)
  }

  /**
   * Register a question in the asking session's inbox.
   * @param session - the asking session.
   * @param request - question body, options, and blocking intent.
   * @returns the new question's id.
   */
  ask(session: Session, request: AskQuestionRequest): string {
    return this.runtime.ask(session, request)
  }

  /**
   * Answer a pending question.
   * @param session - the session that owns the question.
   * @param id - question id.
   * @param answer - the human answer.
   * @returns whether it transitioned to answered.
   */
  answer(session: Session, id: string, answer: string | string[]): boolean {
    return this.runtime.answer(session, id, answer)
  }

  /**
   * Dismiss a pending question.
   * @param session - the session that owns the question.
   * @param id - question id.
   * @returns whether it transitioned to dismissed.
   */
  dismiss(session: Session, id: string): boolean {
    return this.runtime.dismiss(session, id)
  }

  /**
   * List a session's questions.
   * @param session - the session whose inbox is read.
   * @returns the questions in ask order.
   */
  list(session: Session): QuestionSnapshot[] {
    return this.runtime.list(session)
  }
}

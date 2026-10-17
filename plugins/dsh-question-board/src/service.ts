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
import { plainQuestionText, renderAnswer } from './board.ts'
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

/**
 * Structural probe for `ctx.userQuestions` (design §5.4's synchronous blocking
 * branch). Kept local: this package reaches the service by global name, never
 * by a package import.
 */
interface UserQuestionsProbe {
  ask(request: {
    questions: readonly {
      id: string
      question: string
      options?: readonly { label: string; description?: string }[]
    }[]
    agent?: Agent
    signal?: AbortSignal
  }): Promise<{
    answers: readonly { id: string; selected: readonly string[]; custom?: string }[]
  }>
}

/** Structural probe for `ctx.approval`, the fallback blocking provider. */
interface ApprovalProbe {
  request(req: {
    agent: Agent
    toolName: string
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
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
  /**
   * Resolve a blocking `ask_question` tool call that is waiting on this
   * question. A panel answer is already durable, so the caller must NOT also
   * deliver it as a wake.
   * @param session - the asking session.
   * @param id - the answered question id.
   * @param answer - the human answer.
   * @returns true when a waiting tool call consumed the answer.
   */
  resolveBlocking?(session: Session, id: string, answer: string | string[]): boolean
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
    // A blocking ask_question tool call may be waiting on this exact question:
    // it receives the answer as its tool result, so delivering a second wake
    // would duplicate it into the conversation.
    if (this.#host.resolveBlocking?.(session, id, answer) === true) return true
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
 * Its write/read methods live on {@link QuestionBoardService.runtime}, the same
 * framework-free object the commands and tool drive — no forwarding surface.
 */
export class QuestionBoardService extends Service {
  static inject = ['sessionProjections'] as const

  /** The framework-free inbox logic (the test seam). */
  readonly runtime: QuestionBoardRuntime

  /**
   * Blocking `ask_question` calls currently paused, keyed by session + question.
   * A panel answer (`/answer_question`) resolves the exact waiting call instead
   * of delivering a second wake.
   */
  private readonly blockingWaits = new Map<string, {
    resolve(answer: string | string[]): void
    cancel(): void
  }>()

  /** @param ctx - the plugin context (sessionProjections is injected). */
  constructor(ctx: Context) {
    super(ctx, 'questionBoard')
    this.runtime = new QuestionBoardRuntime({
      agent: sessionId => ctx.get('agents')?.get(sessionId),
      board: session => ctx.sessionProjections.stateOf(session, 'questionBoard'),
      resolveBlocking: (session, id, answer) => this.resolveBlocking(session, id, answer),
    })
    ctx.sessionProjections.register(questionBoardProjection)
    ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.tools.register(defineAskQuestionTool({
        ask: (session, request) => this.runtime.ask(session, request),
        askBlocking: (session, id, request, agent, signal) =>
          this.askBlocking(session, id, request, agent, signal),
      }))
    })
    registerQuestionBoardCommands(ctx, this.runtime)
  }

  /** The wait map key: one blocking call per session-local question. */
  private waitKey(session: Session, id: string): string {
    return `${String(session.id)}\u0000${id}`
  }

  /** Resolve a waiting blocking call with a panel answer (see {@link QuestionBoardHost}). */
  private resolveBlocking(session: Session, id: string, answer: string | string[]): boolean {
    const key = this.waitKey(session, id)
    const wait = this.blockingWaits.get(key)
    if (wait === undefined) return false
    this.blockingWaits.delete(key)
    // Stop the competing userQuestions/approval wait; the panel answer wins.
    wait.cancel()
    wait.resolve(answer)
    return true
  }

  /**
   * Pause the calling turn until the human answers. The blocking branch reuses
   * `ctx.userQuestions` (design §5.4), falling back to `ctx.approval` when the
   * interactive question service is absent. A panel answer to the same
   * question resolves the wait too, so either UI settles the same tool call.
   */
  private async askBlocking(
    session: Session,
    id: string,
    request: AskQuestionRequest,
    agent: Agent | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const userQuestions = this.ctx.get('userQuestions') as UserQuestionsProbe | undefined
    const approval = this.ctx.get('approval') as ApprovalProbe | undefined
    if (userQuestions === undefined && approval === undefined) {
      throw new QuestionBoardError(
        'blocking ask_question needs ctx.userQuestions or ctx.approval, neither of which is composed',
        'NO_HUMAN_PROVIDER',
      )
    }
    if (signal?.aborted === true) {
      throw new QuestionBoardError('ask_question was aborted before the human answered', 'ASK_ABORTED')
    }
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    const key = this.waitKey(session, id)
    const question = plainQuestionText(request.content)
    const panel = new Promise<string | string[]>((resolve) => {
      this.blockingWaits.set(key, {
        resolve,
        cancel: () => { controller.abort() },
      })
    })
    try {
      if (userQuestions !== undefined) {
        const asked = userQuestions.ask({
          questions: [{
            id,
            question,
            ...request.options === undefined ? {} : { options: request.options },
          }],
          ...agent === undefined ? {} : { agent },
          signal: controller.signal,
        })
        const settled = await Promise.race([
          asked.then(result => ({ source: 'questions' as const, value: result })),
          panel.then(answer => ({ source: 'panel' as const, value: answer })),
        ])
        if (settled.source === 'panel') return normalizeAnswer(settled.value)
        const answer = settled.value.answers.find(item => item.id === id) ?? settled.value.answers[0]
        const text = answer === undefined
          ? '(no answer)'
          : [...answer.selected, ...(answer.custom === undefined || answer.custom.trim() === '' ? [] : [answer.custom.trim()])].join(', ') || '(no answer)'
        session.append('question/answered', { id, answer: text })
        return text
      }
      // Approval fallback: the prompt's reason IS the question; only an
      // affirmative answer settles the ask.
      if (agent === undefined) {
        throw new QuestionBoardError('blocking ask_question has no live calling agent for ctx.approval', 'CALLER_NOT_LIVE')
      }
      const requested = approval!.request({
        agent,
        toolName: 'ask_question',
        reason: question,
        signal: controller.signal,
      })
      const settled = await Promise.race([
        requested.then(outcome => ({ source: 'approval' as const, value: outcome })),
        panel.then(answer => ({ source: 'panel' as const, value: answer })),
      ])
      if (settled.source === 'panel') return normalizeAnswer(settled.value)
      if (settled.value !== 'allowed-once') {
        throw new QuestionBoardError(`blocking ask_question was not answered (${settled.value})`, 'NOT_APPROVED')
      }
      session.append('question/answered', { id, answer: 'approved' })
      return 'approved'
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.blockingWaits.delete(key)
    }
  }
}

/** Normalize a panel/human answer to one display string. */
function normalizeAnswer(answer: string | string[]): string {
  const text = Array.isArray(answer) ? answer.join(', ') : answer
  return text.trim() === '' ? '(no answer)' : text
}

/**
 * Advisory delivery: severity routing to the primary agent (inject vs steer
 * vs terminal-answer card), the immuneTurns budget that downgrades repeated
 * concern/blocker advice to asides, and the terminal-answer policy that
 * preserves a concern as a card instead of extending a finished turn.
 *
 * Routing decisions are pure ({@link decideDelivery}); the stateful
 * {@link DeliveryController} tracks the primary's terminal-answer state,
 * the immune budget, and the queued-steer/deferred-card slots that the
 * runtime resolves at `agent/pre-step`, `agent/turn-stopping`, and
 * `turn/end` boundaries.
 *
 * @module @dsh-plugin/dsh-advisor/delivery
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { escapeXml } from '@dsh-plugin/dsh-util/xml'
import type { Severity } from './severity.ts'
import { isInterrupting } from './severity.ts'

/**
 * The plugin's own message-source kind in the primary session. Declared in
 * `@deepseek-ai/dsh-llm`'s `MessageSourceMap` (see `src/index.ts`); the old
 * shared `{ kind: 'plugin', plugin }` vocabulary is gone.
 */
export const ADVISOR_SOURCE_KIND = 'dsh-advisor'

/**
 * Render an advisory note as the model-visible XML card delivered to the
 * primary agent.
 * @param note - the advisory note.
 * @param severity - the advisory grade.
 * @returns the rendered advisory text.
 */
export function renderAdvisory(note: string, severity: Severity): string {
  return `<advisory severity="${severity}" guidance="weigh, don't blindly obey">${escapeXml(note)}</advisory>`
}

/**
 * Build the user message delivered to the primary agent: plugin-sourced,
 * `notice` form with a bounded one-line summary.
 * @param note - the advisory note.
 * @param severity - the advisory grade.
 * @returns a frozen user message.
 */
export function advisoryMessage(note: string, severity: Severity): UserMessage {
  const text = renderAdvisory(note, severity)
  const summary = boundContextSummary(`advisor (${severity}): ${note.replace(/\s+/g, ' ').trim()}`)
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: ADVISOR_SOURCE_KIND, form: 'notice', summary },
  })
}

/** How one advisory reaches the primary agent. */
export type DeliveryChannel = 'inject' | 'steer' | 'card' | 'none'

/** The primary agent's state at a delivery decision. */
export interface PrimaryState {
  /** Whether a driver is active (`agent.status === 'running'`). */
  readonly running: boolean
  /** Whether the inbox holds queued or steering work. */
  readonly hasQueuedWork: boolean
  /** Whether the most recent completed turn ended with no queued work (a terminal answer). */
  readonly lastTurnTerminal: boolean
  /** Whether we are inside the `agent/turn-stopping` boundary of the current turn. */
  readonly atTurnStopping: boolean
}

/** Result of one {@link decideDelivery} call. */
export interface DeliveryDecision {
  readonly channel: DeliveryChannel
  /**
   * When `true` the advisory must wait for the current turn's `turn/end`
   * before delivery (the terminal-answer card). Only `card` decisions set it.
   */
  readonly deferred?: boolean
  /** Whether a concern/blocker was downgraded to an aside by the immune budget. */
  readonly downgraded?: boolean
}

/**
 * Pure routing decision for one advisory.
 *
 * - `nit` → inject (non-waking aside).
 * - `concern` while running → steer at the next step boundary; at the
 *   turn-stopping boundary → deferred card (do not extend the turn).
 * - `concern` while idle → card when the last turn ended with a terminal
 *   answer and no work is queued, otherwise steer (new turn).
 * - `blocker` → always steer (a terminal answer is still extended).
 * - A concern/blocker under the immune budget downgrades to an aside
 *   (inject) regardless of state.
 *
 * @param severity - the advisory grade.
 * @param state - the primary agent's state.
 * @param immuneActive - whether the immune budget still suppresses interrupts.
 * @returns the delivery decision.
 */
export function decideDelivery(
  severity: Severity,
  state: PrimaryState,
  immuneActive: boolean,
): DeliveryDecision {
  if (isInterrupting(severity) && immuneActive) {
    return { channel: 'inject', downgraded: true }
  }
  switch (severity) {
    case 'nit':
      return { channel: 'inject' }
    case 'concern':
      if (state.running) {
        return state.atTurnStopping
          ? { channel: 'card', deferred: true }
          : { channel: 'steer' }
      }
      return state.lastTurnTerminal && !state.hasQueuedWork
        ? { channel: 'card' }
        : { channel: 'steer' }
    case 'blocker':
      return { channel: 'steer' }
    default:
      return { channel: 'none' }
  }
}

/** Options for {@link DeliveryController}. */
export interface DeliveryControllerOptions {
  /** Primary turns a successful concern/blocker delivery suppresses interrupts (default 3). */
  readonly immuneTurns: number
}

/** A queued concern/blocker awaiting a step or turn boundary. */
export interface QueuedSteer {
  readonly severity: Severity
  readonly message: UserMessage
}

/**
 * Stateful delivery bookkeeping for one primary agent: immune budget,
 * terminal-answer tracking, and the queued-steer/deferred-card slots the
 * runtime resolves at step and turn boundaries.
 */
export class DeliveryController {
  private immuneRemaining = 0
  private terminal = false
  private queued: QueuedSteer | undefined
  private card: UserMessage | undefined

  constructor(private readonly options: DeliveryControllerOptions) {
    if (!Number.isSafeInteger(options.immuneTurns) || options.immuneTurns < 1) {
      throw new Error(`DeliveryController immuneTurns must be a positive safe integer, got ${String(options.immuneTurns)}`)
    }
  }

  /** Whether the immune budget still downgrades concern/blocker advice. */
  get immuneActive(): boolean {
    return this.immuneRemaining > 0
  }

  /** Whether the most recent turn ended with a terminal answer and no queued work. */
  get lastTurnTerminal(): boolean {
    return this.terminal
  }

  /** A concern/blocker awaiting the next step or turn boundary. */
  get queuedSteer(): QueuedSteer | undefined {
    return this.queued
  }

  /** A concern awaiting the current turn's `turn/end` (terminal-answer card). */
  get deferredCard(): UserMessage | undefined {
    return this.card
  }

  /** Clear every slot, the terminal flag, and the immune budget (reset signal). */
  reset(): void {
    this.immuneRemaining = 0
    this.terminal = false
    this.queued = undefined
    this.card = undefined
  }

  /**
   * Queue a concern/blocker received while the primary is running. The
   * runtime resolves the slot at the next `agent/pre-step` (steer) or
   * `agent/turn-stopping` (blocker steers, concern becomes the deferred card).
   */
  queue(severity: Severity, message: UserMessage): void {
    this.queued = { severity, message }
  }

  /** Take the queued steer for immediate delivery at a step boundary. */
  takeQueuedSteer(): QueuedSteer | undefined {
    const queued = this.queued
    this.queued = undefined
    return queued
  }

  /** Convert the queued steer into the deferred terminal-answer card. */
  deferQueuedSteerAsCard(): void {
    if (this.queued !== undefined) {
      this.card = this.queued.message
      this.queued = undefined
    }
  }

  /** Take the deferred card for delivery after `turn/end`. */
  takeDeferredCard(): UserMessage | undefined {
    const card = this.card
    this.card = undefined
    return card
  }

  /**
   * The primary's turn closed. Updates the terminal-answer state, spends one
   * immune-budget turn, and preserves any still-queued steer as a card (a
   * turn that closed without a step boundary — abort or error — must not
   * drop the advisory).
   * @param hasQueuedWork - whether the inbox holds work at close time.
   */
  onPrimaryTurnEnd(hasQueuedWork: boolean): void {
    this.terminal = !hasQueuedWork
    if (this.immuneRemaining > 0) this.immuneRemaining--
    if (this.queued !== undefined) {
      this.card = this.queued.message
      this.queued = undefined
    }
  }

  /** A concern/blocker was delivered (steer or card): start the immune window. */
  spendBudget(): void {
    this.immuneRemaining = this.options.immuneTurns
  }

  /** Human input was claimed: the immune window ends and the terminal state resets. */
  onUserInput(): void {
    this.immuneRemaining = 0
    this.terminal = false
  }
}

/**
 * Whether an agent's inbox still holds accepted work. `Inbox.hasPending` was
 * removed from the public interface; this is the inlined upstream predicate
 * (`nextTurn` or `nextStep` non-empty).
 * @param agent - the agent whose inbox to read.
 * @returns whether either inbox destination is non-empty.
 */
export function inboxHasPending(agent: Agent): boolean {
  return agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
}

/** Primary state read off a live agent. */
export function readPrimaryState(
  primary: Agent,
  atTurnStopping: boolean,
  terminal: boolean,
): PrimaryState {
  return {
    running: primary.status === 'running',
    hasQueuedWork: inboxHasPending(primary),
    lastTurnTerminal: terminal,
    atTurnStopping,
  }
}

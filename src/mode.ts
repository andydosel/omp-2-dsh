/**
 * Compact-mode collaboration state: while active, the live loop is paused and
 * every claimed user message is captured as a review instruction (see the
 * engine's pre-step listener). The state in force is folded from the session
 * log (`compact/mode`, last one wins), so resume and fork restore it without a
 * live mirror.
 *
 * NOTE ON PERSISTENCE CATALOG: `compact/mode` is declared here as a module
 * augmentation of `SessionEventMap`. In this standalone out-of-tree plugin the
 * event is consumed only by OUR code, so no persistence catalog regeneration
 * is needed. A FUTURE in-repo move MUST re-run `pnpm run gen-persistence-catalog`
 * (regenerates packages/core/session/src/known-event-types.ts +
 * docs/persistence-catalog.md) or CI verify-persistence-catalog fails and the
 * persistence read side rejects logs containing this event.
 *
 * @module @dsh-plugin/dsh-compact-mode/mode
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whether compact mode is in force from this point on: log-only,
     * non-surface, whole-value replace. The last `compact/mode` wins; a log
     * with none folds to inactive through {@link foldCompactMode}.
     */
    'compact/mode': { active: boolean }
  }
}

/**
 * Whether compact mode is active after the first `end` events. The last
 * `compact/mode` wins; a prefix with none is inactive.
 *
 * @param events - the session log or any prefix of it.
 * @param end - fold `events[0, end)`; defaults to the whole log.
 * @returns whether compact mode is active.
 */
export function foldCompactMode(events: readonly SessionEvent[], end = events.length): boolean {
  let active = false
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === 'compact/mode') active = event.data.active
  }
  return active
}

/** Whether the log holds an opened turn without its closing `turn/end`. */
export function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/** Compact state at the last logged request header, or `undefined` before the first header. */
export function compactModeAtLastHeader(events: readonly SessionEvent[]): boolean | undefined {
  let lastHeader = -1
  let index = 0
  for (const event of events) {
    if (event.type === 'request/header') lastHeader = index
    index++
  }
  if (lastHeader < 0) return undefined
  return foldCompactMode(events, lastHeader + 1)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    compactMode: CompactModeController
  }
}

/**
 * `ctx.compactMode`: owns the logged compact-mode state with plan-mode-style
 * selection semantics (committed between turns, pending during an open turn)
 * and a user-switch narration notice. UIs observe committed flips through
 * `session/event`; there is no live mirror.
 *
 * Cross-plugin mutex contract (vibe-mode etc.): read via
 * `ctx.get('compactMode')` as
 * `{ get(agent: Agent): { active: boolean; pending?: boolean } } | undefined`.
 */
export class CompactModeController extends Service {
  /**
   * Latest selection per session awaiting the next accepted in-turn pre-step.
   * `narrate` is true for user selections and false for programmatic flips.
   */
  private readonly pendingIntents = new WeakMap<Session, { active: boolean; narrate: boolean }>()

  constructor(ctx: Context) {
    super(ctx, 'compactMode')
    // Pre-step is outside Session.append publication, so a pending selection
    // can be appended inside an open turn without re-entering the session.
    // A failed append remains pending for a later accepted in-turn pre-step.
    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      const pending = this.pendingIntents.get(agent.session)
      if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision
      try {
        this.onBoundary(agent.session)
      } catch (error) {
        ctx.logger.warn('dsh-compact-mode: failed to append selected compact mode at step start: %o', error)
        return decision
      }
      return decision
    })
  }

  /**
   * Read the logged compact state and any selected state awaiting the next
   * accepted in-turn pre-step.
   *
   * @param agent - the agent to read.
   * @returns current logged state plus a pending selection, when present.
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = foldCompactMode(agent.session.events)
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * Select whether compact mode should be active. Between turns the method
   * appends the change immediately because no in-turn pre-step will run until
   * another prompt starts a turn. During an open turn the selection remains
   * pending until the next accepted in-turn pre-step. Repeated selection of
   * the current or already-pending state is a no-op.
   *
   * NOTE: entering compact mode additionally requires command state (no open
   * turn) because the review lock (`compaction/start`, owner null) can only be
   * written between turns. The engine enforces that contract on top of this
   * mode event.
   *
   * @param agent - the agent to switch.
   * @param active - whether compact mode should be active.
   * @returns what happened: `committed`, `queued`, `cancelled`, or `noop`.
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const target = pending?.active ?? foldCompactMode(session.events)
    if (active === target) return 'noop'
    if (hasOpenTurn(session.events)) {
      this.pendingIntents.set(session, { active, narrate: true })
      return foldCompactMode(session.events) === active ? 'cancelled' : 'queued'
    }
    if (active === foldCompactMode(session.events)) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    session.append('compact/mode', { active })
    this.pendingIntents.delete(session)
    const narration = this.narration(session, active)
    if (narration !== undefined) agent.inject(narration)
    return 'committed'
  }

  /** Append one pending selection before the next request assembly. */
  private onBoundary(session: Session): void {
    const pending = this.pendingIntents.get(session)
    if (pending === undefined) return
    const target = pending.active
    if (target === foldCompactMode(session.events)) {
      this.pendingIntents.delete(session)
      return
    }
    session.append('compact/mode', { active: target })
    this.pendingIntents.delete(session)
  }

  /** Build a user-switch notice when the last logged header described the other mode. */
  private narration(session: Session, target: boolean): UserMessage | undefined {
    const told = compactModeAtLastHeader(session.events)
    if (told === undefined || told === target) return
    const text = target
      ? 'The user switched this session to compact mode: the live loop is paused; messages are review instructions until /compact_apply or /compact_abort.'
      : 'The user switched this session back to the default mode.'
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-compact-mode', form: 'notice', summary: text },
    })
  }
}

export default CompactModeController

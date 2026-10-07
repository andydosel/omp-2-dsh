/**
 * Compact-mode collaboration state: while active, the live loop is paused and
 * every claimed user message is captured as a review instruction (see the
 * engine's pre-step listener). The state in force is read from the
 * plugin-owned store (`compact/mode` was a session event; it is now plugin
 * state with a JSON snapshot), so the UI projection and the cross-plugin mutex
 * read the store rather than the session log.
 *
 * @module @dsh-plugin/dsh-compact-mode/mode
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { CompactModeStore } from './state-store.ts'

/** Whether the log holds an opened turn without its closing `turn/end`. */
export function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    compactMode: CompactModeController
  }
}

/**
 * `ctx.compactMode`: owns the plugin-owned compact-mode state with
 * plan-mode-style selection semantics (committed between turns, pending during
 * an open turn) and a user-switch narration notice. UIs observe flips through
 * the plugin store.
 *
 * Cross-plugin read contract: consumers read `ctx.get('compactMode')` as
 * `{ get(agent: Agent): { active: boolean; pending?: boolean } } | undefined`
 * — the mode-ui projection uses it for the compact badge, and other exclusive
 * modes use it for mutual exclusion.
 */
export class CompactModeController extends Service {
  /** Plugin-owned mode state (active flag), persisted to JSON. */
  readonly store = new CompactModeStore()

  /** The last mode narrated to the model, per session. */
  private readonly lastNarrated = new WeakMap<Session, boolean>()

  /**
   * Latest selection per session awaiting the next accepted in-turn pre-step.
   * `narrate` is true for user selections and false for programmatic flips.
   */
  private readonly pendingIntents = new WeakMap<Session, { active: boolean; narrate: boolean }>()

  constructor(ctx: Context) {
    super(ctx, 'compactMode')
    void this.store.load().catch((error: unknown) => {
      ctx.logger.warn('dsh-compact-mode: failed to load mode state snapshot: %o', error)
    })
    // Pre-step is outside Session.append publication, so a pending selection
    // can be applied inside an open turn without re-entering the session.
    // A failed apply remains pending for a later accepted in-turn pre-step.
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
        ctx.logger.warn('dsh-compact-mode: failed to apply selected compact mode at step start: %o', error)
        return decision
      }
      return decision
    })

    // Resume/fork: seed the last-narrated marker from the store so a resumed
    // compact session doesn't re-narrate the entry it already told the model.
    // `agent/created` is serial and awaited, so this handler stays synchronous
    // (it must not await its own agent's lifecycle).
    ctx.on('agent/created', ({ agent }): undefined => {
      this.lastNarrated.set(agent.session, this.store.get(agent.session.id).active)
      return undefined
    })
  }

  /**
   * Read the plugin-owned compact state and any selected state awaiting the
   * next accepted in-turn pre-step.
   *
   * @param agent - the agent to read.
   * @returns current store state plus a pending selection, when present.
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = this.store.get(agent.session.id).active
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * Select whether compact mode should be active. Between turns the method
   * applies the change immediately because no in-turn pre-step will run until
   * another prompt starts a turn. During an open turn the selection remains
   * pending until the next accepted in-turn pre-step. Repeated selection of
   * the current or already-pending state is a no-op.
   *
   * @param agent - the agent to switch.
   * @param active - whether compact mode should be active.
   * @returns what happened: `committed`, `queued`, `cancelled`, or `noop`.
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const target = pending?.active ?? this.store.get(session.id).active
    if (active === target) return 'noop'
    if (hasOpenTurn(session.snapshotEvents())) {
      this.pendingIntents.set(session, { active, narrate: true })
      return this.store.get(session.id).active === active ? 'cancelled' : 'queued'
    }
    if (active === this.store.get(session.id).active) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    this.store.setActive(session.id, active)
    this.pendingIntents.delete(session)
    const narration = this.narration(session, active)
    if (narration !== undefined) agent.inject(narration)
    return 'committed'
  }

  /** Apply one pending selection before the next request assembly. */
  private onBoundary(session: Session): void {
    const pending = this.pendingIntents.get(session)
    if (pending === undefined) return
    const target = pending.active
    if (target === this.store.get(session.id).active) {
      this.pendingIntents.delete(session)
      return
    }
    this.store.setActive(session.id, target)
    this.pendingIntents.delete(session)
  }

  /** Build a user-switch notice when the mode actually changed. */
  private narration(session: Session, target: boolean): UserMessage | undefined {
    const told = this.lastNarrated.get(session)
    this.lastNarrated.set(session, target)
    if (told === target) return
    const text = target
      ? 'The user switched this session to compact mode: the live loop is paused; messages are review instructions until /compact_apply or /compact_abort.'
      : 'The user switched this session back to the default mode.'
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-compact-mode', form: 'notice', summary: text },
    })
  }
}

export default CompactModeController

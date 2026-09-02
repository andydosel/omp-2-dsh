/**
 * Vibe-mode state machine: plugin-owned active state (no `vibe/mode` session
 * event), pending selections, the step-boundary commit, narration, and the
 * plan/compact mutex. Mirrors `@deepseek-ai/dsh-plan-mode`'s controller shape:
 * the state in force is read from the plugin-owned store, selections remain
 * pending until the next accepted in-turn pre-step, and the change is
 * applied at `agent/pre-step` only when the step is accepted.
 *
 * The controller IS the plugin (plan-mode pattern): it also owns the `/vibe`
 * command (including `/vibe restore`), the per-director narrowing lifecycle
 * (through {@link applyDirectorScope}), and the worker park/drain lifecycle.
 *
 * @module @dsh-plugin/dsh-vibe-mode/mode
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ZodType } from 'zod'
import { z as zod } from 'zod'
// Type-only edge: resolves `ctx.commands` for the command child.
import type {} from '@deepseek-ai/dsh-commands'
// Type-only edge: resolves `ctx.sessionProjections` for the projection unit.
import type {} from '@deepseek-ai/dsh-session-projection'
import {
  DEFAULT_DIRECTOR_SECTION,
  resolveConfig,
  VibeModeConfigSchema,
  type ResolvedVibeModeConfig,
  type VibeModeConfig,
  type VibeWorkersProjection,
} from './types.ts'
import { VibeModeStore } from './state-store.ts'
import { applyDirectorScope, type DirectorScope } from './director.ts'

/** Whether the log holds an opened turn without its closing `turn/end`. */
function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/**

 * The structural mutex probe for a sibling mode service. Read through
 * `ctx.get(name)` with this cast — the sibling owns the Context declaration,
 * so an optional structural placeholder here cannot conflict on interface
 * merge (compact-mode contract).
 */
type ModeServiceProbe = {
  get(agent: Agent): { active: boolean; pending?: boolean }
}

/** Thrown when a conflicting mode is active at vibe entry. */
export class VibeModeConflictError extends Error {
  constructor(readonly conflict: 'plan' | 'compact') {
    super(`cannot enter vibe mode while ${conflict} mode is active — leave it first`)
    this.name = 'VibeModeConflictError'
  }
}

/** Wire schema of the `vibeWorkers` projection (validated before leaving the host). */
const vibeWorkersSchema: ZodType<VibeWorkersProjection> = zod.object({
  workers: zod.array(zod.object({
    id: zod.string(),
    name: zod.string().optional(),
    tier: zod.enum(['fast', 'good']),
    state: zod.enum(['starting', 'running', 'idle', 'parked', 'dead']),
    turn: zod.number().int().nonnegative(),
    lastActivity: zod.string().optional(),
  })),
})

/**
 * `ctx.vibeMode`: owns the logged vibe-mode state, applies and narrates
 * selected state at step start, enforces the plan/compact mutex, and drives
 * the DIRECTOR narrowing + worker lifecycle through the `/vibe` command.
 */
export class VibeModeController extends Service {
  static inject = ['subagents', 'tools', 'systemPrompt', 'agents']

  /** Validated deployment config. */
  readonly config: ResolvedVibeModeConfig

  /**
   * Live DIRECTOR-instructions text source for the `director:instructions`
   * section thunk. Starts at the frozen config; the settings seam (below)
   * swaps it for the resolved namespace when attached, so a runtime settings
   * change reaches the next prompt assembly without restart or re-entry.
   */
  private sectionSource: () => string

  /** Plugin-owned mode state (active flag + worker roster), persisted to JSON. */
  readonly store = new VibeModeStore()

  /**
   * The last mode the controller narrated to the model, per session. Undefined
   * until the first change; session-start seeds it from the store (resume).
   */
  private readonly lastNarrated = new WeakMap<Session, boolean>()

  /**
   * Latest selection per session awaiting the next accepted in-turn pre-step.
   * `narrate` is true for user selections (the `/vibe` command).
   */
  private readonly pendingIntents = new WeakMap<Session, { active: boolean; narrate: boolean }>()

  /** Live per-agent director scopes (narrowing + worker bookkeeping). */
  private readonly scopes = new WeakMap<Agent, DirectorScope>()

  constructor(ctx: Context, config: VibeModeConfig = {}) {
    super(ctx, 'vibeMode')
    this.config = resolveConfig(config)
    this.sectionSource = () => this.config.section
    void this.store.load().catch((error: unknown) => {
      ctx.logger.warn('dsh-vibe-mode: failed to load mode state snapshot: %o', error)
    })

    // Runtime DIRECTOR-instructions settings: the `dsh-vibe-mode` namespace
    // resolves settings-user-layer → composition config (base) → schema
    // defaults; the section thunk reads the live source. The browser
    // settings panel can only touch this namespace because the host's
    // api-proxy whitelist exposes it (added by the annex worker); without
    // that entry every client read/write answers `settings-not-exposed`.
    installSettingsSection(ctx, settingsNamespace('dsh-vibe-mode'), VibeModeConfigSchema, config, {
      setSource: (source) => {
        this.sectionSource = () => source().section ?? config.section ?? DEFAULT_DIRECTOR_SECTION
      },
      onChange: () => {},
    })

    // The `vibeWorkers` projection unit (session-projection RFC): serves
    // clients the live roster from the plugin-owned store (no session event).
    // The projection is session-agnostic, so `apply` re-syncs from the store's
    // current roster on every committed event and returns the same reference
    // when unchanged (the registry's Object.is gate).
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'vibeWorkers', VibeWorkersProjection>({
        key: 'vibeWorkers',
        stateSchema: vibeWorkersSchema,
        init: () => ({ workers: this.store.current().workers }),
        apply: (state) => {
          const workers = this.store.current().workers
          return workers === state.workers ? state : { workers }
        },
        wire: { viewSchema: vibeWorkersSchema, view: state => ({ workers: state.workers }) },
        stateVersion: 1,
      })
    })

    // Pre-step is outside Session.append publication, so it can append the
    // log-only mode event inside an open turn without re-entering the session.
    // A failed append remains pending for a later accepted in-turn pre-step.
    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      const pending = this.pendingIntents.get(agent.session)
      if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision
      const narration = this.narration(agent.session, pending.active)
      try {
        this.onBoundary(agent.session)
      } catch (error) {
        ctx.logger.warn('dsh-vibe-mode: failed to append selected vibe mode at step start: %o', error)
        return decision
      }
      return !pending.narrate || narration === undefined
        ? decision
        : { ...decision, messages: [...decision.messages, narration] }
    })

    // The `/vibe` command. Empty/on enters; `off` parks workers and exits;
    // `off --terminate` drains the worker forest and exits.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'vibe',
        description: 'Enter, leave, or restore DIRECTOR mode (workers: vibe_spawn/send/wait/kill/list)',
        input: { hint: '[on|off|off --terminate|restore]' },
        handler: async ({ agent, rawInput }) => {
          const message = rawInput.trim()
          if (message === 'off' || message === 'off --terminate') {
            const scope = this.scopes.get(agent)
            if (scope === undefined && !this.store.get(agent.session.id).active) {
              this.set(agent, false)
              return { kind: 'success' as const, text: 'Vibe mode is already inactive.' }
            }
            if (scope !== undefined) {
              if (message === 'off --terminate') {
                // Hard destroy: permanently closes continuable admission for
                // this director tree until it leaves the registry — only reachable
                // through an explicit --terminate or director disposal.
                await ctx.subagents.drainContinuableDescendants([agent])
              } else {
                // Default park: stop each live worker's current turn; sessions,
                // inboxes, and descendants survive for later resume.
                for (const worker of scope.registry.list()) {
                  ctx.subagents.interrupt(worker.childId, { kind: 'ancestor', agent })
                }
                scope.registry.parkAll()
              }
              this.scopes.delete(agent)
              scope.dispose()
            }
            const outcome = this.set(agent, false)
            const text = message === 'off --terminate'
              ? 'Vibe mode off; all workers terminated.'
              : outcome === 'queued'
                ? 'Leaving vibe mode (applies from the next step); workers parked.'
                : 'Vibe mode off; workers parked.'
            return { kind: 'success' as const, text }
          }
          // One-click restore: re-apply the runtime scope (narrowing + sections)
          // and re-attach the persisted worker roster for a session whose saved
          // state is active. Idempotent.
          if (message === 'restore') {
            if (this.store.get(agent.session.id).active) {
              if (this.scopes.get(agent) === undefined) {
                const scope = applyDirectorScope(ctx, agent, this.config, this.store, this.sectionSource)
                scope.registry.seed(this.store.get(agent.session.id).workers)
                this.scopes.set(agent, scope)
              }
              return { kind: 'success' as const, text: 'DIRECTOR mode restored: toolset narrowed; workers re-attached.' }
            }
            return { kind: 'success' as const, text: 'No saved DIRECTOR state for this session.' }
          }
          // Enter: mutex conflicts throw and surface as the command error.
          try {
            const outcome = this.set(agent, true)
            if (this.scopes.get(agent) === undefined) {
              const scope = applyDirectorScope(ctx, agent, this.config, this.store, this.sectionSource)
              scope.registry.seed(this.store.get(agent.session.id).workers)
              this.scopes.set(agent, scope)
            }
            const text = outcome === 'queued'
              ? 'Entering DIRECTOR mode (applies from the next step).'
              : 'DIRECTOR mode on: toolset narrowed; use vibe_spawn/send/wait/kill/list for workers.'
            return { kind: 'success' as const, text }
          } catch (error) {
            if (error instanceof Error && error.name === 'VibeModeConflictError') {
              return { kind: 'error' as const, text: error.message }
            }
            throw error
          }
        },
      })
    })

    // Resume/fork restore: a director session whose plugin-owned state says
    // vibe mode is active gets its narrowing re-applied (the scoped
    // registrations died with the previous agent), and the worker roster is
    // seeded from the persisted snapshot. Workers restore themselves via the
    // persisted `subagent/descriptor`; this restores the director's own tool
    // surface and the dock roster.
    ctx.on('agent/session-start', ({ agent }) => {
      this.lastNarrated.set(agent.session, this.store.get(agent.session.id).active)
      if (!this.store.get(agent.session.id).active) return
      if (this.scopes.get(agent) !== undefined) return
      const scope = applyDirectorScope(ctx, agent, this.config, this.store, this.sectionSource)
      scope.registry.seed(this.store.get(agent.session.id).workers)
      this.scopes.set(agent, scope)
    })

    // Director disposal fallback: drain the worker forest (the director is
    // leaving the registry, so the continuable-admission closure is moot) and
    // dispose the scoped narrowing.
    ctx.on('agent/disposed', ({ agent }) => {
      const scope = this.scopes.get(agent)
      if (scope === undefined) return
      this.scopes.delete(agent)
      scope.dispose()
      void ctx.subagents.drainContinuableDescendants([agent]).catch((error: unknown) => {
        ctx.logger.warn('dsh-vibe-mode: failed to drain workers of disposed director %s: %o', agent.id, error)
      })
    })
  }

  /**
   * Read the plugin-owned vibe state and any selected state awaiting the next
   * accepted in-turn pre-step.
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = this.store.get(agent.session.id).active
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * Select whether vibe mode should be active. Between turns the change
   * lands immediately; during an open turn it stays pending until the next
   * accepted in-turn pre-step. Entering while plan or compact mode is active
   * throws {@link VibeModeConflictError}.
   *
   * @returns what happened: `committed` (applied now), `queued` (awaiting the
   * next accepted in-turn pre-step), `cancelled` (an opposite pending
   * selection was cleared; the state already matches), or `noop`.
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    if (active) this.assertEnterable(agent)
    const pending = this.pendingIntents.get(session)
    const target = pending?.active ?? this.store.get(session.id).active
    if (active === target) return 'noop'
    if (hasOpenTurn(session.events)) {
      this.pendingIntents.set(session, { active, narrate: true })
      return this.store.get(session.id).active === active ? 'cancelled' : 'queued'
    }
    if (active === this.store.get(session.id).active) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    // No open turn: commit now.
    this.store.setActive(session.id, active)
    this.pendingIntents.delete(session)
    const narration = this.narration(session, active)
    if (narration !== undefined) agent.inject(narration)
    return 'committed'
  }

  /**
   * Throw when entering vibe mode is blocked by an active sibling mode.
   * Read via `ctx.get(name)` with a structural probe: the sibling package
   * owns the Context declaration, so we never declare `compactMode`/`planMode`
   * here and the optional read is a plain service lookup (undefined when the
   * sibling plugin is not mounted).
   */
  assertEnterable(agent: Agent): void {
    const ctx = this.ctx
    const plan = ctx.get('planMode') as ModeServiceProbe | undefined
    if (plan?.get(agent).active === true) {
      throw new VibeModeConflictError('plan')
    }
    const compact = ctx.get('compactMode') as ModeServiceProbe | undefined
    if (compact?.get(agent).active === true) {
      throw new VibeModeConflictError('compact')
    }
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
      ? 'The user switched this session to DIRECTOR (vibe) mode: your toolset is narrowed and you must delegate all work to vibe_* workers instead of doing it yourself.'
      : 'The user switched this session back to the default mode.'
    return createUserMessage({
      content: [{ type: 'text', text }],
      // The narration is already one sentence, so it is its own summary.
      source: { kind: 'plugin', plugin: 'vibe-mode', form: 'notice', summary: text },
    })
  }
}

export default VibeModeController

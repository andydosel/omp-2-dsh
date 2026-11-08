/**
 * Advisor runtime: binds to the primary agent, creates and owns one or more
 * reviewer agents (full agents with their own loop), feeds them primary
 * transcript deltas via `followup`, observes their `advise` tool calls on the
 * reviewer sessions, routes severity-graded advice to the primary agent, and
 * rebuilds everything on compaction/rewrite/fork/resume reset signals.
 *
 * Reviewer construction (per the confirmed v1.1 architecture):
 * 1. join the primary agent's preset composition (`composeFrom`);
 * 2. restrict inherited global tools to the allow-list (`tools.restrict`);
 * 3. register the scoped `advise` tool (mask-immune scoped registration);
 * 4. pin delegated policy (read-only sandbox + approval `never`);
 * 5. install the role + WATCHDOG system-prompt sections.
 *
 * The plugin feeds deltas and observes the reviewer's session events; it
 * never drives `ctx.llm.stream` directly.
 *
 * @module @dsh-plugin/dsh-advisor/advisor
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedAdvisorConfig } from './config.ts'
import { DeltaObserver, serializeDelta, type FeedKind } from './delta.ts'
import { ADVISE_TOOL, type AdviseArgs } from './advise-tool.ts'
import { ADVISOR_SOURCE_KIND, advisoryMessage, decideDelivery, DeliveryController, inboxHasPending, readPrimaryState, type DeliveryDecision } from './delivery.ts'
import { EmissionGuard } from './emission-guard.ts'
import { composeReviewer } from './reviewer.ts'
import type { Severity } from './severity.ts'
import { isInterrupting, isSeverity } from './severity.ts'
import { discoverWatchdog, renderWatchdogGuidance, type WatchdogSource } from './watchdog.ts'
import { AdvisorStore, type AdvisorState } from './state-store.ts'

/** One reviewer's validated spec (roster entry or the default reviewer). */
export interface ReviewerSpec {
  readonly name: string
  readonly enabled: boolean
  readonly model?: string
  readonly tools: readonly string[]
  readonly instructions?: string
}

/** A live reviewer: the owned agent handle plus its spec and session id. */
export interface ReviewerHandle {
  readonly id: SessionId
  readonly name: string
  readonly spec: ReviewerSpec
  readonly agent: Agent
  readonly handle: AgentHandle
}

/** The reviewer's role system-prompt section. */
export const ROLE_SECTION = 'You are the session advisor: an independent reviewer attached to the primary agent session. '
  + 'You observe deltas of the primary transcript and evaluate them against your guidance.\n\n'
  + '- Use your read/grep/glob tools to verify claims against the workspace when needed.\n'
  + '- When you find an issue, call the advise tool at most once per review with:\n'
  + '  - severity "nit": a minor aside that must not interrupt the primary agent.\n'
  + '  - severity "concern": a substantive risk that should steer the primary agent\'s next step.\n'
  + '  - severity "blocker": a defect that makes continued work wasted; it must interrupt.\n'
  + '- Keep notes concise and actionable. Your guidance is advisory: weigh it, do not blindly obey, '
  + 'and never act on the primary agent\'s behalf.'

/** Bound on the syncBacklog catch-up wait. */
export const SYNC_BACKLOG_WAIT_MS = 30_000

/** Unobserved event span that triggers a mid-turn delta flush. */
export const MID_TURN_FLUSH_EVENTS = 24

/** Coalesce a reviewer session id from a spec name. */
function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  return slug === '' ? 'reviewer' : slug
}

/**
 * Resolve the reviewer specs from the watchdog roster, falling back to one
 * default reviewer.
 *
 * `spec.model` carries only a ROSTER-explicit model: the plugin config's
 * `model` and the runtime override chosen in the header panel are applied
 * later, in {@link AdvisorRuntime}'s route resolution, so the priority stays
 * roster entry > runtime override > plugin config > follow the primary.
 */
export function resolveReviewerSpecs(config: ResolvedAdvisorConfig, watchdog: WatchdogSource): ReviewerSpec[] {
  if (watchdog.roster !== undefined && watchdog.roster.entries.length > 0) {
    return watchdog.roster.entries.map((entry) => ({
      name: entry.name,
      enabled: entry.enabled,
      ...entry.model !== undefined ? { model: entry.model } : {},
      tools: entry.tools !== undefined && entry.tools.length > 0 ? entry.tools : config.defaultTools,
      ...entry.instructions !== undefined ? { instructions: entry.instructions } : {},
    }))
  }
  return [{
    name: 'default',
    enabled: true,
    tools: config.defaultTools,
  }]
}

/**
 * Whether an agent-creation failure means the reviewer session id already
 * exists in the backend (a reviewer from an earlier process lifetime).
 * @param error - the rejection from `ctx.agents.create`.
 * @returns true when resuming the persisted session is the correct recovery.
 */
function isExistingSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'SessionAlreadyExistsError' || /session .* already exists/i.test(error.message)
}

/**
 * Parse the `arguments` of an advise call. A native tool surface records the
 * raw JSON string on `tool/call`; a PTC surface records the already
 * JSON-normalized value on `tool/ptc-dispatch`, so both shapes are accepted.
 */
function parseAdviseArgs(raw: unknown): AdviseArgs | undefined {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  const severity = record['severity']
  const note = record['note']
  if (!isSeverity(severity) || typeof note !== 'string' || note.trim() === '') return undefined
  return { severity, note }
}

/** The runtime's attach phase: whether reviewers are live. */
export type AdvisorPhase = 'idle' | 'starting' | 'ready' | 'resetting'

/**
 * Owns the advisor's whole lifecycle for one plugin context. Event listeners
 * are registered once in the constructor and filter by the bound primary.
 */
export class AdvisorRuntime {
  private primary: Agent | undefined
  private readonly reviewers = new Map<SessionId, ReviewerHandle>()
  private watchdog: WatchdogSource = {}
  private enabled: boolean
  private phase: AdvisorPhase = 'idle'
  private resetQueued = false
  private lastGeneration = 0
  /** Bumped by disable/teardown so an in-flight start aborts its own creation. */
  private epoch = 0
  /**
   * The last reviewer compose/creation failure message, surfaced by
   * `/advisor status` as `reviewers: 0 (error: …)`. Cleared on a successful
   * start, disable, or teardown so a stale failure never masks a live state.
   */
  private reviewerError: string | undefined
  /**
   * Reviewer model route chosen at runtime (the header panel's model picker),
   * `''` when unset. Persisted with the rest of the state so a restart restores
   * it; it outranks the plugin config but never a roster entry's own model.
   */
  private modelOverride = ''
  private readonly observer: DeltaObserver
  private readonly delivery: DeliveryController
  private readonly guard = new EmissionGuard()
  private readonly adviseCalls = new Map<string, AdviseArgs>()

  /**
   * Run a side effect after the session publication that triggered it returns.
   * The session store refuses an append re-entered while another append is
   * being published; a `followup`/`append`/`inject`/`steer` issued straight
   * from a `session/event` listener hits that guard, and the resulting
   * rejection would otherwise escape as an unhandled one and stop the host.
   * `setImmediate` leaves the publish frame and preserves listener order; the
   * delivery decision itself is not re-evaluated.
   * @param label - task name used in the failure log.
   * @param task - the side effect to run after publication.
   */
  private afterPublish(label: string, task: () => void | Promise<void>): void {
    setImmediate(() => {
      try {
        this.detach(label, Promise.resolve(task()))
      } catch (error) {
        this.ctx.logger.warn('dsh-advisor: %s failed: %o', label, error)
      }
    })
  }

  /**
   * Attach a failure log to a detached async task so a background failure is
   * never an unhandled rejection.
   * @param label - task name used in the failure log.
   * @param task - the in-flight task.
   */
  private detach(label: string, task: Promise<void>): void {
    void task.catch((error: unknown) => {
      this.ctx.logger.warn('dsh-advisor: %s failed: %o', label, error)
    })
  }

  /** Plugin-owned advisor state (enabled flag + reviewer count), persisted. */
  readonly store = new AdvisorStore()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedAdvisorConfig,
  ) {
    this.enabled = config.enabled
    this.observer = new DeltaObserver(event => this.isOwnMessage(event))
    this.delivery = new DeliveryController({ immuneTurns: config.immuneTurns })
    // Re-seed a persisted runtime `enabled` (a `/advisor on` survives restart),
    // but only when a snapshot was actually loaded — never override config.
    void this.store.load().then(() => {
      if (!this.store.hasSnapshot) return
      const snapshot = this.store.current()
      this.enabled = snapshot.enabled
      // A persisted route is the panel's pick, so it outranks the config — but
      // a snapshot that merely echoed the configured route is not an override
      // (a later config edit must still win).
      if (snapshot.model !== '' && snapshot.model !== this.config.model) this.modelOverride = snapshot.model
      this.emitStatus()
      if (this.enabled && this.primary !== undefined && this.phase === 'idle') {
        this.detach('advisor restart', this.start())
      }
    }).catch((error: unknown) => {
      ctx.logger.warn('dsh-advisor: failed to load advisor state snapshot: %o', error)
    })
  }

  /** Register every root-ctx listener. Idempotent. */
  attach(): void {
    // `agent/session-start` no longer exists: its `source` moved onto the
    // serial, awaited `agent/created` payload, so binding and the resume reset
    // share one handler (no second binding pass). This handler must stay
    // synchronous — it never awaits its own owner's disposal or the agent.
    this.ctx.on('agent/created', ({ agent, source }) => {
      this.detach('agent bind', this.maybeBind(agent))
      if (source === 'resume' && this.isPrimary(agent)) this.scheduleReset('resume')
      return undefined
    })
    this.ctx.on('agent/disposed', ({ agent }) => {
      if (this.isPrimary(agent)) this.detach('primary teardown', this.teardownPrimary())
    })
    this.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (message.source.kind !== 'user') return
      if (this.isPrimary(agent)) {
        this.delivery.onUserInput()
        return
      }
      // A human prompt in another top-level session is the strongest signal
      // of the session the user is actually looking at: follow it instead of
      // staying attached to whichever agent happened to resume first.
      this.detach('advisor rebind', this.rebind(agent))
    })
    this.ctx.on('agent/pre-step', async (payload, next) => {
      if (this.isPrimary(payload.agent) && this.isLive()) {
        const queued = this.delivery.takeQueuedSteer()
        if (queued !== undefined) {
          payload.agent.steer(queued.message)
          this.delivery.spendBudget()
        }
      }
      return next()
    })
    this.ctx.on('agent/turn-stopping', (payload) => {
      if (this.isPrimary(payload.agent) && this.isLive()) {
        const queued = this.delivery.queuedSteer
        if (queued !== undefined) {
          if (queued.severity === 'blocker') {
            const taken = this.delivery.takeQueuedSteer()
            if (taken !== undefined) {
              payload.agent.steer(taken.message)
              this.delivery.spendBudget()
            }
          } else {
            // concern at the stop boundary: do NOT extend the turn; the
            // advisory becomes a card delivered after turn/end.
            this.delivery.deferQueuedSteerAsCard()
            this.delivery.spendBudget()
          }
        }
      }
    })
    this.ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })
    this.ctx.on('session/created', (session) => { this.onSessionCreated(session) })

    // Bind to an already-running agent (plugin loaded after the primary).
    for (const agent of this.ctx.agents.list()) {
      this.detach('agent bind', this.maybeBind(agent))
    }
  }

  // ---- public command surface ----

  /** Whether the advisor is currently enabled. */
  get isEnabled(): boolean {
    return this.enabled
  }

  /** Attach (idempotent): starts reviewers when a primary is bound. */
  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.ctx.logger.info('dsh-advisor: enabled')
    this.emitStatus()
    if (this.primary !== undefined && this.phase === 'idle') {
      this.detach('advisor start', this.start())
    }
  }

  /** Detach: disposes every reviewer and stops feeding. */
  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    this.epoch++
    this.ctx.logger.info('dsh-advisor: disabled')
    this.delivery.reset()
    this.guard.reset()
    this.adviseCalls.clear()
    this.reviewerError = undefined
    this.phase = 'idle'
    this.emitStatus()
    this.detach('reviewer disposal', this.disposeReviewers())
  }

  /**
   * Publish the whole-value advisor state to the plugin-owned store (the UI
   * badge's `advisorStatus` projection reads it). Replaces the old
   * `advisor/status` session-event mirror. A disabled advisor reports zero
   * reviewers (the dispose is in flight or already done).
   */
  private emitStatus(): void {
    this.store.set({
      enabled: this.enabled,
      reviewers: this.enabled ? this.reviewers.size : 0,
      model: this.effectiveModel,
    })
  }

  /**
   * The reviewer model route in effect: the runtime override when set,
   * otherwise the plugin config; `''` means "follow the primary model".
   */
  get effectiveModel(): string {
    return this.modelOverride !== '' ? this.modelOverride : this.config.model
  }

  /**
   * Set the reviewer model route from the UI/command surface. The pick is
   * persisted with the rest of the state and applied immediately: live
   * reviewers are rebuilt, because a reviewer's model is fixed at creation.
   * @param route - `provider/model`, a bare model id, or `''` to follow the primary.
   * @returns the effective route after the change.
   */
  setReviewerModel(route: string): string {
    const next = route.trim()
    if (next === this.modelOverride) return this.effectiveModel
    this.modelOverride = next
    this.ctx.logger.info('dsh-advisor: reviewer model route -> %s', next === '' ? '(follow primary)' : next)
    this.emitStatus()
    if (!this.enabled || this.primary === undefined) return this.effectiveModel
    if (this.phase === 'ready' && this.reviewers.size > 0) {
      this.scheduleReset('reviewer model change')
    } else if (this.phase === 'idle' && this.reviewers.size === 0) {
      // A previous start failed (or was never run): pick the new route up now.
      this.detach('advisor start', this.start())
    }
    return this.effectiveModel
  }

  /** The current advisor state (the `advisorStatus` projection's read). */
  status(): AdvisorState {
    return this.store.current()
  }

  // ---- primary binding ----

  private isPrimary(agent: Agent): boolean {
    return this.primary !== undefined && agent.id === this.primary.id
  }

  private isLive(): boolean {
    return this.enabled && this.phase === 'ready'
  }

  /** Whether an agent is a legal primary candidate for this runtime. */
  private canBind(agent: Agent): boolean {
    if (this.config.agentId !== '' && agent.id !== this.config.agentId) return false
    // Never bind to our own reviewer sessions (only reachable on a replay).
    if (this.reviewers.has(agent.id)) return false
    // Subagent sessions are reviewed work, never the primary conversation.
    return agent.session.header.origin !== 'subagent'
  }

  /** Point the runtime at `agent`, resetting every per-primary slot. */
  private adopt(agent: Agent, verb: 'attached to' | 'rebound to'): void {
    this.primary = agent
    this.lastGeneration = agent.session.surface.replaceGeneration
    this.delivery.reset()
    this.guard.reset()
    this.adviseCalls.clear()
    this.reviewerError = undefined
    this.phase = 'idle'
    this.ctx.logger.info('dsh-advisor: %s session %s', verb, agent.id)
    this.emitStatus()
  }

  /** Bind to a candidate agent if none is bound and it matches the config. */
  private async maybeBind(agent: Agent): Promise<void> {
    if (this.primary !== undefined) return
    if (!this.canBind(agent)) return
    this.adopt(agent, 'attached to')
    if (this.enabled && this.phase === 'idle') {
      await this.start()
    }
  }

  /**
   * Follow a human prompt into a different top-level session: the web client
   * can keep several sessions live at once, so "first agent bound" is not the
   * session the user is looking at. Reviewer construction is per-primary, so
   * the old set is disposed before the new one starts.
   * @param agent - the agent that just claimed human input.
   */
  private async rebind(agent: Agent): Promise<void> {
    if (!this.enabled) return
    if (this.primary === undefined) {
      await this.maybeBind(agent)
      return
    }
    if (this.primary.id === agent.id) return
    if (!this.canBind(agent)) return
    // A start/reset owns the reviewer map; the next prompt retries.
    if (this.phase === 'starting' || this.phase === 'resetting') return
    this.epoch++
    this.phase = 'resetting'
    await this.disposeReviewers()
    this.adopt(agent, 'rebound to')
    if (this.enabled) await this.start()
  }

  private async teardownPrimary(): Promise<void> {
    this.ctx.logger.info('dsh-advisor: primary agent disposed; detaching')
    this.epoch++
    this.reviewerError = undefined
    this.phase = 'idle'
    await this.disposeReviewers()
    this.primary = undefined
    this.delivery.reset()
    this.guard.reset()
    this.adviseCalls.clear()
  }

  // ---- session event handling ----

  private onSessionCreated(session: Session): void {
    if (this.primary === undefined) return
    if (session.id === this.primary.id) return
    if (this.reviewers.has(session.id)) return
    // A fork of the primary conversation (not a subagent session): rebuild.
    if (session.header.parentSession === this.primary.id && session.header.origin !== 'subagent') {
      this.scheduleReset('fork')
    }
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.primary !== undefined && session.id === this.primary.id) {
      this.onPrimaryEvent(session, event)
      return
    }
    const reviewer = this.reviewers.get(session.id)
    if (reviewer !== undefined) this.onReviewerEvent(reviewer, event)
  }

  private onPrimaryEvent(session: Session, event: SessionEvent): void {
    // Reset signals first: any rewrite invalidates the cursor and the guard.
    if (this.isResetSignal(event, session)) return
    const primary = this.primary
    if (primary === undefined) return
    if (event.type === 'turn/end') {
      const card = this.delivery.deferredCard
      // Terminal state is computed BEFORE the card delivery queues work.
      this.delivery.onPrimaryTurnEnd(inboxHasPending(primary))
      // Both the card and the feed touch the primary/reviewer while this
      // append is still publishing; run them once the publish frame returns.
      this.afterPublish('turn/end delivery', () => {
        if (card !== undefined) primary.inject(card)
        return this.flushDeltas()
      })
      return
    }
    this.observer.observe(event)
    // Feed mid-turn deltas when the unobserved span grows, so a long tool
    // loop is still reviewed; turn/end covers the steady cadence.
    if (this.isLive() && this.pendingOverBudget()) {
      this.afterPublish('mid-turn delta flush', () => this.flushDeltas())
    }
  }

  private isResetSignal(event: SessionEvent, session: Session): boolean {
    if (event.type.startsWith('compaction/')) {
      this.scheduleReset('compaction')
      return true
    }
    if (isReplacementSurfaceEvent(event)) {
      this.scheduleReset('rewrite')
      return true
    }
    if (session.surface.replaceGeneration !== this.lastGeneration) {
      this.lastGeneration = session.surface.replaceGeneration
      this.scheduleReset('rewrite')
      return true
    }
    return false
  }

  private onReviewerEvent(reviewer: ReviewerHandle, event: SessionEvent): void {
    if (event.type === 'tool/call' && event.data.name === ADVISE_TOOL) {
      const args = parseAdviseArgs(event.data.arguments)
      if (args !== undefined) this.adviseCalls.set(event.data.callId, args)
    } else if (event.type === 'tool/ptc-dispatch' && event.data.name === ADVISE_TOOL) {
      // PTC preset: the reviewer's only tool is `run_code`, so `advise` runs as
      // a bridged sub-call. That path logs no `tool/call`/`tool/result` pair —
      // the settle event carries both the normalized arguments and the outcome,
      // so route straight from it. Without this branch the reviewer reports
      // "Advisory recorded" while nothing ever reaches the primary.
      if (event.data.isError) return
      const args = parseAdviseArgs(event.data.arguments)
      if (args !== undefined) this.routeAdvice(reviewer, args.severity, args.note)
    } else if (event.type === 'tool/result') {
      const callId = event.data.message.source.callId
      const args = this.adviseCalls.get(callId)
      if (args !== undefined) {
        this.adviseCalls.delete(callId)
        // routeAdvice keeps its guard/immune/status decision synchronous
        // (one macrotask must not move the rate-limit window); the append and
        // inject/steer it triggers are scheduled past the publish frame.
        this.routeAdvice(reviewer, args.severity, args.note)
      }
    } else if (event.type === 'turn/end') {
      this.guard.endUpdate(reviewer.id)
    }
  }

  // ---- advice routing ----

  private routeAdvice(reviewer: ReviewerHandle, severity: Severity, note: string): void {
    const primary = this.primary
    if (primary === undefined || !this.enabled) return
    const guarded = this.guard.accept(note, reviewer.id)
    if (!guarded.accepted) return
    // User-visible copy: a durable, replayable card in the primary transcript.
    // Log-only, so it neither enters model history nor rewrites the surface;
    // the model-side delivery below keeps its steer/immune semantics. Both
    // touch the primary while the reviewer's append is publishing, so they
    // run after the publish frame (FIFO keeps the card ahead of the delivery).
    this.afterPublish('advisory record', () => {
      this.recordAdvice(primary, reviewer, severity, note)
    })
    const message = advisoryMessage(note, severity)
    if (this.delivery.immuneActive && isInterrupting(severity)) {
      // Downgraded to an aside until the immune window closes.
      this.afterPublish('advisory aside', () => primary.inject(message))
      return
    }
    if (primary.status === 'running') {
      // The boundary listeners decide: steer at the next step, or the
      // terminal-answer policy at turn-stopping.
      this.delivery.queue(severity, message)
      return
    }
    const state = readPrimaryState(primary, false, this.delivery.lastTurnTerminal)
    const decision = decideDelivery(severity, state, false)
    this.applyDecision(decision, message)
  }

  /**
   * Append the user-visible advisory card to the primary transcript. Best
   * effort: a session-log failure must never suppress the model-side
   * delivery, so the error is logged and routing continues.
   * @param primary - the primary agent whose transcript receives the card.
   * @param reviewer - the reviewer that produced the advice.
   * @param severity - the advisory grade.
   * @param note - the advisory note.
   */
  private recordAdvice(primary: Agent, reviewer: ReviewerHandle, severity: Severity, note: string): void {
    try {
      primary.session.append('advisor/advice', { severity, note, reviewer: reviewer.name })
    } catch (error) {
      this.ctx.logger.warn('dsh-advisor: failed to record advisory card: %o', error)
    }
  }

  private applyDecision(decision: DeliveryDecision, message: UserMessage): void {
    const primary = this.primary
    if (primary === undefined) return
    switch (decision.channel) {
      case 'inject':
        this.afterPublish('advisory inject', () => primary.inject(message))
        return
      case 'steer':
        this.delivery.spendBudget()
        this.afterPublish('advisory steer', () => primary.steer(message))
        return
      case 'card':
        if (decision.deferred !== true) {
          this.delivery.spendBudget()
          this.afterPublish('advisory inject', () => primary.inject(message))
        }
        return
      default:
        return
    }
  }

  // ---- delta feeding ----

  private pendingOverBudget(): boolean {
    const primary = this.primary
    if (primary === undefined) return false
    const unobserved = primary.session.seq - this.observer.nextSeq
    return unobserved >= MID_TURN_FLUSH_EVENTS
  }

  private feedMessage(text: string, kind: FeedKind): UserMessage {
    const summary = kind === 'baseline'
      ? 'advisor: session baseline loaded'
      : 'advisor: new transcript activity'
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: ADVISOR_SOURCE_KIND, form: 'notice', summary },
    })
  }

  /** Collect unobserved primary surface messages and feed every reviewer. */
  private async flushDeltas(): Promise<void> {
    const primary = this.primary
    if (primary === undefined || !this.isLive() || this.reviewers.size === 0) return
    const batch = this.observer.collect(primary.session)
    if (batch.messages.length === 0) return
    const serialized = serializeDelta('delta', batch.messages, batch.seqs, this.config.maxPromptTokens, primary.id)
    if (serialized.messageCount === 0) return
    for (const reviewer of this.reviewers.values()) {
      this.guard.beginUpdate(reviewer.id)
      reviewer.agent.followup(this.feedMessage(serialized.text, 'delta'))
    }
    if (this.config.syncBacklog > 0) {
      await this.waitForCatchUp()
    }
  }

  /** Bounded catch-up wait: ≤30s for the reviewers to consume the backlog. */
  private async waitForCatchUp(): Promise<void> {
    const waiters = [...this.reviewers.values()].map(reviewer =>
      Promise.race([
        reviewer.agent.whenIdle(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SYNC_BACKLOG_WAIT_MS)
          timer.unref?.()
        }),
      ]))
    await Promise.all(waiters)
  }

  // ---- reviewer lifecycle ----

  private async start(): Promise<void> {
    if (this.primary === undefined || this.phase !== 'idle') return
    const epoch = this.epoch
    this.phase = 'starting'
    this.ctx.logger.info('dsh-advisor: starting reviewers')
    try {
      try {
        this.watchdog = await discoverWatchdog({
          cwd: this.primary.session.header.cwd ?? process.cwd(),
          userDir: this.config.watchdog.userDir,
          projectMarkers: this.config.watchdog.projectMarkers,
        })
      } catch (error) {
        // A broken WATCHDOG must not take the advisor down; log and continue.
        this.ctx.logger.warn('dsh-advisor: watchdog discovery failed: %o', error)
        this.watchdog = {}
      }
      const specs = resolveReviewerSpecs(this.config, this.watchdog)
      for (const spec of specs) {
        if (!spec.enabled) continue
        if (epoch !== this.epoch || !this.enabled) {
          await this.disposeReviewers()
          this.phase = 'idle'
          return
        }
        const reviewer = await this.createReviewer(spec)
        this.reviewers.set(reviewer.id, reviewer)
      }
      if (epoch !== this.epoch || !this.enabled) {
        await this.disposeReviewers()
        this.phase = 'idle'
        return
      }
      this.lastGeneration = this.primary.session.surface.replaceGeneration
      this.phase = 'ready'
      this.reviewerError = undefined
      this.emitStatus()
      await this.feedBaseline()
    } catch (error) {
      // Loud by contract: a reviewer that cannot be composed must not fail
      // silently into "reviewers: none" — the message is logged AND surfaced
      // by `/advisor status` until a later start succeeds.
      const message = error instanceof Error ? error.message : String(error)
      this.reviewerError = message
      this.ctx.logger.warn('dsh-advisor: failed to start reviewers: %s', message)
      this.phase = 'idle'
      await this.disposeReviewers()
      this.emitStatus()
    }
  }

  /** Rewind the observer and feed the whole current bounded surface. */
  private async feedBaseline(): Promise<void> {
    const primary = this.primary
    if (primary === undefined || this.reviewers.size === 0) return
    this.observer.rewind()
    const batch = this.observer.collect(primary.session)
    if (batch.messages.length === 0) return
    const serialized = serializeDelta('baseline', batch.messages, batch.seqs, this.config.maxPromptTokens, primary.id)
    if (serialized.messageCount === 0) return
    for (const reviewer of this.reviewers.values()) {
      this.guard.beginUpdate(reviewer.id)
      reviewer.agent.followup(this.feedMessage(serialized.text, 'baseline'))
    }
  }

  /** Create one reviewer agent (full agent with its own loop). */
  private async createReviewer(spec: ReviewerSpec): Promise<ReviewerHandle> {
    const primary = this.requirePrimary()
    const sessionId = SessionId(`${primary.id}__advisor-${slugify(spec.name)}`)
    const cwd = primary.session.header.cwd
    const watchdog = this.watchdog
    const agentOptions = this.reviewerAgentOptions(primary, spec)
    // Reviewers are delegated children, not user conversations: mark the
    // durable header so the Web session list keeps them out of the top level
    // (origin) and the recursion budget survives a resume (delegationDepth).
    const delegationDepth = (primary.session.header.delegationDepth ?? 0) + 1
    const setup = (agentCtx: Context, agent: Agent): void => {
      this.setupReviewer(agentCtx, agent, spec, watchdog)
    }
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: {
          ...cwd !== undefined ? { cwd } : {},
          origin: 'subagent',
          delegationDepth,
        },
        agentOptions,
        setup,
      })
    } catch (error) {
      // The reviewer id is deterministic across restarts, so a persisted
      // reviewer session from an earlier process lifetime is expected: resume
      // that log instead of failing the whole reviewer set into `reviewers: 0`.
      if (!isExistingSessionError(error)) throw error
      this.ctx.logger.info('dsh-advisor: reviewer session %s already exists; resuming it', sessionId)
      handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    }
    return { id: handle.agent.id, name: spec.name, spec, agent: handle.agent, handle }
  }

  /** Resolve the reviewer's model route: an explicit spec, the runtime override, the config, or the primary's. */
  private reviewerAgentOptions(primary: Agent, spec: ReviewerSpec): AgentOptions {
    const route = this.reviewerRoute(spec)
    if (route === undefined) {
      // Follow the primary agent's route exactly.
      return {
        ...primary.options.provider !== undefined ? { provider: primary.options.provider } : {},
        ...primary.options.model !== undefined ? { model: primary.options.model } : {},
        ...primary.options.maxTokens !== undefined ? { maxTokens: primary.options.maxTokens } : {},
      }
    }
    const provider = route.provider ?? primary.options.provider
    return {
      ...provider !== undefined ? { provider } : {},
      model: route.model,
    }
  }

  /**
   * Resolve the model route for one reviewer. Priority: the roster entry's own
   * `model`, then the runtime override (the header panel's pick), then the
   * plugin config — then empty, meaning "follow the primary conversation".
   * `provider/model` splits on the FIRST slash only (model ids never contain
   * one); a bare model id keeps the primary's provider.
   * @param spec - the reviewer spec being created.
   * @returns the route, or undefined to follow the primary agent's options.
   */
  private reviewerRoute(spec: ReviewerSpec): { provider?: string; model: string } | undefined {
    const raw = spec.model !== undefined && spec.model !== '' ? spec.model : this.effectiveModel
    if (raw === '') return undefined
    const slash = raw.indexOf('/')
    if (slash <= 0 || slash === raw.length - 1) return { model: raw }
    return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
  }

  /**
   * The reviewer's creation-time composition. Synchronous (composition only):
   * the shared {@link composeReviewer} recipe (preset join, tool restriction,
   * scoped advise registration, delegated policy pin) plus the reviewer's own
   * role/instructions/WATCHDOG prompt section.
   */
  private setupReviewer(agentCtx: Context, agent: Agent, spec: ReviewerSpec, watchdog: WatchdogSource): void {
    composeReviewer(agentCtx, agent, {
      name: spec.name,
      tools: spec.tools,
      primary: this.requirePrimary(),
      warn: (message, ...args) => { this.ctx.logger.warn(message, ...args) },
    })
    // Reviewer prompt: role + instructions + WATCHDOG attention blocks.
    agentCtx.systemPrompt.section({ name: 'advisor:role', order: 60, text: this.roleSection(spec, watchdog) })
  }

  /** Assemble the reviewer's system-prompt section text. */
  private roleSection(spec: ReviewerSpec, watchdog: WatchdogSource): string {
    const parts: string[] = [ROLE_SECTION]
    const shared = watchdog.roster?.sharedInstructions
    if (shared !== undefined || spec.instructions !== undefined) {
      const instructions = [shared, spec.instructions].filter(text => text !== undefined && text.trim() !== '').join('\n\n')
      if (instructions !== '') {
        parts.push(`<attention role="instructions">\n${instructions}\n</attention>`)
      }
    }
    const guidance = renderWatchdogGuidance(watchdog)
    if (guidance !== '') parts.push(guidance)
    return parts.join('\n\n')
  }

  private requirePrimary(): Agent {
    if (this.primary === undefined) throw new Error('dsh-advisor: no primary agent bound')
    return this.primary
  }

  private async disposeReviewers(): Promise<void> {
    const handles = [...this.reviewers.values()]
    this.reviewers.clear()
    this.adviseCalls.clear()
    await Promise.all(handles.map(reviewer => reviewer.handle.dispose().catch((error: unknown) => {
      this.ctx.logger.warn('dsh-advisor: reviewer %s dispose failed: %o', reviewer.id, error)
    })))
  }

  // ---- reset ----

  private scheduleReset(reason: string): void {
    if (!this.enabled || this.primary === undefined) return
    if (this.phase === 'starting' || this.phase === 'resetting' || this.resetQueued) return
    this.resetQueued = true
    this.detach('advisor reset', this.runReset(reason))
  }

  private async runReset(reason: string): Promise<void> {
    this.resetQueued = false
    this.phase = 'resetting'
    this.ctx.logger.info('dsh-advisor: reset (%s)', reason)
    try {
      this.guard.reset()
      this.delivery.reset()
      this.observer.rewind()
      await this.disposeReviewers()
      this.phase = 'idle'
      if (this.enabled) await this.start()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reviewerError = message
      this.ctx.logger.warn('dsh-advisor: reset failed: %s', message)
      this.phase = 'idle'
    }
  }

  // ---- status / usage ----

  /** Render the `/advisor status` report (never enters model history). */
  statusText(): string {
    const lines: string[] = []
    lines.push(`advisor: ${this.enabled ? 'enabled' : 'disabled'}`)
    lines.push(`model: ${this.effectiveModel === '' ? '(follow primary)' : this.effectiveModel}`)
    if (this.primary === undefined) {
      lines.push('not attached to a session')
      return lines.join('\n')
    }
    lines.push(`session: ${this.primary.id}`)
    if (this.delivery.immuneActive) {
      lines.push('immune window: active (concern/blocker downgraded to asides)')
    }
    if (this.reviewers.size === 0) {
      lines.push(this.reviewerError === undefined
        ? 'reviewers: none'
        : `reviewers: 0 (error: ${this.reviewerError})`)
    } else {
      for (const reviewer of this.reviewers.values()) {
        const usage = this.measureUsage(reviewer)
        const model = reviewer.agent.options.model ?? '(follow primary)'
        const cost = usage.cost === undefined ? '' : ` cost=$${usage.cost.toFixed(4)}`
        lines.push(`- ${reviewer.name} [${reviewer.id}]: status=${reviewer.agent.status} model=${model} tokens=${usage.totalTokens}${cost}`)
      }
    }
    if (this.watchdog.md !== undefined) lines.push(`watchdog: ${this.watchdog.md.path}`)
    return lines.join('\n')
  }

  /** Per-reviewer token usage via `ctx.tokenMeter` plus optional cost. */
  measureUsage(reviewer: ReviewerHandle): { totalTokens: number; cost?: number } {
    const meter = this.ctx.get('tokenMeter')
    if (meter === undefined) return { totalTokens: 0 }
    try {
      const measurement = meter.measure(reviewer.agent.session)
      const rate = this.costRate(reviewer.agent.options.provider, reviewer.agent.options.model)
      return {
        totalTokens: measurement.totalTokens,
        ...rate !== undefined ? { cost: (measurement.totalTokens / 1_000_000) * rate } : {},
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-advisor: token measurement failed for %s: %o', reviewer.id, error)
      return { totalTokens: 0 }
    }
  }

  /** Look up a per-1M-token rate: `provider/model`, then `provider`, then `model`. */
  private costRate(provider: string | undefined, model: string | undefined): number | undefined {
    const table = this.config.costTable
    if (provider !== undefined && model !== undefined) {
      const exact = table[`${provider}/${model}`]
      if (exact !== undefined) return exact
    }
    if (provider !== undefined) {
      const byProvider = table[provider]
      if (byProvider !== undefined) return byProvider
    }
    if (model !== undefined) {
      const byModel = table[model]
      if (byModel !== undefined) return byModel
    }
    return undefined
  }

  /** Whether a primary-session event is one of our own delivered advisories. */
  private isOwnMessage(event: SessionEvent): boolean {
    if (event.type !== 'user/message') return false
    const source = event.data.source
    return source.kind === ADVISOR_SOURCE_KIND
  }
}

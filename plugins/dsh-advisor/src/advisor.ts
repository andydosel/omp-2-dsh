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
import { ADVISOR_SOURCE_KIND, advisoryMessage, decideDelivery, DeliveryController, inboxHasPending, readPrimaryState } from './delivery.ts'
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

/** Resolve the reviewer specs from the watchdog roster, falling back to one default reviewer. */
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
    ...config.model !== '' ? { model: config.model } : {},
    tools: config.defaultTools,
  }]
}

/** Parse the raw `arguments` JSON string of an advise tool call. */
function parseAdviseArgs(raw: string): AdviseArgs | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
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
  private readonly observer: DeltaObserver
  private readonly delivery: DeliveryController
  private readonly guard = new EmissionGuard()
  private readonly adviseCalls = new Map<string, AdviseArgs>()

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
      this.enabled = this.store.current().enabled
      this.emitStatus()
      if (this.enabled && this.primary !== undefined && this.phase === 'idle') {
        void this.start()
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
      void this.maybeBind(agent)
      if (source === 'resume' && this.isPrimary(agent)) this.scheduleReset('resume')
      return undefined
    })
    this.ctx.on('agent/disposed', ({ agent }) => {
      if (this.isPrimary(agent)) void this.teardownPrimary()
    })
    this.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (this.isPrimary(agent) && message.source.kind === 'user') this.delivery.onUserInput()
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
      void this.maybeBind(agent)
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
      void this.start()
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
    void this.disposeReviewers()
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
    })
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

  /** Bind to a candidate agent if none is bound and it matches the config. */
  private async maybeBind(agent: Agent): Promise<void> {
    if (this.primary !== undefined) return
    if (this.config.agentId !== '' && agent.id !== this.config.agentId) return
    // Never bind to our own reviewer sessions (only reachable on a replay).
    if (this.reviewers.has(agent.id)) return
    this.primary = agent
    this.lastGeneration = agent.session.surface.replaceGeneration
    this.delivery.reset()
    this.guard.reset()
    this.ctx.logger.info('dsh-advisor: attached to session %s', agent.id)
    this.emitStatus()
    if (this.enabled && this.phase === 'idle') {
      await this.start()
    }
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
      if (card !== undefined) primary.inject(card)
      void this.flushDeltas()
      return
    }
    this.observer.observe(event)
    // Feed mid-turn deltas when the unobserved span grows, so a long tool
    // loop is still reviewed; turn/end covers the steady cadence.
    if (this.isLive() && this.pendingOverBudget()) {
      void this.flushDeltas()
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
    } else if (event.type === 'tool/result') {
      const callId = event.data.message.source.callId
      const args = this.adviseCalls.get(callId)
      if (args !== undefined) {
        this.adviseCalls.delete(callId)
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
    const message = advisoryMessage(note, severity)
    if (this.delivery.immuneActive && isInterrupting(severity)) {
      // Downgraded to an aside until the immune window closes.
      primary.inject(message)
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

  private applyDecision(decision: ReturnType<typeof decideDelivery>, message: UserMessage): void {
    const primary = this.primary
    if (primary === undefined) return
    switch (decision.channel) {
      case 'inject':
        primary.inject(message)
        return
      case 'steer':
        primary.steer(message)
        this.delivery.spendBudget()
        return
      case 'card':
        if (decision.deferred !== true) {
          primary.inject(message)
          this.delivery.spendBudget()
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
    const handle = await this.ctx.agents.create({
      sessionId,
      ...cwd !== undefined ? { meta: { cwd } } : {},
      agentOptions: this.reviewerAgentOptions(primary, spec),
      setup: (agentCtx, agent) => this.setupReviewer(agentCtx, agent, spec, watchdog),
    })
    return { id: handle.agent.id, name: spec.name, spec, agent: handle.agent, handle }
  }

  /** Resolve the reviewer's model route: explicit override or the primary's. */
  private reviewerAgentOptions(primary: Agent, spec: ReviewerSpec): AgentOptions {
    const model = spec.model ?? (this.config.model !== '' ? this.config.model : '')
    if (model === '') {
      // Follow the primary agent's route exactly.
      return {
        ...primary.options.provider !== undefined ? { provider: primary.options.provider } : {},
        ...primary.options.model !== undefined ? { model: primary.options.model } : {},
        ...primary.options.maxTokens !== undefined ? { maxTokens: primary.options.maxTokens } : {},
      }
    }
    return {
      ...primary.options.provider !== undefined ? { provider: primary.options.provider } : {},
      model,
    }
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
    void this.runReset(reason)
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

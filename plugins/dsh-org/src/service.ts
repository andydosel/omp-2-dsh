/**
 * `ctx.org`: the organisation service. It owns the live {@link OrgState}, folds
 * every live session log into it (seeding from the sessions already open at
 * construction), and exposes the mutations the tools, commands, and the
 * controller drive.
 *
 * Durable-first: every mutation appends its `org/*` event(s) to the ACTING
 * session's log, and `claim`/`relinquish`/`forbid` also mirror the relevant
 * event onto the TARGET's log, so each session's own `org` projection is
 * self-describing (an accepted lead's projection shows `managedBy` + its
 * `lead` role without consulting the secretary's log). The in-memory state is
 * then the fold of those appends — the log stays the source of truth.
 *
 * `OrgController` (index.ts) extends this class with the framework wiring
 * (commands, projection, agent re-sync); everything here is driveable against
 * real Sessions and a fake context in tests.
 *
 * @module @dsh-plugin/dsh-org/service
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { escapeXml } from '@dsh-plugin/dsh-util/xml'
import { Config, resolveOrgConfig, type OrgConfig, type ResolvedOrgConfig } from './config.ts'
import { applyLeadEnvelope, disposeEnvelope } from './envelope.ts'
import { workspaceRoot } from './paths.ts'
import {
  addForbidden,
  applyOrgEvent,
  emptyOrgState,
  forbiddenOf,
  grantClaim,
  isForbidden,
  managerOf,
  managesOf,
  roleOf,
  toSessionId,
} from './state.ts'
import type {
  ApprovalProbe,
  AssignInput,
  FsProbe,
  OrgApi,
  OrgDeps,
  OrgNotice,
  OrgRole,
  OrgState,
  PeersProbe,
  PersistenceHandleProbe,
  PersistenceProbe,
  SpawnLeadInput,
  TaskBoardProbe,
} from './types.ts'

/**
 * One event destined for a TARGET's own log. Release and forbid are mirrored
 * onto the target log so it stays self-describing across a cold resume; the
 * union keeps `live.append` type-narrowed per event type.
 */
type TargetLogEvent =
  | { readonly type: 'org/role'; readonly data: { sessionId: SessionId } }
  | { readonly type: 'org/relinquish'; readonly data: { secretaryId: SessionId; targetId: SessionId } }
  | { readonly type: 'org/forbidden'; readonly data: { secretaryId: SessionId; targetId: SessionId } }

/**
 * The organisation service (context key `org`). Constructing it registers the
 * service and starts folding every live session log.
 */
export class OrgService extends Service implements OrgApi {
  static inject = ['agents', 'sessions'] as const

  static Config = Config

  /**
   * Plain TypeScript-private fields, deliberately NOT ECMAScript `#` private
   * fields: Cordis hands consumers a Proxy of this service (`ctx.get('org')`),
   * and reading a `#field` through that Proxy throws "Cannot read private
   * member #state from an object whose class did not declare it" because the
   * Proxy is not an instance of the declaring class. These names are private
   * by convention/type only, which is the price of a proxy-safe service.
   */
  private readonly resolvedConfig: ResolvedOrgConfig
  private readonly resolvedDeps: OrgDeps
  private orgState: OrgState = emptyOrgState()

  /**
   * @param ctx - the plugin context (`agents` and `sessions` are injected).
   * @param config - raw plugin configuration (validated here; unknown keys throw).
   */
  constructor(ctx: Context, config: OrgConfig = {}) {
    super(ctx, 'org')
    this.resolvedConfig = resolveOrgConfig(config)
    this.resolvedDeps = {
      org: this,
      config: this.resolvedConfig,
      peers: () => ctx.get('peers') as PeersProbe | undefined,
      taskBoard: () => ctx.get('taskBoard') as TaskBoardProbe | undefined,
      approval: () => ctx.get('approval') as ApprovalProbe | undefined,
      fs: () => ctx.get('fs') as FsProbe | undefined,
      sessionPersistence: () => ctx.get('sessionPersistence') as PersistenceProbe | undefined,
    }
    // Seed from sessions that already exist, then stay current.
    for (const session of ctx.sessions.list()) this.foldLog(session)
    ctx.on('session/created', session => this.foldLog(session))
    ctx.on('session/event', (session, event) => this.applyEvent(session, event))
  }

  /** The detached, validated configuration the role envelopes consume. */
  get config(): ResolvedOrgConfig {
    return this.resolvedConfig
  }

  /** The seams the controller hands to the envelopes and tools. */
  get deps(): OrgDeps {
    return this.resolvedDeps
  }

  /** The live organisation state (do not mutate; every change goes through a transition). */
  state(): OrgState {
    return this.orgState
  }

  // ── readers (OrgApi) ──────────────────────────────────────────────────────

  /** The secretary managing `targetId`, or undefined when independent. */
  managerOf(targetId: SessionId | string): SessionId | undefined {
    return managerOf(this.orgState, targetId)
  }

  /** The sessions `secretaryId` currently manages, in claim order. */
  managesOf(secretaryId: SessionId | string): SessionId[] {
    return managesOf(this.orgState, secretaryId)
  }

  /** The sessions `secretaryId` has forbidden. */
  forbiddenOf(secretaryId: SessionId | string): SessionId[] {
    return forbiddenOf(this.orgState, secretaryId)
  }

  /** Whether `secretaryId` has forbidden `targetId`. */
  isForbidden(secretaryId: SessionId | string, targetId: SessionId | string): boolean {
    return (this.forbiddenOf(secretaryId)).includes(toSessionId(targetId))
  }

  /** The folded role of a session, or undefined when independent. */
  roleOf(sessionId: SessionId | string): OrgRole | undefined {
    return roleOf(this.orgState, sessionId)
  }

  // ── mutations (OrgApi) ────────────────────────────────────────────────────

  /**
   * Take over a target session for a secretary. A cold (not-live) persisted
   * session is first resumed through `ctx.agents.resume()` with the LEAD
   * envelope composed in `setup`, so takeover works across a restart (§9).
   * Appends `org/claim` to both logs (plus the self-describing role events the
   * projections need).
   * @param secretary - the claiming agent.
   * @param targetId - the target session id.
   * @throws when the target is unknown and cannot be resumed, is the caller
   *   itself, is managed by a DIFFERENT secretary, or is forbidden to this
   *   secretary.
   */
  async claim(secretary: Agent, targetId: string): Promise<void> {
    const id = toSessionId(targetId)
    if (id === secretary.id) {
      throw new Error(`dsh-org: a session cannot manage itself (${targetId})`)
    }
    // Hard invariant check before any side effect (throws on conflict / forbidden).
    grantClaim(this.orgState, secretary.id, id)
    let target = this.ctx.sessions.get(id) ?? this.ctx.agents.get(id)?.session
    if (target === undefined) {
      // Cold-session takeover: load the persisted session and give its agent
      // the lead envelope at the only point the scope is still unpublished.
      if (typeof this.ctx.agents.resume !== 'function') {
        throw new Error(`dsh-org: cannot claim ${targetId}: no live session with that id (agent resume unavailable)`)
      }
      const handle = await this.ctx.agents.resume({
        resumeSessionId: id,
        setup: (agentCtx, leadAgent) => { applyLeadEnvelope(agentCtx, leadAgent, this.resolvedDeps) },
      })
      target = handle.agent.session
    } else {
      // A LIVE target has already joined its preset composition, so the
      // envelope must be applied to its agent scope now — recording only the
      // role would leave a lead with its full toolset (including bash and
      // unrestricted writes).
      const liveTarget = this.ctx.agents.get(id)
      if (liveTarget !== undefined) applyLeadEnvelope(liveTarget.ctx, liveTarget, this.resolvedDeps)
    }
    this.ensureRole(secretary.session, secretary.id, 'secretary')
    secretary.session.append('org/claim', { secretaryId: secretary.id, targetId: id })
    this.ensureRole(target, id, 'lead')
    target.append('org/claim', { secretaryId: secretary.id, targetId: id })
  }

  /**
   * Release a management edge and clear the target's lead role (forbidden set
   * untouched). The target's log receives the release whether it is live (via
   * `Session.append`) or cold (via the persistence seam), so a resumed target
   * does not keep showing the old claim/lead role from its stored history.
   * @param secretary - the releasing agent.
   * @param targetId - the managed session id.
   * @throws when the caller does not manage the target.
   */
  async relinquish(secretary: Agent, targetId: string): Promise<void> {
    const id = toSessionId(targetId)
    if (managerOf(this.orgState, id) !== secretary.id) {
      throw new Error(`dsh-org: ${secretary.id} does not manage ${targetId}; nothing to relinquish`)
    }
    const wasLead = roleOf(this.orgState, id) === 'lead'
    secretary.session.append('org/relinquish', { secretaryId: secretary.id, targetId: id })
    // Lift the mechanism-level envelope too: releasing the edge must give the
    // live session its full toolset back, not just clear the folded role.
    this.liftTargetEnvelope(id)
    const drafts: TargetLogEvent[] = wasLead
      ? [{ type: 'org/role', data: { sessionId: id } }, { type: 'org/relinquish', data: { secretaryId: secretary.id, targetId: id } }]
      : [{ type: 'org/relinquish', data: { secretaryId: secretary.id, targetId: id } }]
    await this.appendToTarget(id, drafts)
  }

  /**
   * Forbid the secretary from touching a target; when the secretary currently
   * owns it, the edge is released in the same operation ("release + forbid").
   * Idempotent. The target's own log records the prohibition (`org/forbidden`,
   * plus the release when owned) even when the target is cold, so a later
   * resume/replay can never resurrect the forbidden edge.
   * @param secretary - the forbidding agent.
   * @param targetId - the session to forbid.
   */
  async forbid(secretary: Agent, targetId: string): Promise<void> {
    const id = toSessionId(targetId)
    const owned = managerOf(this.orgState, id) === secretary.id
    const wasLead = roleOf(this.orgState, id) === 'lead'
    addForbidden(this.orgState, secretary.id, id)
    secretary.session.append('org/forbid', { secretaryId: secretary.id, targetId: id })
    const drafts: TargetLogEvent[] = []
    if (owned) {
      this.liftTargetEnvelope(id)
      if (wasLead) drafts.push({ type: 'org/role', data: { sessionId: id } })
      drafts.push({ type: 'org/relinquish', data: { secretaryId: secretary.id, targetId: id } })
    }
    drafts.push({ type: 'org/forbidden', data: { secretaryId: secretary.id, targetId: id } })
    await this.appendToTarget(id, drafts)
  }

  /**
   * Set or clear a session's organisational role (durable `org/role`).
   * @param sessionId - the session whose role changes.
   * @param role - the role, or undefined to clear it.
   * @throws when no live session has that id.
   */
  setRole(sessionId: SessionId, role: OrgRole | undefined): void {
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) {
      throw new Error(`dsh-org: cannot set the role of ${sessionId}: no live session with that id`)
    }
    if (this.roleFromLog(session, sessionId) === role) return
    session.append('org/role', role === undefined ? { sessionId } : { sessionId, role })
  }

  /**
   * Create a lead agent under the secretary's management: mint its session id,
   * create the agent with the LEAD envelope composed in `setup`, claim it, and
   * wake it with the opening brief.
   * @param secretary - the managing agent.
   * @param input - lead name, optional workspace, and the opening brief.
   * @returns the new lead's session id.
   */
  async spawnLead(secretary: Agent, input: SpawnLeadInput): Promise<{ sessionId: SessionId }> {
    const sessionId = SessionId(`session-${randomUUID()}`)
    const cwd = input.cwd ?? workspaceRoot(secretary.session.header.cwd)
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd },
      setup: (agentCtx, leadAgent) => {
        applyLeadEnvelope(agentCtx, leadAgent, this.resolvedDeps)
      },
    })
    await this.claim(secretary, sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text: `<assignment lead="${escapeXml(input.name)}">${escapeXml(input.prompt)}</assignment>` }],
      source: { kind: 'dsh-org', form: 'notice', summary: `Opening brief for lead "${input.name}"` },
    })
    handle.agent.followup(message)
    return { sessionId }
  }

  /**
   * Assign a task to a lead the secretary manages: record `org/assign`, mirror
   * it onto the task board when one is composed, and deliver the brief to the
   * lead (peers when composed, else the lead's own inbox). Delivery is
   * fire-and-forget on the peers path — the durable `org/assign` record is the
   * assignment of record, and a failed wake must not roll it back — so a
   * delivery failure is logged, not thrown.
   * @param secretary - the assigning agent.
   * @param input - the managed lead, subject, and brief.
   * @returns the task-board id when a board recorded it.
   * @throws when the secretary does not manage the lead, or when there is no
   *   way to deliver at all (no peers service AND no live lead agent).
   */
  assign(secretary: Agent, input: AssignInput): { taskId?: string } {
    const leadId = toSessionId(input.leadId)
    if (isForbidden(this.orgState, secretary.id, leadId)) {
      throw new Error(`dsh-org: assign_task: ${input.leadId} is forbidden to ${secretary.id}; it can never be assigned work`)
    }
    if (managerOf(this.orgState, leadId) !== secretary.id) {
      throw new Error(`dsh-org: assign_task: ${input.leadId} is not managed by ${secretary.id}; claim it first`)
    }
    const board = this.resolvedDeps.taskBoard()
    const created = board === undefined ? undefined : board.create(secretary.session, { subject: input.subject, owner: leadId })
    secretary.session.append('org/assign', {
      secretaryId: secretary.id,
      leadId,
      subject: input.subject,
      brief: input.brief,
      ...created === undefined ? {} : { taskId: created.id },
    })
    const body = `<assignment from="${escapeXml(secretary.id)}" subject="${escapeXml(input.subject)}">${escapeXml(input.brief)}</assignment>`
    const peers = this.resolvedDeps.peers()
    if (peers !== undefined) {
      void peers.send(secretary, { targetId: leadId, content: body, delivery: 'wakeup' }).catch((error: unknown) => {
        this.ctx.logger.warn('dsh-org: assign_task delivery failed for %s: %o', input.leadId, error)
      })
    } else {
      const lead = this.ctx.agents.get(leadId)
      if (lead === undefined) {
        throw new Error('dsh-org: assign_task: cannot deliver the brief (no peers service and no live lead agent)')
      }
      lead.followup(createUserMessage({
        content: [{ type: 'text', text: body }],
        source: { kind: 'dsh-org', form: 'notice', summary: `Task assigned: ${input.subject}` },
      }))
    }
    return created === undefined ? {} : { taskId: created.id }
  }

  /**
   * Record a durable user-facing notice on the caller's log.
   * @param agent - the notifying agent (its own log carries the notice).
   * @param content - the note.
   * @returns the notice id (stable across folds: `n-<event seq>`).
   */
  notify(agent: Agent, content: string): { id: string } {
    const event = agent.session.append('org/notice', { content })
    return { id: `n-${event.seq}` }
  }

  /**
   * The notices recorded on a session's log, oldest first.
   * @param sessionId - the session whose log is read.
   * @returns the notices (empty when the session is unknown).
   */
  notices(sessionId: SessionId | string): OrgNotice[] {
    const session = this.ctx.sessions.get(toSessionId(sessionId))
    if (session === undefined) return []
    const notices: OrgNotice[] = []
    for (const event of session.snapshotEvents()) {
      if (event.type === 'org/notice') notices.push({ id: `n-${event.seq}`, content: event.data.content, time: event.time })
    }
    return notices
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Unwind a live target's role envelope when its management edge is released.
   * A cold session has no live scope; its role events (and the controller's
   * `agent/created` re-sync) decide what it gets on resume.
   */
  private liftTargetEnvelope(id: SessionId): void {
    const agent = this.ctx.agents.get(id)
    if (agent !== undefined) disposeEnvelope(agent)
  }

  /**
   * Append release/forbid records to a target's own log. A live target appends
   * through its `Session`; a cold one writes its stored log through the
   * persistence seam, so the record survives until the target resumes.
   * @param id - the target session.
   * @param drafts - the events to append, in order.
   */
  private async appendToTarget(id: SessionId, drafts: readonly TargetLogEvent[]): Promise<void> {
    if (drafts.length === 0) return
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) {
      this.appendLiveTarget(live, drafts)
      return
    }
    await this.appendStoredTarget(id, drafts)
  }

  /** Append drafts to a live target's in-memory log (which folds and persists them). */
  private appendLiveTarget(session: Session, drafts: readonly TargetLogEvent[]): void {
    for (const draft of drafts) {
      if (draft.type === 'org/role') session.append('org/role', draft.data)
      else session.append(draft.type, draft.data)
    }
  }

  /**
   * Append drafts directly to a cold target's stored log. Events are marked
   * `ignorable` because out-of-tree event vocabulary is outside the harness's
   * known-type catalog (the documented compatibility mechanism); a reader that
   * does not know `org/*` can then skip them instead of refusing the log.
   * @param id - the cold target session.
   * @param drafts - the events to append, in order.
   */
  private async appendStoredTarget(id: SessionId, drafts: readonly TargetLogEvent[]): Promise<void> {
    const persistence = this.resolvedDeps.sessionPersistence()
    if (persistence === undefined) return
    let handle: PersistenceHandleProbe
    try {
      handle = await persistence.open(id, 'write')
    } catch (error) {
      // No stored log for that id: `/org forbid <unknown-id>` stays a valid,
      // purely local prohibition, so there is simply nothing durable to write.
      if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') return
      // A resume may have won the race after the liveness check: append to the
      // now-live session instead of writing behind its back.
      const live = this.ctx.sessions.get(id)
      if (live !== undefined) {
        this.appendLiveTarget(live, drafts)
        return
      }
      throw error
    }
    try {
      let next = (await persistence.stat?.(id))?.eventCount
      if (next === undefined) {
        const { events } = await handle.read()
        const last = events.at(-1)
        next = last === undefined ? 0 : last.seq + 1
      }
      const batch = drafts.map((draft, index) => ({
        type: draft.type,
        seq: SessionSeq(next + index),
        time: Date.now(),
        data: draft.data,
        ignorable: true,
      } as SessionEvent))
      await handle.append(batch)
      await handle.flush()
    } finally {
      await handle.close()
    }
  }

  /** Fold a session's whole existing log into the state. */
  private foldLog(session: Session): void {
    let next = this.orgState
    for (const event of session.snapshotEvents()) next = applyOrgEvent(next, event)
    this.orgState = next
  }

  /** Fold one live event into the state. */
  private applyEvent(_session: Session, event: SessionEvent): void {
    this.orgState = applyOrgEvent(this.orgState, event)
  }

  /** Append a self-describing role event when the session's OWN log does not already carry it. */
  private ensureRole(session: Session, sessionId: SessionId, role: OrgRole): void {
    if (this.roleFromLog(session, sessionId) === role) return
    session.append('org/role', { sessionId, role })
  }

  /**
   * The role a session's OWN log folds to. The global state is not used here:
   * a claim stamps `roles[target] = 'lead'` from the SECRETARY's event, but the
   * target's projection only learns its role from a role event on its own log.
   */
  private roleFromLog(session: Session, sessionId: SessionId): OrgRole | undefined {
    let role: OrgRole | undefined
    for (const event of session.snapshotEvents()) {
      if (event.type === 'org/role' && event.data.sessionId === sessionId) role = event.data.role
    }
    return role
  }
}

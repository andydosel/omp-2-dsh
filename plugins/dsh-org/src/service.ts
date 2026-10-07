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
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveOrgConfig, type OrgConfig, type ResolvedOrgConfig } from './config.ts'
import { applyLeadEnvelope } from './envelope.ts'
import { workspaceRoot } from './paths.ts'
import {
  addForbidden,
  applyOrgEvent,
  emptyOrgState,
  forbiddenOf,
  grantClaim,
  managerOf,
  managesOf,
  roleOf,
  toSessionId,
} from './state.ts'
import { escapeXml } from './tools.ts'
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
  SpawnLeadInput,
  TaskBoardProbe,
} from './types.ts'

/**
 * The organisation service (context key `org`). Constructing it registers the
 * service and starts folding every live session log.
 */
export class OrgService extends Service implements OrgApi {
  static inject = ['agents', 'sessions'] as const

  readonly #config: ResolvedOrgConfig
  readonly #deps: OrgDeps
  #state: OrgState = emptyOrgState()

  /**
   * @param ctx - the plugin context (`agents` and `sessions` are injected).
   * @param config - raw plugin configuration (validated here; unknown keys throw).
   */
  constructor(ctx: Context, config: OrgConfig = {}) {
    super(ctx, 'org')
    this.#config = resolveOrgConfig(config)
    this.#deps = {
      org: this,
      config: this.#config,
      peers: () => ctx.get('peers') as PeersProbe | undefined,
      taskBoard: () => ctx.get('taskBoard') as TaskBoardProbe | undefined,
      approval: () => ctx.get('approval') as ApprovalProbe | undefined,
      fs: () => ctx.get('fs') as FsProbe | undefined,
    }
    // Seed from sessions that already exist, then stay current.
    for (const session of ctx.sessions.list()) this.#foldLog(session)
    ctx.on('session/created', session => this.#foldLog(session))
    ctx.on('session/event', (session, event) => this.#applyEvent(session, event))
  }

  /** The detached, validated configuration the role envelopes consume. */
  get config(): ResolvedOrgConfig {
    return this.#config
  }

  /** The seams the controller hands to the envelopes and tools. */
  get deps(): OrgDeps {
    return this.#deps
  }

  /** The live organisation state (do not mutate; every change goes through a transition). */
  state(): OrgState {
    return this.#state
  }

  // ── readers (OrgApi) ──────────────────────────────────────────────────────

  /** The secretary managing `targetId`, or undefined when independent. */
  managerOf(targetId: SessionId | string): SessionId | undefined {
    return managerOf(this.#state, targetId)
  }

  /** The sessions `secretaryId` currently manages, in claim order. */
  managesOf(secretaryId: SessionId | string): SessionId[] {
    return managesOf(this.#state, secretaryId)
  }

  /** The sessions `secretaryId` has forbidden. */
  forbiddenOf(secretaryId: SessionId | string): SessionId[] {
    return forbiddenOf(this.#state, secretaryId)
  }

  /** Whether `secretaryId` has forbidden `targetId`. */
  isForbidden(secretaryId: SessionId | string, targetId: SessionId | string): boolean {
    return (this.forbiddenOf(secretaryId)).includes(toSessionId(targetId))
  }

  /** The folded role of a session, or undefined when independent. */
  roleOf(sessionId: SessionId | string): OrgRole | undefined {
    return roleOf(this.#state, sessionId)
  }

  // ── mutations (OrgApi) ────────────────────────────────────────────────────

  /**
   * Take over a target session for a secretary. Appends `org/claim` to both
   * logs (plus the self-describing role events the projections need).
   * @param secretary - the claiming agent.
   * @param targetId - the target session id.
   * @throws when the target is unknown, is the caller itself, is managed by a
   *   DIFFERENT secretary, or is forbidden to this secretary.
   */
  claim(secretary: Agent, targetId: string): void {
    const id = toSessionId(targetId)
    if (id === secretary.id) {
      throw new Error(`dsh-org: a session cannot manage itself (${targetId})`)
    }
    const target = this.ctx.sessions.get(id)
    if (target === undefined) {
      throw new Error(`dsh-org: cannot claim ${targetId}: no live session with that id`)
    }
    // Hard invariant check before any append (throws on conflict / forbidden).
    grantClaim(this.#state, secretary.id, id)
    this.#ensureRole(secretary.session, secretary.id, 'secretary')
    secretary.session.append('org/claim', { secretaryId: secretary.id, targetId: id })
    this.#ensureRole(target, id, 'lead')
    target.append('org/claim', { secretaryId: secretary.id, targetId: id })
  }

  /**
   * Release a management edge and clear the target's lead role (forbidden set
   * untouched).
   * @param secretary - the releasing agent.
   * @param targetId - the managed session id.
   * @throws when the caller does not manage the target.
   */
  relinquish(secretary: Agent, targetId: string): void {
    const id = toSessionId(targetId)
    if (managerOf(this.#state, id) !== secretary.id) {
      throw new Error(`dsh-org: ${secretary.id} does not manage ${targetId}; nothing to relinquish`)
    }
    const wasLead = roleOf(this.#state, id) === 'lead'
    const target = this.ctx.sessions.get(id)
    secretary.session.append('org/relinquish', { secretaryId: secretary.id, targetId: id })
    if (target === undefined) return
    if (wasLead) target.append('org/role', { sessionId: id })
    target.append('org/relinquish', { secretaryId: secretary.id, targetId: id })
  }

  /**
   * Forbid the secretary from touching a target; when the secretary currently
   * owns it, the edge is released in the same operation ("release + forbid").
   * Idempotent.
   * @param secretary - the forbidding agent.
   * @param targetId - the session to forbid.
   */
  forbid(secretary: Agent, targetId: string): void {
    const id = toSessionId(targetId)
    const owned = managerOf(this.#state, id) === secretary.id
    const wasLead = roleOf(this.#state, id) === 'lead'
    addForbidden(this.#state, secretary.id, id)
    secretary.session.append('org/forbid', { secretaryId: secretary.id, targetId: id })
    if (!owned) return
    const target = this.ctx.sessions.get(id)
    if (target === undefined) return
    if (wasLead) target.append('org/role', { sessionId: id })
    target.append('org/relinquish', { secretaryId: secretary.id, targetId: id })
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
    if (this.#roleFromLog(session, sessionId) === role) return
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
        applyLeadEnvelope(agentCtx, leadAgent, this.#deps)
      },
    })
    this.claim(secretary, sessionId)
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
    if (managerOf(this.#state, leadId) !== secretary.id) {
      throw new Error(`dsh-org: assign_task: ${input.leadId} is not managed by ${secretary.id}; claim it first`)
    }
    const board = this.#deps.taskBoard()
    const created = board === undefined ? undefined : board.create(secretary.session, { subject: input.subject, owner: leadId })
    secretary.session.append('org/assign', {
      secretaryId: secretary.id,
      leadId,
      subject: input.subject,
      brief: input.brief,
      ...created === undefined ? {} : { taskId: created.id },
    })
    const body = `<assignment from="${escapeXml(secretary.id)}" subject="${escapeXml(input.subject)}">${escapeXml(input.brief)}</assignment>`
    const peers = this.#deps.peers()
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

  /** Fold a session's whole existing log into the state. */
  #foldLog(session: Session): void {
    let next = this.#state
    for (const event of session.snapshotEvents()) next = applyOrgEvent(next, event)
    this.#state = next
  }

  /** Fold one live event into the state. */
  #applyEvent(_session: Session, event: SessionEvent): void {
    this.#state = applyOrgEvent(this.#state, event)
  }

  /** Append a self-describing role event when the session's OWN log does not already carry it. */
  #ensureRole(session: Session, sessionId: SessionId, role: OrgRole): void {
    if (this.#roleFromLog(session, sessionId) === role) return
    session.append('org/role', { sessionId, role })
  }

  /**
   * The role a session's OWN log folds to. The global state is not used here:
   * a claim stamps `roles[target] = 'lead'` from the SECRETARY's event, but the
   * target's projection only learns its role from a role event on its own log.
   */
  #roleFromLog(session: Session, sessionId: SessionId): OrgRole | undefined {
    let role: OrgRole | undefined
    for (const event of session.snapshotEvents()) {
      if (event.type === 'org/role' && event.data.sessionId === sessionId) role = event.data.role
    }
    return role
  }
}

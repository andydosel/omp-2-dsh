/**
 * dsh-org domain vocabulary: the durable `org/*` session events, the
 * `org` session-projection declarations, the coarse global `OrgState` the
 * service folds, the structural probes for the sibling services this plugin
 * wires by GLOBAL NAME only (never by package import), and the framework-free
 * `OrgApi`/`OrgDeps` seam the tools, envelopes, and commands program against.
 *
 * Design: DESIGN-COORDINATOR-SUITE.md §5.1 / §5.6 / §5.9 / §5.10 / §13.6.
 *
 * Event semantics (delta events, folded):
 * - `org/claim` / `org/relinquish` are appended to BOTH the acting secretary's
 *   log and the target session's log, so each session's own `org` projection is
 *   self-describing (the secretary sees `manages`, the target sees `managedBy`).
 *   The per-session projection tells the two apart from the session's folded
 *   `role` (a `secretary`-role log reads a claim as "I manage the target",
 *   every other log reads it as "the target is managed by the secretary").
 * - `org/role` names the session it applies to, so it is folded verbatim and
 *   an ABSENT `role` means "role cleared".
 * - `org/forbid` is appended to the acting secretary's log (the forbidden set
 *   is the secretary's "sessions I must not touch" list); its target-side
 *   mirror `org/forbidden` is appended to the TARGET's log (live, or its
 *   stored log when cold) so replaying the target's old `org/claim` can never
 *   resurrect the forbidden edge.
 * - `org/assign` / `org/notice` are informational for the coarse global state;
 *   their durable home is the acting session's log and the `org` projection.
 *
 * @module @dsh-plugin/dsh-org/types
 */

import type { ContextFormed, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ResolvedOrgConfig } from './config.ts'

/** A session's organisational role. Independent sessions carry none. */
export type OrgRole = 'secretary' | 'lead'

/**
 * The coarse, process-global organisation state the service owns and folds
 * from every live session log.
 *
 * - `manager`: target session → the ONE secretary that manages it. An absent
 *   key means the target is independent; the `| undefined` is a read-side view
 *   convenience, a stored `undefined` is never written.
 * - `forbidden`: secretary session → the sessions it must not touch.
 * - `roles`: session → its folded role (absent = independent).
 */
export interface OrgState {
  manager: Record<SessionId, SessionId | undefined>
  forbidden: Record<SessionId, SessionId[]>
  roles: Record<SessionId, OrgRole>
}

/** One durable user-facing notice recorded by `notify_user`. */
export interface OrgNotice {
  id: string
  content: string
  time: number
}

/**
 * The `org` session projection value. A secretary's log shows what it
 * `manages` and what is `forbidden`; a managed session shows `managedBy` and
 * its own `role`; `notices` are the notes it recorded for the human.
 */
export interface OrgProjectionView {
  role: OrgRole | null
  managedBy: SessionId | null
  manages: SessionId[]
  forbidden: SessionId[]
  notices: OrgNotice[]
}

/** A `org_spawn_lead` request: the lead's display name, workspace, and opening brief. */
export interface SpawnLeadInput {
  name: string
  cwd?: string
  prompt: string
}

/** An `assign_task` request: the managed lead, the task subject, and the brief. */
export interface AssignInput {
  leadId: string
  subject: string
  brief: string
}

/**
 * Structural probe for the sibling `dsh-peers` service (`ctx.peers`). Only the
 * members this plugin actually calls are named; nothing here imports the peer
 * package (load-order safety).
 */
export interface PeersProbe {
  listMessages(targetId: SessionId | string): readonly {
    id: string
    senderId: SessionId
    targetId: SessionId
    delivery: 'quiet' | 'wakeup'
    content: unknown[]
    time: number
  }[]
  send(
    sender: Agent,
    input: { targetId: SessionId | string; content: string; delivery?: 'quiet' | 'wakeup' },
  ): Promise<{ status: 'delivered' | 'duplicate'; message: { id: string } }>
}

/**
 * Structural probe for the sibling task-board service (`ctx.taskBoard`). The
 * board ships exactly `create(session, { subject, owner })`; this plugin never
 * assumes more.
 */
export interface TaskBoardProbe {
  create(session: Session, input: { subject: string; owner?: SessionId | string }): { id: string }
}

/**
 * Structural probe for the filesystem seam (`ctx.fs`). Kept opaque: the
 * resolved target is passed straight back to the provider's own methods.
 */
export interface FsProbe {
  resolve(path: string, options: { cwd: string }): unknown
  readText(target: unknown): Promise<string>
  stat(target: unknown): Promise<unknown>
  listDir(target: unknown): Promise<{ name: string; type: 'file' | 'directory' | 'other' }[]>
}

/** Structural probe for the approval seam (`ctx.approval`). */
export interface ApprovalProbe {
  request(req: { agent: Agent; toolName: string; reason?: string; callId?: never; signal?: AbortSignal }): Promise<ApprovalOutcome>
}

/**
 * Structural probe for one open durable-log handle (`ctx.sessionPersistence`).
 * Only the members the cold-target append needs are named; events carry their
 * own seq/time/data because the handle appends already-built entries.
 */
export interface PersistenceHandleProbe {
  read(offset?: number, length?: number): Promise<{ events: readonly SessionEvent[] }>
  append(events: readonly SessionEvent[], options?: { signal?: AbortSignal }): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

/**
 * Structural probe for the session persistence seam. A cold (not-live) target
 * has no `Session` object to append to, so release/forbid records are written
 * straight to its stored log through this seam.
 */
export interface PersistenceProbe {
  open(id: SessionId, access: 'write'): Promise<PersistenceHandleProbe>
  stat?(id: SessionId): Promise<{ eventCount?: number }>
}

/**
 * The framework-free organisation API the tools, role envelopes, and commands
 * program against. `OrgService` implements it; tests can drive it directly.
 */
export interface OrgApi {
  managerOf(targetId: SessionId | string): SessionId | undefined
  managesOf(secretaryId: SessionId | string): SessionId[]
  forbiddenOf(secretaryId: SessionId | string): SessionId[]
  isForbidden(secretaryId: SessionId | string, targetId: SessionId | string): boolean
  roleOf(sessionId: SessionId | string): OrgRole | undefined
  claim(secretary: Agent, targetId: string): Promise<void>
  relinquish(secretary: Agent, targetId: string): Promise<void>
  forbid(secretary: Agent, targetId: string): Promise<void>
  setRole(sessionId: SessionId, role: OrgRole | undefined): void
  spawnLead(secretary: Agent, input: SpawnLeadInput): Promise<{ sessionId: SessionId }>
  assign(secretary: Agent, input: AssignInput): { taskId?: string }
  notify(agent: Agent, content: string): { id: string }
  notices(sessionId: SessionId | string): OrgNotice[]
}

/**
 * The seams every role tool / envelope reads through. Each optional sibling is
 * resolved lazily by GLOBAL NAME through `ctx.get`, so composition order does
 * not matter and an absent peer is a visible, explicable failure at the exact
 * call that needs it — never a silent no-op.
 */
export interface OrgDeps {
  /** The organisation service itself (tools close over it). */
  readonly org: OrgApi
  /** Resolved plugin configuration (paths, handoff dir, strictness). */
  readonly config: ResolvedOrgConfig
  /** Sibling peers service, when composed. */
  peers(): PeersProbe | undefined
  /** Sibling task-board service, when composed. */
  taskBoard(): TaskBoardProbe | undefined
  /** Approval seam, when composed. */
  approval(): ApprovalProbe | undefined
  /** Filesystem seam, when composed. */
  fs(): FsProbe | undefined
  /** Durable session-log seam, when composed (cold-target release/forbid records). */
  sessionPersistence(): PersistenceProbe | undefined
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A secretary claimed management of a target session (appended to both logs). */
    'org/claim': { secretaryId: SessionId; targetId: SessionId }
    /** A secretary released its management edge (appended to both logs). */
    'org/relinquish': { secretaryId: SessionId; targetId: SessionId }
    /** A secretary forbade itself from touching a session (acting log only). */
    'org/forbid': { secretaryId: SessionId; targetId: SessionId }
    /**
     * The target-side mirror of `org/forbid`: appended to the forbidden
     * session's own log (live or cold) so replaying its old `org/claim` can
     * never resurrect the edge. Folded into the same global forbidden set.
     */
    'org/forbidden': { secretaryId: SessionId; targetId: SessionId }
    /** A session's organisational role; an absent role clears it. */
    'org/role': { sessionId: SessionId; role?: OrgRole }
    /** A secretary handed a task brief to one of its leads (acting log only). */
    'org/assign': { secretaryId: SessionId; leadId: SessionId; subject: string; brief: string; taskId?: string }
    /** A durable note to the human, surfaced by the `org` projection (acting log only). */
    'org/notice': { content: string }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The session's own organisation view (role, manager edge, manages, forbidden, notices). */
    org: OrgProjectionView
  }

  interface SessionProjectionStateMap {
    /** Host fold state of the `org` unit (same shape as the wire view; plain JSON). */
    org: OrgProjectionView
  }
}

// This plugin's own message-source kind (the shared `plugin` catch-all was
// removed in 0.2.0-rc.2): the opening brief and every delivered report are
// `{ kind: 'dsh-org', form: 'notice', … }`.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-org': { kind: 'dsh-org' } & ContextFormed
  }
}

/** Re-exported so consumers building an `org`-sourced message need one import. */
export type { ContentBlock }

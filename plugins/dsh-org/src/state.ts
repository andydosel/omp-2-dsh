/**
 * The pure organisation fold: `OrgState` transitions shared by the service, the
 * session projection, and the tests. No ctx, no I/O — every function returns a
 * NEW state only when it changed something and otherwise the SAME reference
 * (`Object.is` is the projection registry's change gate and the idempotence
 * witness for replay).
 *
 * The one hard rule is "one secretary per session": {@link grantClaim} throws
 * when a DIFFERENT secretary already manages the target. The fold itself
 * ({@link applyOrgEvent}) mirrors that edge non-throwingly so replaying a
 * hand-authored conflicting log cannot blow up the projection drive, and it
 * never resurrects a forbidden edge regardless of cross-log replay order; the
 * service is where the invariant is enforced before an event is ever appended.
 *
 * @module @dsh-plugin/dsh-org/state
 */

import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { toSessionId } from '@dsh-plugin/dsh-util/session'
import type { OrgRole, OrgState } from './types.ts'

export { toSessionId }

/** An empty organisation state (nothing claimed, forbidden, or assigned). */
export function emptyOrgState(): OrgState {
  return { manager: {}, forbidden: {}, roles: {} }
}

/** The secretary managing `targetId`, or undefined when it is independent. */
export function managerOf(state: OrgState, targetId: SessionId | string): SessionId | undefined {
  return state.manager[toSessionId(targetId)]
}

/** The sessions `secretaryId` manages, in claim order. */
export function managesOf(state: OrgState, secretaryId: SessionId | string): SessionId[] {
  const id = toSessionId(secretaryId)
  const managed: SessionId[] = []
  for (const [target, secretary] of Object.entries(state.manager)) {
    if (secretary === id) managed.push(toSessionId(target))
  }
  return managed
}

/** The sessions `secretaryId` has forbidden itself from touching. */
export function forbiddenOf(state: OrgState, secretaryId: SessionId | string): SessionId[] {
  return [...(state.forbidden[toSessionId(secretaryId)] ?? [])]
}

/** Whether `secretaryId` has forbidden `targetId`. */
export function isForbidden(state: OrgState, secretaryId: SessionId | string, targetId: SessionId | string): boolean {
  return (state.forbidden[toSessionId(secretaryId)] ?? []).includes(toSessionId(targetId))
}

/** The folded role of a session, or undefined when it is independent. */
export function roleOf(state: OrgState, sessionId: SessionId | string): OrgRole | undefined {
  return state.roles[toSessionId(sessionId)]
}

/**
 * Apply a claim without the conflict check: set the manager edge and stamp both
 * roles. Same reference when the edge and roles are already exactly this.
 * A forbidden pair is never re-established: logs fold in arbitrary cross-session
 * order, so a target's old `org/claim` replayed after the secretary's
 * `org/forbid` must not resurrect the edge (the service enforces the same rule
 * before appending, and {@link grantClaim} throws).
 */
function applyClaim(state: OrgState, secretaryId: SessionId, targetId: SessionId): OrgState {
  if (isForbidden(state, secretaryId, targetId)) return state
  const unchanged = managerOf(state, targetId) === secretaryId
    && roleOf(state, targetId) === 'lead'
    && roleOf(state, secretaryId) === 'secretary'
  if (unchanged) return state
  return {
    manager: { ...state.manager, [targetId]: secretaryId },
    forbidden: state.forbidden,
    roles: { ...state.roles, [targetId]: 'lead', [secretaryId]: 'secretary' },
  }
}

/**
 * Claim a target for a secretary. Hard-enforced: throws when a DIFFERENT
 * secretary already manages the target, and when the secretary has forbidden
 * it (a forbidden pair is never claimable).
 * @param state - the organisation state before the claim.
 * @param secretaryId - the claiming secretary.
 * @param targetId - the session to manage.
 * @returns the next state (same reference when the claim is already in force).
 * @throws when the target is managed by another secretary or forbidden to this one.
 */
export function grantClaim(state: OrgState, secretaryId: SessionId, targetId: SessionId): OrgState {
  const existing = managerOf(state, targetId)
  if (existing !== undefined && existing !== secretaryId) {
    throw new Error(`dsh-org: session ${targetId} is already managed by ${existing}; one secretary per session`)
  }
  if (isForbidden(state, secretaryId, targetId)) {
    throw new Error(`dsh-org: ${secretaryId} has forbidden ${targetId}; a forbidden pair is never claimable`)
  }
  return applyClaim(state, secretaryId, targetId)
}

/**
 * Release a management edge and, if the target's folded role is `lead`, clear
 * it too. The forbidden set is never touched here.
 * @param state - the organisation state before the release.
 * @param secretaryId - the secretary releasing the target.
 * @param targetId - the managed session.
 * @returns the next state (same reference when nothing changed).
 */
export function relinquishEdge(state: OrgState, secretaryId: SessionId, targetId: SessionId): OrgState {
  const owned = managerOf(state, targetId) === secretaryId
  const wasLead = roleOf(state, targetId) === 'lead'
  if (!owned && !wasLead) return state
  const manager = { ...state.manager }
  if (owned) delete manager[targetId]
  const roles = { ...state.roles }
  if (wasLead) delete roles[targetId]
  return { manager, forbidden: state.forbidden, roles }
}

/**
 * Forbid a secretary from touching a target. Idempotent; when this secretary
 * currently owns the target, the manager edge (and the target's `lead` role) is
 * cleared in the SAME transition — the panel's "release + forbid" is one
 * operation, so a forbidden session is never left half-managed.
 * @param state - the organisation state before the forbid.
 * @param secretaryId - the forbidding secretary.
 * @param targetId - the session to forbid.
 * @returns the next state (same reference when already forbidden and unowned).
 */
export function addForbidden(state: OrgState, secretaryId: SessionId, targetId: SessionId): OrgState {
  const list = state.forbidden[secretaryId] ?? []
  const already = list.includes(targetId)
  const owned = managerOf(state, targetId) === secretaryId
  if (already && !owned) return state
  const forbidden = already ? state.forbidden : { ...state.forbidden, [secretaryId]: [...list, targetId] }
  if (!owned) return { manager: state.manager, forbidden, roles: state.roles }
  const manager = { ...state.manager }
  delete manager[targetId]
  const roles = { ...state.roles }
  if (roles[targetId] === 'lead') delete roles[targetId]
  return { manager, forbidden, roles }
}

/**
 * Set (or clear) a session's organisational role. An `undefined` role removes
 * the entry — the read side then reports the session as independent.
 * @param state - the organisation state before the change.
 * @param sessionId - the session whose role changes.
 * @param role - the role, or undefined to clear it.
 * @returns the next state (same reference when the role is unchanged).
 */
export function setRole(state: OrgState, sessionId: SessionId, role: OrgRole | undefined): OrgState {
  if (role === undefined) {
    if (state.roles[sessionId] === undefined) return state
    const roles = { ...state.roles }
    delete roles[sessionId]
    return { manager: state.manager, forbidden: state.forbidden, roles }
  }
  if (state.roles[sessionId] === role) return state
  return { manager: state.manager, forbidden: state.forbidden, roles: { ...state.roles, [sessionId]: role } }
}

/**
 * Fold one committed session event into the organisation state. Events that are
 * not `org/*` (or an `org/*` event that changes nothing) return the SAME state
 * reference.
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state, or the same reference when the event is foreign.
 */
export function applyOrgEvent(state: OrgState, event: SessionEvent): OrgState {
  switch (event.type) {
    case 'org/claim':
      return applyClaim(state, event.data.secretaryId, event.data.targetId)
    case 'org/relinquish':
      return relinquishEdge(state, event.data.secretaryId, event.data.targetId)
    case 'org/forbid':
    case 'org/forbidden':
      return addForbidden(state, event.data.secretaryId, event.data.targetId)
    case 'org/role':
      return setRole(state, event.data.sessionId, event.data.role)
    case 'org/assign':
    case 'org/notice':
      // Informational for the coarse state: both events' durable home is the
      // acting session's log and the per-session `org` projection.
      return state
    default:
      return state
  }
}

/**
 * Fold a session's committed events into the organisation state. The fold is
 * idempotent: replaying an already-folded prefix returns the same state
 * reference.
 * @param events - the session's events, in order.
 * @param seed - the state to fold into (default: empty).
 * @returns the folded organisation state.
 */
export function orgStateFromEvents(events: readonly SessionEvent[], seed: OrgState = emptyOrgState()): OrgState {
  let state = seed
  for (const event of events) state = applyOrgEvent(state, event)
  return state
}

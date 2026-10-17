/**
 * Pure organisation-fold tests over REAL session logs (real append validation):
 * the manager/forbid semantics, the one-secretary-per-session invariant,
 * relinquish, and replay idempotence.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import '../src/types.ts'
import type { OrgState } from '../src/types.ts'
import {
  addForbidden,
  applyOrgEvent,
  emptyOrgState,
  forbiddenOf,
  grantClaim,
  isForbidden,
  managerOf,
  managesOf,
  orgStateFromEvents,
  relinquishEdge,
  roleOf,
} from '../src/state.ts'

/** A real session with a stable id. */
function newSession(id: string): Session {
  return Session.create(SessionId(id))
}

/** Fold one session's log into a fresh organisation state. */
function fold(session: Session): OrgState {
  return orgStateFromEvents(session.snapshotEvents())
}

describe('org state fold', () => {
  it('a claim sets the manager edge and both roles', () => {
    const session = newSession('sec')
    session.append('org/claim', { secretaryId: SessionId('sec'), targetId: SessionId('tgt') })
    const state = fold(session)
    expect(managerOf(state, 'tgt')).toBe('sec')
    expect(roleOf(state, 'tgt')).toBe('lead')
    expect(roleOf(state, 'sec')).toBe('secretary')
    expect(managesOf(state, 'sec')).toEqual(['tgt'])
  })

  it('a second secretary claiming the same target throws and leaves the state untouched', () => {
    const session = newSession('sec')
    session.append('org/claim', { secretaryId: SessionId('sec'), targetId: SessionId('tgt') })
    const state = fold(session)
    expect(() => grantClaim(state, SessionId('other'), SessionId('tgt'))).toThrow(/one secretary per session/)
    expect(managerOf(state, 'tgt')).toBe('sec')
    expect(managesOf(state, 'other')).toEqual([])
  })

  it('forbid blocks a later claim, clears an existing edge, and is idempotent', () => {
    const session = newSession('sec')
    session.append('org/claim', { secretaryId: SessionId('sec'), targetId: SessionId('tgt') })
    let state = fold(session)
    state = addForbidden(state, SessionId('sec'), SessionId('tgt'))
    expect(isForbidden(state, 'sec', 'tgt')).toBe(true)
    expect(managerOf(state, 'tgt')).toBeUndefined()
    expect(roleOf(state, 'tgt')).toBeUndefined()
    expect(() => grantClaim(state, SessionId('sec'), SessionId('tgt'))).toThrow(/forbidden/)
    const again = addForbidden(state, SessionId('sec'), SessionId('tgt'))
    expect(again).toBe(state)
    expect(forbiddenOf(state, 'sec')).toEqual(['tgt'])
  })

  it('forbid keeps a never-owned target unclaimable', () => {
    let state = emptyOrgState()
    state = addForbidden(state, SessionId('sec'), SessionId('tgt'))
    expect(() => grantClaim(state, SessionId('sec'), SessionId('tgt'))).toThrow(/forbidden/)
  })

  it('relinquish clears the edge and the lead role while the forbidden set is untouched', () => {
    const session = newSession('sec')
    session.append('org/claim', { secretaryId: SessionId('sec'), targetId: SessionId('tgt') })
    let state = fold(session)
    state = addForbidden(state, SessionId('sec'), SessionId('other'))
    const next = relinquishEdge(state, SessionId('sec'), SessionId('tgt'))
    expect(managerOf(next, 'tgt')).toBeUndefined()
    expect(roleOf(next, 'tgt')).toBeUndefined()
    expect(forbiddenOf(next, 'sec')).toEqual(['other'])
  })

  it('never resurrects a forbidden edge when the target claim replays later', () => {
    // Cross-session logs fold in arbitrary order: the secretary's forbid can
    // land before the target's historical claim. The fold must keep the pair
    // forbidden and leave no manager edge/lead role.
    let state = emptyOrgState()
    state = applyOrgEvent(state, {
      type: 'org/forbid', seq: 0, time: 0,
      data: { secretaryId: SessionId('sec'), targetId: SessionId('tgt') },
    } as SessionEvent)
    state = applyOrgEvent(state, {
      type: 'org/claim', seq: 0, time: 0,
      data: { secretaryId: SessionId('sec'), targetId: SessionId('tgt') },
    } as SessionEvent)
    expect(isForbidden(state, 'sec', 'tgt')).toBe(true)
    expect(managerOf(state, 'tgt')).toBeUndefined()
    expect(roleOf(state, 'tgt')).toBeUndefined()
  })

  it('folds the target-side forbidden mirror into the same forbidden set', () => {
    const session = newSession('target')
    session.append('org/claim', { secretaryId: SessionId('sec'), targetId: SessionId('tgt') })
    session.append('org/forbidden', { secretaryId: SessionId('sec'), targetId: SessionId('tgt') })
    const state = fold(session)
    expect(isForbidden(state, 'sec', 'tgt')).toBe(true)
    expect(managerOf(state, 'tgt')).toBeUndefined()
  })

  it('is replay-idempotent and passes foreign events through by reference', () => {
    const session = newSession('sec')
    session.append('org/claim', { secretaryId: SessionId('sec'), targetId: SessionId('tgt') })
    session.append('org/claim', { secretaryId: SessionId('sec'), targetId: SessionId('tgt') })
    const events = session.snapshotEvents()
    const once = orgStateFromEvents(events)
    const twice = orgStateFromEvents(events, once)
    expect(twice).toBe(once)
    const foreign = { type: 'turn/start', seq: 999, time: 0, data: { turn: 1 } } as unknown as SessionEvent
    expect(applyOrgEvent(once, foreign)).toBe(once)
  })
})

/**
 * `peers` inbox fold tests: the pure transition over REAL appended Session
 * events, the reference-identity gate, and replay idempotence (the fold never
 * duplicates a replayed `peer/message`).
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { applyPeerEvent, findMessage, foldPeerInbox, hasKey, listMessages } from '../src/inbox.ts'
import { dedupeKey } from '../src/types.ts'
import type { PeerMessageSnapshot } from '../src/types.ts'

/** One well-formed snapshot addressed to `target`. */
function snapshot(sender: string, messageId: string, target = 'sess-a', text = 'hello'): PeerMessageSnapshot {
  return {
    id: dedupeKey(SessionId(sender), messageId),
    senderId: SessionId(sender),
    targetId: SessionId(target),
    messageId,
    delivery: 'quiet',
    content: [{ type: 'text', text }],
    time: 1,
  }
}

describe('applyPeerEvent', () => {
  it('returns the SAME reference for a non-peer event', () => {
    const session = Session.create(SessionId('sess-a'))
    const turnStart = session.append('turn/start', { turn: 1 })
    const state: PeerMessageSnapshot[] = []
    expect(applyPeerEvent(state, turnStart)).toBe(state)
  })

  it('returns the SAME reference for an already-folded dedupe key', () => {
    const session = Session.create(SessionId('sess-a'))
    const event = session.append('peer/message', snapshot('sender', 'm1'))
    const once = applyPeerEvent([], event)
    expect(once).toHaveLength(1)
    expect(applyPeerEvent(once, event)).toBe(once)
  })

  it('appends a new snapshot in arrival order', () => {
    const session = Session.create(SessionId('sess-a'))
    const first = session.append('peer/message', snapshot('sender', 'm1', 'sess-a', 'one'))
    const second = session.append('peer/message', snapshot('sender', 'm2', 'sess-a', 'two'))
    const state = foldPeerInbox([first, second])
    expect(state.map(message => message.messageId)).toEqual(['m1', 'm2'])
  })
})

describe('foldPeerInbox', () => {
  it('is replay-idempotent: doubling the log leaves the inbox unchanged', () => {
    const session = Session.create(SessionId('sess-a'))
    session.append('turn/start', { turn: 1 })
    const a = session.append('peer/message', snapshot('sender', 'm1'))
    const b = session.append('peer/message', snapshot('other', 'm1'))
    const once = foldPeerInbox([a, b])
    expect(once).toHaveLength(2)
    const replayed = foldPeerInbox([a, b, a, b, a, b])
    expect(replayed).toHaveLength(2)
    expect(replayed.map(message => message.id)).toEqual(once.map(message => message.id))
  })
})

describe('inbox readers', () => {
  const state = foldPeerInbox([
    Session.create(SessionId('sess-a')).append('peer/message', snapshot('s1', 'm1', 'sess-a')),
    Session.create(SessionId('sess-b')).append('peer/message', snapshot('s2', 'm1', 'sess-b')),
  ])

  it('narrows by target', () => {
    expect(listMessages(state, 'sess-a').map(message => String(message.senderId))).toEqual(['s1'])
    expect(listMessages(state, 'sess-b')).toHaveLength(1)
    expect(listMessages(state)).toHaveLength(2)
  })

  it('finds by dedupe key', () => {
    const key = dedupeKey(SessionId('s1'), 'm1')
    expect(hasKey(state, key)).toBe(true)
    expect(findMessage(state, key)?.messageId).toBe('m1')
    expect(findMessage(state, 's1#nope')).toBeUndefined()
  })
})

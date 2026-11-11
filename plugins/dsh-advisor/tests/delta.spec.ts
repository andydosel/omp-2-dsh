/**
 * Delta observer + serialization tests: cursor advancement, live-surface
 * filtering after replacement, the self-advice filter, and prompt-budget
 * truncation.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeltaObserver, estimateTokens, serializeDelta } from '../src/delta.ts'
import { ADVISOR_SOURCE_KIND } from '../src/delivery.ts'
import { appendAssistantMessage, appendToolResult, appendUserMessage, messageText } from './helpers.ts'

/** Predicate matching the runtime's self-advice filter. */
function ownMessagePredicate(event: SessionEvent): boolean {
  return event.type === 'user/message'
    && event.data.source.kind === ADVISOR_SOURCE_KIND
}

describe('DeltaObserver', () => {
  it('advances the cursor over appended events and collects surface messages', () => {
    const session = Session.create(SessionId('primary'))
    appendUserMessage(session, 'user prompt')
    appendAssistantMessage(session, 'assistant reply')
    appendToolResult(session, 'c1', 'tool output')

    const observer = new DeltaObserver(ownMessagePredicate)
    // Simulate the live feed: observe each event as it lands.
    for (const event of session.snapshotEvents()) observer.observe(event)

    const batch = observer.collect(session)
    expect(batch.messages.map(messageText)).toEqual(['user prompt', 'assistant reply', 'tool output'])
    expect(batch.seqs).toEqual([0, 1, 2])
    expect(batch.dropped).toBe(0)
    // The cursor advanced to the log end; a second collect returns nothing.
    expect(observer.nextSeq).toBe(session.seq)
    expect(observer.collect(session).messages).toEqual([])
  })

  it('collects each event exactly once across observe/collect cycles', () => {
    const session = Session.create(SessionId('primary'))
    const first = appendUserMessage(session, 'one')
    const observer = new DeltaObserver(ownMessagePredicate)
    observer.observe(first)
    // collect drains the uncollected range; a second collect finds nothing.
    expect(observer.collect(session).messages).toHaveLength(1)
    expect(observer.collect(session).messages).toHaveLength(0)
    // The observed event is stale after the cursor passed it.
    expect(observer.observe(first)).toBe(false)
    expect(observer.nextSeq).toBe(session.seq)
  })

  it('drops shadowed nodes and own messages from a collected batch', () => {
    const session = Session.create(SessionId('primary'))
    appendUserMessage(session, 'original')
    appendUserMessage(session, 'second')
    // Replace node 0 with a summary (compaction-style rewrite).
    const summary = createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } })
    session.append('user/message', summary, { surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) }, sourceEventSeqs: [SessionSeq(0)] })

    const observer = new DeltaObserver(ownMessagePredicate)
    for (const event of session.snapshotEvents()) observer.observe(event)
    const batch = observer.collect(session)
    // Node 0 (shadowed) is dropped from the surface entirely; the
    // replacement node (surface position 0) and node 1 survive, in surface
    // position order.
    expect(batch.messages.map(messageText)).toEqual(['summary', 'second'])
    expect(batch.dropped).toBe(0)
  })

  it('rewind makes the next collect return the whole current surface', () => {
    const session = Session.create(SessionId('primary'))
    appendUserMessage(session, 'hello')
    const observer = new DeltaObserver(ownMessagePredicate)
    observer.fastForward(session)
    expect(observer.collect(session).messages).toEqual([])
    observer.rewind()
    const batch = observer.collect(session)
    expect(batch.messages.map(messageText)).toEqual(['hello'])
    expect(batch.seqs).toEqual([0])
  })

  it('fastForward skips existing history', () => {
    const session = Session.create(SessionId('primary'))
    appendUserMessage(session, 'old')
    const observer = new DeltaObserver(ownMessagePredicate)
    observer.fastForward(session)
    expect(observer.collect(session).messages).toEqual([])
    appendUserMessage(session, 'new')
    expect(observer.collect(session).messages.map(messageText)).toEqual(['new'])
  })

  it('filters advisor-plugin-sourced messages via the predicate', () => {
    const session = Session.create(SessionId('primary'))
    appendUserMessage(session, 'user text')
    appendUserMessage(session, 'advisor says fix', {
      kind: ADVISOR_SOURCE_KIND,
      form: 'notice',
      summary: 'advisor (nit): fix',
    })
    const observer = new DeltaObserver(ownMessagePredicate)
    for (const event of session.snapshotEvents()) observer.observe(event)
    const batch = observer.collect(session)
    expect(batch.messages.map(messageText)).toEqual(['user text'])
    expect(batch.dropped).toBe(1)
  })
})

describe('estimateTokens', () => {
  it('prices four characters per token', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('serializeDelta', () => {
  function makeMessage(text: string) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  it('frames a delta with a seq range and guidance', () => {
    const messages = [makeMessage('first'), makeMessage('second')]
    const serialized = serializeDelta('delta', messages, [10, 11], 8192, 'primary')
    expect(serialized.text).toContain('<advisor-delta seqs="10..11" context="primary">')
    expect(serialized.text).toContain('<entry seq="10" role="user">')
    expect(serialized.text).toContain('first')
    expect(serialized.text).toContain('advise')
    expect(serialized.messageCount).toBe(2)
    expect(serialized.truncated).toBe(false)
  })

  it('frames a baseline without a seq range', () => {
    const serialized = serializeDelta('baseline', [makeMessage('state')], [3], 8192, 'primary')
    expect(serialized.text).toContain('<advisor-baseline kind="baseline"')
    expect(serialized.text).not.toContain('seqs=')
    expect(serialized.text).toContain('current bounded transcript')
  })

  it('truncates past the token budget while keeping the head', () => {
    const long = 'x'.repeat(2000)
    const serialized = serializeDelta('delta', [makeMessage('head'), makeMessage(long)], [0, 1], 100, 'primary')
    expect(serialized.truncated).toBe(true)
    expect(serialized.messageCount).toBe(1)
    expect(serialized.text).toContain('head')
    expect(serialized.text).not.toContain(long)
    expect(serialized.text).toContain('truncated')
  })

  it('keeps the TAIL of a truncated baseline, not the oldest entries', () => {
    const messages = [makeMessage('a'.repeat(3000)), makeMessage('b'.repeat(3000)), makeMessage('recent-state')]
    const serialized = serializeDelta('baseline', messages, [0, 1, 2], 200, 'primary')
    expect(serialized.truncated).toBe(true)
    expect(serialized.messageCount).toBe(1)
    expect(serialized.text).toContain('recent-state')
    expect(serialized.text).not.toContain('a'.repeat(3000))
    expect(serialized.text).toContain('[baseline truncated: 2 earlier entries omitted')
  })

  it('re-attaches the first entry as an anchor when the budget allows', () => {
    const messages = [makeMessage('TASK-ANCHOR'), makeMessage('b'.repeat(3000)), makeMessage('recent-state')]
    const serialized = serializeDelta('baseline', messages, [0, 1, 2], 250, 'primary')
    expect(serialized.truncated).toBe(true)
    expect(serialized.messageCount).toBe(2)
    expect(serialized.text.indexOf('TASK-ANCHOR')).toBeLessThan(serialized.text.indexOf('recent-state'))
    expect(serialized.text).toContain('[baseline truncated: 1 earlier entries omitted')
  })

  it('renders tool-call and tool-result blocks inside entries', () => {
    const session = Session.create(SessionId('primary'))
    appendToolResult(session, 'c1', 'output')
    const message = session.deriveMessages()[0]
    expect(message).toBeDefined()
    const serialized = serializeDelta('delta', [message], [0], 8192, 'primary')
    expect(serialized.text).toContain('<entry seq="0" role="tool"')
    expect(serialized.text).toContain('tool-result')
  })
})

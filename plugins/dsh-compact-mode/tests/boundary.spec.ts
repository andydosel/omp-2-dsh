/**
 * Boundary hardening for the compact-mode review state machine: late
 * instructions / crash windows, span changes during review, lock conflicts,
 * apply rollback, and success/abort lifecycle reinforcement.
 *
 * Deterministic and keyless: the llm mock streams canned chunks; the helpers'
 * `DSH_HOME` fixture isolates every test's review tree under a fresh temp dir.
 *
 * @module dsh-compact-mode/tests/boundary
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { CompactModeEngine } from '../src/engine.ts'

import { makeAgent, makeContext } from './helpers.ts'
import type { MockLlm } from './helpers.ts'

/** Seed four user messages so a compactable range exists (mirrors review.spec). */
function seedSurface(agent: Agent): void {
  for (let i = 0; i < 4; i += 1) {
    agent.session.append('user/message', {
      role: 'user',
      id: `m${i}`,
      content: [{ type: 'text', text: `message ${i} `.repeat(200) }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
  }
}

/** A claimed user message — the pre-step capture input. */
function claimed(text: string): UserMessage {
  return {
    role: 'user',
    id: `claimed-${text.length}`,
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Engine fixture on a bare mocked context. */
function setupEngine(reviewTree: 'domain' | 'file' = 'file') {
  const { ctx, llm, tokenMeter, sessions } = makeContext()
  const engine = new CompactModeEngine(ctx, {
    auto: false,
    reviewTree,
    keepRecentTokens: 4000,
    minShakeSavingsRatio: 0,
  })
  return { ctx, llm, tokenMeter, sessions, engine }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** Poll until `check` stops throwing; rethrows the last assertion error. */
async function waitFor(check: () => void | Promise<void>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      lastError = error
      if (Date.now() >= deadline) throw lastError
      await sleep(5)
    }
  }
}

/** One recorded llm call's flattened message text. */
function callText(call: MockLlm['calls'][number]): string {
  return call.messages.map((message: unknown) => {
    if (typeof message === 'object' && message !== null && 'content' in message) {
      const blocks = (message as { content?: unknown }).content
      if (Array.isArray(blocks)) {
        return blocks.map((block: unknown) => {
          if (typeof block === 'object' && block !== null && 'text' in block) {
            return (block as { text?: unknown }).text
          }
          return ''
        }).filter((t: unknown): t is string => typeof t === 'string').join('|')
      }
    }
    return ''
  }).join('\n')
}

/** All recorded llm call texts, flattened. */
function allText(llm: MockLlm): string {
  return llm.calls.map(call => callText(call)).join('\n')
}

/** Session keys currently persisted in this test's review-tree JSON file. */
function readTreeKeys(): string[] {
  const home = process.env.DSH_HOME
  if (home === undefined || home.length === 0) return []
  try {
    const raw = readFileSync(join(home, 'storages', 'compact-review.json'), 'utf8')
    return Object.keys(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return []
  }
}

describe('review queue: late instructions and crash windows', () => {
  it('captures claimed instruction text synchronously into the in-memory queue before the running revision completes', async () => {
    const { engine, llm } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-inflight')
    seedSurface(agent)

    // Gate the seed revision call so it stays in flight until we release it.
    const gate = Promise.withResolvers<void>()
    let concurrent = 0
    let maxConcurrent = 0
    const gatedStream: MockLlm['stream'] = (options) => {
      llm.calls.push({
        provider: options.provider,
        model: options.model,
        messages: options.messages,
        purpose: options.purpose,
      })
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        await gate.promise
        yield { type: 'text-delta', index: 0, text: llm.reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: llm.reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        concurrent -= 1
      })()
    }
    llm.stream = gatedStream

    await engine.compactNow(agent, new AbortController().signal)
    // The seed revision is in flight, blocked on the gate.
    await waitFor(() => { expect(llm.calls).toHaveLength(1) })
    const state = engine.reviews.require(agent)
    expect(state.processing).toBe(true)

    // Capture while the revision is running: the text lands in the queue
    // SYNCHRONOUSLY (no await between capture() and this assertion), and no
    // second revision call starts yet.
    engine.reviews.capture(agent, [claimed('fix the tone')])
    expect(state.queue).toEqual(['fix the tone'])
    expect(llm.calls).toHaveLength(1)

    // Release the seed; the queued instruction drains re-entrantly AFTER it.
    gate.resolve()
    await waitFor(() => { expect(llm.calls).toHaveLength(2) })
    await waitFor(() => { expect(state.processing).toBe(false) })
    expect(state.queue).toEqual([])

    // Exactly one revision call ran at a time.
    expect(maxConcurrent).toBe(1)
    // FIFO order: seed draft first, then the captured instruction.
    expect(callText(llm.calls[0]!)).toContain('Produce the initial compaction draft')
    expect(callText(llm.calls[1]!)).toContain('Revision instruction: fix the tone')
    expect(callText(llm.calls[0]!)).not.toContain('fix the tone')
    // Both revisions landed as tree nodes, in order.
    const branch = await state.tree.engine.getBranch()
    expect(branch.map(node => node.content.instruction)).toEqual([
      'Produce the initial compaction draft for the shadowed region above.',
      'fix the tone',
    ])
  })

  it('capture with an idle drain starts the revision call synchronously (never awaited by a listener)', async () => {
    const { engine, llm } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-idle')
    seedSurface(agent)
    await engine.compactNow(agent, new AbortController().signal)
    const state = engine.reviews.require(agent)
    await waitFor(() => { expect(state.processing).toBe(false) })
    expect(state.queue).toEqual([])

    const callsBefore = llm.calls.length
    engine.reviews.capture(agent, [claimed('idle capture instruction')])
    // The queue push, the drain kick, and the revision call's stream entry
    // all happen synchronously inside capture() — the queue is consumed in
    // the same call frame.
    expect(llm.calls).toHaveLength(callsBefore + 1)
    expect(state.processing).toBe(true)

    await waitFor(() => { expect(state.processing).toBe(false) })
    expect(allText(llm)).toContain('Revision instruction: idle capture instruction')
  })

  it('a failed revision appends a failed node retaining the instruction, breaks the drain, and later instructions still process', async () => {
    const { engine, llm } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-fail')
    seedSurface(agent)

    // The seed draft fails immediately; the first captured instruction fails
    // only after a gate, so a SECOND instruction can queue behind it — its
    // processing depends on the drain's re-entrant tail after the break.
    const failGate = Promise.withResolvers<void>()
    const spy = vi.spyOn(llm, 'stream')
      .mockImplementationOnce(() => { throw new Error('simulated revision failure') })
      .mockImplementationOnce((options) => {
        llm.calls.push({
          provider: options.provider,
          model: options.model,
          messages: options.messages,
          purpose: options.purpose,
        })
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          await failGate.promise
          throw new Error('simulated instruction failure')
        })()
      })

    await engine.compactNow(agent, new AbortController().signal)
    const state = engine.reviews.require(agent)
    await waitFor(async () => { expect(await state.tree.engine.getSize()).toBe(1) })
    expect(spy).toHaveBeenCalledTimes(1)

    // Capture TWO instructions while the first revision is in flight (the
    // second queues behind it).
    engine.reviews.capture(agent, [claimed('keep this instruction')])
    await waitFor(() => { expect(spy).toHaveBeenCalledTimes(2) })
    engine.reviews.capture(agent, [claimed('still works after failure')])
    expect(state.queue).toEqual(['still works after failure'])

    // The in-flight instruction fails → a failed node keeps its text, the
    // drain breaks, and the re-entrant tail processes the queued one.
    failGate.resolve()
    await waitFor(async () => { expect(await state.tree.engine.getSize()).toBe(3) })
    expect(state.processing).toBe(false)

    const branch = await state.tree.engine.getBranch()
    expect(branch.map(node => node.content.instruction)).toEqual([
      'Produce the initial compaction draft for the shadowed region above.',
      'keep this instruction',
      'still works after failure',
    ])
    // Failed nodes retain the previous draft; the successful one landed.
    expect(branch.map(node => node.content.draft)).toEqual(['', '', 'mock summary text'])
    expect(await state.tree.engine.getLeaf()).toBe('v3')
    // The review survives the failures: mode on, lock open, still active.
    expect(engine.reviews.isActive(agent)).toBe(true)
    expect(engine.mode.get(agent).active).toBe(true)
    expect(agent.session.events.some(e => e.type === 'compaction/end')).toBe(false)
  })
})

describe('span changes during review', () => {
  it('apply rejects with changed when a user/message landed inside the selected span; surface untouched, lock open, mode active', async () => {
    const { engine } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-span')
    seedSurface(agent)
    await engine.compactNow(agent, new AbortController().signal)
    const state = engine.reviews.require(agent)
    await waitFor(() => { expect(state.processing).toBe(false) })

    // A user/message lands INSIDE the reviewed span: replace its middle node
    // with a fresh surface node (e.g. an injected notice while reviewing).
    const middle = state.shadowedSeqs[1]!
    const lengthBeforeInjection = agent.session.events.length
    agent.session.append('user/message', {
      role: 'user',
      id: 'mid',
      content: [{ type: 'text', text: 'injected inside the span' }],
      source: { kind: 'user' },
    }, { surfaceOp: { op: 'replace', start: middle, end: middle }, sourceEventSeqs: [middle] })
    const lengthAfterInjection = agent.session.events.length
    expect(lengthAfterInjection).toBe(lengthBeforeInjection + 1)

    await expect(engine.reviews.apply(agent, undefined, new AbortController().signal))
      .rejects.toMatchObject({ name: 'ManualCompactionError', code: 'changed' })

    // apply appended NOTHING: the span guard fires before any commit event.
    expect(agent.session.events).toHaveLength(lengthAfterInjection)
    expect(agent.session.events.some(e => e.type === 'compaction/summary')).toBe(false)
    expect(agent.session.events.some(e => e.type === 'compaction/end')).toBe(false)
    // Lock still open, mode still active, review state intact.
    expect(engine.mode.get(agent).active).toBe(true)
    expect(engine.reviews.isActive(agent)).toBe(true)
    expect(await state.tree.engine.getLeaf()).not.toBeNull()
  })

  it('apply rejects with changed when the compaction/start marker is no longer the event at startSeq', async () => {
    const { engine } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-marker')
    seedSurface(agent)
    await engine.compactNow(agent, new AbortController().signal)
    const state = engine.reviews.require(agent)
    await waitFor(() => { expect(state.processing).toBe(false) })

    // Simulate a log whose seqs shifted after a resumed/repaired session:
    // the seq the review lock was entered under now holds a user/message.
    // Append-only logs make this unreachable in-process; the guard is the
    // defense-in-depth revalidation.
    Object.assign(state, { startSeq: 0 })
    const lengthBefore = agent.session.events.length

    await expect(engine.reviews.apply(agent, undefined, new AbortController().signal))
      .rejects.toMatchObject({ name: 'ManualCompactionError', code: 'changed' })

    expect(agent.session.events).toHaveLength(lengthBefore)
    expect(agent.session.events.some(e => e.type === 'compaction/end')).toBe(false)
    expect(engine.mode.get(agent).active).toBe(true)
    expect(engine.reviews.isActive(agent)).toBe(true)
  })
})

describe('lock conflicts', () => {
  it('enter rejects with busy when an unmatched compaction/start exists in the log', async () => {
    const { engine } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-lock-unmatched')
    agent.session.append('compaction/start', { compactionId: CompactionId('foreign'), turn: null })
    await expect(engine.reviews.enter(agent))
      .rejects.toMatchObject({ name: 'ManualCompactionError', code: 'busy' })
    expect(engine.reviews.isActive(agent)).toBe(false)
    expect(engine.mode.get(agent).active).toBe(false)
  })

  it('enter rejects with busy while a turn is open (not command state)', async () => {
    const { engine } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-lock-turn')
    agent.session.append('turn/start', { turn: 1 })
    await expect(engine.reviews.enter(agent))
      .rejects.toMatchObject({ name: 'ManualCompactionError', code: 'busy' })
    expect(engine.reviews.isActive(agent)).toBe(false)
    expect(agent.session.events.some(e => e.type === 'compaction/start')).toBe(false)
  })

  it('compactRegion rejects with busy during an active review (engine-level guard)', async () => {
    const { engine } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-lock-region')
    seedSurface(agent)
    await engine.compactNow(agent, new AbortController().signal)
    // The ENGINE rejects before any coordinator/surface work: the review
    // holds the durable lock. (The port's own assertNoActiveCompaction
    // recheck is a second layer; this message proves the engine fired first.)
    await expect(engine.compactRegion(0, 2, agent, new AbortController().signal))
      .rejects.toMatchObject({
        name: 'ManualCompactionError',
        code: 'busy',
        message: 'compact review is active; abort or apply before region compaction',
      })
    expect(engine.reviews.isActive(agent)).toBe(true)
    expect(agent.session.events.some(e => e.type === 'compaction/summary')).toBe(false)
    expect(agent.session.events.some(e => e.type === 'compaction/end')).toBe(false)
  })

  it('a second enter on the same session rejects with busy', async () => {
    const { engine } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-lock-double')
    seedSurface(agent)
    await engine.compactNow(agent, new AbortController().signal)
    await expect(engine.compactNow(agent, new AbortController().signal))
      .rejects.toMatchObject({
        name: 'ManualCompactionError',
        code: 'busy',
        message: 'compact review already active for this session',
      })
    expect(engine.reviews.isActive(agent)).toBe(true)
    // Exactly one durable lock exists.
    expect(agent.session.events.filter(e => e.type === 'compaction/start')).toHaveLength(1)
  })
})

describe('apply rollback', () => {
  it('apply rejects with summary when the draft is not smaller; zero surface mutation, lock open, mode active', async () => {
    const { engine, tokenMeter } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-shrink')
    seedSurface(agent)
    await engine.compactNow(agent, new AbortController().signal)
    const state = engine.reviews.require(agent)
    await waitFor(() => { expect(state.processing).toBe(false) })

    // Force the framed checkpoint to price above the shadowed content so the
    // shrink revalidation fails (mock meter default: estimateMessage = 1000).
    tokenMeter.estimateMessage = () => 100_000
    const lengthBefore = agent.session.events.length

    await expect(engine.reviews.apply(agent, undefined, new AbortController().signal))
      .rejects.toMatchObject({ name: 'ManualCompactionError', code: 'summary' })

    // Zero surface mutation: no summary, no checkpoint replace, no end.
    expect(agent.session.events).toHaveLength(lengthBefore)
    expect(agent.session.events.some(e => e.type === 'compaction/summary')).toBe(false)
    expect(agent.session.events.some(e => e.type === 'user/message'
      && typeof e.surfaceOp === 'object')).toBe(false)
    expect(agent.session.events.some(e => e.type === 'compaction/end')).toBe(false)
    // Lock open, mode active, review retained with its tree.
    expect(engine.mode.get(agent).active).toBe(true)
    expect(engine.reviews.isActive(agent)).toBe(true)
    expect(await state.tree.engine.getLeaf()).not.toBeNull()
  })

  it('apply durability flush failure: persistence error thrown after the commit events land; tree and review state retained', async () => {
    const { engine, sessions } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-flush')
    seedSurface(agent)
    await engine.compactNow(agent, new AbortController().signal)
    const state = engine.reviews.require(agent)
    await waitFor(() => { expect(state.processing).toBe(false) })

    sessions.flush = async () => { throw new Error('disk full') }
    await expect(engine.reviews.apply(agent, undefined, new AbortController().signal))
      .rejects.toMatchObject({ name: 'ManualCompactionError', code: 'persistence' })

    // ACTUAL BEHAVIOR (documented): the commit sequence (compaction/summary →
    // checkpoint replace → compaction/end) lands in the log BEFORE the
    // durability checkpoint, and the mode is exited; the flush failure then
    // throws, so the tree and the review state are retained — cleanup runs
    // after the flush.
    const events = agent.session.events
    const summaryIdx = events.findIndex(e => e.type === 'compaction/summary')
    const replaceIdx = events.findIndex(e => e.type === 'user/message' && typeof e.surfaceOp === 'object')
    const endIdx = events.findIndex(e => e.type === 'compaction/end')
    expect(summaryIdx).toBeGreaterThanOrEqual(0)
    expect(replaceIdx).toBeGreaterThan(summaryIdx)
    expect(endIdx).toBeGreaterThan(replaceIdx)
    expect(events[endIdx]!.data.error).toBeUndefined()
    expect(engine.mode.get(agent).active).toBe(false)
    expect(engine.reviews.isActive(agent)).toBe(true)
    expect(await state.tree.engine.getLeaf()).not.toBeNull()

    // A retried apply revalidates the span, which the landed checkpoint has
    // already replaced → the retry fails with 'changed' (the surface is
    // consumed even though durability was never confirmed).
    await expect(engine.reviews.apply(agent, undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'changed' })
  })
})

describe('apply success and abort lifecycle', () => {
  it('apply success: summary → checkpoint replace → end order, mode exited, review cleared, tree destroyed', async () => {
    const { engine } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-success')
    seedSurface(agent)
    await engine.compactNow(agent, new AbortController().signal)
    const state = engine.reviews.require(agent)
    await waitFor(() => { expect(state.processing).toBe(false) })

    const result = await engine.reviews.apply(agent, undefined, new AbortController().signal)
    const events = agent.session.events
    const summaryIdx = events.findIndex(e => e.type === 'compaction/summary')
    const replaceIdx = events.findIndex(e => e.type === 'user/message' && typeof e.surfaceOp === 'object')
    const endIdx = events.findIndex(e => e.type === 'compaction/end')
    const replaceEvent = events[replaceIdx] as SessionEvent<'user/message'> | undefined

    // Event order is contractual: summary → checkpoint replace → end.
    expect(summaryIdx).toBeGreaterThanOrEqual(0)
    expect(replaceIdx).toBeGreaterThan(summaryIdx)
    expect(endIdx).toBeGreaterThan(replaceIdx)
    expect(replaceEvent!.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'compact',
      compactionId: result.compactionId,
    })
    expect(replaceEvent!.surfaceOp).toEqual({
      op: 'replace',
      start: state.shadowedRange.start,
      end: state.shadowedRange.end,
    })
    expect(events[endIdx]!.data.error).toBeUndefined()

    // Mode exited, review state cleared, tree destroyed.
    expect(engine.mode.get(agent).active).toBe(false)
    expect(engine.reviews.isActive(agent)).toBe(false)
    expect(engine.reviews.reviews.has(agent.session.id)).toBe(false)
    await waitFor(() => { expect(readTreeKeys()).not.toContain(agent.session.id) })
  })

  it('abort closes the lock with an error, exits the mode, clears review state, keeps the tree; the context-change watcher deletes it later', async () => {
    const { engine } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-abort')
    seedSurface(agent)
    await engine.compactNow(agent, new AbortController().signal)
    const state = engine.reviews.require(agent)
    await waitFor(() => { expect(state.processing).toBe(false) })

    await engine.reviews.abort(agent, 'user cancelled')
    const events = agent.session.events
    const end = events.find(e => e.type === 'compaction/end')
    expect(end!.data.error).toBe('user cancelled')
    expect(end!.data.turn).toBeNull()
    expect(engine.mode.get(agent).active).toBe(false)
    expect(engine.reviews.isActive(agent)).toBe(false)
    expect(engine.reviews.reviews.has(agent.session.id)).toBe(false)

    // TREE KEPT (not destroyed): still queryable and still persisted.
    expect(await state.tree.engine.getLeaf()).not.toBeNull()
    await waitFor(() => { expect(readTreeKeys()).toContain(agent.session.id) })

    // A later context change (a new user/message) makes the engine watcher
    // delete the preserved tree.
    engine.ctx.emit('session/event', agent.session, {
      type: 'user/message',
      seq: events.length,
      time: Date.now(),
      data: { role: 'user', id: 'post-abort', content: [{ type: 'text', text: 'new context' }], source: { kind: 'user' } },
      surfaceOp: 'append',
      sourceEventSeqs: [events.length - 1],
    } as unknown as SessionEvent)
    await waitFor(() => { expect(readTreeKeys()).not.toContain(agent.session.id) })
  })

  it('pre-step reject during active review: no step/start, no user/message append, blocked turn close recorded; instruction text matches the claimed message', async () => {
    const { engine, llm } = setupEngine()
    const agent = makeAgent(engine.ctx, 's-prestep')
    seedSurface(agent)
    await engine.compactNow(agent, new AbortController().signal)
    await waitFor(() => { expect(engine.reviews.require(agent).processing).toBe(false) })

    const claimedText = 'remember the exact file path: src/engine.ts'
    const logStart = agent.session.events.length
    // The driver opens the turn, proposes the step, and closes it blocked;
    // the plugin must not append anything itself.
    agent.session.append('turn/start', { turn: 7 })
    const decision = await engine.ctx.waterfall(
      'agent/pre-step',
      { agent, messages: [claimed(claimedText)], turn: 7, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(decision).toEqual({ kind: 'reject' })
    agent.session.append('turn/end', { turn: 7, reason: { kind: 'blocked' } })

    // No step/start, no user/message append: only the driver's turn bracket.
    expect(agent.session.events.slice(logStart).map(e => e.type)).toEqual(['turn/start', 'turn/end'])

    // The captured instruction text matches the claimed message content.
    await waitFor(() => {
      expect(allText(llm)).toContain(`Revision instruction: ${claimedText}`)
    })
  })
})

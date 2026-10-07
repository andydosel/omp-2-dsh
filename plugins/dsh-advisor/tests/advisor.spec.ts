/**
 * AdvisorRuntime integration tests with mocked context/agents and real
 * dsh-session objects: reviewer construction (composeFrom/restrict/advise
 * visibility), delta feeding + self-advice filter, advise observation →
 * routing (inject/steer/card), immuneTurns downgrade, reset signals, and the
 * /advisor command surface.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AdvisorRuntime, ROLE_SECTION } from '../src/advisor.ts'
import { resolveConfig, type ResolvedAdvisorConfig } from '../src/config.ts'
import { advisorCommandHandler } from '../src/commands.ts'
import {
  appendAdviseCall,
  appendTurnEnd,
  appendUserMessage,
  FakeContext,
  flush,
  isAdvisory,
  makeFakeAgent,
  messageText,
} from './helpers.ts'

let tmp: string
let ctx: FakeContext
let runtime: AdvisorRuntime
let primary: Agent

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'advisor-runtime-'))
  // Isolate the plugin-owned advisor-state JSON snapshot per test.
  process.env.DSH_HOME = tmp
  ctx = new FakeContext()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<ResolvedAdvisorConfig> = {}): ResolvedAdvisorConfig {
  return resolveConfig({
    watchdog: { userDir: tmp, projectMarkers: ['.git'] },
    ...overrides,
  })
}

/** Create a primary agent whose session header carries a cwd inside tmp. */
function makePrimary(status: Agent['status'] = 'idle'): Agent {
  const session = Session.create(SessionId('primary'), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('primary'),
    createdAt: Date.now(),
    isSeeded: false,
    cwd: tmp,
  })
  return makeFakeAgent('primary', session, { status })
}

function attach(config = makeConfig()): void {
  runtime = new AdvisorRuntime(ctx as unknown as Context, config)
  runtime.attach()
}

/** Bind the runtime to a primary and wait for reviewers to start. */
async function bindPrimary(): Promise<void> {
  primary = makePrimary()
  ctx.emit('agent/created', { agent: primary })
  await flush()
}

/** Close one reviewer update window by ending its turn (guard semantics). */
function endReviewerTurn(reviewer: { session: Session }): void {
  const event = reviewer.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  ctx.emit('session/event', reviewer.session, event)
}

describe('reviewer construction', () => {
  it('creates one reviewer with composeFrom + restrict + scoped advise + role section', async () => {
    attach()
    await bindPrimary()

    expect(ctx.createSpy).toHaveBeenCalledTimes(1)
    const options = ctx.createSpy.mock.calls[0]![0] as {
      sessionId: SessionId
      agentOptions: Record<string, unknown>
      setup: (agentCtx: unknown) => void
    }
    expect(String(options.sessionId)).toContain('primary__advisor-default')

    const agentCtx = ctx.created[0]!.agentCtx
    expect(agentCtx.restrictSpy).toHaveBeenCalledWith({ allow: ['read', 'grep', 'glob'] })
    expect(agentCtx.registerSpy).toHaveBeenCalled()
    const registered = agentCtx.registerSpy.mock.calls[0]![0] as { name: string }
    expect(registered.name).toBe('advise')
    expect(agentCtx.sectionSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'advisor:role' }))
    const role = agentCtx.sectionSpy.mock.calls[0]![0] as { text: string }
    expect(role.text).toContain(ROLE_SECTION)
  })

  it('intersects reviewer tools with the toolset actually present and warns on dropped names', async () => {
    // The reviewer's composed scope only carries `read`; grep/glob are missing
    // (the minimal-preset shape from the E2E). The restrict must degrade to
    // the intersection instead of throwing on unknown names.
    ctx.reviewerToolNames = ['read']
    attach()
    await bindPrimary()

    expect(ctx.createSpy).toHaveBeenCalledTimes(1)
    const agentCtx = ctx.created[0]!.agentCtx
    expect(agentCtx.restrictSpy).toHaveBeenCalledWith({ allow: ['read'] })
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('tool names not present in the agent toolset'),
      expect.stringContaining('default'),
      'grep, glob',
    )
    // The reviewer still exists and the status reports it.
    expect(ctx.created[0]!.agentCtx.sectionSpy).toHaveBeenCalled()
    const status = (advisorCommandHandler(runtime, 'status') as { text: string }).text
    expect(status).toContain('default')
    expect(status).not.toContain('reviewers: 0 (error')
  })

  it('fails loud when no reviewer tool survives the intersection (empty → error surfaced in status)', async () => {
    // The reviewer scope carries tools the spec never allows (write/bash);
    // nothing from defaultTools is present → composition must fail loudly and
    // the status must surface the error instead of "reviewers: none".
    ctx.reviewerToolNames = ['write', 'bash']
    attach()
    await bindPrimary()
    await flush()

    // The setup throw rejects creation: no reviewer entry is ever recorded.
    expect(ctx.createSpy).not.toHaveBeenCalled()
    expect(ctx.created).toHaveLength(0)
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to start reviewers'),
      expect.stringContaining('no usable tools'),
    )
    const status = (advisorCommandHandler(runtime, 'status') as { text: string }).text
    expect(status).toContain('reviewers: 0 (error:')
    expect(status).toContain('no usable tools')
    expect(status).not.toContain('reviewers: none')
  })

  it('joins the primary preset composition when a roster is composed', async () => {
    const presetCtx = new FakeContext(true)
    const runtime2 = new AdvisorRuntime(presetCtx as unknown as Context, makeConfig())
    runtime2.attach()
    const primary2 = makePrimary()
    presetCtx.emit('agent/created', { agent: primary2 })
    await flush()

    const agentCtx = presetCtx.created[0]!.agentCtx
    expect(agentCtx.agentPresetsMock.composeFrom).toHaveBeenCalledTimes(1)
    expect(agentCtx.agentPresetsMock.composeFrom.mock.calls[0]![1]).toBe(primary2.ctx)
  })

  it('follows the primary route when no model is configured', async () => {
    attach()
    await bindPrimary()
    const options = ctx.createSpy.mock.calls[0]![0] as { agentOptions: Record<string, unknown> }
    expect(options.agentOptions).toMatchObject({ provider: 'test-provider', model: 'primary-model' })
  })

  it('uses a configured reviewer model override', async () => {
    attach(makeConfig({ model: 'deepseek-review' }))
    await bindPrimary()
    const options = ctx.createSpy.mock.calls[0]![0] as { agentOptions: Record<string, unknown> }
    expect(options.agentOptions).toMatchObject({ model: 'deepseek-review' })
  })

  it('creates one reviewer per enabled roster entry', async () => {
    await writeFile(join(tmp, 'WATCHDOG.yml'), [
      'roster:',
      '  - name: style',
      '    enabled: true',
      '    model: reviewer-a',
      '  - name: safety',
      '    enabled: true',
      '  - name: retired',
      '    enabled: false',
    ].join('\n'))
    attach()
    await bindPrimary()
    expect(ctx.createSpy).toHaveBeenCalledTimes(2)
    const ids = ctx.createSpy.mock.calls.map(call => String((call[0] as { sessionId: SessionId }).sessionId))
    expect(ids.some(id => id.includes('__advisor-style'))).toBe(true)
    expect(ids.some(id => id.includes('__advisor-safety'))).toBe(true)
    expect(ids.some(id => id.includes('retired'))).toBe(false)
  })

  it('loads WATCHDOG guidance and roster instructions into the reviewer prompt only', async () => {
    await writeFile(join(tmp, 'WATCHDOG.md'), 'never modify user files without asking')
    await writeFile(join(tmp, 'WATCHDOG.yml'), [
      'instructions: shared top-level rules',
      'roster:',
      '  - name: style',
      '    enabled: true',
      '    instructions: follow the house style',
    ].join('\n'))
    attach()
    await bindPrimary()

    const agentCtx = ctx.created[0]!.agentCtx
    expect(agentCtx.sectionSpy).toHaveBeenCalledTimes(1)
    const section = agentCtx.sectionSpy.mock.calls[0]![0] as { name: string; text: string }
    expect(section.name).toBe('advisor:role')
    expect(section.text).toContain('shared top-level rules')
    expect(section.text).toContain('follow the house style')
    expect(section.text).toContain('<attention source=')
    expect(section.text).toContain('never modify user files without asking')
  })

  it('waits for reviewer catch-up when syncBacklog is enabled', async () => {
    attach(makeConfig({ syncBacklog: 1 }))
    await bindPrimary()
    const reviewer = ctx.created[0]!.agent

    appendUserMessage(primary.session, 'activity')
    const end = appendTurnEnd(primary.session)
    ctx.emit('session/event', primary.session, end)
    await flush()
    // flushDeltas raced the reviewer's whenIdle against the 30s cap.
    expect(reviewer.whenIdle).toHaveBeenCalled()
  })
})

describe('delta feeding', () => {
  it('feeds a baseline on attach and deltas on primary turn end', async () => {
    attach()
    primary = makePrimary()
    appendUserMessage(primary.session, 'pre-existing transcript')
    appendTurnEnd(primary.session)
    ctx.emit('agent/created', { agent: primary })
    await flush()

    const reviewer = ctx.created[0]!.agent
    expect(reviewer.followup).toHaveBeenCalledTimes(1)
    const baseline = messageText(reviewer.followup.mock.calls[0]![0])
    expect(baseline).toContain('<advisor-baseline')
    expect(baseline).toContain('pre-existing transcript')

    appendUserMessage(primary.session, 'new activity')
    const end = appendTurnEnd(primary.session)
    ctx.emit('session/event', primary.session, end)
    await flush()

    expect(reviewer.followup).toHaveBeenCalledTimes(2)
    const delta = messageText(reviewer.followup.mock.calls[1]![0])
    expect(delta).toContain('<advisor-delta')
    expect(delta).toContain('new activity')
    expect(delta).not.toContain('pre-existing transcript')
  })

  it('excludes advisor-plugin-sourced messages from deltas (self-advice filter)', async () => {
    attach()
    await bindPrimary()
    const reviewer = ctx.created[0]!.agent

    appendUserMessage(primary.session, 'user said this')
    appendUserMessage(primary.session, 'advisor said that', {
      kind: 'dsh-advisor',
      form: 'notice',
      summary: 'advisor (nit): that',
    })
    const end = appendTurnEnd(primary.session)
    ctx.emit('session/event', primary.session, end)
    await flush()

    const last = messageText(reviewer.followup.mock.calls.at(-1)![0])
    expect(last).toContain('user said this')
    expect(last).not.toContain('advisor said that')
  })

  it('observes primary events and advances the delta cursor only forward', async () => {
    attach()
    await bindPrimary()
    const reviewer = ctx.created[0]!.agent

    const first = appendUserMessage(primary.session, 'first')
    ctx.emit('session/event', primary.session, first)
    // Re-emitting the same event must not double-feed.
    ctx.emit('session/event', primary.session, first)
    const end = appendTurnEnd(primary.session)
    ctx.emit('session/event', primary.session, end)
    await flush()

    const texts = reviewer.followup.mock.calls.map(call => messageText(call[0]))
    const deltaTexts = texts.filter(text => text.includes('<advisor-delta'))
    expect(deltaTexts).toHaveLength(1)
    expect(deltaTexts[0]).toContain('first')
    expect((deltaTexts[0]!.match(/<entry seq=/g) ?? []).length).toBe(1)
  })
})

describe('advise observation and delivery routing', () => {
  it('routes a nit to inject without waking', async () => {
    attach()
    await bindPrimary()
    const reviewer = ctx.created[0]!
    const { call, result } = appendAdviseCall(reviewer.session, 'nit', 'minor style point')
    ctx.emit('session/event', reviewer.session, call)
    ctx.emit('session/event', reviewer.session, result)
    await flush()

    expect(primary.inject).toHaveBeenCalledTimes(1)
    expect(primary.steer).not.toHaveBeenCalled()
    const message = primary.inject.mock.calls[0]![0]
    expect(isAdvisory(message, 'nit')).toBe(true)
  })

  it('steers a concern on an idle fresh session', async () => {
    attach()
    await bindPrimary()
    const reviewer = ctx.created[0]!
    const { call, result } = appendAdviseCall(reviewer.session, 'concern', 'the schema may be wrong')
    ctx.emit('session/event', reviewer.session, call)
    ctx.emit('session/event', reviewer.session, result)
    await flush()

    expect(primary.steer).toHaveBeenCalledTimes(1)
    expect(isAdvisory(primary.steer.mock.calls[0]![0], 'concern')).toBe(true)
    expect(primary.inject).not.toHaveBeenCalled()
  })

  it('queues a running concern and delivers it as a card after turn end (terminal policy)', async () => {
    attach()
    await bindPrimary()
    primary.status = 'running'
    const reviewer = ctx.created[0]!
    const { call, result } = appendAdviseCall(reviewer.session, 'concern', 'hold on, the plan changed')
    ctx.emit('session/event', reviewer.session, call)
    ctx.emit('session/event', reviewer.session, result)
    await flush()

    // While running the concern is queued, not delivered.
    expect(primary.steer).not.toHaveBeenCalled()
    expect(primary.inject).not.toHaveBeenCalled()

    // The turn reaches its stop boundary: concern must NOT extend the turn.
    ctx.emit('agent/turn-stopping', { agent: primary, turn: 1, signal: new AbortController().signal })
    expect(primary.steer).not.toHaveBeenCalled()

    // After turn/end the concern arrives as a card (inject).
    const end = appendTurnEnd(primary.session)
    ctx.emit('session/event', primary.session, end)
    await flush()
    expect(primary.steer).not.toHaveBeenCalled()
    expect(primary.inject).toHaveBeenCalledTimes(1)
    expect(isAdvisory(primary.inject.mock.calls[0]![0], 'concern')).toBe(true)
  })

  it('steers a blocker at the turn-stopping boundary (extends the turn)', async () => {
    attach()
    await bindPrimary()
    primary.status = 'running'
    const reviewer = ctx.created[0]!
    const { call, result } = appendAdviseCall(reviewer.session, 'blocker', 'this approach cannot work')
    ctx.emit('session/event', reviewer.session, call)
    ctx.emit('session/event', reviewer.session, result)
    await flush()

    expect(primary.steer).not.toHaveBeenCalled()
    ctx.emit('agent/turn-stopping', { agent: primary, turn: 1, signal: new AbortController().signal })
    expect(primary.steer).toHaveBeenCalledTimes(1)
    expect(isAdvisory(primary.steer.mock.calls[0]![0], 'blocker')).toBe(true)
  })

  it('keeps a concern as a card on an idle terminal primary', async () => {
    attach()
    await bindPrimary()
    // Simulate a completed terminal turn with no queued work.
    const end = appendTurnEnd(primary.session)
    ctx.emit('session/event', primary.session, end)
    await flush()

    const reviewer = ctx.created[0]!
    const { call, result } = appendAdviseCall(reviewer.session, 'concern', 'post-answer concern')
    ctx.emit('session/event', reviewer.session, call)
    ctx.emit('session/event', reviewer.session, result)
    await flush()

    expect(primary.steer).not.toHaveBeenCalled()
    expect(primary.inject).toHaveBeenCalledTimes(1)
    expect(isAdvisory(primary.inject.mock.calls[0]![0], 'concern')).toBe(true)
  })

  it('downgrades concern/blocker to asides during the immune window and recovers on user input', async () => {
    attach()
    await bindPrimary()
    const reviewer = ctx.created[0]!

    // First concern delivers via steer and opens the immune window.
    let pair = appendAdviseCall(reviewer.session, 'concern', 'first concern', 'c1')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    expect(primary.steer).toHaveBeenCalledTimes(1)
    endReviewerTurn(reviewer)
    await flush()

    // Second concern is downgraded to an aside (inject) within the window.
    pair = appendAdviseCall(reviewer.session, 'concern', 'second concern', 'c2')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    expect(primary.steer).toHaveBeenCalledTimes(1)
    expect(primary.inject).toHaveBeenCalledTimes(1)
    endReviewerTurn(reviewer)
    await flush()

    // A blocker is also downgraded inside the window.
    pair = appendAdviseCall(reviewer.session, 'blocker', 'urgent blocker', 'c3')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    expect(primary.steer).toHaveBeenCalledTimes(1)
    endReviewerTurn(reviewer)
    await flush()

    // Human input closes the window: the next concern steers again.
    ctx.emit('agent/inbox/claimed', { agent: primary, message: { source: { kind: 'user' } }, turn: 2 })
    pair = appendAdviseCall(reviewer.session, 'concern', 'third concern', 'c4')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    expect(primary.steer).toHaveBeenCalledTimes(2)
  })

  it('immune window closes after the configured number of primary turns', async () => {
    attach(makeConfig({ immuneTurns: 2 }))
    await bindPrimary()
    const reviewer = ctx.created[0]!
    const inbox = primary.inbox as { nextTurn: unknown[] }

    let pair = appendAdviseCall(reviewer.session, 'concern', 'first', 'c1')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    expect(primary.steer).toHaveBeenCalledTimes(1)
    endReviewerTurn(reviewer)
    await flush()

    pair = appendAdviseCall(reviewer.session, 'concern', 'second', 'c2')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    // Downgraded to an aside inside the immune window.
    expect(primary.steer).toHaveBeenCalledTimes(1)
    expect(primary.inject).toHaveBeenCalledTimes(1)
    endReviewerTurn(reviewer)
    await flush()

    // Two completed primary turns exhaust the budget of two. Queued work at
    // close keeps the terminal flag off so the next concern can steer.
    for (let turn = 1; turn <= 2; turn++) {
      inbox.nextTurn.push({})
      const end = appendTurnEnd(primary.session, turn)
      ctx.emit('session/event', primary.session, end)
      await flush()
    }
    inbox.nextTurn.length = 0
    pair = appendAdviseCall(reviewer.session, 'concern', 'third', 'c3')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    // The immune window is closed: a full concern steers again.
    expect(primary.steer).toHaveBeenCalledTimes(2)
  })

  it('emission guard blocks duplicate notes across the session', async () => {
    attach()
    await bindPrimary()
    const reviewer = ctx.created[0]!

    let pair = appendAdviseCall(reviewer.session, 'concern', 'duplicate me', 'd1')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    expect(primary.steer).toHaveBeenCalledTimes(1)

    // Identical note from a later review is deduped (no second delivery).
    pair = appendAdviseCall(reviewer.session, 'concern', 'DUPLICATE ME!', 'd2')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    expect(primary.steer).toHaveBeenCalledTimes(1)
    expect(primary.inject).not.toHaveBeenCalled()
  })
})

describe('reset signals', () => {
  it('rebuilds the reviewer and re-feeds the baseline on compaction', async () => {
    attach()
    await bindPrimary()
    expect(ctx.createSpy).toHaveBeenCalledTimes(1)

    // Give the primary session surface content so the re-fed baseline has text.
    const userEvent = appendUserMessage(primary.session, 'persisted state')
    ctx.emit('session/event', primary.session, userEvent)

    // A compaction marker on the primary session resets everything.
    const marker = (primary.session as Session).append('compaction/start' as never, {} as never)
    ctx.emit('session/event', primary.session, marker)
    await flush()
    await flush()

    expect(ctx.createSpy).toHaveBeenCalledTimes(2)
    // The new reviewer received a fresh baseline over the current surface.
    const newReviewer = ctx.created[1]!.agent
    const feeds = newReviewer.followup.mock.calls.map(call => messageText(call[0]))
    expect(feeds.some(text => text.includes('<advisor-baseline'))).toBe(true)
    expect(feeds.some(text => text.includes('persisted state'))).toBe(true)
  })

  it('resets on a surface replacement event', async () => {
    attach()
    await bindPrimary()
    expect(ctx.createSpy).toHaveBeenCalledTimes(1)

    // Build a two-node surface, then replace the first node with a summary.
    // Target the first surface node explicitly (seq positions are not assumed).
    const first = appendUserMessage(primary.session, 'original')
    ctx.emit('session/event', primary.session, first)
    const second = appendUserMessage(primary.session, 'second')
    ctx.emit('session/event', primary.session, second)
    const summary = appendUserMessage(primary.session, 'summarized')
    const firstSurfaceSeq = primary.session.snapshotEvents().find(event => event.type === 'user/message')!.seq
    const replaceEvent = (primary.session as Session).append(
      'user/message',
      summary.data,
      { surfaceOp: { op: 'replace', startSeq: firstSurfaceSeq, endSeq: firstSurfaceSeq }, sourceEventSeqs: [firstSurfaceSeq] },
    )
    ctx.emit('session/event', primary.session, replaceEvent)
    await flush()
    await flush()

    expect(ctx.createSpy).toHaveBeenCalledTimes(2)
  })

  it('resets on agent/created with source resume', async () => {
    attach()
    await bindPrimary()
    expect(ctx.createSpy).toHaveBeenCalledTimes(1)

    ctx.emit('agent/created', { agent: primary, source: 'resume' })
    await flush()
    await flush()
    expect(ctx.createSpy).toHaveBeenCalledTimes(2)

    // A startup source is not a reset signal.
    ctx.emit('agent/created', { agent: primary, source: 'startup' })
    await flush()
    expect(ctx.createSpy).toHaveBeenCalledTimes(2)
  })

  it('resets on a fork of the primary session but not on a subagent session', async () => {
    attach()
    await bindPrimary()
    expect(ctx.createSpy).toHaveBeenCalledTimes(1)

    const fork = Session.create(SessionId('fork-1'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('fork-1'),
      createdAt: Date.now(),
      isSeeded: false,
      parentSession: primary.id,
    })
    ctx.emit('session/created', fork)
    await flush()
    await flush()
    expect(ctx.createSpy).toHaveBeenCalledTimes(2)

    const subagent = Session.create(SessionId('sub-1'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('sub-1'),
      createdAt: Date.now(),
      isSeeded: false,
      parentSession: primary.id,
      origin: 'subagent',
    })
    ctx.emit('session/created', subagent)
    await flush()
    expect(ctx.createSpy).toHaveBeenCalledTimes(2)
  })

  it('clears the emission guard on reset', async () => {
    attach()
    await bindPrimary()
    const reviewer = ctx.created[0]!

    let pair = appendAdviseCall(reviewer.session, 'concern', 'memorable note', 'm1')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    expect(primary.steer).toHaveBeenCalledTimes(1)

    // Duplicate while the guard remembers it: blocked.
    pair = appendAdviseCall(reviewer.session, 'concern', 'memorable note', 'm2')
    ctx.emit('session/event', reviewer.session, pair.call)
    ctx.emit('session/event', reviewer.session, pair.result)
    await flush()
    expect(primary.steer).toHaveBeenCalledTimes(1)

    // After a compaction reset the guard is empty: the note is accepted again.
    const marker = (primary.session as Session).append('compaction/end' as never, {} as never)
    ctx.emit('session/event', primary.session, marker)
    await flush()
    await flush()
    const newReviewer = ctx.created[1]!
    pair = appendAdviseCall(newReviewer.session, 'concern', 'memorable note', 'm3')
    ctx.emit('session/event', newReviewer.session, pair.call)
    ctx.emit('session/event', newReviewer.session, pair.result)
    await flush()
    expect(primary.steer).toHaveBeenCalledTimes(2)
  })
})

describe('enable/disable', () => {
  it('starts disabled when configured off and binds on enable', async () => {
    attach(makeConfig({ enabled: false }))
    primary = makePrimary()
    ctx.emit('agent/created', { agent: primary })
    await flush()
    expect(ctx.createSpy).not.toHaveBeenCalled()

    runtime.enable()
    await flush()
    await flush()
    expect(ctx.createSpy).toHaveBeenCalledTimes(1)
    expect(runtime.isEnabled).toBe(true)
  })

  it('disable disposes reviewers and stops feeding', async () => {
    attach()
    await bindPrimary()
    expect(ctx.createSpy).toHaveBeenCalledTimes(1)

    runtime.disable()
    await flush()
    expect(ctx.created[0]!.dispose).toHaveBeenCalled()
    expect(runtime.isEnabled).toBe(false)

    // No new feeds happen while disabled.
    const end = appendTurnEnd(primary.session)
    ctx.emit('session/event', primary.session, end)
    await flush()
    const reviewer = ctx.created[0]!.agent
    const feedsBefore = reviewer.followup.mock.calls.length
    expect(feedsBefore).toBe(0)
  })
})

describe('advisor status (plugin-owned state)', () => {
  it('reports the whole-value state on primary bind', async () => {
    attach(makeConfig({ enabled: false }))
    primary = makePrimary()
    ctx.emit('agent/created', { agent: primary })
    await flush()
    expect(runtime.status()).toEqual({ enabled: false, reviewers: 0 })
  })

  it('reports the live reviewer count after reviewers start', async () => {
    attach()
    await bindPrimary()
    expect(runtime.status()).toEqual({ enabled: true, reviewers: 1 })
  })

  it('reports disabled with zero reviewers on disable', async () => {
    attach()
    await bindPrimary()
    runtime.disable()
    await flush()
    expect(runtime.status()).toEqual({ enabled: false, reviewers: 0 })
  })
})

describe('/advisor commands', () => {
  it('toggles on/off and reports status without touching model history', async () => {
    attach()
    await bindPrimary()

    expect(advisorCommandHandler(runtime, 'status').kind).toBe('success')
    const status = (advisorCommandHandler(runtime, 'status') as { text: string }).text
    expect(status).toContain('advisor: enabled')
    expect(status).toContain('session: primary')
    expect(status).toContain('default')
    expect(status).toContain('primary-model')

    expect(advisorCommandHandler(runtime, 'off').kind).toBe('success')
    expect(runtime.isEnabled).toBe(false)
    expect((advisorCommandHandler(runtime, 'status') as { text: string }).text).toContain('advisor: disabled')

    expect(advisorCommandHandler(runtime, 'on').kind).toBe('success')
    expect(runtime.isEnabled).toBe(true)
    await flush()
  })

  it('rejects unknown subcommands', () => {
    attach()
    const result = advisorCommandHandler(runtime, 'dump')
    expect(result.kind).toBe('error')
  })

  it('reports per-reviewer token usage and cost from the token meter', async () => {
    ctx.getMock.mockImplementation((name: string) => {
      if (name === 'tokenMeter') {
        return { measure: () => ({ totalTokens: 4000 }) }
      }
      return undefined
    })
    attach(makeConfig({ costTable: { 'test-provider/primary-model': 0.5 } }))
    await bindPrimary()

    const status = (advisorCommandHandler(runtime, 'status') as { text: string }).text
    expect(status).toContain('tokens=4000')
    expect(status).toContain('cost=$0.0020')
  })
})

describe('primary teardown', () => {
  it('detaches and disposes reviewers when the primary agent is disposed', async () => {
    attach()
    await bindPrimary()
    expect(ctx.createSpy).toHaveBeenCalledTimes(1)

    ctx.emit('agent/disposed', { agent: primary })
    await flush()
    expect(ctx.created[0]!.dispose).toHaveBeenCalled()
    expect(runtime.statusText()).toContain('not attached')

    // A new primary binds again.
    const second = makePrimary()
    ctx.emit('agent/created', { agent: second })
    await flush()
    await flush()
    expect(ctx.createSpy).toHaveBeenCalledTimes(2)
  })
})

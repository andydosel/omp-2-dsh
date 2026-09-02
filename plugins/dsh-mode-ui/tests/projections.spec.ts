/**
 * Tests for the four mode-status projection units: the pure read-side views
 * and the service-driven `apply` transitions (re-sourced from the sibling
 * plugins' plugin-owned state, no session events).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { apply } from '../src/index.ts'
import { viewCompactMode } from '../src/projections/compact.ts'
import { viewVibeMode } from '../src/projections/vibe.ts'
import { viewAdvisorStatus } from '../src/projections/advisor.ts'
import { viewWechatChannel } from '../src/projections/wechat.ts'

describe('view functions (pure state → wire)', () => {
  it('compactMode', () => {
    expect(viewCompactMode({ active: true })).toEqual({ active: true })
    expect(viewCompactMode({ active: false })).toEqual({ active: false })
  })

  it('vibeMode', () => {
    expect(viewVibeMode({ active: true })).toEqual({ active: true })
  })

  it('advisorStatus', () => {
    expect(viewAdvisorStatus({ enabled: true, reviewers: 2 })).toEqual({ enabled: true, reviewers: 2 })
  })

  it('wechatChannel (account optional)', () => {
    expect(viewWechatChannel({ connected: true, account: 'acct' })).toEqual({ connected: true, account: 'acct' })
    expect(viewWechatChannel({ connected: false })).toEqual({ connected: false })
  })
})

describe('projection apply (reads sibling plugin state)', () => {
  it('folds each projection from the sibling service, re-syncing on committed events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    let compact = { active: false }
    let vibe = { active: false }
    let advisor = { enabled: false, reviewers: 0 }
    let wechat = { connected: false, account: undefined as string | undefined }
    ctx.provide('compactMode', { store: { current: () => compact } })
    ctx.provide('vibeMode', { store: { current: () => vibe } })
    ctx.provide('advisor', { runtime: { status: () => advisor } })
    ctx.provide('wechat', { status: () => wechat })
    await ctx.plugin({ apply })
    const session = Session.create(SessionId('proj-session'))
    const snap = () => ctx.sessionProjections.snapshot(session).values
    // Empty log: each unit's init() state.
    expect(snap().compactMode).toEqual({ active: false })
    expect(snap().vibeMode).toEqual({ active: false })
    expect(snap().advisorStatus).toEqual({ enabled: false, reviewers: 0 })
    expect(snap().wechatChannel).toEqual({ connected: false })

    // Flip the sibling state, then drive a committed event.
    compact = { active: true }
    vibe = { active: true }
    advisor = { enabled: true, reviewers: 1 }
    wechat = { connected: true, account: 'acct' }
    const event = session.append('turn/start', { turn: 1 })
    ctx.emit('session/event', session, event)

    expect(snap().compactMode).toEqual({ active: true })
    expect(snap().vibeMode).toEqual({ active: true })
    expect(snap().advisorStatus).toEqual({ enabled: true, reviewers: 1 })
    expect(snap().wechatChannel).toEqual({ connected: true, account: 'acct' })
  })
})

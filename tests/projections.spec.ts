/**
 * Pure folding tests for the four mode-status projection units. The units
 * are pure mathematics over committed session events — no cordis context, no
 * session store, no mocks: construct events, fold, assert the wire view.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyCompactModeEvent, viewCompactMode } from '../src/projections/compact.ts'
import { applyVibeModeEvent, viewVibeMode } from '../src/projections/vibe.ts'
import { applyAdvisorStatusEvent, viewAdvisorStatus } from '../src/projections/advisor.ts'
import { applyWechatChannelEvent, viewWechatChannel } from '../src/projections/wechat.ts'

/** Minimal event builder; the fold functions only read type/data. */
function event(type: string, data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: 1_000, data } as unknown as SessionEvent
}

describe('compactMode unit', () => {
  it('folds to inactive on an empty log', () => {
    expect(viewCompactMode({ active: false })).toEqual({ active: false })
  })

  it('flips on compact/mode active:true and back to false', () => {
    let state = { active: false }
    state = applyCompactModeEvent(state, event('compact/mode', { active: true }, 1))
    expect(viewCompactMode(state)).toEqual({ active: true })
    state = applyCompactModeEvent(state, event('compact/mode', { active: false }, 2))
    expect(viewCompactMode(state)).toEqual({ active: false })
  })

  it('keeps the same reference for unrelated events (zero downstream work)', () => {
    const state = { active: true }
    expect(applyCompactModeEvent(state, event('user/message', {}, 1))).toBe(state)
    expect(applyCompactModeEvent(state, event('vibe/mode', { active: true }, 2))).toBe(state)
  })

  it('the last compact/mode wins across interleaved events', () => {
    let state = { active: false }
    state = applyCompactModeEvent(state, event('user/message', {}, 1))
    state = applyCompactModeEvent(state, event('compact/mode', { active: true }, 2))
    state = applyCompactModeEvent(state, event('turn/end', { turn: 1 }, 3))
    state = applyCompactModeEvent(state, event('compact/mode', { active: true }, 4))
    expect(viewCompactMode(state)).toEqual({ active: true })
    state = applyCompactModeEvent(state, event('compact/mode', { active: false }, 5))
    expect(viewCompactMode(state)).toEqual({ active: false })
  })
})

describe('vibeMode unit', () => {
  it('folds to inactive on an empty log', () => {
    expect(viewVibeMode({ active: false })).toEqual({ active: false })
  })

  it('flips on vibe/mode active:true and back to false', () => {
    let state = { active: false }
    state = applyVibeModeEvent(state, event('vibe/mode', { active: true }, 1))
    expect(viewVibeMode(state)).toEqual({ active: true })
    state = applyVibeModeEvent(state, event('vibe/mode', { active: false }, 2))
    expect(viewVibeMode(state)).toEqual({ active: false })
  })

  it('keeps the same reference for unrelated events', () => {
    const state = { active: true }
    expect(applyVibeModeEvent(state, event('compact/mode', { active: true }, 1))).toBe(state)
  })
})

describe('advisorStatus unit', () => {
  it('folds to disabled with zero reviewers on an empty log', () => {
    expect(viewAdvisorStatus({ enabled: false, reviewers: 0 })).toEqual({ enabled: false, reviewers: 0 })
  })

  it('whole-value replaces on advisor/status events', () => {
    let state = { enabled: false, reviewers: 0 }
    state = applyAdvisorStatusEvent(state, event('advisor/status', { enabled: true, reviewers: 2 }, 1))
    expect(viewAdvisorStatus(state)).toEqual({ enabled: true, reviewers: 2 })
    state = applyAdvisorStatusEvent(state, event('advisor/status', { enabled: true, reviewers: 1 }, 2))
    expect(viewAdvisorStatus(state)).toEqual({ enabled: true, reviewers: 1 })
    state = applyAdvisorStatusEvent(state, event('advisor/status', { enabled: false, reviewers: 0 }, 3))
    expect(viewAdvisorStatus(state)).toEqual({ enabled: false, reviewers: 0 })
  })

  it('keeps the same reference for unrelated events', () => {
    const state = { enabled: true, reviewers: 3 }
    expect(applyAdvisorStatusEvent(state, event('compact/mode', { active: true }, 1))).toBe(state)
  })
})

describe('wechatChannel unit', () => {
  it('folds to disconnected on an empty log', () => {
    expect(viewWechatChannel({ connected: false })).toEqual({ connected: false })
  })

  it('whole-value replaces on wechat/channel events with an account', () => {
    let state = { connected: false }
    state = applyWechatChannelEvent(state, event('wechat/channel', { connected: true, account: 'c5610f3ce386@im.bot' }, 1))
    expect(viewWechatChannel(state)).toEqual({ connected: true, account: 'c5610f3ce386@im.bot' })
    state = applyWechatChannelEvent(state, event('wechat/channel', { connected: false, account: 'c5610f3ce386@im.bot' }, 2))
    expect(viewWechatChannel(state)).toEqual({ connected: false, account: 'c5610f3ce386@im.bot' })
  })

  it('an event without an account drops the previous one (whole-value semantics)', () => {
    let state = { connected: false }
    state = applyWechatChannelEvent(state, event('wechat/channel', { connected: true, account: 'a@im.bot' }, 1))
    state = applyWechatChannelEvent(state, event('wechat/channel', { connected: true }, 2))
    expect(viewWechatChannel(state)).toEqual({ connected: true })
  })

  it('keeps the same reference for unrelated events', () => {
    const state = { connected: true, account: 'a@im.bot' }
    expect(applyWechatChannelEvent(state, event('advisor/status', { enabled: true, reviewers: 0 }, 1))).toBe(state)
  })
})

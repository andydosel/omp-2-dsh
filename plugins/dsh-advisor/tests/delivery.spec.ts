/**
 * Delivery unit tests: the pure routing matrix (inject vs steer vs card),
 * immuneTurns downgrade, terminal-answer tracking, and the queued/deferred
 * boundary slots.
 */

import { describe, expect, it } from 'vitest'
import { advisoryMessage, decideDelivery, DeliveryController, renderAdvisory } from '../src/delivery.ts'
import type { PrimaryState } from '../src/delivery.ts'

const state = (overrides: Partial<PrimaryState> = {}): PrimaryState => ({
  running: false,
  hasQueuedWork: false,
  lastTurnTerminal: false,
  atTurnStopping: false,
  ...overrides,
})

describe('renderAdvisory', () => {
  it('wraps the note in the advisory card and XML-escapes it', () => {
    const text = renderAdvisory('check "quotes" & <tags>', 'concern')
    expect(text).toBe('<advisory severity="concern" guidance="weigh, don\'t blindly obey">check &quot;quotes&quot; &amp; &lt;tags&gt;</advisory>')
  })

  it('builds a plugin-sourced notice message with a bounded summary', () => {
    const message = advisoryMessage('The retry loop may never terminate', 'blocker')
    expect(message.role).toBe('user')
    expect(message.source).toMatchObject({ kind: 'dsh-advisor', form: 'notice' })
    expect(message.source).toHaveProperty('summary')
  })
})

describe('decideDelivery', () => {
  it('routes nit to inject in every state', () => {
    expect(decideDelivery('nit', state(), false).channel).toBe('inject')
    expect(decideDelivery('nit', state({ running: true }), false).channel).toBe('inject')
    expect(decideDelivery('nit', state({ running: true, atTurnStopping: true }), false).channel).toBe('inject')
  })

  it('steers a concern while the primary is running mid-turn', () => {
    expect(decideDelivery('concern', state({ running: true }), false)).toEqual({ channel: 'steer' })
  })

  it('defers a concern to a card at the turn-stopping boundary', () => {
    expect(decideDelivery('concern', state({ running: true, atTurnStopping: true }), false))
      .toEqual({ channel: 'card', deferred: true })
  })

  it('keeps a concern as a card after a terminal answer with no queued work', () => {
    expect(decideDelivery('concern', state({ lastTurnTerminal: true }), false)).toEqual({ channel: 'card' })
  })

  it('steers a concern on a fresh idle session or with queued work', () => {
    expect(decideDelivery('concern', state(), false).channel).toBe('steer')
    expect(decideDelivery('concern', state({ hasQueuedWork: true, lastTurnTerminal: true }), false).channel).toBe('steer')
  })

  it('always steers a blocker', () => {
    expect(decideDelivery('blocker', state(), false).channel).toBe('steer')
    expect(decideDelivery('blocker', state({ running: true, atTurnStopping: true }), false).channel).toBe('steer')
    expect(decideDelivery('blocker', state({ lastTurnTerminal: true }), false).channel).toBe('steer')
  })

  it('downgrades concern/blocker to an aside under the immune budget', () => {
    expect(decideDelivery('concern', state({ running: true }), true)).toEqual({ channel: 'inject', downgraded: true })
    expect(decideDelivery('blocker', state({ lastTurnTerminal: true }), true)).toEqual({ channel: 'inject', downgraded: true })
    // nit is never downgraded (it is already an aside).
    expect(decideDelivery('nit', state(), true).channel).toBe('inject')
  })
})

describe('DeliveryController', () => {
  it('rejects invalid immuneTurns', () => {
    expect(() => new DeliveryController({ immuneTurns: 0 })).toThrow()
    expect(() => new DeliveryController({ immuneTurns: 1.5 })).toThrow()
  })

  it('tracks the immune budget across primary turns', () => {
    const controller = new DeliveryController({ immuneTurns: 3 })
    expect(controller.immuneActive).toBe(false)
    controller.spendBudget()
    expect(controller.immuneActive).toBe(true)
    controller.onPrimaryTurnEnd(false)
    controller.onPrimaryTurnEnd(false)
    expect(controller.immuneActive).toBe(true)
    controller.onPrimaryTurnEnd(false)
    expect(controller.immuneActive).toBe(false)
  })

  it('ends the immune window and resets terminal state on user input', () => {
    const controller = new DeliveryController({ immuneTurns: 3 })
    controller.spendBudget()
    controller.onPrimaryTurnEnd(false)
    expect(controller.lastTurnTerminal).toBe(true)
    controller.onUserInput()
    expect(controller.immuneActive).toBe(false)
    expect(controller.lastTurnTerminal).toBe(false)
  })

  it('computes terminal-answer state from queued work at turn end', () => {
    const controller = new DeliveryController({ immuneTurns: 3 })
    controller.onPrimaryTurnEnd(false)
    expect(controller.lastTurnTerminal).toBe(true)
    controller.onPrimaryTurnEnd(true)
    expect(controller.lastTurnTerminal).toBe(false)
  })

  it('queues a running steer and delivers it at the next boundary', () => {
    const controller = new DeliveryController({ immuneTurns: 3 })
    const message = advisoryMessage('check this', 'concern')
    controller.queue('concern', message)
    expect(controller.queuedSteer?.severity).toBe('concern')
    const taken = controller.takeQueuedSteer()
    expect(taken?.message).toBe(message)
    expect(controller.queuedSteer).toBeUndefined()
  })

  it('deferQueuedSteerAsCard converts the queued steer into the deferred card', () => {
    const controller = new DeliveryController({ immuneTurns: 3 })
    const message = advisoryMessage('check this', 'concern')
    controller.queue('concern', message)
    controller.deferQueuedSteerAsCard()
    expect(controller.queuedSteer).toBeUndefined()
    expect(controller.deferredCard).toBe(message)
    expect(controller.takeDeferredCard()).toBe(message)
    expect(controller.deferredCard).toBeUndefined()
  })

  it('preserves a still-queued steer as a card when the turn closes', () => {
    const controller = new DeliveryController({ immuneTurns: 3 })
    const message = advisoryMessage('aborted turn advice', 'concern')
    controller.queue('concern', message)
    controller.onPrimaryTurnEnd(false)
    expect(controller.queuedSteer).toBeUndefined()
    expect(controller.deferredCard).toBe(message)
  })

  it('reset clears every slot and budget', () => {
    const controller = new DeliveryController({ immuneTurns: 3 })
    controller.spendBudget()
    controller.queue('blocker', advisoryMessage('x', 'blocker'))
    controller.onPrimaryTurnEnd(false)
    controller.reset()
    expect(controller.immuneActive).toBe(false)
    expect(controller.lastTurnTerminal).toBe(false)
    expect(controller.queuedSteer).toBeUndefined()
    expect(controller.deferredCard).toBeUndefined()
  })
})

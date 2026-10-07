/**
 * `PeersService` tests over real Sessions and a local fake context: the
 * `senderId+messageId` dedup (including after re-seeding from the log), the
 * quiet/wakeup delivery split, and the forbidden-sender hard block.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { PEER_SEND_TOOL } from '../src/tool.ts'
import { PeersService, PeerSendError, resolvePeersConfig } from '../src/service.ts'
import { FakeContext, makeFakeAgent, type FakeAgent } from './fake-context.ts'

interface Setup {
  readonly ctx: FakeContext
  readonly service: PeersService
  readonly sender: FakeAgent
  readonly target: FakeAgent
  readonly targetSession: Session
}

/** A fake context with a sender and a target session/agent, and a live service. */
function setup(options: { wakeupEnabled?: boolean; maxContentBytes?: number; forbidden?: boolean } = {}): Setup {
  const ctx = new FakeContext()
  const senderSession = Session.create(SessionId('sender'))
  const targetSession = Session.create(SessionId('sess-a'))
  ctx.sessionMap.set('sender', senderSession)
  ctx.sessionMap.set('sess-a', targetSession)
  const sender = makeFakeAgent('sender', senderSession)
  const target = makeFakeAgent('sess-a', targetSession)
  ctx.agentMap.set('sender', sender)
  ctx.agentMap.set('sess-a', target)
  if (options.forbidden === true) ctx.orgProbe = { isForbidden: () => true }
  const config = {
    ...options.wakeupEnabled === undefined ? {} : { wakeupEnabled: options.wakeupEnabled },
    ...options.maxContentBytes === undefined ? {} : { maxContentBytes: options.maxContentBytes },
  }
  return { ctx, service: new PeersService(ctx as unknown as Context, config), sender, target, targetSession }
}

/** The `peer/message` events in a session's log. */
function peerEvents(session: Session): number {
  return session.snapshotEvents().filter(event => event.type === 'peer/message').length
}

/** The text of a delivered message's first block. */
function firstText(agent: FakeAgent): string {
  const block = agent.followup.mock.calls[0]?.[0].content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('PeersService registration', () => {
  it('registers the global peer_send tool and the peers projection', () => {
    const { ctx } = setup()
    expect(ctx.registeredTools.some(tool => tool.name === PEER_SEND_TOOL)).toBe(true)
    expect(ctx.registeredProjections.some(unit => unit.key === 'peers')).toBe(true)
  })
})

describe('PeersService.send dedup', () => {
  it('the SAME senderId+messageId sent twice appends ONE event and returns duplicate the second time, including after re-seeding', async () => {
    const { ctx, service, sender, targetSession } = setup()
    const first = await service.send(sender, { targetId: 'sess-a', content: 'hello', messageId: 'm1' })
    expect(first.status).toBe('delivered')
    expect(first.woke).toBe(true)
    expect(peerEvents(targetSession)).toBe(1)

    const second = await service.send(sender, { targetId: 'sess-a', content: 'hello again', messageId: 'm1' })
    expect(second.status).toBe('duplicate')
    expect(second.woke).toBe(false)
    expect(second.message.id).toBe(first.message.id)
    expect(peerEvents(targetSession)).toBe(1)

    // A fresh service seeds its inbox from the durable log and still dedupes.
    const reseeded = new PeersService(ctx as unknown as Context, {})
    const third = await reseeded.send(sender, { targetId: 'sess-a', content: 'x', messageId: 'm1' })
    expect(third.status).toBe('duplicate')
    expect(peerEvents(targetSession)).toBe(1)
  })

  it('distinct messageIds from the same sender both land', async () => {
    const { service, sender, targetSession } = setup()
    await service.send(sender, { targetId: 'sess-a', content: 'a', messageId: 'm1' })
    await service.send(sender, { targetId: 'sess-a', content: 'b', messageId: 'm2' })
    expect(service.inboxSize('sess-a')).toBe(2)
    expect(peerEvents(targetSession)).toBe(2)
    expect(service.has(SessionId('sender'), 'm1', 'sess-a')).toBe(true)
    expect(service.has(SessionId('sender'), 'm3', 'sess-a')).toBe(false)
  })

  it('mints a messageId when none is supplied (so two default sends both land)', async () => {
    const { service, sender } = setup()
    await service.send(sender, { targetId: 'sess-a', content: 'a' })
    await service.send(sender, { targetId: 'sess-a', content: 'b' })
    expect(service.inboxSize('sess-a')).toBe(2)
  })
})

describe('PeersService.send delivery', () => {
  it('quiet never calls followup; wakeup calls it exactly once with a dsh-peers notice', async () => {
    const { service, sender, target } = setup()
    await service.send(sender, { targetId: 'sess-a', content: 'q', delivery: 'quiet', messageId: 'q1' })
    expect(target.followup).not.toHaveBeenCalled()

    const woke = await service.send(sender, { targetId: 'sess-a', content: 'w', delivery: 'wakeup', messageId: 'w1' })
    expect(woke.woke).toBe(true)
    expect(target.followup).toHaveBeenCalledTimes(1)
    const message = target.followup.mock.calls[0]?.[0]
    expect(message?.source.kind).toBe('dsh-peers')
    expect(firstText(target)).toContain('<peer-message')
  })

  it('wakeupEnabled:false degrades every delivery to inbox-only', async () => {
    const { service, sender, target } = setup({ wakeupEnabled: false })
    const result = await service.send(sender, { targetId: 'sess-a', content: 'w', delivery: 'wakeup', messageId: 'w1' })
    expect(result.status).toBe('delivered')
    expect(result.woke).toBe(false)
    expect(target.followup).not.toHaveBeenCalled()
    expect(service.inboxSize('sess-a')).toBe(1)
  })
})

describe('PeersService.send authorization and validation', () => {
  it('rejects a forbidden sender and appends nothing', async () => {
    const { service, sender, targetSession } = setup({ forbidden: true })
    await expect(service.send(sender, { targetId: 'sess-a', content: 'x', messageId: 'f1' }))
      .rejects.toThrow(/forbidden/)
    expect(peerEvents(targetSession)).toBe(0)
    expect(service.inboxSize('sess-a')).toBe(0)
  })

  it('rejects an unknown target, a self-send, an empty body, and an oversized body', async () => {
    const { service, sender } = setup({ maxContentBytes: 4 })
    await expect(service.send(sender, { targetId: 'nope', content: 'x' })).rejects.toBeInstanceOf(PeerSendError)
    await expect(service.send(sender, { targetId: 'sender', content: 'x' })).rejects.toThrow(/yourself/)
    await expect(service.send(sender, { targetId: 'sess-a', content: '   ' })).rejects.toThrow(/non-empty/)
    await expect(service.send(sender, { targetId: 'sess-a', content: '12345' })).rejects.toThrow(/maxContentBytes/)
  })
})

describe('PeersService live fold', () => {
  it('folds an observed peer/message event into the target inbox, idempotently', () => {
    const { ctx, service, targetSession } = setup()
    const event = targetSession.append('peer/message', {
      id: 'sender#live1',
      senderId: SessionId('sender'),
      targetId: SessionId('sess-a'),
      messageId: 'live1',
      delivery: 'quiet',
      content: [{ type: 'text', text: 'live' }],
      time: 1,
    })
    ctx.emit('session/event', targetSession, event)
    expect(service.inboxSize('sess-a')).toBe(1)
    ctx.emit('session/event', targetSession, event)
    expect(service.inboxSize('sess-a')).toBe(1)
  })
})

describe('peer_send tool', () => {
  it('delegates to the service with the calling agent and returns status+messageId', async () => {
    const { ctx, sender } = setup()
    const tool = ctx.registeredTools.find(definition => definition.name === PEER_SEND_TOOL)
    expect(tool).toBeDefined()
    // A minimal ToolRunContext: the tool reads only `agent`, the rest of the
    // execution identity is loop-owned and never touched here.
    const exec = { agent: sender } as unknown as ToolRunContext
    const value = await tool?.execute({ targetId: 'sess-a', content: 'hi', delivery: 'quiet' }, exec)
    expect(value).toEqual({ status: 'delivered', messageId: expect.any(String) })
  })

  it('refuses to run without a calling agent', async () => {
    const { ctx } = setup()
    const tool = ctx.registeredTools.find(definition => definition.name === PEER_SEND_TOOL)
    const exec = {} as unknown as ToolRunContext
    await expect(tool?.execute({ targetId: 'sess-a', content: 'hi' }, exec)).rejects.toThrow(/no calling agent/)
  })
})

describe('resolvePeersConfig', () => {
  it('applies defaults and fails loud on an unknown key', () => {
    expect(resolvePeersConfig({})).toEqual({ wakeupEnabled: true, maxContentBytes: 16384 })
    expect(() => resolvePeersConfig({ nope: true } as unknown as Parameters<typeof resolvePeersConfig>[0]))
      .toThrow(/unknown config key/)
  })
})

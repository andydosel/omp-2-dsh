import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { chatIdFromSessionKey } from '../src/adapter.ts'
import { renderAssistantText, sessionKeyForPeer, WeChatSessionManager } from '../src/session-map.ts'
import type { Context } from '@deepseek-ai/cordis'

describe('session key mapping', () => {
  it('maps DMs to weixin:dm:{userId}', () => {
    expect(sessionKeyForPeer('dm', 'peer@im.wechat', 'peer@im.wechat', {}, { groupSessionsPerUser: true, threadSessionsPerUser: false }))
      .toBe('weixin:dm:peer@im.wechat')
  })

  it('maps groups to weixin:group:{chatId}[:thread][:userId]', () => {
    const options = { groupSessionsPerUser: true, threadSessionsPerUser: false }
    expect(sessionKeyForPeer('group', 'room@chatroom', 'u1', {}, options)).toBe('weixin:group:room@chatroom:u1')
    expect(sessionKeyForPeer('group', 'room@chatroom', 'u1', { thread_id: 't1' }, options))
      .toBe('weixin:group:room@chatroom:t1')
    // threads are shared unless threadSessionsPerUser
    expect(sessionKeyForPeer('group', 'room@chatroom', 'u1', { thread_id: 't1' }, { groupSessionsPerUser: true, threadSessionsPerUser: true }))
      .toBe('weixin:group:room@chatroom:t1:u1')
    // groupSessionsPerUser=false → no user suffix
    expect(sessionKeyForPeer('group', 'room@chatroom', 'u1', {}, { groupSessionsPerUser: false, threadSessionsPerUser: false }))
      .toBe('weixin:group:room@chatroom')
  })
})

describe('chatIdFromSessionKey', () => {
  it('extracts the outbound chat id', () => {
    expect(chatIdFromSessionKey(SessionId('weixin:dm:peer@im.wechat'))).toBe('peer@im.wechat')
    expect(chatIdFromSessionKey(SessionId('weixin:group:room@chatroom:u1'))).toBe('room@chatroom')
  })
})

describe('renderAssistantText', () => {
  it('joins text blocks and ignores non-text blocks', () => {
    const text = renderAssistantText({ content: [
      { type: 'text', text: 'first' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'second' },
    ] })
    expect(text).toBe('first\nsecond')
  })

  it('returns empty for empty content', () => {
    expect(renderAssistantText({ content: [] })).toBe('')
  })
})

describe('WeChatSessionManager', () => {
  function makeFakeAgent() {
    const followup = vi.fn()
    return {
      id: SessionId('weixin:dm:peer@im.wechat'),
      followup,
      session: { id: SessionId('weixin:dm:peer@im.wechat') },
    }
  }

  it('creates an agent on first contact and follows up with a user message', async () => {
    const fakeAgent = makeFakeAgent()
    const create = vi.fn().mockResolvedValue({ agent: fakeAgent, dispose: vi.fn() })
    const resume = vi.fn().mockRejectedValue(new Error('no persistence'))
    let listener: ((session: unknown, event: unknown) => void) | undefined
    const ctx = {
      agents: { get: vi.fn().mockReturnValue(undefined), create, resume },
      on: vi.fn((_name: string, fn: (session: unknown, event: unknown) => void) => {
        listener = fn
        return () => undefined
      }),
    } as unknown as Context

    const hooks = {
      onAssistantMessage: vi.fn(),
      onTurnStart: vi.fn(),
      onTurnEnd: vi.fn(),
    }
    const manager = new WeChatSessionManager(ctx, hooks)
    await manager.followup('weixin:dm:peer@im.wechat', 'hello wechat')

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SessionId('weixin:dm:peer@im.wechat') }))
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: SessionId('weixin:dm:peer@im.wechat') }))
    const message = fakeAgent.followup.mock.calls[0]![0]!
    expect(message.role).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: 'hello wechat' }])
    expect(message.source).toEqual({ kind: 'user' })

    // session/event observation: assistant message → outbound hook
    listener?.(fakeAgent.session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'reply!' }] } },
    })
    expect(hooks.onAssistantMessage).toHaveBeenCalledWith(SessionId('weixin:dm:peer@im.wechat'), 'reply!')

    // typing hooks
    listener?.(fakeAgent.session, { type: 'turn/start', data: {} })
    expect(hooks.onTurnStart).toHaveBeenCalledWith(SessionId('weixin:dm:peer@im.wechat'))
    listener?.(fakeAgent.session, { type: 'turn/end', data: {} })
    expect(hooks.onTurnEnd).toHaveBeenCalledWith(SessionId('weixin:dm:peer@im.wechat'))
  })

  it('reuses the live agent instead of creating a second one', async () => {
    const fakeAgent = makeFakeAgent()
    const create = vi.fn()
    const ctx = {
      agents: {
        get: vi.fn().mockReturnValue(fakeAgent),
        create,
        resume: vi.fn(),
      },
      on: vi.fn(() => () => undefined),
    } as unknown as Context
    const manager = new WeChatSessionManager(ctx, {
      onAssistantMessage: vi.fn(), onTurnStart: vi.fn(), onTurnEnd: vi.fn(),
    })
    await manager.followup('weixin:dm:peer@im.wechat', 'again')
    expect(create).not.toHaveBeenCalled()
    expect(fakeAgent.followup).toHaveBeenCalledTimes(1)
  })

  it('dispose tears down owned handles and unregisters the session listener', async () => {
    const fakeAgent = makeFakeAgent()
    const dispose = vi.fn().mockResolvedValue(undefined)
    const onDisposer = vi.fn()
    const ctx = {
      agents: {
        get: vi.fn().mockReturnValue(undefined),
        create: vi.fn().mockResolvedValue({ agent: fakeAgent, dispose }),
        resume: vi.fn().mockRejectedValue(new Error('nope')),
      },
      on: vi.fn(() => onDisposer),
    } as unknown as Context
    const manager = new WeChatSessionManager(ctx, {
      onAssistantMessage: vi.fn(), onTurnStart: vi.fn(), onTurnEnd: vi.fn(),
    })
    await manager.followup('weixin:dm:peer@im.wechat', 'hi')
    expect(manager.size).toBe(1)
    await manager.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(onDisposer).toHaveBeenCalledTimes(1)
    expect(manager.size).toBe(0)
  })
})

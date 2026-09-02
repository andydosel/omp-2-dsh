/**
 * Tests for the `agent://<sessionId>` internal-URL branch of the read tool:
 * transcript rendering (user/assistant/tool-result events with tool-call
 * summaries), tool-result elision, selector windows over the rendered text,
 * unknown-session failed notes, nested `agent://<parent>/<child>` addressing,
 * and final-output clarity. Sessions are real `Session.create` objects seeded
 * with fixture events — no host, no API keys.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { applyReadTool, renderReadValue } from '../src/read/index.ts'
import type { ReadToolCaps, ReadValue } from '../src/read/index.ts'
import { HarnessCtx, HarnessFs, makeExec, tempDir } from './helpers.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const CAPS: ReadToolCaps = {
  limit: 300,
  maxLines: 2000,
  maxLineLength: 2000,
  maxBytes: 50 * 1024,
  directory: { depth: 2, perDir: 12 },
  archiveListLimit: 500,
  sqliteQueryLimit: 20,
  sqliteQueryMax: 500,
  sqliteRawQueryMaxRows: 1000,
  urlMaxLines: 300,
  urlMaxBytes: 50 * 1024,
  agentToolResultChars: 2000,
}

/** One fixture event: surface events carry the append marker; log-only ones do not. */
function ev<T extends SessionEvent['type']>(type: T, seq: number, time: number, data: SessionEvent[T]['data'], surface = false): SessionEvent {
  return {
    type,
    seq,
    time,
    data,
    ...surface ? { surfaceOp: 'append' as const } : {},
  } as unknown as SessionEvent
}

const user = (seq: number, time: number, text: string): SessionEvent =>
  ev('user/message', seq, time, createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), true)

const assistant = (seq: number, time: number, content: ContentBlock[]): SessionEvent =>
  ev('assistant/message', seq, time, {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content,
      provider: 'mock',
      model: 'mock',
      source: { provider: 'mock', model: 'mock' },
    }),
  }, true)

const toolCall = (seq: number, time: number, callId: string, name: string, args: string): SessionEvent =>
  ev('tool/call', seq, time, { turn: 1, step: 1, callId, name, arguments: args })

const toolResult = (seq: number, time: number, callId: string, text: string): SessionEvent =>
  ev('tool/result', seq, time, {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: CallId(callId), content: [{ type: 'text', text }], isError: false }),
  }, true)

/** A worker-style log: task → assistant (text + tool call) → tool result → final answer. */
function workerLog(): SessionEvent[] {
  return [
    ev('turn/start', 0, 100, { turn: 1 }),
    user(1, 200, 'Summarize the repo changes.'),
    assistant(2, 300, [
      { type: 'text', text: "I'll inspect the repository." },
      { type: 'tool-call', id: CallId('call-1'), name: 'read', arguments: '{"path":"src/index.ts"}' },
    ]),
    toolCall(3, 400, 'call-1', 'read', '{"path":"src/index.ts"}'),
    toolResult(4, 500, 'call-1', '1: export const name = "plugin"'),
    assistant(5, 600, [{ type: 'text', text: 'The repo is a plugin exporting "plugin".' }]),
  ]
}

function makeSession(id: string, events: SessionEvent[], header: Partial<{ parentSession: string; cwd: string; origin: 'subagent'; agentPreset: string }> = {}): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, events, {
    version: 0,
    id: sessionId,
    createdAt: 100,
    ...header.parentSession !== undefined ? { parentSession: SessionId(header.parentSession) } : {},
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    ...header.origin !== undefined ? { origin: header.origin } : {},
    ...header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {},
  })
}

let dir: string
let ctx: HarnessCtx
let sessions: Map<string, Session>
let read: (path: string) => Promise<ReadValue>

beforeEach(async () => {
  dir = await tempDir('agent-read-test')
  sessions = new Map()
  ctx = new HarnessCtx(new HarnessFs(dir))
  // The read tool reaches the live store through `ctx.sessions.get(id)`.
  Object.assign(ctx, {
    sessions: {
      get: (id: unknown): Session | undefined => sessions.get(String(id)),
    },
  })
  applyReadTool(ctx as never, CAPS)
  const definition = ctx.registered[0]!
  read = async (path: string) => definition.execute({ path }, makeExec()) as Promise<ReadValue>
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('read tool: agent:// session transcripts', () => {
  it('renders the title block, events, and final output from a worker log', async () => {
    sessions.set('worker-1', makeSession('worker-1', workerLog(), { origin: 'subagent', cwd: 'C:\\work', agentPreset: 'code' }))
    const value = await read('agent://worker-1')
    expect(value.kind).toBe('agent')
    expect(value.sessionId).toBe('worker-1')
    expect(value.messageCount).toBe(4)
    expect(value.createdAt).toBe(100)
    expect(value.updatedAt).toBe(600)
    expect(value.text).toBeUndefined()
    expect(value.truncated).toBe(false)

    const text = value.lines!.map(line => line.text).join('\n')
    expect(text).toContain('# agent://worker-1')
    expect(text).toContain('created: 1970-01-01T00:00:00.100Z')
    expect(text).toContain('updated: 1970-01-01T00:00:00.600Z')
    expect(text).toContain('messages: 4')
    expect(text).toContain('origin: subagent')
    expect(text).toContain('cwd: C:\\work')
    expect(text).toContain('agent preset: code')
    expect(text).toContain('── user (seq 1) ──')
    expect(text).toContain('Summarize the repo changes.')
    expect(text).toContain('── assistant (seq 2) ──')
    expect(text).toContain("I'll inspect the repository.")
    expect(text).toContain('[tool call: read {"path":"src/index.ts"}]')
    expect(text).toContain('── tool result: read (seq 4) ──')
    expect(text).toContain('1: export const name = "plugin"')
    expect(text).toContain('── assistant (seq 5) ──')
    expect(text).toContain('The repo is a plugin exporting "plugin".')
  })

  it('marks the final assistant output clearly for the director', async () => {
    sessions.set('worker-1', makeSession('worker-1', workerLog()))
    const value = await read('agent://worker-1')
    const text = value.lines!.map(line => line.text).join('\n')
    const finalIndex = text.indexOf('── final output ──')
    expect(finalIndex).toBeGreaterThanOrEqual(0)
    expect(text.slice(finalIndex)).toContain('The repo is a plugin exporting "plugin".')
  })

  it('skips trace-only events and the seed marker', async () => {
    sessions.set('worker-1', makeSession('worker-1', workerLog()))
    const value = await read('agent://worker-1')
    const text = value.lines!.map(line => line.text).join('\n')
    expect(text).not.toContain('turn/start')
    expect(text).not.toContain('session/end-seed')
    expect(text).not.toContain('── tool result (seq 3) ──') // the tool/call event is not a section
  })

  it('elides oversized tool results with a truncation marker', async () => {
    const big = 'x'.repeat(5000)
    const log = [
      user(0, 100, 'run the tool'),
      toolResult(1, 200, 'call-1', big),
    ]
    sessions.set('worker-1', makeSession('worker-1', log))
    const value = await read('agent://worker-1')
    expect(value.truncated).toBe(true)
    const text = value.lines!.map(line => line.text).join('\n')
    expect(text).toContain('[tool output truncated — 5000 chars]')
    expect(text).toContain('x'.repeat(2000))
    expect(text).not.toContain('x'.repeat(2001))
  })

  it('applies a numbered selector window with context on the transcript', async () => {
    sessions.set('worker-1', makeSession('worker-1', workerLog()))
    const value = await read('agent://worker-1:2-3')
    expect(value.lines!.map(line => line.number)).toEqual([1, 2, 3, 4, 5, 6])
    expect(value.offset).toBe(2)
    expect(value.totalLines).toBeGreaterThan(6)
  })

  it('applies a raw selector to the whole transcript', async () => {
    sessions.set('worker-1', makeSession('worker-1', workerLog()))
    const value = await read('agent://worker-1:raw')
    expect(value.text).toContain('# agent://worker-1')
    expect(value.text).toContain('── final output ──')
    expect(value.lines).toBeUndefined()
  })

  it('applies a raw range selector', async () => {
    sessions.set('worker-1', makeSession('worker-1', workerLog()))
    const value = await read('agent://worker-1:1-2:raw')
    expect(value.text).toBeDefined()
    expect(value.text!.split('\n')).toHaveLength(2)
  })

  it('reports an unknown session as a failed note, not a throw', async () => {
    const value = await read('agent://ghost')
    expect(value.kind).toBe('agent')
    expect(value.failed).toContain('unknown session "ghost"')
    expect(value.text).toContain('Failed to read agent://ghost')
  })

  it('renders a failed note when the sessions service is missing', async () => {
    const bare = new HarnessCtx(new HarnessFs(dir))
    applyReadTool(bare as never, CAPS)
    const value = await bare.registered[0]!.execute({ path: 'agent://worker-1' }, makeExec()) as ReadValue
    expect(value.kind).toBe('agent')
    expect(value.failed).toContain('sessions service is not mounted')
  })

  it('resolves nested agent://<parent>/<child> to the child session', async () => {
    sessions.set('parent-1', makeSession('parent-1', [user(0, 100, 'spawn worker')]))
    sessions.set('child-1', makeSession('child-1', workerLog(), { parentSession: 'parent-1' }))
    const value = await read('agent://parent-1/child-1')
    expect(value.kind).toBe('agent')
    expect(value.sessionId).toBe('child-1')
    const text = value.lines!.map(line => line.text).join('\n')
    expect(text).toContain('# agent://child-1')
    expect(text).toContain('parent: parent-1')
  })

  it('fails a nested path when the child declares a different parent', async () => {
    sessions.set('parent-1', makeSession('parent-1', [user(0, 100, 'spawn worker')]))
    sessions.set('other-1', makeSession('other-1', workerLog(), { parentSession: 'elsewhere' }))
    const value = await read('agent://parent-1/other-1')
    expect(value.kind).toBe('agent')
    expect(value.failed).toContain('is not a child of "parent-1"')
  })

  it('renders the model-facing envelope with the agent type', async () => {
    sessions.set('worker-1', makeSession('worker-1', workerLog()))
    const value = await read('agent://worker-1')
    const rendered = renderReadValue({ path: 'agent://worker-1' }, value, CAPS)
    const text = rendered[0]?.type === 'text' ? rendered[0].text : ''
    expect(text).toContain('<path>agent://worker-1</path>')
    expect(text).toContain('<type>agent</type>')
    expect(text).toMatch(/1: # agent:\/\/worker-1/)
  })

  it('does not disturb file reads (dispatch keeps literal paths intact)', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree', 'utf8')
    const value = await read('a.txt')
    expect(value.kind).toBe('file')
    expect(value.totalLines).toBe(3)
  })
})

/**
 * Test helpers: a bare cordis context with mocked dsh services, and a minimal
 * session/agent harness. No API keys: the llm mock streams canned chunks.
 *
 * @module dsh-compact-mode/tests/helpers
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Canned text stream chunks for the mock llm. */
export function textStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/** A mock llm service with a configurable canned reply. */
export class MockLlm {
  calls: { provider: string; model: string; messages: unknown[]; purpose?: string }[] = []
  reply = 'mock summary text'

  stream(options: { provider: string; model: string; messages: unknown[]; purpose?: string }) {
    this.calls.push({
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      purpose: options.purpose,
    })
    return textStream(this.reply)
  }

  async resolveModelInfo(_provider: string, _model: string) {
    return { context: { contextWindow: 100_000 } }
  }
}

/** A mock token meter whose nodes mirror the session surface. */
export class MockTokenMeter {
  totalTokens = 50_000
  surfaceTokens = 50_000
  perNodeTokens = 4000

  measure(session: Session) {
    const nodes = session.surface.nodes.map(seq => ({ seq, tokens: this.perNodeTokens }))
    return {
      logRevision: session.events.length,
      baseline: { kind: 'estimated' as const, tokens: 0 },
      surfaceDeltaTokens: 0,
      totalTokens: this.totalTokens,
      surfaceTokens: this.surfaceTokens,
      nodes,
    }
  }

  estimateMessage(_message: unknown): number {
    return 1000
  }
}

/** A mock sessions service. */
export class MockSessions {
  flushed: Session[] = []
  async flush(session: Session) {
    this.flushed.push(session)
  }
}

/** A mock commands service that records registrations. */
export class MockCommands {
  registered: { name: string; handler: (invocation: unknown) => unknown }[] = []
  register(definition: { name: string; handler: (invocation: unknown) => unknown }) {
    this.registered.push(definition)
  }
}

/** Build a bare context with all mocks provided. */
export function makeContext() {
  const ctx = new Context()
  const llm = new MockLlm()
  const tokenMeter = new MockTokenMeter()
  const sessions = new MockSessions()
  const commands = new MockCommands()
  ctx.provide('llm', llm)
  ctx.provide('tokenMeter', tokenMeter)
  ctx.provide('sessions', sessions)
  ctx.provide('commands', commands)
  return { ctx, llm, tokenMeter, sessions, commands }
}

/** A minimal agent harness around a detached session. */
export function makeAgent(ctx: Context, id = 's-test'): Agent {
  const session = createSession(id)
  return {
    id: SessionId(id),
    session,
    options: { provider: 'mock', model: 'mock-model' },
    inbox: { pending: [], parked: [] } as never,
    status: 'idle',
    ctx,
    cancel: () => {},
    whenIdle: async () => {},
    runMaintenance: async <T,>(task: (signal: AbortSignal) => Promise<T>) => {
      const controller = new AbortController()
      return task(controller.signal)
    },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
  } as Agent
}

import { Session } from '@deepseek-ai/dsh-session'

/** Create a detached session. */
export function createSession(id: string): Session {
  return Session.create(SessionId(id))
}

// Every spec file that imports these helpers registers this fixture: the
// plugin-owned review-tree file (`<DSH_HOME>/storages/compact-review.json`)
// is isolated per test under a fresh temp dir. Without it, tests running in
// parallel workers all hit the SAME cwd file and their atomic-rename writes
// collide (Windows EPERM) — a pre-existing flake surfaced while hardening.
import { afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-compact-tests-'))
})

afterEach(() => {
  const home = process.env.DSH_HOME
  if (home !== undefined) {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup: a late async drain may still hold the dir.
    }
    delete process.env.DSH_HOME
  }
})

/**
 * Review-gate unit tests: flag parsing/stripping at the user-input boundary,
 * path classification, and the write fence's allow/ask/deny decisions —
 * including that `ask`/`deny` SHORT-CIRCUIT dispatch (`next()` is never
 * reached) while everything else delegates.
 *
 * @module @dsh-plugin/dsh-review-gate/tests
 */

import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/config.ts'
import { findFlagTarget, parseInputFlags, stripFlags } from '../src/flags.ts'
import { createWriteGateListener, evaluateWriteGate, readToolPath } from '../src/gate.ts'
import { classifyPath } from '../src/paths.ts'
import { applyFlagsToState, initialGateState } from '../src/state.ts'

/** One claimed user message with a single text block. */
function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

const workspace = '/workspace'
const config = resolveConfig({})

/** A closed gate on `task-2` (the state every fence assertion starts from). */
const closedGate = { taskId: 'task-2', enabled: true, awaitingApproval: true, reviewers: 0 }

/** A fabricated pre-execute execution: only the fields the fence reads matter. */
function fakeExec(name: string, args: unknown): ToolExecution {
  // Test seam: the real ToolExecution is minted by the tool registry, which
  // this unit test deliberately does not compose.
  return {
    name,
    arguments: args,
    callId: 'call-1',
    agent: { session: { header: { cwd: workspace } } },
  } as unknown as ToolExecution
}

describe('parseInputFlags', () => {
  it('strips a trailing --review and reports it', () => {
    expect(parseInputFlags('fix the parser --review')).toEqual({ text: 'fix the parser', review: true })
  })

  it('strips a trailing --no-review and reports it', () => {
    expect(parseInputFlags('ship it --no-review')).toEqual({ text: 'ship it', review: false })
  })

  it('reads --workers N in the space form', () => {
    expect(parseInputFlags('do the thing --workers 4')).toEqual({ text: 'do the thing', workers: 4 })
  })

  it('reads both flags in either order', () => {
    expect(parseInputFlags('do it --review --workers 3')).toEqual({ text: 'do it', review: true, workers: 3 })
    expect(parseInputFlags('do it --workers 3 --review')).toEqual({ text: 'do it', review: true, workers: 3 })
  })

  it('reads the inline --workers=N form', () => {
    expect(parseInputFlags('do it --workers=2 --review')).toEqual({ text: 'do it', review: true, workers: 2 })
  })

  it('lets the flag nearest the end win', () => {
    expect(parseInputFlags('do it --review --no-review')).toEqual({ text: 'do it', review: false })
  })

  it('leaves mid-sentence and lookalike tokens alone', () => {
    expect(parseInputFlags('use --review in the middle')).toEqual({ text: 'use --review in the middle' })
    expect(parseInputFlags('fix it --not-review')).toEqual({ text: 'fix it --not-review' })
  })

  it('accepts a flag-only input and returns empty text', () => {
    expect(parseInputFlags('--review')).toEqual({ text: '', review: true })
    expect(parseInputFlags('  --workers 5  ')).toEqual({ text: '', workers: 5 })
  })
})

describe('stripFlags', () => {
  it('rewrites the flag-carrying block, preserving message identity', () => {
    const before = userMessage('do the thing --review')
    const target = findFlagTarget([before])
    expect(target).toBeDefined()
    const after = stripFlags([before], target!, 'do the thing')
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(before.id)
    expect(after[0]!.content).toEqual([{ type: 'text', text: 'do the thing' }])
  })

  it('drops a message the strip emptied entirely', () => {
    const before = userMessage('--review')
    const after = stripFlags([before], findFlagTarget([before])!, '')
    expect(after).toEqual([])
  })

  it('ignores plugin-sourced messages that follow the user input', () => {
    const user = userMessage('do it --review')
    const injected = createUserMessage({
      content: [{ type: 'text', text: 'not user input --no-review' }],
      source: { kind: 'dsh-review-gate', form: 'notice', summary: 'notice' },
    })
    expect(findFlagTarget([user, injected])?.messageId).toBe(user.id)
  })
})

describe('classifyPath', () => {
  const classify = (filePath: string, overrides: Partial<Parameters<typeof classifyPath>[0]> = {}) =>
    classifyPath({ filePath, cwd: workspace, protectedPaths: config.protectedPaths, scratchDir: config.scratchDir, ...overrides })

  it('protects real source under the default globs', () => {
    expect(classify('src/app.ts')).toBe('protected')
    expect(classify('packages/core/src/index.ts')).toBe('protected')
    expect(classify('src/thing.tsx')).toBe('protected')
    expect(classify('src/legacy.js')).toBe('protected')
  })

  it('keeps the scratch area writable and lets ordinary files through', () => {
    expect(classify('.dsh-plans/plan.md')).toBe('scratch')
    expect(classify('docs/readme.md')).toBe('other')
    expect(classify('notes.txt')).toBe('other')
  })

  it('wins the scratch area over a protected glob and fences `..` escapes', () => {
    expect(classify('.dsh-plans/plan.md', { protectedPaths: ['**/*.md'] })).toBe('scratch')
    expect(classify('../outside/src/escape.ts')).toBe('protected')
    expect(classify('src\\windows\\style.ts')).toBe('protected')
  })
})

describe('evaluateWriteGate', () => {
  const evaluate = (overrides: Partial<Parameters<typeof evaluateWriteGate>[0]> = {}) =>
    evaluateWriteGate({
      tool: 'write',
      args: { file_path: 'src/app.ts' },
      state: closedGate,
      approvalPolicy: 'ask',
      cwd: workspace,
      config,
      ...overrides,
    })

  it('asks for approval on a protected write while the gate is closed', () => {
    const decision = evaluate()
    expect(decision.kind).toBe('ask')
    if (decision.kind !== 'ask') return
    expect(decision.reason).toContain('src/app.ts')
    expect(decision.displayReason.zh.length).toBeGreaterThan(0)
  })

  it('denies outright when the approval policy is `never`', () => {
    const decision = evaluate({ approvalPolicy: 'never' })
    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') return
    expect(decision.reason).toContain('approval policy is "never"')
  })

  it('allows the scratch area, ordinary files, non-write tools and an open gate', () => {
    expect(evaluate({ args: { file_path: '.dsh-plans/plan.md' } }).kind).toBe('allow')
    expect(evaluate({ args: { file_path: 'docs/readme.md' } }).kind).toBe('allow')
    expect(evaluate({ tool: 'read', args: { file_path: 'src/app.ts' } }).kind).toBe('allow')
    expect(evaluate({ state: { ...closedGate, awaitingApproval: false } }).kind).toBe('allow')
    expect(evaluate({ state: { ...closedGate, enabled: false } }).kind).toBe('allow')
  })

  it('fences conservatively when the target path is unreadable', () => {
    expect(evaluate({ args: {} }).kind).toBe('ask')
    expect(evaluate({ args: { file_path: '   ' } }).kind).toBe('ask')
    expect(readToolPath({ file_path: 42 })).toBeUndefined()
  })

  it('reads both write-target spellings (`file_path` and the omp `path`)', () => {
    expect(evaluate({ args: { path: 'src/app.ts' } }).kind).toBe('ask')
    expect(evaluate({ args: { path: '.dsh-plans/plan.md' } }).kind).toBe('allow')
    expect(readToolPath({ path: 'src/app.ts' })).toBe('src/app.ts')
    expect(readToolPath({ file_path: 'a.ts', path: 'b.ts' })).toBe('a.ts')
  })
})

describe('pre-execute listener short-circuit', () => {
  const make = (overrides: Partial<{ unlocked: boolean; policy: 'ask' | 'never'; state: typeof closedGate }> = {}) => {
    const guarded: Array<{ callId: string; target: string }> = []
    const next = vi.fn(async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
    const listener = createWriteGateListener({
      config,
      stateOf: () => overrides.state ?? closedGate,
      approvalPolicyOf: () => overrides.policy ?? 'ask',
      isUnlocked: () => overrides.unlocked ?? false,
      onGuarded: (_session, callId, target) => { guarded.push({ callId, target }) },
    })
    const session = { header: { cwd: workspace } } as unknown as Session
    return { listener, next, guarded, session }
  }

  it('returns ask without dispatching the write, and records the blocked call', async () => {
    const { listener, next, guarded, session } = make()
    const decision = await listener(fakeExec('write', { file_path: 'src/app.ts' }), next)
    expect(decision.kind).toBe('ask')
    expect(next).not.toHaveBeenCalled()
    expect(guarded).toEqual([{ callId: 'call-1', target: 'src/app.ts' }])
    expect(session.header.cwd).toBe(workspace)
  })

  it('returns deny without dispatching, and records nothing to approve', async () => {
    const { listener, next, guarded } = make({ policy: 'never' })
    const decision = await listener(fakeExec('edit', { file_path: 'src/app.ts' }), next)
    expect(decision.kind).toBe('deny')
    expect(next).not.toHaveBeenCalled()
    expect(guarded).toEqual([])
  })

  it('delegates every allowed call and every already-unlocked session', async () => {
    const { listener, next } = make()
    expect((await listener(fakeExec('read', { file_path: 'src/app.ts' }), next)).kind).toBe('allow')
    expect((await listener(fakeExec('write', { file_path: '.dsh-plans/plan.md' }), next)).kind).toBe('allow')
    const unlocked = make({ unlocked: true })
    expect((await unlocked.listener(fakeExec('write', { file_path: 'src/app.ts' }), unlocked.next)).kind).toBe('allow')
    expect(next).toHaveBeenCalledTimes(2)
    expect(unlocked.next).toHaveBeenCalledTimes(1)
  })
})

describe('flag → state transition', () => {
  it('arms the gate on --review and records the reviewer count', () => {
    const state = applyFlagsToState(initialGateState('off'), { text: '', review: true, workers: 4 }, 2)
    expect(state).toEqual({ taskId: 'task-2', enabled: true, awaitingApproval: true, reviewers: 4 })
  })

  it('cancels the gate on --no-review and keeps the count on a bare --workers', () => {
    const cancelled = applyFlagsToState(closedGate, { text: '', review: false }, 3)
    expect(cancelled).toEqual({ taskId: 'task-3', enabled: false, awaitingApproval: false, reviewers: 0 })
    const counted = applyFlagsToState(closedGate, { text: '', workers: 5 }, 3)
    expect(counted).toEqual({ ...closedGate, reviewers: 5 })
  })

  it('starts every task behind the fence under defaultPolicy `on`', () => {
    expect(initialGateState('on')).toEqual({ taskId: '', enabled: true, awaitingApproval: true, reviewers: 0 })
    expect(initialGateState('off')).toEqual({ taskId: '', enabled: false, awaitingApproval: false, reviewers: 0 })
  })
})

/**
 * dsh-task-board specs: the durable event fold (tombstones included), the
 * revision compare-and-set, the bounded work-set projection (pure renderer +
 * the per-agent prompt section), the signal-gated auto-close, the five tools
 * over the real tool runtime, and config materialization.
 */

import { describe, expect, it } from 'vitest'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { TASK_BOARD_KEY, workSetTasks } from '../src/projection.ts'
import { TaskRevisionConflictError } from '../src/service.ts'
import { WORK_SET_HEADER, WORK_SET_SECTION, renderWorkSet } from '../src/workset.ts'
import type { TaskSnapshot } from '../src/types.ts'
import { boardHarness, fakeAgent, foldedBoard, type BoardHarness } from './harness.ts'

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** A task fixture with sensible defaults (pure-renderer tests). */
function task(id: string, subject: string, patch: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id,
    revision: 1,
    subject,
    status: 'pending',
    reviewRound: 0,
    findings: [],
    filteredFindings: [],
    inContext: true,
    ...patch,
  }
}

/** A registered tool whose rendered result carries `text` (auto-close driver). */
function renderedResultTool(name: string, text: string): ToolDefinition {
  return defineTool({
    name,
    description: 'test double: renders an arbitrary result text',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text }],
    },
    execute: async () => ({ ok: true }),
  })
}

/** Run one tool through the real runtime for the harness session. */
async function runTool(
  harness: BoardHarness,
  name: string,
  args: unknown,
  callId = `call-${name}`,
): Promise<ToolExecutionResult> {
  return harness.ctx.tools.execute({
    callId: ToolCallId(callId),
    name,
    arguments: args,
    agent: fakeAgent(harness.session),
    signal: new AbortController().signal,
  })
}

/** Flatten a tool result's model-facing text. */
function resultText(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

describe('projection: durable task events fold whole values', () => {
  it('appends one event per mutation and replays the board from the log', async () => {
    const { ctx, board, session } = await boardHarness()
    const created = board.create(session, { subject: 'Ship the coordinator suite' })
    expect(created).toMatchObject({ id: 'task-1', revision: 1, status: 'pending', inContext: true, reviewRound: 0 })

    const started = board.update(session, created.id, { status: 'in_progress' }, created.revision)
    expect(started).toMatchObject({ status: 'in_progress', revision: 2, inContext: true })

    const closed = board.close(session, created.id, 'user cancelled it')
    expect(closed).toMatchObject({ status: 'closed', revision: 3, inContext: false })

    const reopened = board.reopen(session, created.id)
    expect(reopened).toMatchObject({ status: 'pending', revision: 4, inContext: true })

    expect(session.snapshotEvents().map(event => event.type)).toEqual([
      'task/new',
      'task/update',
      'task/closed',
      'task/reopened',
    ])
    // Closing is a replayable tombstone: the log keeps the whole task and the reason.
    const closedEvent = session.snapshotEvents().find(event => event.type === 'task/closed')
    expect(closedEvent?.data).toMatchObject({ reason: 'user cancelled it', task: { status: 'closed', revision: 3 } })

    // The live projection and an independent fold of the raw log agree.
    expect(ctx.sessionProjections.stateOf(session, TASK_BOARD_KEY)).toEqual([reopened])
    expect(foldedBoard(session)).toEqual([reopened])
  })

  it('keeps deletions on the board but out of the client view, and never reuses an id', async () => {
    const { ctx, board, session } = await boardHarness()
    const first = board.create(session, { subject: 'Retire the legacy gateway' })
    board.update(session, first.id, { status: 'deleted' }, first.revision)
    const second = board.create(session, { subject: 'Ship the review gate' })

    expect(second.id).toBe('task-2')
    expect(board.list(session).map(entry => entry.id)).toEqual(['task-2'])
    expect(ctx.sessionProjections.stateOf(session, TASK_BOARD_KEY)).toHaveLength(2)
    expect(ctx.sessionProjections.snapshot(session).values[TASK_BOARD_KEY]).toHaveLength(1)
  })

  it('accumulates findings and owner through a patch as a whole value', async () => {
    const { board, session } = await boardHarness()
    const created = board.create(session, { subject: 'Carry review findings', owner: 'lead-1' })
    expect(created.owner).toBe('lead-1')
    const reviewed = board.update(session, created.id, {
      reviewRound: 1,
      findings: [{ severity: 'P1', summary: 'Missing backoff', sourceRound: 1 }],
      filteredFindings: [{ severity: 'P2', summary: 'False positive', sourceRound: 1 }],
    }, created.revision)
    expect(reviewed).toMatchObject({
      reviewRound: 1,
      owner: 'lead-1',
      revision: 2,
      findings: [{ severity: 'P1', summary: 'Missing backoff', sourceRound: 1 }],
      filteredFindings: [{ severity: 'P2', summary: 'False positive', sourceRound: 1 }],
    })
  })
})

describe('revision CAS', () => {
  it('rejects a stale revision, names both revisions, and appends nothing', async () => {
    const { board, session } = await boardHarness()
    const created = board.create(session, { subject: 'Guard concurrent updates' })
    board.update(session, created.id, { status: 'in_progress' }, created.revision)

    let conflict: unknown
    try {
      board.update(session, created.id, { status: 'completed' }, created.revision)
    } catch (error: unknown) {
      conflict = error
    }
    expect(conflict).toBeInstanceOf(TaskRevisionConflictError)
    expect(conflict).toMatchObject({ taskId: created.id, expected: 1, actual: 2 })
    expect((conflict as Error).message).toContain('is at revision 2, not 1')

    // The rejected update left no trace: one task/new plus the accepted task/update.
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['task/new', 'task/update'])
    expect(board.get(session, created.id)).toMatchObject({ status: 'in_progress', revision: 2 })
  })

  it('bumps the revision on every accepted mutation, including work-set moves', async () => {
    const { board, session } = await boardHarness()
    const created = board.create(session, { subject: 'Track revisions' })
    const hidden = board.update(session, created.id, { inContext: false }, created.revision)
    expect(hidden).toMatchObject({ revision: 2, inContext: false })
    const shown = board.update(session, created.id, { inContext: true }, hidden.revision)
    expect(shown).toMatchObject({ revision: 3, inContext: true })
  })

  it('forces a terminal status out of the work set', async () => {
    const { board, session } = await boardHarness()
    const created = board.create(session, { subject: 'Complete without a hint' })
    const done = board.update(session, created.id, { status: 'completed' }, created.revision)
    expect(done).toMatchObject({ status: 'completed', inContext: false })
  })

  it('refuses to touch a task that is not on this session board', async () => {
    const { board, session } = await boardHarness()
    expect(() => board.update(session, 'task-77', { status: 'in_progress' })).toThrow(/not on this session's board/)
    expect(() => board.close(session, 'task-77')).toThrow(/not on this session's board/)
  })
})

/** Yield to the macrotask queue once: the per-agent install activates on a later microtask. */
function flushScheduler(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  return promise
}

describe('work set', () => {
  it('renders only in-context, non-deleted tasks under a hard byte budget', () => {
    const tasks = [
      task('task-1', 'First requirement'),
      task('task-2', 'Second requirement', { inContext: false }),
      task('task-3', 'Closed requirement', { status: 'closed' }),
      task('task-4', 'Deleted requirement', { status: 'deleted' }),
    ]
    expect(renderWorkSet(tasks, 500)).toBe(`${WORK_SET_HEADER}\n- task-1 [pending] First requirement`)
    expect(renderWorkSet([], 500)).toBe('')
    // Not even the header fits → contribute nothing rather than a truncated header.
    expect(renderWorkSet(tasks, 10)).toBe('')
  })

  it('collapses whitespace and truncates with an omission trailer inside the budget', () => {
    const long = Array.from({ length: 20 }, (_, index) =>
      task(`task-${index + 1}`, `Requirement number ${index + 1} with a\n  multi-line subject`))
    const rendered = renderWorkSet(long, 200)
    expect(byteLength(rendered)).toBeLessThanOrEqual(200)
    expect(rendered).toContain('…(+')
    expect(rendered).toContain('more)')
    expect(rendered).not.toContain('\n  ')
    // Every rendered line is a whole task line, never a fragment.
    for (const line of rendered.split('\n').slice(1, -1)) expect(line).toMatch(/^- task-\d+ \[pending\] /u)
  })

  it('installs one bounded section per agent rendering that agent session board', async () => {
    const { ctx, board, session } = await boardHarness({ maxContextBytes: 500 })
    board.create(session, { subject: 'Review-gate requirement' })
    const scopeKey: object = {}
    const scope = createScope(ctx, scopeKey)
    expect(scopeOf(scope.ctx)).toBe(scopeKey)
    ctx.emit('agent/created', { agent: fakeAgent(session, 'workset-agent', scope.ctx), source: 'startup' })
    // The injected section registers when the child fiber activates (one microtask later).
    await flushScheduler()

    const assembly = await ctx.systemPrompt.assemble({ scope: scopeKey })
    const section = assembly.sections.find(entry => entry.name === WORK_SET_SECTION)
    expect(section?.text).toBe(`${WORK_SET_HEADER}\n- task-1 [pending] Review-gate requirement`)
    expect(section?.interpolate).toBe(false)

    // The section re-reads the board at assembly time, so mutations show up live.
    board.update(session, 'task-1', { status: 'in_progress' }, 1)
    const later = await ctx.systemPrompt.assemble({ scope: scopeKey })
    expect(later.sections.find(entry => entry.name === WORK_SET_SECTION)?.text)
      .toBe(`${WORK_SET_HEADER}\n- task-1 [in_progress] Review-gate requirement`)

    expect(workSetTasks(board.boardOf(session)).map(entry => entry.id)).toEqual(['task-1'])
    await scope.dispose()
  })
})

describe('auto-close', () => {
  it('completes in-progress tasks only when a configured signal appears in a successful result', async () => {
    const harness = await boardHarness()
    const { ctx, board, session } = harness
    const started = board.create(session, { subject: 'Run the tests' })
    board.update(session, started.id, { status: 'in_progress' }, started.revision)
    const untouched = board.create(session, { subject: 'Never started' })

    ctx.tools.register(renderedResultTool('quiet_runner', 'all good'))
    await runTool(harness, 'quiet_runner', {})
    expect(board.get(session, started.id)?.status).toBe('in_progress')

    ctx.tools.register(renderedResultTool('real_runner', 'ok — test-passed (12 assertions)'))
    await runTool(harness, 'real_runner', {})

    expect(board.get(session, started.id)).toMatchObject({ status: 'completed', inContext: false, revision: 3 })
    // Conservative: a task nobody started stays for the user to confirm.
    expect(board.get(session, untouched.id)?.status).toBe('pending')
    expect(workSetTasks(board.boardOf(session)).map(entry => entry.id)).toEqual([untouched.id])
  })

  it('ignores a failed result and an empty signal list', async () => {
    const failing = await boardHarness()
    const started = failing.board.create(failing.session, { subject: 'Fail the tests' })
    failing.board.update(failing.session, started.id, { status: 'in_progress' }, started.revision)
    failing.ctx.tools.register(defineTool({
      name: 'failing_runner',
      description: 'test double: renders the signal but fails',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: 'test-passed' }],
      },
      execute: async () => {
        throw new Error('executable not found')
      },
    }))
    await runTool(failing, 'failing_runner', {})
    expect(failing.board.get(failing.session, started.id)?.status).toBe('in_progress')

    const disabled = await boardHarness({ autoCloseSignals: [] })
    const open = disabled.board.create(disabled.session, { subject: 'No auto-close configured' })
    disabled.board.update(disabled.session, open.id, { status: 'in_progress' }, open.revision)
    disabled.ctx.tools.register(renderedResultTool('passing_runner', 'test-passed'))
    await runTool(disabled, 'passing_runner', {})
    expect(disabled.board.get(disabled.session, open.id)?.status).toBe('in_progress')
  })
})

describe('coordinator tools', () => {
  it('drives the whole board through the registered tool names', async () => {
    const harness = await boardHarness()
    const { board, session } = harness

    const created = await runTool(harness, 'task_new', { subject: 'Draft the design spec' })
    expect(created.isError).toBe(false)
    expect(resultText(created)).toContain('Created task-1 (pending, in work set) at revision 1')

    const listed = await runTool(harness, 'task_list', {})
    expect(resultText(listed)).toBe('task-1 [pending] rev 1 ★ — Draft the design spec')

    const updated = await runTool(harness, 'task_update', {
      id: 'task-1',
      patch: { status: 'in_progress', findings: [{ severity: 'P0', summary: 'Unsigned log entry', sourceRound: 1 }] },
      revision: 1,
    })
    expect(updated.isError).toBe(false)
    expect(board.get(session, 'task-1')).toMatchObject({
      status: 'in_progress',
      revision: 2,
      findings: [{ severity: 'P0', summary: 'Unsigned log entry', sourceRound: 1 }],
    })

    const conflict = await runTool(harness, 'task_update', { id: 'task-1', patch: { status: 'completed' }, revision: 1 })
    expect(conflict.isError).toBe(true)
    expect(resultText(conflict)).toContain('is at revision 2, not 1')

    const closed = await runTool(harness, 'task_close', { id: 'task-1', reason: 'superseded' })
    expect(closed.isError).toBe(false)
    expect(board.get(session, 'task-1')).toMatchObject({ status: 'closed', inContext: false, revision: 3 })

    const reopened = await runTool(harness, 'task_reopen', { id: 'task-1' })
    expect(reopened.isError).toBe(false)
    expect(board.get(session, 'task-1')).toMatchObject({ status: 'pending', inContext: true, revision: 4 })
  })

  it('rejects an invalid argument and an empty patch', async () => {
    const harness = await boardHarness()
    const missingSubject = await runTool(harness, 'task_new', {})
    expect(missingSubject.isError).toBe(true)
    expect(resultText(missingSubject)).toContain('subject')

    await runTool(harness, 'task_new', { subject: 'Real task' })
    const emptyPatch = await runTool(harness, 'task_update', { id: 'task-1', patch: {} })
    expect(emptyPatch.isError).toBe(true)
    expect(resultText(emptyPatch)).toContain('non-empty patch')
  })

  it('refuses a blank subject and a tool call with no agent session', async () => {
    const { ctx, board, session } = await boardHarness()
    expect(() => board.create(session, { subject: '   ' })).toThrow(/non-empty string/)
    const anonymous = await ctx.tools.execute({
      callId: ToolCallId('call-anon'),
      name: 'task_list',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(anonymous.isError).toBe(true)
    expect(resultText(anonymous)).toContain('no agent session')
  })
})

describe('config', () => {
  it('materializes the design defaults (maxContextBytes 2000, test-passed)', async () => {
    const { board } = await boardHarness()
    expect(board.config).toEqual({ maxContextBytes: 2000, autoCloseSignals: ['test-passed'] })
  })

  it('fails loud on a bad knob instead of silently ignoring it', async () => {
    await expect(boardHarness({ maxContextBytes: -1 })).rejects.toThrow(/maxContextBytes/)
    await expect(boardHarness({ autoCloseSignals: [''] })).rejects.toThrow(/autoCloseSignals/)
  })
})

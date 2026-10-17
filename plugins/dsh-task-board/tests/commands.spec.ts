/**
 * dsh-task-board `/task` + browser-node specs: the command bridge the Web
 * task-board panel's rows drive, and the client ConversationNode fold against
 * the host projection.
 */

import { describe, expect, it } from 'vitest'
import type {
  ConversationMatch, ConversationNodeContext, ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TASK_BOARD_NODE_ID, TASK_BOARD_NODE_KIND, taskBoardDefinition } from '../client/src/definition.ts'
import { TASK_USAGE, taskCommandHandler, type TaskCommandInvocation } from '../src/commands.ts'
import type { TaskBoardState } from '../src/types.ts'
import { boardHarness, fakeAgent, type BoardHarness } from './harness.ts'

/** One `/task` invocation from an arbitrary (non-model) UI session. */
function invocation(harness: BoardHarness, rawInput: string): TaskCommandInvocation {
  return { rawInput, agent: fakeAgent(harness.session, 'panel-user') }
}

/** Replay the session log through the browser Definition, as the client assembler does. */
function foldThroughClientDefinition(harness: BoardHarness): TaskBoardState {
  const emptyContext = {} as ConversationNodeContext<TaskBoardState>
  const reader = { previous: () => undefined }
  let state: TaskBoardState | undefined
  let started = false
  for (const event of harness.session.snapshotEvents()) {
    const match = taskBoardDefinition.match(event)
    if (match === null) continue
    if (!started) {
      started = true
      const start = { event, role: 'start', location: { kind: 'session' } } as unknown as ConversationStartMatch
      state = taskBoardDefinition.start(emptyContext, start, reader)
      continue
    }
    const update = { event, role: match.role, location: { kind: 'session' } } as unknown as ConversationMatch
    state = taskBoardDefinition.update({ ...emptyContext, state: state as TaskBoardState }, update)
  }
  return state ?? []
}

describe('/task command', () => {
  it('lists the ledger with its work-set markers', async () => {
    const harness = await boardHarness()
    expect(taskCommandHandler(harness.board, invocation(harness, 'list'))).toEqual({
      kind: 'success',
      text: 'task board: no tasks',
    })

    harness.board.create(harness.session, { subject: 'Wire the panel' })
    harness.board.create(harness.session, { subject: 'Parked idea', inContext: false })
    const listed = taskCommandHandler(harness.board, invocation(harness, ' list '))
    expect(listed).toEqual({
      kind: 'success',
      text: '[x] task-1 pending — Wire the panel\n[ ] task-2 pending — Parked idea',
    })
  })

  it('closes and reopens a task through the service (durable events, not a side channel)', async () => {
    const harness = await boardHarness()
    harness.board.create(harness.session, { subject: 'Close me' })

    expect(taskCommandHandler(harness.board, invocation(harness, 'close task-1'))).toEqual({
      kind: 'success',
      text: 'task-1 closed.',
    })
    expect(harness.board.get(harness.session, 'task-1')).toMatchObject({ status: 'closed', inContext: false })
    expect(harness.session.snapshotEvents().map(event => event.type)).toContain('task/closed')

    expect(taskCommandHandler(harness.board, invocation(harness, 'reopen task-1'))).toEqual({
      kind: 'success',
      text: 'task-1 reopened.',
    })
    expect(harness.board.get(harness.session, 'task-1')).toMatchObject({ status: 'pending', inContext: true })
  })

  it('moves a task in and out of the work set', async () => {
    const harness = await boardHarness()
    harness.board.create(harness.session, { subject: 'Focus me' })

    expect(taskCommandHandler(harness.board, invocation(harness, 'unfocus task-1'))).toEqual({
      kind: 'success',
      text: 'task-1 removed from the work set.',
    })
    expect(harness.board.get(harness.session, 'task-1')?.inContext).toBe(false)

    expect(taskCommandHandler(harness.board, invocation(harness, 'focus task-1'))).toEqual({
      kind: 'success',
      text: 'task-1 added to the work set.',
    })
    expect(harness.board.get(harness.session, 'task-1')?.inContext).toBe(true)
    expect(harness.board.renderWorkSet(harness.session)).toContain('Focus me')
  })

  it('reports an unknown id and an unknown verb as errors instead of throwing', async () => {
    const harness = await boardHarness()
    const missing = taskCommandHandler(harness.board, invocation(harness, 'close task-9'))
    expect(missing.kind).toBe('error')
    expect(missing.text).toContain('task-9')

    expect(taskCommandHandler(harness.board, invocation(harness, 'nope'))).toEqual({ kind: 'error', text: TASK_USAGE })
    expect(taskCommandHandler(harness.board, invocation(harness, 'close'))).toEqual({ kind: 'error', text: TASK_USAGE })
  })
})

describe('browser node definition', () => {
  it('folds the durable log into exactly the board the host projection publishes', async () => {
    const harness = await boardHarness()
    harness.board.create(harness.session, { subject: 'Alpha' })
    harness.board.create(harness.session, { subject: 'Beta' })
    harness.board.close(harness.session, 'task-2')
    harness.board.update(harness.session, 'task-1', { status: 'in_progress', reviewRound: 2 })
    harness.board.update(harness.session, 'task-1', { inContext: false })

    expect(foldThroughClientDefinition(harness)).toEqual(harness.board.list(harness.session))
  })

  it('anchors one singleton board panel at the first task event and is inert elsewhere', async () => {
    const harness = await boardHarness()
    harness.board.create(harness.session, { subject: 'Only task' })
    const events = harness.session.snapshotEvents()

    expect(taskBoardDefinition.kind).toBe(TASK_BOARD_NODE_KIND)
    expect(taskBoardDefinition.target).toBe('chat')
    expect(events.every(event => {
      const match = taskBoardDefinition.match(event)
      return event.type.startsWith('task/') ? match?.id === TASK_BOARD_NODE_ID : match === null
    })).toBe(true)

    expect(taskBoardDefinition.buildViewNode({
      key: 'chat/task-board/board',
      kind: TASK_BOARD_NODE_KIND,
      id: TASK_BOARD_NODE_ID,
      matches: [],
      start: undefined,
      state: undefined,
      current: new Map(),
    })).toMatchObject({
      kind: TASK_BOARD_NODE_KIND,
      id: TASK_BOARD_NODE_ID,
      target: 'chat',
      // Session location keeps the panel out of the completed turn's process
      // disclosure (ui-chat hides non-independent turn/step nodes there).
      location: { kind: 'session' },
      visibility: 'visible',
      data: { tasks: [] },
    })
  })
})

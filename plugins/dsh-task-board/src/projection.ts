/**
 * The `taskBoard` projection unit: a pure whole-value fold over the durable
 * `task/*` events (the projection seam's whole-value rule — every event
 * carries the complete post-change {@link TaskSnapshot}), plus the pure board
 * queries the service and the work-set renderer share.
 *
 * @module @dsh-plugin/dsh-task-board/projection
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  FINDING_SEVERITIES,
  TASK_STATUSES,
  type TaskBoardState,
  type TaskId,
  type TaskSnapshot,
  type TaskStatus,
} from './types.ts'

/** Projection key owned by this unit. */
export const TASK_BOARD_KEY = 'taskBoard'

/** Prefix of every minted task id. */
export const TASK_ID_PREFIX = 'task-'

const findingSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  summary: z.string(),
  sourceRound: z.number().int().nonnegative(),
}).strict()

const taskSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  subject: z.string(),
  status: z.enum(TASK_STATUSES),
  owner: z.string().optional(),
  reviewRound: z.number().int().nonnegative(),
  findings: z.array(findingSchema),
  filteredFindings: z.array(findingSchema),
  inContext: z.boolean(),
}).strict()

/**
 * Persisted-board schema. The `as` is only for `owner`/`id`: zod validates the
 * wire-JSON strings and the brands are compile-time refinements with no
 * runtime representation.
 */
export const taskBoardStateSchema = z.array(taskSchema) as unknown as ZodType<TaskBoardState>

/** The empty board (the fold's `init`). */
export const EMPTY_TASK_BOARD: TaskBoardState = []

/** Whether a status is terminal: no further work is expected and it leaves the work set. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'closed' || status === 'deleted'
}

/** Replace one task by id, or append it when new (board order = creation order). */
export function upsertTask(state: TaskBoardState, task: TaskSnapshot): TaskBoardState {
  const index = state.findIndex(entry => entry.id === task.id)
  if (index < 0) return [...state, task]
  const next = state.slice()
  next[index] = task
  return next
}

/** Board members a caller may act on: tombstones (`deleted`) are hidden, `closed` stays visible. */
export function visibleTasks(state: TaskBoardState): readonly TaskSnapshot[] {
  return state.filter(task => task.status !== 'deleted')
}

/** Whether a task is an active work-set member: in context and not terminal. */
export function isWorkSetMember(task: TaskSnapshot): boolean {
  return task.inContext && !isTerminalStatus(task.status)
}

/** Work set members: the tasks whose subjects the prompt section renders. */
export function workSetTasks(state: TaskBoardState): readonly TaskSnapshot[] {
  return state.filter(isWorkSetMember)
}

/** One task by id, tombstones included (so `task_reopen`/CAS find closed tasks). */
export function findTask(state: TaskBoardState, id: TaskId): TaskSnapshot | undefined {
  return state.find(task => task.id === id)
}

/** Mint the next session-local id: one past the highest `task-<n>` ever recorded. */
export function nextTaskId(state: TaskBoardState): TaskId {
  let highest = 0
  for (const task of state) {
    if (!task.id.startsWith(TASK_ID_PREFIX)) continue
    const parsed = Number(task.id.slice(TASK_ID_PREFIX.length))
    if (Number.isSafeInteger(parsed) && parsed > highest) highest = parsed
  }
  return `${TASK_ID_PREFIX}${highest + 1}`
}

/**
 * Fold one committed event. Unrelated events return the same reference, so the
 * registry's `Object.is` gate skips them.
 */
export function applyTaskEvent(state: TaskBoardState, event: SessionEvent): TaskBoardState {
  switch (event.type) {
    case 'task/new':
    case 'task/update':
    case 'task/closed':
    case 'task/reopened':
      return upsertTask(state, event.data.task)
    default:
      return state
  }
}

/** Read-side view: the client sees the board without deletion tombstones. */
export function viewTaskBoard(state: TaskBoardState): TaskBoardState {
  return visibleTasks(state)
}

/** The registered `taskBoard` unit (exported for the unit spec). */
export const taskBoardProjection = {
  key: TASK_BOARD_KEY,
  stateSchema: taskBoardStateSchema,
  init: () => EMPTY_TASK_BOARD,
  apply: applyTaskEvent,
  wire: { viewSchema: taskBoardStateSchema, view: viewTaskBoard },
  stateVersion: 1,
} satisfies ProjectionDefinition<'taskBoard'>

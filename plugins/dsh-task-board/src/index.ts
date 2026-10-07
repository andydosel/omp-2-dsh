/**
 * dsh-task-board: the persistent requirement-level task ledger plus the
 * attention work set for the coordinator suite
 * (`DESIGN-COORDINATOR-SUITE-V1.0.md` §5.2 / §13.3).
 *
 * - durable events: `task/new`, `task/update` (whole-value, revision CAS),
 *   `task/closed`, `task/reopened` — all replayable, tombstones included
 * - projection: `taskBoard` (whole-value fold over `task/*`, client wire view
 *   without `deleted` tombstones)
 * - tools: `task_new` / `task_update` / `task_close` / `task_reopen` /
 *   `task_list` (coordinator scope; granted by a role layer's
 *   `tools.restrict({ allow: [...] })`)
 * - service: `ctx.taskBoard` (`create/update/close/reopen/list/get/complete`,
 *   `boardOf`, `renderWorkSet`) — the orchestrator's zero-P0 loop writes its
 *   findings and rounds here
 * - work set: one `systemPrompt.section` per agent rendering the `inContext`
 *   task subjects, bounded by `maxContextBytes`
 * - auto-close: a `tools/result` observer completes `in_progress` tasks only
 *   when the result carries a configured completion signal (`autoCloseSignals`)
 * - user surface: `/task list|close|reopen|focus|unfocus` (the Web task-board
 *   panel's action channel, `src/commands.ts`)
 * - Web UI: the browser half (`client/src/`) registers the `task-board`
 *   ConversationNode — the work set plus the full ledger, per-row close/reopen
 *   and a work-set checkbox, reading `taskBoard` through `useProjection` and
 *   writing back through `ctx.remote.commands`
 *
 * The board is per session and independent of `dsh-org`: a coordinator uses
 * it whether or not any lead exists.
 *
 * @module @dsh-plugin/dsh-task-board
 */

import { TaskBoardService } from './service.ts'

export const name = 'dsh-task-board'

export default TaskBoardService
export { TaskBoardService }
export {
  DEFAULT_AUTO_CLOSE_SIGNALS,
  DEFAULT_MAX_CONTEXT_BYTES,
  TaskNotFoundError,
  TaskRevisionConflictError,
  matchesAutoCloseSignal,
  resolveTaskBoardConfig,
} from './service.ts'
export type { CreateTaskInput, ResolvedTaskBoardConfig, TaskBoardConfig, TaskBoardHost } from './service.ts'

export { TASK_TOOLS, defineTaskTools } from './tools.ts'

export { TASK_USAGE, registerTaskCommands, taskCommandHandler } from './commands.ts'
export type { TaskCommandInvocation } from './commands.ts'

export {
  EMPTY_TASK_BOARD,
  TASK_BOARD_KEY,
  TASK_ID_PREFIX,
  applyTaskEvent,
  findTask,
  isTerminalStatus,
  isWorkSetMember,
  nextTaskId,
  taskBoardProjection,
  taskBoardStateSchema,
  upsertTask,
  viewTaskBoard,
  visibleTasks,
  workSetTasks,
} from './projection.ts'

export { WORK_SET_HEADER, WORK_SET_ORDER, WORK_SET_SECTION, renderWorkSet } from './workset.ts'

export { FINDING_SEVERITIES, TASK_STATUSES } from './types.ts'

// The `task/*` SessionEventMap merge and the `taskBoard` projection merges live
// in src/types.ts (their one home); this re-export keeps the module edge in the
// emitted index.d.ts, so aggregate programs consuming the declarations still
// receive them.
export type * from './types.ts'

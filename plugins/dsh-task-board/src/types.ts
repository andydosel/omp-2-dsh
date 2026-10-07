/**
 * Task-board domain vocabulary: the durable `task/*` session events, the
 * `taskBoard` session projection (host fold state + client wire value), and
 * the requirement-level {@link TaskSnapshot} the coordinator suite shares
 * (`DESIGN-COORDINATOR-SUITE-V1.0.md` §5.2 / §13.3).
 *
 * Everything here is declaration-only so the merges reach every consumer's
 * emitted `.d.ts` (see the `export type *` in `index.ts`).
 *
 * @module @dsh-plugin/dsh-task-board/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Session-local task id, `task-<n>` (n strictly increasing within the owning
 * session's log). Ids are minted by the board, never chosen by a caller.
 */
export type TaskId = string

/** Every task life-cycle state (§13.3). Terminal states leave the work set. */
export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'awaiting_approval',
  'completed',
  'closed',
  'deleted',
] as const

/** One task life-cycle state. */
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Finding grades of the requirement-review loop (§5.7), most severe first. */
export const FINDING_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const

/** One finding grade. */
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

/** One review finding carried on a task (accumulated as a cross-round union). */
export interface Finding {
  /** Grade assigned by the reviewer/lead. */
  readonly severity: FindingSeverity
  /** One-line, actionable statement of the defect. */
  readonly summary: string
  /** Review round the finding came from (`0` outside a review loop). */
  readonly sourceRound: number
}

/** One requirement-level task: a unit of work the user handed to a coordinator. */
export interface TaskSnapshot {
  /** Session-local id, `task-<n>`. */
  readonly id: TaskId
  /** Compare-and-set counter: starts at 1, `+1` per accepted mutation. */
  readonly revision: number
  /** Requirement-level description (one requirement = one task). */
  readonly subject: string
  /** Life-cycle state. */
  readonly status: TaskStatus
  /** The session accountable for the task, when one was assigned. */
  readonly owner?: SessionId
  /** Number of review rounds this task went through. */
  readonly reviewRound: number
  /** Cross-round union of findings. */
  readonly findings: readonly Finding[]
  /** Findings the lead filtered out as false positives (kept for auditability). */
  readonly filteredFindings: readonly Finding[]
  /** Work set membership: `true` renders this task's subject into the prompt. */
  readonly inContext: boolean
}

/** Whole folded board: every task the session ever created, tombstones included. */
export type TaskBoardState = readonly TaskSnapshot[]

/**
 * Caller-supplied mutation of one task. Absent members keep their current
 * value; `owner` accepts the raw string form so callers coming from JSON
 * (tools, other plugins) do not need the {@link SessionId} brand.
 */
export interface TaskPatch {
  readonly subject?: string
  readonly status?: TaskStatus
  readonly owner?: SessionId | string
  readonly reviewRound?: number
  readonly findings?: readonly Finding[]
  readonly filteredFindings?: readonly Finding[]
  readonly inContext?: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A requirement-level task entered the board (revision 1, `inContext:
     * true`). Carries the complete task, per the projection whole-value rule,
     * so replay never has to reconstruct a delta.
     */
    'task/new': { task: TaskSnapshot }
    /**
     * A task changed: any field, including `status`, plus the compare-and-set
     * `revision` the producer validated. Carries the complete post-change
     * task.
     */
    'task/update': { task: TaskSnapshot }
    /**
     * A task was closed by the user/coordinator. The task stays in the log and
     * on the board as a tombstone (status `closed`, out of the work set) and
     * can be replayed; `task/reopened` restores it.
     */
    'task/closed': { task: TaskSnapshot; reason?: string }
    /** A closed (or otherwise terminal) task was reopened: status `pending`, back in the work set. */
    'task/reopened': { task: TaskSnapshot }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host fold of the board: every task, tombstones included. */
    taskBoard: TaskBoardState
  }

  interface SessionProjectionMap {
    /** Client-visible board: tombstones (`deleted`) filtered out. */
    taskBoard: TaskBoardState
  }
}

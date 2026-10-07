/**
 * Shared orchestrator vocabulary: the plugin's own message-source kind and the
 * wire shapes its tools return.
 *
 * The source kind lives in its ONE home here (0.2.0-rc.2 removed the shared
 * wildcard `{ kind: 'plugin' }` vocabulary: each producer declares its own
 * `kind` in its own module), and `index.ts` re-exports this file so aggregate
 * programs consuming the plugin's declarations still receive the merge.
 *
 * @module @dsh-plugin/dsh-orchestrator/types
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SubTaskOutcome } from './dispatch.ts'
import type { LoopSnapshot, RoundRecord } from './loop.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Orchestrator-authored delivery: the reviewer brief handed to one clean
     * reviewer, and a sub-task's routed prompt. `relay` marks content this
     * plugin forwards on another party's behalf rather than composing itself.
     */
    'dsh-orchestrator': { kind: 'dsh-orchestrator' } & ContextFormed
  }
}

/** One `subtask_parallel` result row, in request order. */
export interface SubTaskResult {
  /** Zero-based index into the requested `tasks` array. */
  readonly taskIndex: number
  readonly value: SubTaskOutcome
}

/** One review-round result: what the round did and where the loop now stands. */
export interface RoundResult {
  /** The round's own record (dispatched/completed/failures/raised/counts/verdict). */
  readonly record: RoundRecord
  /** The loop after this round. */
  readonly loop: LoopSnapshot
  /** Per-reviewer outcomes, in dispatch order. */
  readonly results: readonly SubTaskResult[]
}

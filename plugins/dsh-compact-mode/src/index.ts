/**
 * dsh-compact-mode: shake-first local elision backend for `ctx.compaction`
 * with a plan-style compact mode and a review tree.
 *
 * Profile wiring (third layer):
 * ```yaml
 * - id: compaction-basic
 *   disabled: true
 * - id: command-compact
 *   disabled: true
 * - insert:
 *     - id: compact-mode
 *       name: '@dsh-plugin/dsh-compact-mode'
 *       config: {}
 * ```
 *
 * @module @dsh-plugin/dsh-compact-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-token-meter'
import { CompactModeEngine } from './engine.ts'
import { registerCompactCommands } from './commands.ts'
import type { CompactModeConfig } from './config.ts'

/**
 * Producer-declared message source for this plugin's injected notices and
 * recall placeholders. The `plugin` catch-all kind was removed in dsh
 * 0.2.0-rc.2; every producer declares its own kind in its own module.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-compact-mode': { kind: 'dsh-compact-mode' } & ContextFormed
  }
}

export { CompactModeEngine } from './engine.ts'
export { CompactModeController, hasOpenTurn } from './mode.ts'
export { resolveConfig, CompactModeConfigSchema } from './config.ts'
export type { CompactModeConfig, ResolvedConfig } from './config.ts'
export { ReviewCoordinator } from './review.ts'
export type { ReviewState } from './review.ts'
export {
  createReviewTree,
  deleteReviewTree,
  emptySerialized,
  reviewTreeDomainSpec,
  resolveTreeStorage,
} from './tree.ts'
export type { ResolvedTreeStorage, ReviewNodeContent, ReviewTreeHandle, ReviewTreeRoute } from './tree.ts'
export {
  assertNoActiveCompaction,
  buildSummarizationInput,
  buildCheckpointMessage,
  commitSummaryAndCheckpoint,
  frameSummary,
  inspectCompactionEntryState,
  selectCompactableRange,
  summarizeWithLlm,
  reviseWithLlm,
  validateSurfaceRegion,
} from './reuse.ts'
export type { SummarizationInput, SummaryResult, SummaryCallConfig } from './reuse.ts'
export { shakeSession } from './shake.ts'
export { simpleDiff } from './commands.ts'

/**
 * The plugin entry: `ctx.plugin(CompactModeEngine, config)` provides
 * `ctx.compaction` (the compact-mode backend) and `ctx.compactMode` (mode
 * controller), and registers the `/compact*` commands through the optional
 * command child.
 *
 * The class constructor wires everything; the static `inject`/`Config`
 * metadata drives plugin loading.
 */
export class CompactModePlugin extends CompactModeEngine {
  constructor(ctx: Context, config?: CompactModeConfig) {
    super(ctx, config)
    registerCompactCommands(ctx, this)
  }
}

export default CompactModePlugin

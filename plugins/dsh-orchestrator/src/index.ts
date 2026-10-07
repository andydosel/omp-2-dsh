/**
 * `@dsh-plugin/dsh-orchestrator` — the coordinator suite's review loop and
 * recursive fan-out (DESIGN-COORDINATOR-SUITE-V1.0.md §5.5, §5.7, §13.5).
 *
 * Two halves, one spawn base:
 *
 * 1. `subtask_parallel` — the explicit recursive fan-out tool (N independent
 *    sub-tasks, one concurrent batch, unified collection, failure isolation)
 *    behind the three deployment gates. Workers ride the shared
 *    `@dsh-plugin/dsh-worker-spawn` base; clean reviewers ride the advisor's
 *    shared `composeReviewer` helper.
 * 2. The review loop — a customized goal (`ctx.goals` + the goal round driver)
 *    carried by a DISPOSABLE review-work subagent, never by the coordinator's
 *    own session. Each round dispatches fresh one-shot clean reviewers; the
 *    loop decides on a numeric count (`zeroP0Approach: 'count'`), never on a
 *    model's feeling. Two exits: zero P0 → implement & verify → complete +
 *    report; a human decision → `goal.block` → wait → `goal.resume`.
 *
 * Composition note: `ctx.goals` hard-depends on `sessionProjections`, and
 * `token-meter` declares the same injection, so `session-projection` and
 * `token-meter` must stay mounted TOGETHER in the profile this plugin is added
 * to (both are dsh-base rows; `profiles/main/cordis.patch.yml` documents the
 * invariant). This plugin declares `goals` in its own inject list, so a
 * composition missing the projection service leaves it inert instead of
 * failing halfway.
 *
 * @module @dsh-plugin/dsh-orchestrator
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { resolveConfig, type OrchestratorConfig, type ResolvedOrchestratorConfig } from './config.ts'
import { OrchestratorRuntime } from './runtime.ts'
import type { OrchestratorStatus } from './runtime.ts'
import { defineOrchestratorTools } from './tools.ts'

export { resolveConfig, Config } from './config.ts'
export type { OrchestratorConfig, ResolvedOrchestratorConfig, FanOutConfig, ZeroP0Approach } from './config.ts'
export { planFanOut, isSubTaskRole, isSubTaskTier } from './fanout.ts'
export type {
  FanOutBounds,
  FanOutContext,
  FanOutPlan,
  FanOutRefusal,
  FanOutRefusalCode,
  FanOutRequest,
  FanOutTaskSpec,
  NormalizedSubTask,
  SubTaskRole,
  SubTaskTier,
} from './fanout.ts'
export {
  SEVERITIES,
  countSeverities,
  estimateTokens,
  findingKey,
  isSeverity,
  mergeFindings,
  parseReviewerReport,
  partitionFindings,
  renderFinding,
  tally,
} from './findings.ts'
export type { Finding, RawFinding, ReviewTally, Severity, SeverityCounts } from './findings.ts'
export { ReviewLoop } from './loop.ts'
export type {
  DispatchReport,
  FilteredFinding,
  LoopBlockReason,
  LoopInit,
  LoopSnapshot,
  LoopStatus,
  RejectionRequest,
  RoundInput,
  RoundRecord,
} from './loop.ts'
export { createDispatcher } from './dispatch.ts'
export type { DispatcherOptions, SubTaskDispatcher, SubTaskOutcome, SubTaskRequest } from './dispatch.ts'
export {
  renderCompletionReport,
  renderLoopMethodology,
  renderReviewerBrief,
  renderReviewerRole,
  renderSeverityLegend,
} from './briefs.ts'
export { OrchestratorRuntime } from './runtime.ts'
export type {
  LoopExitResult,
  LoopStartResult,
  LoopSummary,
  OrchestratorStatus,
} from './runtime.ts'
export { defineOrchestratorTools } from './tools.ts'

// The plugin's own message-source kind lives in src/types.ts (its ONE home);
// this re-export keeps the module edge in the emitted index.d.ts, so aggregate
// programs consuming the declarations still receive the merge.
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    orchestrator: OrchestratorService
  }
}

/**
 * The orchestrator plugin entry (cordis Service class). Registers the eight
 * model-facing tools on the plugin's context and exposes the runtime as
 * `ctx.orchestrator` for programmatic access (the sibling plugins read the
 * loop status through it).
 */
export class OrchestratorService extends Service {
  static inject = ['agents', 'goals', 'subagents', 'tools'] as const

  readonly runtime: OrchestratorRuntime
  readonly resolved: ResolvedOrchestratorConfig

  constructor(ctx: Context, config: OrchestratorConfig = {}) {
    super(ctx, 'orchestrator')
    this.resolved = resolveConfig(config)
    this.runtime = new OrchestratorRuntime(ctx, this.resolved)
    for (const tool of defineOrchestratorTools(this.runtime)) {
      ctx.tools.register(tool)
    }
    ctx.logger.info(
      'dsh-orchestrator: ready (reviewersPerRound=%d, reviewerTools=%s, zeroP0Approach=%s, fanOut=%o)',
      this.resolved.reviewersPerRound,
      this.resolved.reviewerTools.join(','),
      this.resolved.zeroP0Approach,
      this.resolved.fanOut,
    )
    ctx.effect(() => () => {
      this.runtime.dispose()
    }, 'dsh-orchestrator: sub-task dispatchers')
  }

  /** The plugin's observable value (loops, bounds, live dispatcher count). */
  status(): OrchestratorStatus {
    return this.runtime.status()
  }
}

export default OrchestratorService

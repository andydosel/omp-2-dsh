/**
 * dsh-advisor: optional reviewer model(s) attached to a session. Ports omp's
 * advisor subsystem: reviewers are full agents with their own loop, fed
 * primary-transcript deltas and restricted to read/grep/glob (plus a scoped
 * `advise` tool); severity-graded advice (nit = aside, concern = steer,
 * blocker = steer) is delivered to the primary agent with an emission guard,
 * an immuneTurns budget, and reset on compaction/rewrite/fork/resume.
 *
 * @module @dsh-plugin/dsh-advisor
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { AdvisorRuntime } from './advisor.ts'
import { registerAdvisorCommands } from './commands.ts'
import { resolveConfig, type AdvisorConfig, type ResolvedAdvisorConfig } from './config.ts'

export { AdvisorRuntime } from './advisor.ts'
export type { ReviewerHandle, ReviewerSpec, AdvisorPhase } from './advisor.ts'
export { ROLE_SECTION } from './advisor.ts'
export { EmissionGuard, normalizeNote, isEmptyPhrase, DEFAULT_DEDUPE_LIMIT } from './emission-guard.ts'
export type { GuardedEmission, GuardRejectionReason } from './emission-guard.ts'
export { decideDelivery, DeliveryController, advisoryMessage, renderAdvisory, readPrimaryState, ADVISOR_PLUGIN } from './delivery.ts'
export type { DeliveryDecision, DeliveryChannel, PrimaryState, QueuedSteer, DeliveryControllerOptions } from './delivery.ts'
export { DeltaObserver, serializeDelta, estimateTokens } from './delta.ts'
export type { DeltaBatch, SerializedDelta, FeedKind, OwnMessagePredicate } from './delta.ts'
export { defineAdviseTool, ADVISE_TOOL } from './advise-tool.ts'
export type { AdviseArgs, AdviseValue } from './advise-tool.ts'
export { isSeverity, isInterrupting, SEVERITIES } from './severity.ts'
export type { Severity } from './severity.ts'
export { discoverWatchdog, parseWatchdogYml, renderWatchdogGuidance, WATCHDOG_MD, WATCHDOG_YML, MAX_WATCHDOG_BYTES, nodeWatchdogFileSystem } from './watchdog.ts'
export type { WatchdogSource, WatchdogRoster, WatchdogRosterEntry, WatchdogMdFile, WatchdogDiscoveryOptions, WatchdogFileSystem } from './watchdog.ts'
export { resolveConfig, Config } from './config.ts'
export type { AdvisorConfig, ResolvedAdvisorConfig, AdvisorWatchdogConfig } from './config.ts'
export { advisorCommandHandler, registerAdvisorCommands } from './commands.ts'

// The `advisor/status` SessionEventMap merge lives in src/types.ts (its one
// home); this re-export keeps the module edge in the emitted index.d.ts, so
// aggregate programs consuming the declarations still receive the merge.
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    advisor: AdvisorController
  }
}

/**
 * The advisor plugin entry (cordis Service class). Attaches the runtime and
 * registers `/advisor` on load; reviewers start once a primary agent exists.
 */
export class AdvisorController extends Service {
  static inject = ['agents'] as const

  readonly runtime: AdvisorRuntime

  constructor(ctx: Context, config: AdvisorConfig = {}) {
    super(ctx, 'advisor')
    const resolved: ResolvedAdvisorConfig = resolveConfig(config)
    this.runtime = new AdvisorRuntime(ctx, resolved)
    this.runtime.attach()
    registerAdvisorCommands(ctx, this.runtime)
  }
}

export default AdvisorController

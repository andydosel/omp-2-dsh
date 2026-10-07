/**
 * The compact-mode compaction backend: shake-first local elision plus a
 * plan-style review flow, replacing `dsh-compaction-basic` as `ctx.compaction`.
 *
 * Implemented from scratch (subclassing `BasicCompactionEngine` is blocked by
 * its strict config key validation and private listeners). Reuses the
 * compaction-basic *library* algorithms via local ports (see reuse.ts — the
 * published `@next` build does not export the helper functions).
 *
 * Listeners (mirror compaction-basic):
 * - `agent/pre-step` pressure → `compactIfNeeded`; while a review is active,
 *   the same listener captures claimed user messages and rejects the step.
 * - `agent/request-error` context overflow → shake, then prompt.
 *
 * @module @dsh-plugin/dsh-compact-mode/engine
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { CompactionEngine, CompactionId, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { CompactModeConfig, ResolvedConfig } from './config.ts'
import { CompactModeConfigSchema, resolveConfig } from './config.ts'
import { CompactModeController } from './mode.ts'
import { ReviewCoordinator } from './review.ts'
import {
  assertNoActiveCompaction,
  buildCheckpointMessage,
  buildSummarizationInput,
  commitSummaryAndCheckpoint,
  frameSummary,
  inspectCompactionEntryState,
  summarizeWithLlm,
  validateSurfaceRegion,
} from './reuse.ts'
import { shakeSession } from './shake.ts'

/** Prompt-state bookkeeping per session (cooldown per threshold kind). */
interface PromptState {
  thresholdAt: number
  overflowAt: number
}

/**
 * Compact-mode compaction engine. Load one per context as `ctx.compaction`;
 * the profile must disable `dsh-compaction-basic` and `dsh-command-compact`
 * (this plugin registers `/compact*` commands itself).
 */
export class CompactModeEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config = CompactModeConfigSchema

  /** Resolved and validated configuration. */
  readonly config: ResolvedConfig

  /** The `ctx.compactMode` service (mode event state). */
  readonly mode: CompactModeController

  /** Review state machine (per-session). */
  readonly reviews: ReviewCoordinator

  private readonly promptStates = new WeakMap<Session, PromptState>()
  private readonly warnedConfigTargets = new Set<string>()

  constructor(ctx: Context, config: Partial<CompactModeConfig> = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    this.mode = new CompactModeController(ctx)
    this.reviews = new ReviewCoordinator(ctx, this.config, this.mode)

    // The pre-step listener owns BOTH automatic pressure and review capture:
    // while a review is active, every claimed user message becomes an
    // instruction and the step is rejected (no model request).
    ctx.on('agent/pre-step', async (
      { agent, messages, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (this.reviews.isActive(agent.session)) {
        // Synchronous capture; the auxiliary call runs from the serial queue
        // after this (blocked) turn closes — NEVER awaited here.
        this.reviews.capture(agent, messages)
        return { kind: 'reject' }
      }
      if (this.config.auto && !signal.aborted) {
        try {
          await this.compactIfNeeded(agent, 'pressure', signal)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    if (this.config.auto) {
      ctx.on('agent/request-error', async (
        { agent, failure, signal },
        next,
      ): Promise<{ kind: 'retry' } | undefined> => {
        if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
        // Hard overflow: shake locally, then prompt (never auto-enter review).
        try {
          const shake = await shakeSession(ctx, agent.session, this.config)
          const target = routedTarget(agent.session)
          if (target !== undefined) {
            const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
            const thresholdTokens = Math.round((info.context?.contextWindow ?? 0) * this.config.thresholdRatio)
            if (thresholdTokens > 0 && shake.measurement.totalTokens <= thresholdTokens) {
              // Shake sufficed; the retried request may now fit.
              return { kind: 'retry' }
            }
          }
          if (this.config.promptOnHardOverflow) this.promptThreshold(agent, 'overflow')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`context-overflow shake failed: ${message}`)
        }
        return next()
      })
    }

    // Context-change watcher: a preserved review tree (aborted, not applied)
    // is deleted once the session surface/log changes after exit.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message'
        && event.type !== 'assistant/message'
        && event.type !== 'tool/result') return
      if (this.reviews.isActive(session)) return
      // Any surface event after exit invalidates a preserved tree.
      void this.reviews.destroyTreeFor(session).then(() => {
        ctx.logger.info('dsh-compact-mode: deleted preserved review tree after context change (session %s)', session.id)
      })
    })

    ctx.effect(() => () => {
      void this.reviews.dispose()
    }, 'dsh-compact-mode: close service lifetime')
  }

  /**
   * Consider automatic compaction for one explicit trigger: shake locally,
   * remeasure, and — when still above the threshold — prompt the user to enter
   * compact mode (never auto-entering: a pressure point cannot write the
   * owner-null lock). Returns `null` always: shake-only reductions are durable
   * surface changes (prunes/placeholders), not a summary compaction result.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (this.reviews.isActive(agent.session)) return null

    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context?.contextWindow
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined || context <= 0) {
      if (!this.warnedConfigTargets.has(targetKey)) {
        this.warnedConfigTargets.add(targetKey)
        this.ctx.logger.warn(
          `dsh-compact-mode: no context capacity for ${targetKey}; configure contextWindow on that adapter model`,
        )
      }
      return null
    }
    const thresholdTokens = Math.round(context * this.config.thresholdRatio)

    // Already comfortably below threshold: nothing to do (avoid churn).
    let measurement = this.ctx.tokenMeter.measure(agent.session)
    if (trigger === 'pressure' && measurement.totalTokens <= thresholdTokens) return null

    // Shake (pruner + fenced/XML placeholders) then remeasure.
    const shake = await shakeSession(this.ctx, agent.session, this.config)
    measurement = shake.measurement
    if (shake.landed) {
      this.ctx.logger.info(
        `dsh-compact-mode shake (${trigger}): landed ${shake.placeholders} placeholder(s), saved ~${shake.savedTokens} tokens`,
      )
    }
    if (measurement.totalTokens <= thresholdTokens) return null

    if (this.config.promptOnThreshold) {
      this.promptThreshold(agent, trigger === 'pressure' ? 'threshold' : 'overflow')
    }
    return null
  }

  /**
   * Enter compact mode (review state machine). Command state only: the
   * owner-null `compaction/start` lock requires no open turn. Returns `null`
   * — the review is in progress; `/compact_apply` produces the result.
   */
  override async compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      await agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        operationSignal.throwIfAborted()
        await this.reviews.enter(agent, sourceCommandId, operationSignal)
      })
    } catch (error) {
      if (error instanceof ManualCompactionError) throw error
      throw new ManualCompactionError(
        'busy',
        'compact mode requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
    return null
  }

  /**
   * Explicit region compaction outside review. While a review is active,
   * throws `ManualCompactionError('busy')` — the review holds the lock.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    if (this.reviews.isActive(agent.session)) {
      throw new ManualCompactionError('busy', 'compact review is active; abort or apply before region compaction')
    }
    signal?.throwIfAborted()
    return compactSurfaceRegionPort(this.ctx, this.config, agent, start, end, signal)
  }

  /** Notice prompt (60% / hard overflow) with per-session cooldown. */
  private promptThreshold(agent: Agent, kind: 'threshold' | 'overflow'): void {
    const session = agent.session
    const now = Date.now()
    let state = this.promptStates.get(session)
    if (state === undefined) {
      state = { thresholdAt: 0, overflowAt: 0 }
      this.promptStates.set(session, state)
    }
    const last = kind === 'threshold' ? state.thresholdAt : state.overflowAt
    if (this.config.promptCooldown > 0) {
      if (now - last < this.config.promptCooldown) return
    } else if (last !== 0) {
      // Cooldown 0 = once per session per threshold kind.
      return
    }
    if (kind === 'threshold') state.thresholdAt = now
    else state.overflowAt = now

    const text = kind === 'threshold'
      ? `Context usage is above ${Math.round(this.config.thresholdRatio * 100)}% after local elision. Enter compact mode with /compact to review a compression draft before applying it.`
      : 'The model context window was exceeded and local elision could not fit the request. Enter compact mode with /compact to review a compression draft, or start a new session.'
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-compact-mode', form: 'notice', summary: text },
    }))
  }

  /** Whether compact mode is active for the agent's session (store flag or live review). */
  isCompactActive(agent: Agent): boolean {
    return this.mode.store.get(agent.session.id).active || this.reviews.isActive(agent.session)
  }
}

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(session: Session): { provider: string; model: string } | undefined {
  const header = session.requestHeader()
  if (header === undefined) return undefined
  const config = header.config
  if (config.provider === undefined || config.model === undefined) return undefined
  return { provider: config.provider, model: config.model }
}

/**
 * Direct summary compaction over one explicit surface span (the non-review
 * path of `compactRegion`), mirroring compaction-basic's `compactSurfaceRegion`
 * with current-turn ownership and whole-surface stability.
 */
async function compactSurfaceRegionPort(
  ctx: Context,
  config: ResolvedConfig,
  agent: Agent,
  start: SessionSeq,
  end: SessionSeq,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  const session = agent.session
  signal?.throwIfAborted()
  const selected = validateSurfaceRegion(session, start, end)
  assertNoActiveCompaction(session, 'compactRegion')

  // Current-turn ownership: region compactions must be enclosed in an open
  // turn (mirror compaction-basic's compactRegion).
  const entry = inspectCompactionEntryState(session.snapshotEvents())
  if (entry.openTurn === null) {
    throw new ManualCompactionError('busy', 'compactRegion requires an open turn (automatic compaction is enclosed in a turn)')
  }

  const compactionId = CompactionId(`region-${session.id}-${start}-${end}-${Date.now()}`)
  const lifecycle = { compactionId, turn: entry.openTurn }
  const startEvent = session.append('compaction/start', lifecycle)

  const measurement = ctx.tokenMeter.measure(session)
  const startIdx = session.surface.nodes.indexOf(start)
  const endIdx = session.surface.nodes.indexOf(end)
  const selectedNodes = measurement.nodes.slice(startIdx, endIdx + 1)
  const shadowedTokenCount = selectedNodes.reduce((total, node) => total + node.tokens, 0)
  const input = buildSummarizationInput(session, selected.shadowedSeqs)

  let result: CompactionResult
  try {
    const summaryResult = await summarizeWithLlm(ctx, config, input, agent, signal)
    const framed = frameSummary(summaryResult.summary)
    const checkpoint = buildCheckpointMessage(compactionId, framed, undefined)
    const framedTokens = ctx.tokenMeter.estimateMessage(checkpoint)
    if (framedTokens >= shadowedTokenCount) {
      throw new ManualCompactionError(
        'summary',
        `summary is not smaller than the shadowed content (${framedTokens} >= ${shadowedTokenCount})`,
      )
    }
    // Whole-surface stability (mirror assertWholeSurfaceUnchanged).
    const current = ctx.tokenMeter.measure(session)
    if (current.nodes.length !== measurement.nodes.length
      || current.nodes.some((node, i) => node.seq !== measurement.nodes[i]?.seq || node.tokens !== measurement.nodes[i]?.tokens)) {
      throw new ManualCompactionError('changed', 'the session surface changed during region compaction')
    }
    const summarySeq = commitSummaryAndCheckpoint(session, startEvent, summaryResult, checkpoint, {
      range: { start, end },
      shadowedSeqs: selected.shadowedSeqs,
      shadowedTokenCount,
    })
    const endEvent = session.append('compaction/end', lifecycle)
    result = {
      compactionId,
      startSeq: startEvent.seq,
      summarySeq,
      endSeq: endEvent.seq,
      summary: summaryResult.summary,
      shadowedRange: { start, end },
      shadowedSeqs: selected.shadowedSeqs,
      shadowedTokenCount,
    }
  } catch (error) {
    try {
      session.append('compaction/end', {
        ...lifecycle,
        error: error instanceof Error ? error.message : String(error),
      })
    } catch {
      // A failed close leaves the unmatched start detectable (lock preserved).
    }
    throw error
  }
  return result
}

export default CompactModeEngine

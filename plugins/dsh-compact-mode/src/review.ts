/**
 * Review state machine: entering compact mode, capturing instructions,
 * serial revision calls, and apply/abort with the compaction event sequence.
 *
 * Contract summary (mirrors `compactSurfaceRegion`):
 * - Enter (command state only, no open turn) appends an owner-null
 *   `compaction/start` — the durable review lock. Any concurrent compaction
 *   transaction is rejected while it is unmatched.
 * - Every claimed user message while active is captured synchronously into the
 *   in-memory queue and the pre-step is REJECTED (no step/start, no
 *   user/message append, no model request). The auxiliary revision call is
 *   NEVER awaited inside the listener: it runs from a plugin-owned serial
 *   queue after the (blocked) turn closes.
 * - Apply revalidates shrink through the token meter, verifies the selected
 *   span is still stable, then appends `compaction/summary` →
 *   `user/message` (surfaceOp replace, `compactCheckpointSource`) →
 *   `compaction/end` synchronously, flushes, destroys the tree, and exits the
 *   mode.
 * - Abort appends `compaction/end` with an error, exits the mode, and KEEPS
 *   the review tree (deleted on later context change by the engine watcher).
 *
 * Crash tolerance: instruction capture lands in the in-memory queue first
 * (synchronous), then the queue persists a tree node per revision. A crash in
 * the claim→persist window can lose the instruction text (documented v1
 * limitation; the message is already out of the inbox and not in the log).
 *
 * @module @dsh-plugin/dsh-compact-mode/review
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { CompactionId, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.ts'
import type { CompactModeController } from './mode.ts'
import {
  buildCheckpointMessage,
  buildSummarizationInput,
  commitSummaryAndCheckpoint,
  estimateMessageTokens,
  inspectCompactionEntryState,
  reviseWithLlm,
  selectCompactableRange,
  validateSurfaceRegion,
} from './reuse.ts'
import type { SummaryResult } from './reuse.ts'
import {
  createReviewTree,
  deleteReviewTree,
  resolveTreeStorage,
} from './tree.ts'
import type { ResolvedTreeStorage, ReviewTreeHandle, ReviewNodeContent } from './tree.ts'

/** One active review session's state. */
export interface ReviewState {
  readonly session: Session
  readonly agent: Agent
  readonly compactionId: CompactionId
  /** Seq of the owner-null `compaction/start` that holds the review lock. */
  readonly startSeq: SessionSeq
  /** The shadowed surface span selected at entry (surface positions). */
  readonly shadowedRange: { start: SessionSeq; end: SessionSeq }
  /** The shadowed surface-node seqs, in surface order. */
  readonly shadowedSeqs: SessionSeq[]
  /** Estimated token count of the shadowed content. */
  readonly shadowedTokenCount: number
  /** The review tree handle (instruction/draft nodes). */
  tree: ReviewTreeHandle
  /** Current draft text (leaf draft). */
  draft: string
  /** Instruction queue awaiting serial revision calls. */
  readonly queue: string[]
  /** Whether a revision call is currently running. */
  processing: boolean
  /** The last revision call's envelope (apply provenance). */
  lastRevision?: SummaryResult
  /** Sequential node ids handed out for this review. */
  nodeSeq: number
}

/**
 * Extract claimed user-message text from content blocks. Tool results are no
 * longer wrapped in a `tool-result` content block (and never appear as
 * user-role messages), so only text contributes.
 */
function claimedText(message: UserMessage): string {
  return message.content
    .map(block => block.type === 'text' ? block.text : '')
    .filter(text => text.length > 0)
    .join('\n')
}

/**
 * Review coordinator: per-session review state, the serial revision queue,
 * apply/abort event sequencing, and review-tree lifecycle hooks.
 */
export class ReviewCoordinator {
  /** Active reviews keyed by session id. */
  readonly reviews = new Map<string, ReviewState>()

  private storagePromise: Promise<ResolvedTreeStorage> | undefined
  private readonly treeFileOverride: string | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly mode: CompactModeController,
  ) {}

  /** Whether a review is active for the session. */
  isActive(session: Session): boolean {
    return this.reviews.has(session.id)
  }

  /** Resolve (and cache) the review-tree storage backend. */
  private storage(): Promise<ResolvedTreeStorage> {
    this.storagePromise ??= resolveTreeStorage(this.ctx, this.config, this.treeFileOverride)
    return this.storagePromise
  }

  /** Begin a review for an idle session (command state, no open turn). */
  async enter(
    agent: Agent,
    sourceCommandId?: CommandId,
    signal?: AbortSignal,
  ): Promise<void> {
    const session = agent.session
    if (this.reviews.has(session.id)) {
      throw new ManualCompactionError('busy', 'compact review already active for this session')
    }
    signal?.throwIfAborted()
    // Command state only: the owner-null lock requires no open turn.
    const entry = inspectCompactionEntryState(session.snapshotEvents())
    if (entry.openTurn !== null) {
      throw new ManualCompactionError('busy', 'compact mode requires command state; wait for the current turn to finish')
    }
    if (entry.unmatchedCompactionStart !== undefined) {
      throw new ManualCompactionError('busy', 'another compaction is already in progress for this session')
    }

    // Select the shadowed span (keep the recent tail verbatim).
    const measurement = this.ctx.tokenMeter.measure(session)
    const range = selectCompactableRange(session, measurement, this.config.keepRecentTokens)
    if (range === null) {
      throw new ManualCompactionError(
        'changed',
        'no compactable range: the whole surface is inside the protected recent window',
      )
    }
    const selected = validateSurfaceRegion(session, range.start, range.end)
    const shadowedNodes = measurement.nodes.slice(
      session.surface.nodes.indexOf(range.start),
      session.surface.nodes.indexOf(range.end) + 1,
    )
    const shadowedTokenCount = shadowedNodes.reduce((total, node) => total + node.tokens, 0)

    // Durable lock: owner-null compaction/start, then the mode event.
    const compactionId = CompactionId(`review-${session.id}-${Date.now()}`)
    const startEvent = session.append('compaction/start', {
      compactionId,
      ...sourceCommandId === undefined ? {} : { sourceCommandId },
      turn: null,
    })

    // Mode flag (plugin store; committed: command state, no open turn).
    const outcome = this.mode.set(agent, true)
    if (outcome !== 'committed') {
      // The mode flip raced; close the lock and fail closed.
      session.append('compaction/end', {
        compactionId,
        ...sourceCommandId === undefined ? {} : { sourceCommandId },
        turn: null,
        error: 'compact/mode did not commit',
      })
      throw new ManualCompactionError('commit', 'compact mode did not commit on entry')
    }

    const storage = await this.storage()
    const tree = await createReviewTree(storage, session)
    const state: ReviewState = {
      session,
      agent,
      compactionId,
      startSeq: startEvent.seq,
      shadowedRange: { start: selected.start, end: selected.end },
      shadowedSeqs: selected.shadowedSeqs,
      shadowedTokenCount,
      tree,
      draft: '',
      queue: [],
      processing: false,
      nodeSeq: 0,
    }
    this.reviews.set(session.id, state)

    // Kick the seed draft v1 (serial queue; not awaited by any listener).
    this.enqueue(state, 'Produce the initial compaction draft for the shadowed region above.')
    void this.drain(session.id)
  }

  /**
   * Capture claimed user-message text synchronously into the review queue and
   * return the pre-step rejection. NEVER awaits the revision call.
   */
  capture(agent: Agent, messages: readonly UserMessage[]): void {
    const state = this.reviews.get(agent.session.id)
    if (state === undefined) return
    for (const message of messages) {
      const text = claimedText(message)
      if (text.trim().length > 0) this.enqueue(state, text)
    }
    void this.drain(agent.session.id)
  }

  /** Enqueue one instruction (in-memory first; persisted per revision). */
  private enqueue(state: ReviewState, instruction: string): void {
    state.queue.push(instruction)
  }

  /**
   * Serial drain: one revision call per instruction, FIFO, never concurrent.
   * Each call is bounded (draft + instruction + source region) and
   * non-accumulating.
   */
  private async drain(sessionId: string): Promise<void> {
    const state = this.reviews.get(sessionId)
    if (state === undefined || state.processing) return
    state.processing = true
    try {
      while (state.queue.length > 0) {
        const instruction = state.queue.shift()!
        try {
          await this.runRevision(state, instruction)
        } catch (error) {
          this.ctx.logger.warn('dsh-compact-mode: revision call failed: %o', error)
          // The instruction stays visible in the tree as a failed node so the
          // user can retry with /compact_edit rather than losing it silently.
          await this.appendNode(state, {
            instruction,
            draft: state.draft,
            sourceDraftId: await this.leafId(state),
          }).catch(() => {})
          break
        }
      }
    } finally {
      state.processing = false
    }
    // Instructions may have been captured while this drain was running;
    // re-enter to process them (never awaited by any listener).
    if (state.queue.length > 0) void this.drain(sessionId)
  }

  /** Current leaf node id (or null for an empty tree). */
  private async leafId(state: ReviewState): Promise<string | null> {
    return state.tree.engine.getLeaf()
  }

  /** Append one review node and update the current draft. */
  private async appendNode(
    state: ReviewState,
    content: ReviewNodeContent,
  ): Promise<string> {
    state.nodeSeq += 1
    const id = `v${state.nodeSeq}`
    await state.tree.engine.append({
      id,
      content,
      ...content.usage === undefined ? {} : { meta: { usage: content.usage } },
    })
    state.draft = content.draft
    return id
  }

  /** Run one revision call and land its node. */
  private async runRevision(state: ReviewState, instruction: string): Promise<string> {
    const input = buildSummarizationInput(state.session, state.shadowedSeqs)
    const result = await reviseWithLlm(
      this.ctx,
      this.config,
      input,
      state.draft,
      instruction,
      state.agent,
    )
    state.lastRevision = result
    const sourceDraftId = await this.leafId(state)
    return this.appendNode(state, {
      instruction,
      draft: result.draft,
      sourceDraftId,
      ...result.provider === undefined ? {} : { provider: result.provider },
      ...result.model === undefined ? {} : { model: result.model },
      ...result.usage === undefined ? {} : { usage: result.usage },
    })
  }

  /** Run one explicit revision (the `/compact_edit` command path). */
  async edit(agent: Agent, instruction: string, signal?: AbortSignal): Promise<{ nodeId: string; draft: string }> {
    const state = this.require(agent)
    signal?.throwIfAborted()
    // Commands can await their own revision; serialize on the queue tail.
    const nodeId = await this.runRevision(state, instruction)
    return { nodeId, draft: state.draft }
  }

  /** The current draft (for /compact view and apply). */
  currentDraft(agent: Agent): { draft: string; nodeId: string | null } {
    const state = this.require(agent)
    return { draft: state.draft, nodeId: state.tree.engine.getLeaf() as unknown as string | null }
  }

  /**
   * Apply the current draft: shrink revalidation, span stability check, then
   * the compactSurfaceRegion event sequence (summary → replace → end),
   * flush, tree destroy, mode exit.
   */
  async apply(agent: Agent, sourceCommandId?: CommandId, signal?: AbortSignal): Promise<CompactionResult> {
    const state = this.require(agent)
    const session = state.session
    signal?.throwIfAborted()

    const summaryBlocks: ContentBlock[] = [{ type: 'text', text: state.draft }]
    const checkpoint = buildCheckpointMessage(state.compactionId, summaryBlocks, sourceCommandId)

    // Shrink revalidation through the conversation meter.
    const framedTokens = estimateMessageTokens(this.ctx, checkpoint)
    if (framedTokens >= state.shadowedTokenCount) {
      throw new ManualCompactionError(
        'summary',
        `draft is not smaller than the shadowed content (${framedTokens} estimated framed tokens >= ${state.shadowedTokenCount}); keep revising or abort`,
      )
    }

    // Span stability: the selected span must still be a valid replacement
    // target with the same shadowed seqs (nodes outside it may have changed).
    let current: { shadowedSeqs: number[] }
    try {
      current = validateSurfaceRegion(session, state.shadowedRange.start, state.shadowedRange.end)
    } catch (error) {
      throw new ManualCompactionError('changed', 'the compacted span changed during review', { cause: error })
    }
    if (current.shadowedSeqs.length !== state.shadowedSeqs.length
      || current.shadowedSeqs.some((seq, i) => seq !== state.shadowedSeqs[i])) {
      throw new ManualCompactionError('changed', 'the compacted span changed during review')
    }

    const startEvent = session.eventAt(state.startSeq)
    if (startEvent === undefined || startEvent.type !== 'compaction/start') {
      throw new ManualCompactionError('changed', 'the review lock marker is no longer in the log')
    }

    // Commit: summary → checkpoint replace → end, synchronously adjacent.
    const summarySeq = commitSummaryAndCheckpoint(
      session,
      startEvent,
      state.lastRevision ?? {
        summary: summaryBlocks,
        provider: '',
        model: '',
        rawOutput: summaryBlocks,
        llmStreamCall: true,
      },
      checkpoint,
      {
        range: state.shadowedRange,
        shadowedSeqs: state.shadowedSeqs,
        shadowedTokenCount: state.shadowedTokenCount,
      },
    )
    const endEvent = session.append('compaction/end', {
      compactionId: state.compactionId,
      ...sourceCommandId === undefined ? {} : { sourceCommandId },
      turn: null,
    })

    // Exit compact mode (log-only mode event).
    this.mode.set(agent, false)

    // Durability checkpoint.
    try {
      await this.ctx.sessions.flush(session)
    } catch (error) {
      throw new ManualCompactionError('persistence', 'compact apply durability checkpoint failed', { cause: error })
    }

    // Tree lifecycle: apply destroys the tree (the result is in the log).
    await state.tree.destroy()
    this.reviews.delete(session.id)

    return {
      compactionId: state.compactionId,
      ...sourceCommandId === undefined ? {} : { sourceCommandId },
      startSeq: state.startSeq,
      summarySeq,
      endSeq: endEvent.seq,
      summary: summaryBlocks,
      shadowedRange: state.shadowedRange,
      shadowedSeqs: state.shadowedSeqs,
      shadowedTokenCount: state.shadowedTokenCount,
    }
  }

  /**
   * Abort the review: close the lock with an error, exit the mode, KEEP the
   * tree (the engine watcher deletes it on later context change).
   */
  async abort(agent: Agent, reason = 'aborted by user', signal?: AbortSignal): Promise<void> {
    const state = this.require(agent)
    const session = state.session
    signal?.throwIfAborted()
    session.append('compaction/end', {
      compactionId: state.compactionId,
      turn: null,
      error: reason,
    })
    this.mode.set(agent, false)
    try {
      await this.ctx.sessions.flush(session)
    } catch (error) {
      throw new ManualCompactionError('persistence', 'compact abort durability checkpoint failed', { cause: error })
    }
    // Tree kept; the engine's context-change watcher deletes it later.
    this.reviews.delete(session.id)
  }

  /** Require an active review for the agent's session. */
  require(agent: Agent): ReviewState {
    const state = this.reviews.get(agent.session.id)
    if (state === undefined) {
      throw new ManualCompactionError('busy', 'compact review is not active for this session')
    }
    return state
  }

  /** Review tree queries for /compact tree|view|jump|diff. */
  async treeView(agent: Agent): Promise<ReviewState> {
    return this.require(agent)
  }

  /** Delete a session's persisted tree (context-change watcher / cleanup). */
  async destroyTreeFor(session: Session): Promise<void> {
    try {
      const storage = await this.storage()
      await deleteReviewTree(storage, session)
    } catch (error) {
      this.ctx.logger.warn('dsh-compact-mode: failed to delete preserved review tree: %o', error)
    }
  }

  /** Close the storage backend on plugin teardown. */
  async dispose(): Promise<void> {
    if (this.storagePromise === undefined) return
    try {
      const storage = await this.storagePromise
      await storage.close()
    } catch (error) {
      this.ctx.logger.warn('dsh-compact-mode: review-tree storage close failed: %o', error)
    }
  }
}

/** Node content builder for tests / commands. */
export function reviewNodeContent(
  instruction: string,
  draft: string,
  sourceDraftId: string | null,
  usage?: TokenUsage,
): ReviewNodeContent {
  return { instruction, draft, sourceDraftId, ...usage === undefined ? {} : { usage } }
}

export type { TokenUsage }

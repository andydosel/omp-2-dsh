/**
 * Shake: the model-free local-elision pass that runs before any threshold
 * decision. Three mechanical reductions, all durable surface changes with no
 * model call:
 *
 * 1. Tool-result pruning through `ctx.toolResultPruner` (when the optional
 *    service is loaded) — its replacements carry their own `compaction/prune`
 *    shadow-price events.
 * 2. Large fenced/XML blocks in user/tool messages → `ctx.spillStore.saveText`
 *    (when present; otherwise a pure truncation marker) with a `CallId()`
 *    synthesized source, landed as a `user/message` surface replace preceded
 *    by the shared `compaction/prune` shadow-price event.
 * 3. A protected recent tail (`keepRecentTokens`) and a minimum-savings ratio
 *    (`minShakeSavingsRatio`) prevent churn on already-small surfaces.
 *
 * Assistant-message shake is intentionally skipped (v1): the session invariant
 * requires `assistant/message` appends to match the current open step, so a
 * same-role assistant replacement cannot be executed during compaction; only
 * user-role placeholder replaces (or skipping) are legal, and v1 skips.
 *
 * @module @dsh-plugin/dsh-compact-mode/shake
 */

import type { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { ResolvedConfig } from './config.ts'
import { inspectCompactionEntryState } from './reuse.ts'

/** Minimum length of one fenced/XML block before it is a shake candidate. */
const MIN_BLOCK_CHARS = 2000

/** Shake results: what landed and the fresh measurement after the pass. */
export interface ShakeResult {
  /** Whether any durable replacement landed (pruner or placeholder). */
  landed: boolean
  /** Number of placeholder replaces landed by this plugin (not the pruner). */
  placeholders: number
  /** Fresh measurement after the whole pass. */
  measurement: TokenMeasurement
  /** Estimated token savings across landed replacements. */
  savedTokens: number
}

/**
 * The pruner pass (step 1). Optional service; absent on compositions without
 * the tool-result-pruner row. Its replacements emit `compaction/prune` events
 * themselves.
 */
function pruneToolResults(ctx: Context, session: Session): { landed: boolean; savedTokens: number } {
  const pruner = ctx.get('toolResultPruner')
  if (pruner === undefined) return { landed: false, savedTokens: 0 }
  const result = pruner.pruneSession(session)
  return { landed: result.pruned.length > 0, savedTokens: result.charsRemoved }
}

/**
 * Locate one large fenced (```) or XML (<tag>…</tag>) block inside a text
 * string, returning its start/end offsets when it meets the size gate.
 */
function findLargeBlock(text: string): { start: number; end: number } | null {
  // Fenced block: triple backticks opening and closing.
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('```', cursor)
    if (open === -1) break
    const close = text.indexOf('```', open + 3)
    if (close === -1) break
    const block = text.slice(open, close + 3)
    if (block.length >= MIN_BLOCK_CHARS) return { start: open, end: close + 3 }
    cursor = close + 3
  }
  // XML-ish block: <tag ...> … </tag> with a matching closer.
  const xmlMatch = /<([a-zA-Z][a-zA-Z0-9_-]*)[^>]*>[\s\S]*?<\/\1>/g
  for (const match of text.matchAll(xmlMatch)) {
    const block = match[0]
    if (block.length >= MIN_BLOCK_CHARS) {
      return { start: match.index!, end: match.index! + block.length }
    }
  }
  return null
}

/** Extract plain text from a message's content blocks for block scanning. */
function textOfMessage(event: SessionEvent<'user/message' | 'tool/result'>): string {
  const message = event.type === 'user/message' ? event.data : event.data.message
  return (message?.content ?? [])
    .map((block) => {
      switch (block.type) {
        case 'text':
        case 'reasoning':
          return block.text
        case 'tool-result':
          return typeof block.content === 'string' ? block.content : ''
        default:
          return ''
      }
    })
    .join('\n')
}

/**
 * Fenced/XML placeholder pass (step 2): for user/tool surface nodes outside
 * the protected recent tail whose text holds a large fenced/XML block, spill
 * the full original text (when a spill store exists) and replace the node with
 * a user/message placeholder. Each replace is immediately preceded by the
 * shared `compaction/prune` shadow-price event so pure consumers can subtract
 * the price without per-node state.
 */
async function placeholdLargeBlocks(
  ctx: Context,
  session: Session,
  config: ResolvedConfig,
  measurement: TokenMeasurement,
): Promise<{ landed: boolean; savedTokens: number; count: number }> {
  const pricedNodes = measurement.nodes
  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compact-mode shake: token-meter surface does not match the session surface')
  }

  // Protection window: keep the recent tail (keepRecentTokens) verbatim.
  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index in range
    accumulated += pricedNodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= config.keepRecentTokens) break
  }

  const candidates: { seq: number; event: SessionEvent<'user/message' | 'tool/result'>; tokens: number }[] = []
  for (let index = 0; index < keepFromIdx; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index in range
    const seq = surfaceNodes[index]!
    const event = session.events[seq]
    if (event === undefined || event.seq !== seq) {
      throw new Error(`compact-mode shake: surface seq ${seq} has no matching session event`)
    }
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue
    // Skip nodes whose surface price is already tiny — nothing worth eliding.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index in range
    if (pricedNodes[index]!.tokens < MIN_BLOCK_CHARS / 4) continue
    if (findLargeBlock(textOfMessage(event)) === null) continue
    candidates.push({ seq, event, tokens: pricedNodes[index]!.tokens })
  }

  const savedTokens = candidates.reduce((total, c) => total + c.tokens, 0)
  if (savedTokens === 0) return { landed: false, savedTokens: 0, count: 0 }
  // Anti-thrash: below the minimum savings ratio, landing replacements would
  // churn the surface for negligible benefit.
  if (savedTokens < measurement.surfaceTokens * config.minShakeSavingsRatio) {
    return { landed: false, savedTokens: 0, count: 0 }
  }

  const spillStore = ctx.get('spillStore')
  let landed = 0
  for (const candidate of candidates) {
    const seq = candidate.seq
    // Re-check the node is still on the surface at the same position before
    // replacing (earlier replaces shift nothing below their position, but the
    // surface is re-read for safety).
    const position = surfaceNodes.indexOf(seq)
    if (position === -1 || position >= keepFromIdx) continue
    const fullText = textOfMessage(candidate.event)
    let placeholder = `[Large block elided during local compaction (${candidate.tokens} tokens).`
    if (spillStore !== undefined && fullText.length > 0) {
      try {
        const ref = await spillStore.saveText({
          owner: { sessionId: session.id },
          source: {
            toolName: 'compact-shake',
            callId: CallId(`shake-${session.id}-${seq}`),
            label: 'fenced-block',
          },
          suggestedName: `shake-${seq}.txt`,
          content: fullText,
        })
        placeholder += ` Full text recovered at ${ref.locator}. Retrieval: ${ref.retrievalHint}`
      } catch (error) {
        ctx.logger.warn('compact-mode shake: spill save failed, keeping truncation marker: %o', error)
        placeholder += ' The original text was not spilled (storage failure).'
      }
    } else {
      placeholder += ' The original text was not spilled.'
    }
    placeholder += ']'

    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: candidate.tokens,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: placeholder }],
      source: { kind: 'plugin', plugin: 'dsh-compact-mode', form: 'recall' },
    }), {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
    landed += 1
  }
  return { landed: landed > 0, savedTokens: landed > 0 ? savedTokens : 0, count: landed }
}

/**
 * Run the full shake pass on one session: pruner, then fenced/XML
 * placeholders, then a fresh measurement. All reductions are durable surface
 * events; nothing here calls the model.
 *
 * @param ctx - context providing optional pruner/spill services and the meter.
 * @param session - session whose surface is shaken.
 * @param config - resolved compact-mode configuration.
 * @returns landed reductions and the fresh measurement.
 */
export async function shakeSession(
  ctx: Context,
  session: Session,
  config: ResolvedConfig,
): Promise<ShakeResult> {
  // The shake must not run while a compaction transaction is open: replacing
  // nodes mid-transaction would invalidate the selected span.
  const entry = inspectCompactionEntryState(session.events)
  if (entry.unmatchedCompactionStart !== undefined) {
    return { landed: false, placeholders: 0, measurement: ctx.tokenMeter.measure(session), savedTokens: 0 }
  }

  const pruned = pruneToolResults(ctx, session)
  const beforePlaceholders = ctx.tokenMeter.measure(session)
  const placeholders = await placeholdLargeBlocks(ctx, session, config, beforePlaceholders)
  const measurement = ctx.tokenMeter.measure(session)
  return {
    landed: pruned.landed || placeholders.landed,
    placeholders: placeholders.count,
    measurement,
    savedTokens: pruned.savedTokens + placeholders.savedTokens,
  }
}

/**
 * Local reimplementations of the compaction-basic library helpers that the
 * PUBLISHED `@next` build does not export.
 *
 * DRIFT NOTE (verified against @deepseek-ai/dsh-compaction-basic@0.1.0-rc.6):
 * the published package ships a single bundled `lib/index.js` exporting only
 * `BasicCompactionEngine`; `summarizeWithLlm` / `frameSummary` /
 * `selectCompactableRange` / `assertNoActiveCompaction` exist only inside the
 * bundle and as orphan `.d.ts` files with no runtime module (the exports map
 * exposes only `.`, `./invariant`, `./src/*` — and `src/` is not shipped).
 * The feasibility docs assumed they were importable; they are not. These
 * faithful local ports (same algorithms, same event vocabulary) replace them.
 *
 * @module @dsh-plugin/dsh-compact-mode/reuse
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import {
  BlockAssembler,
  LlmError,
  contentHasImage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import { isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { randomUUID } from 'node:crypto'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed source region. Textual equivalent of compaction-basic's private
 * COMPACTION_INSTRUCTION: structured checkpoint output, no tool calls, no
 * mention of the compaction itself.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Replayed conversation prefix the summarizer condenses. */
export interface SummarizationInput {
  /** The conversation's own system prompt, reused for prefix-cache alignment. */
  readonly system?: string
  /** The conversation's tool schemas, reused for prefix-cache alignment. */
  readonly tools?: readonly ToolSchema[]
  /** The shadowed region, in surface order, that precedes the compaction instruction. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/** Config surface consumed by the local summarizer port (subset of ResolvedConfig). */
export interface SummaryCallConfig {
  summarizationProvider: string
  summarizationModel: string
  maxTokens: number
}

/** Resolve provider/model like compaction-basic: configured ?? latest ?? agent options. */
function resolveCallTarget(
  config: SummaryCallConfig,
  agent: Agent,
): { provider: string; model: string } {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for the revision call: set both compact-mode summarization fields, route one request, or set both AgentOptions fields',
    )
  }
  return target
}

/** Map a terminal stream finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('revision truncated at the token cap (incomplete draft)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 *
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration (provider/model/maxTokens).
 * @param input - replayed conversation prefix (system, tools, and leading messages).
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryCallConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const target = resolveCallTarget(config, agent)
  const assembler = new BlockAssembler()
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
      source: { kind: 'dsh-compact-mode' },
    }),
  ]
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.system === undefined ? {} : { system: input.system },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction' as const,
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/**
 * Run one bounded review revision call: replay the source region prefix, then
 * append the CURRENT DRAFT and the USER INSTRUCTION as the trailing user
 * messages. The draft and instruction are the only novel input, so the call is
 * a genuine prefix of the conversation and reuses the provider's KV cache.
 * Bounded and non-accumulating: no matter how many revisions run, each call's
 * input is draft + instruction + source region.
 *
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration (provider/model/maxTokens).
 * @param input - replayed conversation prefix (system, tools, and source region).
 * @param draft - the current draft text ("" for the first draft).
 * @param instruction - the user's revision instruction.
 * @param agent - supplies routed-model history and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns the new draft text plus the exact call envelope and output.
 */
export async function reviseWithLlm(
  ctx: Context,
  config: SummaryCallConfig,
  input: SummarizationInput,
  draft: string,
  instruction: string,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult & { draft: string }> {
  const target = resolveCallTarget(config, agent)
  const assembler = new BlockAssembler()
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: `Current draft:\n${draft === '' ? '(none yet)' : draft}` }],
      source: { kind: 'dsh-compact-mode' },
    }),
    createUserMessage({
      content: [{ type: 'text', text: `Revision instruction: ${instruction}` }],
      source: { kind: 'dsh-compact-mode' },
    }),
  ]
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.system === undefined ? {} : { system: input.system },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction' as const,
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const text = summaryText(rawOutput)
  if (!text.some(block => block.text.trim().length > 0)) {
    throw new Error('revision produced no text draft content')
  }
  return {
    draft: text.map(block => block.text).join('\n'),
    summary: text,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 *
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/**
 * Resolve the next head-anchored range while retaining a priced recent tail
 * and never splitting an assistant tool-call/result pair. Local port of
 * compaction-basic's `selectCompactableRange`.
 *
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement from the conversation meter.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
): { start: SessionSeq; end: SessionSeq } | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null

  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compact-mode: token-meter surface does not match the current session surface')
  }

  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- pricedNodes[index] exists while index is in range
    accumulated += pricedNodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx === 0) return null

  while (keepFromIdx > 0) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index in range
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx === 0) return null

  // oxlint-disable-next-line typescript/no-non-null-assertion -- non-empty array
  const first = surfaceNodes[0]!
  // oxlint-disable-next-line typescript/no-non-null-assertion -- keepFromIdx >= 1 here
  const cutoff = surfaceNodes[keepFromIdx - 1]!
  return { start: first, end: cutoff }
}

/** Open-turn, unmatched-compaction, and seed-boundary state (local port). */
interface CompactionEntryState {
  readonly openTurn: number | null
  readonly unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  readonly latestEndSeedSeq: SessionSeq | undefined
}

/** Inspect the durable compaction-lock state of one session log (local port). */
export function inspectCompactionEntryState(events: readonly SessionEvent[]): CompactionEntryState {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: SessionSeq | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index in range
    const event = events[index]!
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown
      && compactionEntryStateKnown
      && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

/** Reject an unmatched compaction marker unless a later seed boundary proves it stale. */
function assertCompactionInactive(
  unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined,
  latestEndSeedSeq: SessionSeq | undefined,
  stage: string,
): void {
  if (unmatchedCompactionStart === undefined
    || (latestEndSeedSeq !== undefined
      && latestEndSeedSeq > unmatchedCompactionStart.seq)) return
  throw new ManualCompactionError(
    'busy',
    `${stage}: compaction already in progress; the session compaction lock is already active`,
  )
}

/**
 * Recheck the durable compaction lock after an asynchronous policy decision.
 * Local port of compaction-basic's `assertNoActiveCompaction`.
 *
 * @param session - session whose latest marker state is inspected.
 * @param stage - operation label included in the busy diagnostic.
 */
export function assertNoActiveCompaction(session: Session, stage: string): void {
  const entryState = inspectCompactionEntryState(session.snapshotEvents())
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    stage,
  )
}

/**
 * Validate one requested surface-position span before asynchronous work begins.
 * Local port of compaction-basic's `validateSurfaceRegion`.
 *
 * @param session - session whose surface is validated.
 * @param start - inclusive first surface-node seq (surface position).
 * @param end - inclusive last surface-node seq (surface position).
 * @returns the validated selection with shadowed seqs in surface order.
 */
export function validateSurfaceRegion(
  session: Session,
  start: SessionSeq,
  end: SessionSeq,
): { start: SessionSeq; end: SessionSeq; shadowedSeqs: SessionSeq[] } {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(
      `compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    )
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- startIdx in range
  if (!toolPairingBalancedBefore(session, nodes[startIdx]!)) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- endIdx in range
  if (!toolPairingBalancedAfter(session, nodes[endIdx]!)) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  }

  return { start, end, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/**
 * Reconstruct the last routed request's cacheable prefix for the shadowed
 * region: its system prompt and tool schemas, then the region's own derived
 * messages in surface order. Local port of compaction-basic's
 * `buildSummarizationInput`.
 *
 * @param session - session supplying the request header and per-node projection.
 * @param shadowedSeqs - the surface-node seqs, in order, being compacted.
 * @returns the replayed conversation prefix to condense.
 */
export function buildSummarizationInput(
  session: Session,
  shadowedSeqs: readonly SessionSeq[],
): SummarizationInput {
  const header = session.requestHeader()
  const regionMessages = shadowedSeqs
    .map(seq => session.eventAt(seq))
    .map(event => event === undefined ? null : session.deriveEventMessage(event))
    .filter((message): message is Message => message !== null)
  return {
    ...header?.system === undefined ? {} : { system: header.system },
    ...header?.tools === undefined ? {} : { tools: header.tools },
    messages: regionMessages,
  }
}

/**
 * Build the replacement checkpoint user message for one compaction
 * transaction, correlated through {@link compactCheckpointSource}.
 *
 * @param compactionId - owning compaction identity.
 * @param summary - safe summary content blocks.
 * @param sourceCommandId - initiating manual command, when present.
 * @returns the checkpoint message.
 */
export function buildCheckpointMessage(
  compactionId: CompactionId,
  summary: readonly ContentBlock[],
  sourceCommandId?: CommandId,
): UserMessage {
  return createUserMessage({
    content: frameSummary(summary),
    source: compactCheckpointSource(compactionId, sourceCommandId),
  })
}

/**
 * Append the completed-summary record and the replacement body without
 * yielding, mirroring compaction-basic's `commitCompactionBody`: the
 * `compaction/summary` record (log-only) is immediately followed by the
 * surface-replacing `user/message` checkpoint. The caller appends
 * `compaction/end` synchronously right after.
 *
 * @param session - session whose log grows.
 * @param startEvent - the opening `compaction/start` event.
 * @param result - the summarize call result.
 * @param checkpoint - the checkpoint user message to land.
 * @param shadowed - validated shadowed range, seqs, and price.
 * @returns the seq of the appended `compaction/summary` event.
 */
export function commitSummaryAndCheckpoint(
  session: Session,
  startEvent: SessionEvent<'compaction/start'>,
  result: SummaryResult,
  checkpoint: UserMessage,
  shadowed: {
    range: { start: SessionSeq; end: SessionSeq }
    shadowedSeqs: SessionSeq[]
    shadowedTokenCount: number
  },
): SessionSeq {
  const callProvenance = result.llmStreamCall === true
    ? { rawOutput: result.rawOutput, llmStreamCall: true as const }
    : result.rawOutput === undefined ? {} : { rawOutput: result.rawOutput }
  const summaryEvent = session.append('compaction/summary', {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    summary: result.summary,
    ...callProvenance,
    shadowedRange: shadowed.range,
    shadowedSeqs: [...shadowed.shadowedSeqs],
    shadowedTokenCount: shadowed.shadowedTokenCount,
    provider: result.provider,
    model: result.model,
    ...result.maxTokens === undefined ? {} : { maxTokens: result.maxTokens },
    ...result.usage === undefined ? {} : { usage: result.usage },
  })
  session.append('user/message', checkpoint, {
    surfaceOp: { op: 'replace', startSeq: shadowed.range.start, endSeq: shadowed.range.end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowed.shadowedSeqs],
  })
  return summaryEvent.seq
}

/**
 * Price one model-visible message through the conversation meter's fixed
 * heuristic (instance face).
 *
 * @param ctx - context providing the token meter.
 * @param message - message to price.
 * @returns heuristic tokens.
 */
export function estimateMessageTokens(ctx: Context, message: Message): number {
  return ctx.tokenMeter.estimateMessage(message)
}

export { deepFreeze, isSurfaceEvent }
export type { CompactionResult }
export { randomUUID }

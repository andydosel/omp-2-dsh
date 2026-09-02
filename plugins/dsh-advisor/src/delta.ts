/**
 * Primary-transcript delta observation: a per-session cursor over appended
 * surface events, projection through `Session.deriveEventMessage`, and
 * bounded prompt serialization for the reviewer feed.
 *
 * The observer is a pure cursor: `observe` advances past every event with a
 * newer seq, and `collect` scans the unobserved log range, keeping only
 * events that are still live surface nodes (a compaction replace shadows
 * earlier nodes even though the log keeps them). Surface order equals seq
 * order — a replacement node always has a higher seq than everything it
 * shadows — so a seq scan filtered by the live surface is the surface order.
 *
 * @module @dsh-plugin/dsh-advisor/delta
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'

/**
 * Whether a session event should be excluded from reviewer deltas: messages
 * this plugin itself delivered to the primary (its own advisories) must not
 * be re-reviewed.
 */
export type OwnMessagePredicate = (event: SessionEvent) => boolean

/** One collected batch of unobserved surface messages. */
export interface DeltaBatch {
  /** Projected messages in surface order. */
  readonly messages: readonly Message[]
  /** The surface seq of each collected message. */
  readonly seqs: readonly number[]
  /** Events skipped in the scanned range (shadowed, own, or non-deriving). */
  readonly dropped: number
}

/**
 * Cursor over one primary session's surface. Not tied to a session object:
 * `collect` takes the session so a rebuilt lifecycle (resume) can be scanned
 * from the same cursor.
 *
 * The cursor is the next UNCOLLECTED seq: `observe` is a liveness marker
 * (events arrive in seq order and re-emissions are ignored), while `collect`
 * drains the uncollected log range and advances the cursor to the log end.
 * This keeps observation and collection decoupled — events observed between
 * two collections are never lost.
 */
export class DeltaObserver {
  /** Next uncollected seq. */
  private cursor = 0

  constructor(private readonly isOwnMessage: OwnMessagePredicate) {}

  /** The next seq `collect` will look at. */
  get nextSeq(): number {
    return this.cursor
  }

  /**
   * Feed one appended session event. Informational: collection is driven by
   * {@link collect}, so this only records that the feed is live and rejects
   * stale re-emissions.
   * @param event - an event observed on `session/event`.
   * @returns whether the event is newer than the collect cursor.
   */
  observe(event: SessionEvent): boolean {
    return event.seq >= this.cursor
  }

  /**
   * Collect unobserved surface messages of `session` in surface position
   * order (a replacement node sits at the position of the range it replaced,
   * so surface order can differ from seq order). Advances the cursor to the
   * end of the log, so later calls return only newer events.
   * @param session - the primary session.
   * @returns the projected messages plus seqs and drop statistics.
   */
  collect(session: Session): DeltaBatch {
    const events = session.events
    const uncollected = new Set<number>()
    for (let seq = this.cursor; seq < events.length; seq++) uncollected.add(seq)
    const messages: Message[] = []
    const seqs: number[] = []
    let dropped = 0
    for (const seq of session.surface.nodes) {
      if (!uncollected.has(seq)) continue
      const event = events[seq]
      if (event === undefined) {
        dropped++
        continue
      }
      if (this.isOwnMessage(event)) {
        dropped++
        continue
      }
      const message = deriveEventMessage(event)
      if (message === null) {
        dropped++
        continue
      }
      messages.push(message)
      seqs.push(seq)
    }
    this.cursor = events.length
    return { messages, seqs, dropped }
  }

  /** Rewind the cursor to 0 so the next {@link collect} returns the whole current surface. */
  rewind(): void {
    this.cursor = 0
  }

  /** Skip everything already in the log (fresh attach without a baseline). */
  fastForward(session: Session): void {
    this.cursor = session.events.length
  }
}

/**
 * Rough token estimate for prompt-budget decisions, mirroring the harness's
 * token-meter heuristic: four characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 4)
}

/** Framing of one reviewer feed. */
export type FeedKind = 'baseline' | 'delta'

/** Result of {@link serializeDelta}. */
export interface SerializedDelta {
  readonly text: string
  readonly messageCount: number
  /** Whether the serialization was cut off by the token budget. */
  readonly truncated: boolean
}

/** One serialized message entry inside the feed frame. */
function renderEntry(seq: number, message: Message): string {
  const role = message.role
  let text = ''
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        text += block.text
        break
      case 'reasoning':
        text += `<reasoning>${block.text}</reasoning>`
        break
      case 'image':
        text += '[image]'
        break
      case 'tool-call':
        text += `<tool-call name="${block.name}" arguments="${block.arguments.replace(/"/g, '&quot;')}"/>`
        break
      case 'tool-result':
        text += `<tool-result tool-call-id="${block.toolCallId}" is-error="${String(block.isError ?? false)}">\n`
        for (const inner of block.content) {
          if (inner.type === 'text') text += inner.text
          else text += `[${inner.type}]`
        }
        text += '\n</tool-result>'
        break
      default: {
        const fallback = block as { type?: string }
        text += `[${fallback.type ?? 'unknown'}]`
      }
    }
  }
  const source = message.source.kind === 'plugin'
    ? ` source="plugin:${message.source.plugin}"`
    : message.source.kind === 'user' ? '' : ` source="${message.source.kind}"`
  return `<entry seq="${seq}" role="${role}"${source}>\n${text}\n</entry>`
}

/**
 * Serialize a message batch into one reviewer feed prompt, bounded by a token
 * budget (chars/4 heuristic). Truncation keeps the head of the batch and
 * marks the cut so the reviewer knows the transcript was trimmed.
 * @param kind - `baseline` frames the whole bounded surface after a reset;
 *   `delta` frames new activity since the last feed.
 * @param messages - projected messages in surface order.
 * @param seqs - the seq of each message.
 * @param maxTokens - prompt token budget.
 * @param context - extra context line (e.g. the primary session id).
 * @returns the serialized prompt plus bookkeeping.
 */
export function serializeDelta(
  kind: FeedKind,
  messages: readonly Message[],
  seqs: readonly number[],
  maxTokens: number,
  context: string,
): SerializedDelta {
  const isBaseline = kind === 'baseline'
  const frame = isBaseline
    ? 'advisor-baseline'
    : 'advisor-delta'
  const opening = isBaseline
    ? 'The session transcript was rebuilt (compaction, rewrite, or fork). This is the current bounded transcript; review it against your guidance and call `advise` when the primary agent\'s state warrants it.'
    : 'New primary-transcript activity since your last review:'
  const header = `<${frame} ${isBaseline ? 'kind="baseline"' : `seqs="${firstLast(seqs)}"`} context="${context}">\n${opening}\n`
  const footer = `\n</${frame}>\n\nEvaluate the activity above against your guidance. If the primary agent needs correction, call the \`advise\` tool with a severity grade (\`nit\` = non-interrupting aside, \`concern\` = substantive risk, \`blocker\` = continued work is wasted) and a concise, actionable note. Weigh your guidance: the primary agent decides.`
  const budget = Math.max(1, Math.floor(maxTokens * 4))

  let body = ''
  let count = 0
  let truncated = false
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message === undefined) continue
    const seq = seqs[i] ?? 0
    const entry = renderEntry(seq, message)
    const candidate = body + entry + '\n'
    // Always keep the first entry even if it alone overflows the budget;
    // everything after the budget boundary is dropped.
    if (count > 0 && body.length + entry.length + header.length + footer.length > budget) {
      truncated = true
      break
    }
    body = candidate
    count++
  }
  let text = header + body + footer
  if (truncated) {
    text = header + body + '\n[delta truncated: further entries exceed the token budget]\n' + footer
  }
  return { text, messageCount: count, truncated }
}

/** Render a seq range like `10..12` (or a bare seq for one). */
function firstLast(seqs: readonly number[]): string {
  if (seqs.length === 0) return ''
  const first = seqs[0]
  const last = seqs[seqs.length - 1]
  if (first === undefined) return ''
  if (last === undefined || last === first) return String(first)
  return `${first}..${last}`
}

/**
 * Trailing review-gate flag parsing and the model-facing strip.
 *
 * The user marks a task by suffixing their input: `--review` (plan first, wait
 * for approval), `--no-review` (cancel this task's gate) and `--workers N`
 * (how many reviewers this round runs). The flags are stripped from the
 * model-facing message text so the model never reads the literal tokens; when
 * two review flags are present the one nearest the end of the input wins.
 *
 * @module @dsh-plugin/dsh-review-gate/flags
 */

import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'

/** One parsed user-input boundary. */
export interface InputFlags {
  /** The input with every trailing flag removed (right-trimmed). */
  readonly text: string
  /** `true` for `--review`, `false` for `--no-review`, absent when neither appeared. */
  readonly review?: boolean
  /** Reviewer count from `--workers N`, absent when the flag did not appear. */
  readonly workers?: number
}

/** Where the strip must be applied: one text block of one claimed user message. */
export interface FlagTarget {
  readonly messageId: MessageId
  readonly blockIndex: number
  readonly text: string
}

/**
 * Read the `kind` discriminant off a merge-extensible message source without
 * asserting a shape the compiler cannot prove (unknown kinds are legal).
 * @param source - one message source.
 * @returns the string kind, or `undefined` when it carries none.
 */
function sourceKind(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null || !('kind' in source)) return undefined
  const kind: unknown = source.kind
  return typeof kind === 'string' ? kind : undefined
}

const TRAILING_NO_REVIEW = /(^|\s)--no-review\s*$/
const TRAILING_REVIEW = /(^|\s)--review\s*$/
const TRAILING_WORKERS = /(^|\s)--workers(?:=|\s+)(\d+)\s*$/

/**
 * Parse the trailing flag suffix of one user input. Flags must sit at the very
 * end and be separated from the message body (and from each other) by
 * whitespace; a token in the middle of the sentence stays ordinary prose.
 * @param input - raw user input text.
 * @returns the stripped text plus whichever flags were recognized.
 */
export function parseInputFlags(input: string): InputFlags {
  let text = input
  let review: boolean | undefined
  let workers: number | undefined
  for (;;) {
    // Stripping runs from the end of the input, so the flag nearest the end
    // claims the review outcome (the `??=` guard keeps the first claim).
    const noReview = TRAILING_NO_REVIEW.exec(text)
    if (noReview !== null) {
      review ??= false
      text = text.slice(0, noReview.index + noReview[1]!.length)
      continue
    }
    const reviewMatch = TRAILING_REVIEW.exec(text)
    if (reviewMatch !== null) {
      review ??= true
      text = text.slice(0, reviewMatch.index + reviewMatch[1]!.length)
      continue
    }
    const workersMatch = TRAILING_WORKERS.exec(text)
    if (workersMatch !== null) {
      workers ??= Number(workersMatch[2])
      text = text.slice(0, workersMatch.index + workersMatch[1]!.length)
      continue
    }
    return {
      text: text.trimEnd(),
      ...review === undefined ? {} : { review },
      ...workers === undefined ? {} : { workers },
    }
  }
}

/**
 * Locate the flag carrier: the last text block of the last claimed message
 * that came from the user directly. No other source can carry a flag gesture.
 * @param messages - the step's claimed batch, in order.
 * @returns the target block, or `undefined` when no direct user text exists.
 */
export function findFlagTarget(messages: readonly UserMessage[]): FlagTarget | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (sourceKind(message.source) !== 'user') continue
    for (let block = message.content.length - 1; block >= 0; block -= 1) {
      const candidate = message.content[block]
      if (candidate === undefined || candidate.type !== 'text') continue
      return { messageId: message.id, blockIndex: block, text: candidate.text }
    }
  }
  return undefined
}

/**
 * Rewrite the targeted text block to the stripped text, preserving message
 * identity. A block emptied by the strip is dropped; a message left with no
 * content is dropped from the model-facing batch entirely (the gate notice
 * injected alongside carries the intent).
 * @param messages - the batch to rewrite.
 * @param target - the block {@link findFlagTarget} located.
 * @param text - the stripped replacement text (`''` drops the block).
 * @returns a new batch; unchanged messages keep their identity.
 */
export function stripFlags(
  messages: readonly UserMessage[],
  target: FlagTarget,
  text: string,
): UserMessage[] {
  const outgoing: UserMessage[] = []
  for (const message of messages) {
    if (message.id !== target.messageId) {
      outgoing.push(message)
      continue
    }
    const content: ContentBlock[] = []
    message.content.forEach((block, index) => {
      if (index !== target.blockIndex || block.type !== 'text') {
        content.push(block)
        return
      }
      if (text !== '') content.push({ type: 'text', text })
    })
    if (content.length > 0) outgoing.push(freezeMessage({ ...message, content }))
  }
  return outgoing
}

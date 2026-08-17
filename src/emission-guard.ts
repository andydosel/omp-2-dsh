/**
 * Emission guard: normalization, empty-phrase filtering, session dedupe, and
 * the one-accepted-note-per-reviewer-update rate limit. Pure logic, fully
 * unit-testable without any harness dependency.
 *
 * Normalization is NFKC + lowercase + non-alphanumeric collapse. Dedupe is a
 * FIFO set (default capacity 4096) keyed by the normalized note. The
 * per-update rate limit tracks one accepted note per reviewer id between
 * `beginUpdate`/`endUpdate` calls, so a reviewer that calls `advise` twice in
 * one delta review only ever emits one advisory.
 *
 * @module @dsh-plugin/dsh-advisor/emission-guard
 */

/** Why a note was not accepted. */
export type GuardRejectionReason = 'duplicate' | 'empty' | 'rate-limited'

/** Result of one {@link EmissionGuard.accept} call. */
export interface GuardedEmission {
  readonly accepted: boolean
  /** The original note, unchanged. */
  readonly note: string
  /** The normalized note (dedupe key). */
  readonly normalized: string
  /** Present when `accepted` is false. */
  readonly reason?: GuardRejectionReason
}

/**
 * Phrase that carries no advisory content once normalized: accept is refused
 * because delivering it would only add noise to the primary transcript.
 */
const EMPTY_PHRASES: ReadonlySet<string> = new Set([
  '', 'stop', 'done', 'lgtm', 'ok', 'okay', 'fine', 'noted', 'understood',
  'thanks', 'thank', 'thx', 'ty', 'np', 'good', 'great', 'nice', 'agreed',
  'sounds good', 'will do', 'got it', 'gotcha', 'on it', 'no problem',
  'you bet', 'sure', 'yeah', 'yep', 'right', 'correct', 'true', 'yes', 'no',
  'aok', 'roger', 'copy', 'affirmative', 'negative', 'nope', 'nah', 'k',
  'kk', 'mm', 'hmm', 'hm', 'ok thanks', 'thanks ok', 'thank you', 'tyvm',
])

/** Default capacity of the FIFO dedupe set (omp's 4096). */
export const DEFAULT_DEDUPE_LIMIT = 4096

/**
 * Normalize a note for comparison: NFKC, lowercase, and collapse every run of
 * non-alphanumeric characters to a single space (then trim).
 * @param note - the raw advisory note.
 * @returns the normalized form used as the dedupe key and phrase check.
 */
export function normalizeNote(note: string): string {
  return note.normalize('NFKC').toLowerCase().replace(/[^0-9a-z]+/g, ' ').trim()
}

/**
 * Whether a normalized note is an empty phrase that must not be delivered.
 * @param normalized - a note already run through {@link normalizeNote}.
 * @returns true when the phrase carries no advisory content.
 */
export function isEmptyPhrase(normalized: string): boolean {
  return EMPTY_PHRASES.has(normalized)
}

/** Options for {@link EmissionGuard}. */
export interface EmissionGuardOptions {
  /** FIFO dedupe capacity (default {@link DEFAULT_DEDUPE_LIMIT}). */
  readonly dedupeLimit?: number
}

/**
 * Session-scoped emission guard. State belongs to one primary session and is
 * cleared by {@link reset} on every compaction/rewrite/fork reset signal.
 */
export class EmissionGuard {
  private readonly seen = new Set<string>()
  private readonly order: string[] = []
  private readonly acceptedThisUpdate = new Set<string>()

  constructor(options: EmissionGuardOptions = {}) {
    const dedupeLimit = options.dedupeLimit ?? DEFAULT_DEDUPE_LIMIT
    if (!Number.isSafeInteger(dedupeLimit) || dedupeLimit < 1) {
      throw new Error(`EmissionGuard dedupeLimit must be a positive safe integer, got ${String(dedupeLimit)}`)
    }
    this.dedupeLimit = dedupeLimit
  }

  private readonly dedupeLimit: number

  /** The number of distinct normalized notes currently remembered. */
  get size(): number {
    return this.seen.size
  }

  /** Normalize a note. Kept as a thin alias for callers that need the key. */
  normalize(note: string): string {
    return normalizeNote(note)
  }

  /**
   * Run one note through the full emission pipeline: empty-phrase filter,
   * session dedupe, and the per-reviewer update rate limit. At most one note
   * per reviewer id is accepted between {@link beginUpdate} and
   * {@link endUpdate}.
   * @param note - the advisory note.
   * @param reviewerId - the reviewer session id that produced it.
   * @returns whether the note may be delivered, plus the reason otherwise.
   */
  accept(note: string, reviewerId: string): GuardedEmission {
    const normalized = normalizeNote(note)
    if (isEmptyPhrase(normalized)) {
      return { accepted: false, note, normalized, reason: 'empty' }
    }
    if (this.seen.has(normalized)) {
      return { accepted: false, note, normalized, reason: 'duplicate' }
    }
    if (this.acceptedThisUpdate.has(reviewerId)) {
      return { accepted: false, note, normalized, reason: 'rate-limited' }
    }
    this.seen.add(normalized)
    this.order.push(normalized)
    this.acceptedThisUpdate.add(reviewerId)
    if (this.order.length > this.dedupeLimit) {
      const evicted = this.order.shift()
      if (evicted !== undefined) this.seen.delete(evicted)
    }
    return { accepted: true, note, normalized }
  }

  /** Open one reviewer update window (call before feeding a delta). */
  beginUpdate(reviewerId: string): void {
    // A new update supersedes an unclosed one; the window is a budget, not a
    // stack, so re-opening simply forgets the stale slot.
    this.acceptedThisUpdate.delete(reviewerId)
  }

  /** Close one reviewer update window (call on the reviewer's turn end). */
  endUpdate(reviewerId: string): void {
    this.acceptedThisUpdate.delete(reviewerId)
  }

  /**
   * Clear all guard state — dedupe history, FIFO order, and open update
   * windows. Called on every compaction/rewrite/fork reset.
   */
  reset(): void {
    this.seen.clear()
    this.order.length = 0
    this.acceptedThisUpdate.clear()
  }
}

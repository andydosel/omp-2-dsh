/**
 * The review loop's finding vocabulary and its deterministic arithmetic.
 *
 * A clean reviewer answers with ONE strict-JSON object holding its findings on
 * the review loop's own P0-P3 scale — deliberately NOT the advisor's
 * `nit/concern/blocker` axis (§7.4#3: advisor advice is optional direction,
 * P0-P3 is a must-fix problem classification). The loop's cross-round union,
 * its false-positive filter, and the `zeroP0Approach: 'count'` verdict are all
 * computed here from those reports; none of them consult a model.
 *
 * @module @dsh-plugin/dsh-orchestrator/findings
 */

/** The four severities, most severe first. */
export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const

/** One review-loop priority grade. `P0` blocks the loop from closing. */
export type Severity = (typeof SEVERITIES)[number]

/** One finding as a reviewer reported it (no round provenance yet). */
export interface RawFinding {
  readonly severity: Severity
  readonly summary: string
  readonly evidence?: string
}

/** One accepted finding, tagged with the round that raised it. */
export interface Finding extends RawFinding {
  /** 1-based review round that first raised this finding. */
  readonly sourceRound: number
}

/** Findings per severity. */
export type SeverityCounts = Readonly<Record<Severity, number>>

/** How many review rounds and reviewers the loop has behind it. */
export interface ReviewTally {
  /** Review rounds that dispatched at least one reviewer. */
  readonly rounds: number
  /** Reviewers that completed with a parseable report. */
  readonly reviewers: number
  /** Reviewers that failed, timed out, or returned an unusable report. */
  readonly failures: number
  /** Accepted (non-filtered) findings in the cross-round union. */
  readonly findings: number
  /** Accepted findings per severity. */
  readonly counts: SeverityCounts
  /**
   * Whether the numeric verdict is `clean`: no P0 remains, no reviewer
   * failed, and at least one reviewer actually reported. A round with zero
   * reviewers or one crashed reviewer must never read as "zero P0" — that is
   * the fail-closed half of `zeroP0Approach: 'count'`.
   */
  readonly zeroP0: boolean
}

/** Bound one reviewer summary; a pathological reviewer cannot bloat the union. */
const SUMMARY_MAX_CHARS = 2000

/** Bound one reviewer evidence snippet. */
const EVIDENCE_MAX_CHARS = 1000

/** Refuse to even scan a reviewer reply beyond this size. */
const REPORT_MAX_CHARS = 200_000

/** Whether one value is a review-loop severity. */
export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value)
}

/**
 * Estimate the token size of one text (4 characters per token, rounded up).
 * Used only by the `fanOut.minEffortTokens` gate, where the decision is
 * "is this worth delegating at all" and a 2x error is immaterial.
 */
export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 4)
}

/** Normalize a model-authored severity spelling, or `undefined` when unknown. */
function normalizeSeverity(value: unknown): Severity | undefined {
  if (typeof value !== 'string') return undefined
  const upper = value.trim().toUpperCase()
  return isSeverity(upper) ? upper : undefined
}

/**
 * Read the finding entries out of one parsed report: either the report object's
 * `findings` array, or a bare array.
 */
function reportEntries(parsed: unknown): readonly unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed !== 'object' || parsed === null || !('findings' in parsed)) return undefined
  const findings: unknown = parsed.findings
  return Array.isArray(findings) ? findings : undefined
}

/** Trim one optional string field and bound its length in code points. */
function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const points = [...trimmed]
  return points.length <= maxChars ? trimmed : points.slice(0, maxChars).join('')
}

/**
 * Extract the JSON text of one reviewer reply. A fenced block wins (the role
 * prompt asks for one); otherwise the outermost braces or brackets are taken,
 * whichever opens first, so a bare findings array parses as well as the
 * canonical `{"findings": …}` object.
 */
function extractJsonText(reply: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply)
  const inner = fenced?.[1]?.trim()
  if (inner !== undefined && (inner.startsWith('{') || inner.startsWith('['))) return inner
  const objectStart = reply.indexOf('{')
  const arrayStart = reply.indexOf('[')
  if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
    const end = reply.lastIndexOf(']')
    return end > arrayStart ? reply.slice(arrayStart, end + 1) : undefined
  }
  if (objectStart < 0) return undefined
  const end = reply.lastIndexOf('}')
  return end > objectStart ? reply.slice(objectStart, end + 1) : undefined
}

/**
 * Parse one reviewer reply into validated findings.
 *
 * Fail-closed by contract: ANY entry that is not an object with a known
 * severity and a non-empty summary fails the whole report, so a malformed
 * finding can never silently disappear from the union. The caller counts such
 * a reviewer as a failure, which keeps the loop from closing on a broken round.
 *
 * @param reply - the reviewer's final assistant output.
 * @returns the validated findings (possibly empty), or `undefined` when the
 *   reply carries no usable report.
 */
export function parseReviewerReport(reply: string): RawFinding[] | undefined {
  if (reply.length > REPORT_MAX_CHARS) return undefined
  const json = extractJsonText(reply)
  if (json === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  const entries = reportEntries(parsed)
  if (entries === undefined) return undefined
  const findings: RawFinding[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || !('severity' in entry) || !('summary' in entry)) return undefined
    const severity = normalizeSeverity(entry.severity)
    const summary = boundedText(entry.summary, SUMMARY_MAX_CHARS)
    if (severity === undefined || summary === undefined) return undefined
    const evidence = 'evidence' in entry ? boundedText(entry.evidence, EVIDENCE_MAX_CHARS) : undefined
    findings.push({ severity, summary, ...evidence === undefined ? {} : { evidence } })
  }
  return findings
}

/**
 * Stable identity of one finding inside a loop: its severity plus its
 * whitespace- and case-normalized summary. Two reviewers reporting the same
 * defect under the same words collapse into one union entry.
 */
export function findingKey(finding: RawFinding): string {
  return `${finding.severity}\u0000${finding.summary.trim().toLowerCase().replace(/\s+/g, ' ')}`
}

/**
 * Union one round's findings into the accepted set: deduplicated by
 * {@link findingKey}, first occurrence wins (so provenance stays at the round
 * that raised it).
 */
export function mergeFindings(
  accepted: readonly Finding[],
  incoming: readonly RawFinding[],
  round: number,
): Finding[] {
  const seen = new Set(accepted.map(findingKey))
  const merged = [...accepted]
  for (const finding of incoming) {
    const key = findingKey(finding)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ ...finding, sourceRound: round })
  }
  return merged
}

/** Split findings into the ones whose keys are listed and the ones kept. */
export function partitionFindings(
  findings: readonly Finding[],
  keys: ReadonlySet<string>,
): { readonly removed: Finding[]; readonly kept: Finding[] } {
  const removed: Finding[] = []
  const kept: Finding[] = []
  for (const finding of findings) {
    if (keys.has(findingKey(finding))) removed.push(finding)
    else kept.push(finding)
  }
  return { removed, kept }
}

/** Count findings per severity (every severity present, zero included). */
export function countSeverities(findings: readonly Finding[]): SeverityCounts {
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}

/**
 * Compute the loop's tally and its numeric verdict from the accepted union.
 * @param findings - the accepted cross-round union.
 * @param rounds - review rounds that dispatched at least one reviewer.
 * @param reviewers - reviewers that completed with a parseable report.
 * @param failures - reviewers that failed, timed out, or were unparseable.
 */
export function tally(
  findings: readonly Finding[],
  rounds: number,
  reviewers: number,
  failures: number,
): ReviewTally {
  const counts = countSeverities(findings)
  return {
    rounds,
    reviewers,
    failures,
    findings: findings.length,
    counts,
    zeroP0: counts.P0 === 0 && rounds > 0 && reviewers > 0 && failures === 0,
  }
}

/** Compact single-line rendering of one finding (tool output and reports). */
export function renderFinding(finding: {
  readonly severity: Severity
  readonly summary: string
  readonly sourceRound?: number
}): string {
  return finding.sourceRound === undefined
    ? `${finding.severity}: ${finding.summary}`
    : `${finding.severity} (round ${finding.sourceRound}): ${finding.summary}`
}

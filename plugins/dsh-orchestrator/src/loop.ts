/**
 * One review loop's durable-in-process state: the review rounds it ran, the
 * cross-round union of accepted findings, the false positives its lead
 * rejected, and the two exits.
 *
 * The class is pure state and arithmetic — no context, no goal service, no
 * dispatch. The runtime owns the effects (spawning the carrier and reviewers,
 * mutating the goal); this owns "what is true about this loop", so the
 * `zeroP0Approach: 'count'` verdict is one deterministic function of the
 * rounds that actually ran (§5.7: reliability from a number, not a feeling).
 *
 * @module @dsh-plugin/dsh-orchestrator/loop
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Finding, RawFinding, ReviewTally, SeverityCounts } from './findings.ts'
import { countSeverities, findingKey, mergeFindings, partitionFindings, tally } from './findings.ts'

/** Where one loop is in its lifecycle. */
export type LoopStatus =
  /** Review rounds are running (or may run again). */
  | 'reviewing'
  /** A round reported zero P0: the approved work may proceed; the goal is still open. */
  | 'cleared'
  /** A human decision is outstanding (`goal.block`); the loop is waiting. */
  | 'blocked'
  /** The goal is closed (`goal.complete`) and the report was relayed. */
  | 'complete'

/**
 * One finding's rejection request: the finding to remove from the union plus
 * why. A P0 that the revised plan ANSWERS must leave the union too, otherwise
 * the numeric verdict could never reach zero (the union is cumulative); the
 * reason keeps the two cases distinguishable in the transcript.
 */
export interface RejectionRequest extends RawFinding {
  /** `false-positive` (default) or `resolved` (the revised plan answers it). */
  readonly reason?: string
}

/** One finding removed from the union, with the reason it was removed. */
export interface FilteredFinding extends Finding {
  readonly reason: string
}

/** How one dispatched child settled, as the loop needs to read it. */
export interface DispatchReport {
  readonly status: 'completed' | 'timeout' | 'aborted' | 'disposed' | 'error'
  /**
   * The child's parsed findings. ABSENT (not empty) when the child produced no
   * usable report — an unparseable reviewer is a FAILURE, never a clean round.
   */
  readonly findings?: readonly RawFinding[]
}

/** One round's request to the loop. */
export interface RoundInput {
  /** 1-based round number (see {@link ReviewLoop.nextRound}). */
  readonly round: number
  /** Reviewers dispatched in this round. */
  readonly dispatched: number
  readonly outcomes: readonly DispatchReport[]
}

/** What one round did, as reported back to the model and kept in the loop. */
export interface RoundRecord {
  readonly round: number
  readonly dispatched: number
  /** Reviewers that returned a parseable report. */
  readonly completed: number
  /** Reviewers that failed, timed out, or were unparseable. */
  readonly failures: number
  /** New findings this round added to the accepted union. */
  readonly raised: number
  /** Accepted-union counts after this round. */
  readonly counts: SeverityCounts
  /** Whether the round left the loop clean (see {@link ReviewTally.zeroP0}). */
  readonly zeroP0: boolean
}

/** A machine-routable blocked reason (the goal service's own vocabulary). */
export interface LoopBlockReason {
  readonly code: string
  readonly message: string
}

/** Everything the loop needs to know at creation. */
export interface LoopInit {
  readonly loopId: string
  /** The review-work subagent carrying the goal. */
  readonly carrierId: SessionId
  /** The session that delegated the objective (the carrier's parent). */
  readonly leadId: SessionId
  readonly objective: string
  /** The id of the goal created on the carrier's session. */
  readonly goalId: string
}

/** The loop's whole value (service `status()`, reports, tests). */
export interface LoopSnapshot {
  readonly loopId: string
  readonly carrierId: SessionId
  readonly leadId: SessionId
  readonly objective: string
  readonly goalId: string
  readonly status: LoopStatus
  readonly round: number
  readonly tally: ReviewTally
  readonly findings: readonly Finding[]
  readonly filtered: readonly FilteredFinding[]
  readonly rounds: readonly RoundRecord[]
  readonly blockedReason?: LoopBlockReason
}

/** One loop's live state and lifecycle rules. */
export class ReviewLoop {
  private readonly init: LoopInit
  private status: LoopStatus = 'reviewing'
  private readonly rounds: RoundRecord[] = []
  private accepted: Finding[] = []
  private readonly filtered: FilteredFinding[] = []
  private reviewers = 0
  private failures = 0
  private blockedReason: LoopBlockReason | undefined

  constructor(init: LoopInit) {
    this.init = init
  }

  get id(): string {
    return this.init.loopId
  }

  get carrierId(): SessionId {
    return this.init.carrierId
  }

  get leadId(): SessionId {
    return this.init.leadId
  }

  get objective(): string {
    return this.init.objective
  }

  get goalId(): string {
    return this.init.goalId
  }

  get currentStatus(): LoopStatus {
    return this.status
  }

  /** Accepted findings (the union the verdict is computed from). */
  get acceptedFindings(): readonly Finding[] {
    return this.accepted
  }

  /** The 1-based number of the next round. */
  nextRound(): number {
    return this.rounds.length + 1
  }

  /**
   * Enter the review phase, reporting a later round/filter as reopening an
   * already-cleared phase (a clearance is only good for the union it saw).
   */
  private enterReviewPhase(action: string): void {
    if (this.status === 'blocked') {
      throw new Error(`review loop ${this.init.loopId} is blocked (${this.blockedReason?.code ?? 'no reason'}): resume it first`)
    }
    if (this.status === 'complete') {
      throw new Error(`review loop ${this.init.loopId} is complete: ${action} is no longer possible`)
    }
    if (this.status === 'cleared') this.status = 'reviewing'
  }

  /** The loop's current numeric verdict. */
  tally(): ReviewTally {
    return tally(this.accepted, this.rounds.filter(record => record.dispatched > 0).length, this.reviewers, this.failures)
  }

  /**
   * Fold one round's reviewer reports into the union.
   * @param input - the round number, dispatched reviewers, and their reports.
   * @returns the round record (counts and verdict after this round).
   * @throws when the loop is not in its review phase.
   */
  recordRound(input: RoundInput): RoundRecord {
    this.enterReviewPhase('another review round')
    const incoming: RawFinding[] = []
    let completed = 0
    let failures = 0
    for (const outcome of input.outcomes) {
      if (outcome.status === 'completed' && outcome.findings !== undefined) {
        completed += 1
        incoming.push(...outcome.findings)
      } else {
        failures += 1
      }
    }
    // A finding its lead already rejected as a false positive must not come
    // back through a later reviewer's report.
    const rejectedKeys = new Set(this.filtered.map(findingKey))
    const admissible = incoming.filter(finding => !rejectedKeys.has(findingKey(finding)))
    const before = this.accepted.length
    this.accepted = mergeFindings(this.accepted, admissible, input.round)
    this.reviewers += completed
    this.failures += failures
    const verdict = this.tally()
    const record: RoundRecord = {
      round: input.round,
      dispatched: input.dispatched,
      completed,
      failures,
      raised: this.accepted.length - before,
      counts: countSeverities(this.accepted),
      zeroP0: verdict.zeroP0,
    }
    this.rounds.push(record)
    return record
  }

  /**
   * Remove findings from the accepted union: the false positives the lead
   * disproved, and the ones a revised plan already answers. Removed findings
   * stop counting (that is what makes the numeric zero-P0 verdict reachable at
   * all: the union is cumulative) and are retained with their reason.
   * @param reject - the findings to remove, matched by severity + summary.
   * @returns the removed findings plus the rejections that matched nothing.
   */
  filterFindings(reject: readonly RejectionRequest[]): {
    readonly removed: readonly FilteredFinding[]
    readonly unmatched: readonly RejectionRequest[]
  } {
    this.enterReviewPhase('filtering findings')
    const reasonByKey = new Map(reject.map(request => [findingKey(request), request.reason ?? 'false-positive']))
    const { removed, kept } = partitionFindings(this.accepted, new Set(reasonByKey.keys()))
    this.accepted = kept
    const removedFindings = removed.map(finding => ({ ...finding, reason: reasonByKey.get(findingKey(finding)) ?? 'false-positive' }))
    this.filtered.push(...removedFindings)
    const removedKeys = new Set(removedFindings.map(findingKey))
    return { removed: removedFindings, unmatched: reject.filter(request => !removedKeys.has(findingKey(request))) }
  }

  /**
   * Close the review phase on a zero-P0 verdict (exit A's gate). The goal stays
   * open: the approved plan still has to be implemented and verified.
   * @returns the verdict the loop closed on.
   * @throws while any P0 is accepted, while a reviewer failure leaves the round
   *   uncertified, or when the loop is already past its review phase.
   */
  clear(): ReviewTally {
    if (this.status !== 'reviewing') {
      throw new Error(`review loop ${this.init.loopId} is ${this.status}: the review phase is already closed`)
    }
    const verdict = this.tally()
    if (verdict.counts.P0 > 0) {
      const summaries = this.accepted.filter(finding => finding.severity === 'P0').map(finding => finding.summary)
      throw new Error(
        `cannot close the review phase: ${verdict.counts.P0} P0 finding(s) remain — ${summaries.join(' | ')}`,
      )
    }
    if (verdict.rounds === 0 || verdict.reviewers === 0) {
      throw new Error('cannot close the review phase: no reviewer has reported yet — run review_round first')
    }
    if (verdict.failures > 0) {
      throw new Error(
        `cannot close the review phase: ${verdict.failures} reviewer(s) failed, timed out, or returned an unusable report — rerun the round`,
      )
    }
    this.status = 'cleared'
    return verdict
  }

  /**
   * Validate exit A's completion WITHOUT mutating the loop. The runtime calls
   * this first, then mutates the goal, then {@link markComplete} — so a goal
   * mutation that fails (a stale revision, a session that ended) cannot leave
   * the loop claiming a completion the goal service never recorded.
   * @returns the verdict the loop would close on.
   * @throws when the review phase is not cleared, or the verdict is no longer zero-P0.
   */
  assertCompletable(): ReviewTally {
    if (this.status === 'complete') {
      throw new Error(`review loop ${this.init.loopId} is already complete`)
    }
    if (this.status !== 'cleared') {
      throw new Error(`review loop ${this.init.loopId} is ${this.status}: close the review phase with review_finish() first`)
    }
    const verdict = this.tally()
    if (!verdict.zeroP0) {
      throw new Error('cannot complete the review loop: the accepted findings are no longer zero-P0')
    }
    return verdict
  }

  /** Record exit A's completion after the goal service accepted it. */
  markComplete(): void {
    this.assertCompletable()
    this.status = 'complete'
  }

  /** Validate exit B's block without mutating the loop. */
  assertBlockable(): void {
    if (this.status === 'complete') {
      throw new Error(`review loop ${this.init.loopId} is complete: it cannot be blocked`)
    }
    if (this.status === 'blocked') {
      throw new Error(`review loop ${this.init.loopId} is already blocked`)
    }
  }

  /** Enter the human-decision wait (exit B) after the goal service accepted it. */
  markBlocked(reason: LoopBlockReason): void {
    this.assertBlockable()
    this.status = 'blocked'
    this.blockedReason = { code: reason.code, message: reason.message }
  }

  /** Validate the return from the human-decision wait without mutating the loop. */
  assertResumable(): void {
    if (this.status !== 'blocked') {
      throw new Error(`review loop ${this.init.loopId} is ${this.status}: there is no blocked decision to resume`)
    }
  }

  /** Return from the human-decision wait after the goal service accepted it. */
  markResumed(): void {
    this.assertResumable()
    this.status = 'reviewing'
    this.blockedReason = undefined
  }

  /** The loop's whole value. */
  snapshot(): LoopSnapshot {
    return {
      loopId: this.init.loopId,
      carrierId: this.init.carrierId,
      leadId: this.init.leadId,
      objective: this.init.objective,
      goalId: this.init.goalId,
      status: this.status,
      round: this.rounds.length,
      tally: this.tally(),
      findings: [...this.accepted],
      filtered: [...this.filtered],
      rounds: [...this.rounds],
      ...this.blockedReason === undefined ? {} : { blockedReason: { ...this.blockedReason } },
    }
  }
}

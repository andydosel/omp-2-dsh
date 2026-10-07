/**
 * Prompt construction for the review loop: the fixed procedure the review-work
 * subagent follows (the "定制化 goal" methodology of §5.7), the one-shot clean
 * reviewer's role, the per-reviewer brief, and the completion report the
 * carrier relays to its lead.
 *
 * The methodology lives in the initial prompt, not in a prompt section: the
 * carrier is established by `subagents.startContinuable`, whose child
 * composition the continuation manager owns (a caller can supply `agentOptions`,
 * `toolFilter`, and `persona` — not an arbitrary scoped section). Carrying the
 * procedure as the child's very first user message also keeps it inside the
 * durable transcript this loop is audited from.
 *
 * @module @dsh-plugin/dsh-orchestrator/briefs
 */

import type { Severity } from './findings.ts'
import { SEVERITIES } from './findings.ts'

/** One-line meaning of each grade, shared by the role, the brief, and the report. */
const SEVERITY_LEGEND: Readonly<Record<Severity, string>> = {
  P0: 'P0 — the objective is not met / the work is wrong or unsafe; the loop MUST NOT close',
  P1: 'P1 — a real defect the implementer must fix before this round is done',
  P2: 'P2 — a worthwhile improvement, not blocking',
  P3: 'P3 — a nit; record it and move on',
}

/** Render the severity legend as one block. */
export function renderSeverityLegend(): string {
  return SEVERITIES.map(severity => `- ${SEVERITY_LEGEND[severity]}`).join('\n')
}

/** The reviewer agent's role section (installed on its own scoped ctx). */
export function renderReviewerRole(): string {
  return [
    'You are a one-shot independent reviewer dispatched by an orchestrator review round.',
    'You have exactly one task, no prior rounds, and no memory of any other reviewer: judge only what you are handed and what you verify in the workspace.',
    'You are READ-ONLY (read/grep/glob): never propose that you edit anything yourself, and never assume an unverified claim is true — open the files.',
    'Finish with ONE JSON object and nothing else around it:',
    '{"findings":[{"severity":"P0|P1|P2|P3","summary":"one line","evidence":"file:line or exact quote + why it matters"}]}',
    'An empty array is a valid, expected answer:',
    '{"findings":[]}',
    renderSeverityLegend(),
    'Report only findings you can point at. Do not pad the list, do not restate the plan, and do not invent findings to look useful.',
  ].join('\n')
}

/** The per-reviewer brief: only the plan, the code references, and the focus. */
export function renderReviewerBrief(input: {
  readonly round: number
  readonly index: number
  readonly total: number
  readonly plan: string
  readonly files: readonly string[]
  readonly focus?: string
}): string {
  const sections = [
    `<review_task round="${input.round}" reviewer="${input.index} of ${input.total}">`,
    'Plan under review:',
    input.plan.trim(),
  ]
  if (input.files.length > 0) {
    sections.push('', 'Inspect these paths (read them; do not trust the plan\'s description of them):', ...input.files.map(file => `- ${file}`))
  }
  if (input.focus !== undefined && input.focus.trim() !== '') {
    sections.push('', `Focus: ${input.focus.trim()}`)
  }
  sections.push(
    '',
    'Answer with the JSON object described in your role instructions, and nothing else.',
    '</review_task>',
  )
  return sections.join('\n')
}

/** The review-work subagent's fixed procedure (its goal methodology). */
export function renderLoopMethodology(input: {
  readonly objective: string
  readonly plan?: string
  readonly files: readonly string[]
  readonly reviewersPerRound: number
  readonly maxGoalRounds: number
  readonly zeroP0Approach: string
}): string {
  const sections = [
    '<review_loop>',
    `Objective: ${input.objective.trim()}`,
    '',
    'You carry ONE goal for exactly this objective, and the orchestrator already created it (do not create another one). '
      + 'You are the lead of this review loop: you design the approach, dispatch the reviewers, filter their false positives, '
      + 'and decide the two exits. Reviewers are clean one-shot agents with no memory of previous rounds — '
      + 'each round\'s reviewers see only the plan and the code references you hand them.',
    '',
    'Procedure:',
    '1. State the plan (the approach, the deliverable, and its acceptance criteria) as your first message. '
      + 'Keep it concrete; the reviewer rounds are only as good as the plan they review.',
  ]
  if (input.plan !== undefined && input.plan.trim() !== '') {
    sections.push('', 'The plan as briefed:', input.plan.trim())
  }
  if (input.files.length > 0) {
    sections.push('', 'Code in scope (pass these paths to every round):', ...input.files.map(file => `- ${file}`))
  }
  sections.push(
    '',
    `2. Run a review round: call \`review_round({plan, files, focus})\`. The orchestrator dispatches `
      + `${input.reviewersPerRound} fresh reviewers, parses their reports, unions the findings across rounds and returns the counts. `
      + 'The count is authoritative — never grade findings up or down in your head.',
    '3. Remove findings that no longer stand: `review_filter({reject:[{severity, summary, reason}], note})` with reason '
      + '"false-positive" for one you can DISPROVE yourself (read the code) and "resolved" for one your revised plan now answers. '
      + 'The union is cumulative, so a P0 stays counted until you remove it explicitly — and a wrongly removed P0 is a review that lied.',
    '4. While any P0 remains, revise the plan so its P0s are answered, remove the answered findings, and run another round. '
      + 'Repeat until a round reports zero P0 with no reviewer failure.',
    '5. EXIT A — zero P0: call `review_finish()` to close the review phase (it refuses while any P0 remains), '
      + 'then do the work that follows the approved plan (use `subtask_parallel` to fan out independent implementation tasks), '
      + 'verify the result, and call `review_complete()` to close the goal and report to whoever delegated this objective.',
    '6. EXIT B — a decision only a human can make (a genuine product/trade-off call, or something irreversible): '
      + 'call `review_block({code, message})`. That stops the loop and waits. Your parent relays the answer back to you as a message; '
      + 'when it arrives, call `review_resume()` to continue with this goal.',
    '',
    'Rules:',
    `- The goal\'s round cap is ${input.maxGoalRounds}; each automatic round also has a goal round prompt. Stay inside the objective.`,
    `- zero-P0 verdict mechanism: ${input.zeroP0Approach} (a numeric count of the accepted union, not a feeling).`,
    '- Reviewers that fail or time out are counted as failures, and a round with failures is never clean: rerun the round.',
    '- Do not let a reviewer talk you out of a P0, and do not close the goal while any P0 is accepted.',
    '</review_loop>',
  )
  return sections.join('\n')
}

/** The completion report the carrier relays to its lead (and the human sees). */
export function renderCompletionReport(input: {
  readonly objective: string
  readonly rounds: number
  readonly reviewers: number
  readonly failures: number
  readonly counts: Readonly<Record<Severity, number>>
  readonly filtered: number
  readonly summary?: string
  readonly carrierId: string
}): string {
  const counts = SEVERITIES.map(severity => `${severity}=${input.counts[severity]}`).join(' ')
  return [
    '[orchestrator] review loop complete',
    `Objective: ${input.objective}`,
    `Rounds: ${input.rounds} · reviewers: ${input.reviewers} (failures ${input.failures}) · accepted findings: ${counts} · filtered as false positive: ${input.filtered}`,
    ...input.summary === undefined || input.summary.trim() === '' ? [] : [`Outcome: ${input.summary.trim()}`],
    `Full transcript: read agent://${input.carrierId}`,
  ].join('\n')
}

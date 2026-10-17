/**
 * The orchestrator's model-facing tools.
 *
 * - `subtask_parallel` — the recursive fan-out: N tasks, one concurrent batch,
 *   unified collection, failure isolation, behind the three gates.
 * - `review_loop` — the delegating agent (a lead) starts one review loop:
 *   this plugin spawns the disposable review-work subagent that CARRIES the
 *   goal and returns immediately.
 * - `review_round` / `review_filter` / `review_finish` — the round, the lead's
 *   false-positive filter, and the numeric zero-P0 verdict that gates the exit.
 * - `review_complete` / `review_block` / `review_resume` — the two exits
 *   (§5.7): zero P0 → complete + report; a human decision → block → wait →
 *   resume.
 *
 * Every tool returns a COMPACT projection (counts and one-line findings), never
 * the loop's internal value: the model reads the counts, and the full state
 * stays reachable through the service and the carrier's transcript.
 *
 * The `review_*` tools are registered on the root context like
 * `subtask_parallel`, but they are authority-gated: the runtime resolves the
 * caller among the loops it started and refuses any other agent, so only the
 * review-work subagent of a given loop can drive that loop.
 *
 * @module @dsh-plugin/dsh-orchestrator/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GoalBlockReason } from '@deepseek-ai/dsh-goal'
import type { OrchestratorRuntime } from './runtime.ts'
import type { FanOutPlan } from './fanout.ts'
import type { RejectionRequest } from './loop.ts'
import { SEVERITIES, renderFinding, type Finding, type RawFinding, type Severity, type SeverityCounts } from './findings.ts'

/** One text block, the shape every renderer returns. */
function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

/** The calling agent, or a loud failure (tools never run without one). */
function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) {
    throw new Error('orchestrator tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/** The compact finding row every tool emits. */
const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    severity: { type: 'string', required: true, enum: [...SEVERITIES] },
    summary: { type: 'string', required: true },
    sourceRound: { type: 'integer' },
  },
} as const

/** The compact severity counters every review tool emits. */
const COUNTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    P0: { type: 'integer', required: true },
    P1: { type: 'integer', required: true },
    P2: { type: 'integer', required: true },
    P3: { type: 'integer', required: true },
  },
} as const

/** Project one accepted finding onto the wire row. */
function findingRow(finding: Finding): { severity: Severity; summary: string; sourceRound: number } {
  return { severity: finding.severity, summary: finding.summary, sourceRound: finding.sourceRound }
}

/** Project one raw (unaccepted) finding onto the wire row. */
function rawRow(finding: RawFinding): { severity: Severity; summary: string } {
  return { severity: finding.severity, summary: finding.summary }
}

/** Project the counts object (copy, so the tool result owns no live state). */
function countsRow(counts: SeverityCounts): { P0: number; P1: number; P2: number; P3: number } {
  return { P0: counts.P0, P1: counts.P1, P2: counts.P2, P3: counts.P3 }
}

/** Refuse a fan-out with the gate's code and reason attached. */
function refuseFanOut(plan: Extract<FanOutPlan, { kind: 'do-it-yourself' }>): never {
  throw new Error(`subtask_parallel refused [${plan.refusal.code}]: ${plan.refusal.reason}`)
}

/**
 * `subtask_parallel`: dispatch N independent sub-tasks concurrently.
 * @param runtime - the orchestrator runtime (gates, dispatch, accounting).
 */
export function defineSubtaskParallelTool(runtime: OrchestratorRuntime): ToolDefinition {
  return defineTool({
    name: 'subtask_parallel',
    description: 'Dispatch independent sub-tasks CONCURRENTLY to fresh sub-agents and collect their results in one call. '
      + 'Use it when work genuinely splits into 2+ independent pieces worth a separate context; do not use it for work you can finish here. '
      + 'Each task\'s `brief` is the child\'s ONLY context, so make it self-contained (goal, constraints, deliverable). '
      + 'role "worker" (default) spawns a durable implementation worker that keeps its conversation; '
      + 'role "reviewer" spawns a ONE-SHOT, read-only clean reviewer that must answer with a JSON findings report. '
      + 'model "fast" is for mechanical work, "good" (default) for judgment. '
      + 'The call waits for every child\'s first turn and returns each one\'s outcome; a failed child is reported in place, never as a failed batch. '
      + 'Three deployment gates bound recursion (depth, total agents, and whether the split is worth it) — when one refuses, the reason tells you to do the work here instead.',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: 'The sub-tasks to dispatch concurrently, in result order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            brief: { type: 'string', required: true, description: 'The complete self-contained task prompt for that child.' },
            model: { type: 'string', enum: ['fast', 'good'], description: 'Dispatch tier: fast = mechanical, good = judgment (default).' },
            role: { type: 'string', enum: ['worker', 'reviewer'], description: 'worker (default) = durable implementation child; reviewer = one-shot read-only clean reviewer.' },
            toolFilter: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional tool allow-list for a worker (design §5.10). It can only narrow the worker toolset; names outside the worker vocabulary are ignored.',
            },
          },
        },
      },
      maxDepth: {
        type: 'integer',
        description: 'Optional TIGHTER delegation-depth cap for this dispatch (the deployment bound still applies).',
      },
      maxTotalAgents: {
        type: 'integer',
        description: 'Optional TIGHTER sub-agent budget for this dispatch (the deployment bound still applies).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskIndex: { type: 'integer', required: true },
                value: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    role: { type: 'string', required: true, enum: ['worker', 'reviewer'] },
                    status: {
                      type: 'string',
                      required: true,
                      enum: ['completed', 'timeout', 'aborted', 'disposed', 'error'],
                    },
                    output: { type: 'string' },
                    error: { type: 'string' },
                    findings: { type: 'array', items: FINDING_SCHEMA },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => text(value.results.map((row) => {
        const status = `${row.value.role} ${row.value.status}`
        const detail = row.value.error ?? row.value.output ?? (row.value.findings === undefined ? '' : `${row.value.findings.length} finding(s)`)
        return detail === '' ? `#${row.taskIndex} ${status}` : `#${row.taskIndex} ${status}: ${detail}`
      }).join('\n')),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const plan = runtime.previewFanOut(agent, {
        tasks: args.tasks,
        ...args.maxDepth === undefined ? {} : { maxDepth: args.maxDepth },
        ...args.maxTotalAgents === undefined ? {} : { maxTotalAgents: args.maxTotalAgents },
      })
      if (plan.kind === 'do-it-yourself') refuseFanOut(plan)
      const results = await runtime.runSubtasks(agent, plan, exec.signal)
      return {
        results: results.map(result => ({
          taskIndex: result.taskIndex,
          value: {
            role: result.value.role,
            status: result.value.status,
            ...result.value.output === undefined ? {} : { output: result.value.output },
            ...result.value.error === undefined ? {} : { error: result.value.error },
            ...result.value.findings === undefined
              ? {}
              : { findings: result.value.findings.map(finding => ({ severity: finding.severity, summary: finding.summary })) },
          },
        })),
      }
    },
  })
}

/** `review_loop`: start one review loop (spawn the carrier, create its goal). */
export function defineReviewLoopTool(runtime: OrchestratorRuntime): ToolDefinition {
  return defineTool({
    name: 'review_loop',
    description: 'Start ONE review loop for an objective: this plugin spawns a disposable review-work sub-agent that carries a goal, '
      + 'runs the design → clean-reviewer rounds → zero-P0 → implement → verify procedure on its own, and reports back to you when it closes. '
      + 'Returns immediately with the loop and sub-agent ids (this call does NOT wait for the review). '
      + 'Give it the objective and (when you have one) the plan and the code paths in scope: each round\'s reviewers see only those. '
      + 'If the review work hits a decision only a human can make, the sub-agent blocks and you are told — relay the answer to it with your subagent messaging tool.',
    parameters: {
      objective: { type: 'string', required: true, description: 'What must end up reviewed, implemented, and verified.' },
      plan: { type: 'string', description: 'Your current plan/design for the objective, if you already drafted one.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Absolute or workspace-relative paths the rounds should inspect.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loopId: { type: 'string', required: true },
          carrierId: { type: 'string', required: true },
          goalId: { type: 'string', required: true },
          objective: { type: 'string', required: true },
          reviewersPerRound: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(
        `review loop ${value.loopId} started on ${value.carrierId} (goal ${value.goalId}, `
        + `${value.reviewersPerRound} clean reviewers per round). It runs on its own and reports back.`,
      ),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const started = await runtime.startLoop(agent, {
        objective: args.objective,
        ...args.plan === undefined ? {} : { plan: args.plan },
        ...args.files === undefined ? {} : { files: args.files },
      }, exec.signal)
      return {
        loopId: started.loop.loopId,
        carrierId: String(started.loop.carrierId),
        goalId: started.loop.goalId,
        objective: started.loop.objective,
        reviewersPerRound: started.reviewersPerRound,
      }
    },
  })
}

/** `review_round`: one round of fresh clean reviewers. */
export function defineReviewRoundTool(runtime: OrchestratorRuntime): ToolDefinition {
  return defineTool({
    name: 'review_round',
    description: 'Run one review round on the plan you hand it: the orchestrator dispatches fresh one-shot clean reviewers (read-only, '
      + 'no memory of earlier rounds), parses their reports, and returns the counts of the ACCEPTED findings across all rounds so far. '
      + 'The count is authoritative: a round is clean only when it reports zero P0 and no reviewer failed. '
      + 'Reviewers see ONLY the plan, the files, and the focus you pass here.',
    parameters: {
      plan: { type: 'string', required: true, description: 'The plan/design/brief to review, verbatim.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Paths the reviewers must open and verify.' },
      focus: { type: 'string', description: 'Optional extra focus for this round (a risk, a subsystem, a regression).' },
      reviewers: { type: 'integer', description: 'Optional SMALLER reviewer count for this round; when you omit it the deployment default applies (a user --workers N for this task, if any, wins).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          round: { type: 'integer', required: true },
          dispatched: { type: 'integer', required: true },
          completed: { type: 'integer', required: true },
          failures: { type: 'integer', required: true },
          raised: { type: 'integer', required: true },
          zeroP0: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          counts: { ...COUNTS_SCHEMA, required: true },
          findings: { type: 'array', required: true, items: FINDING_SCHEMA },
          reviewerErrors: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => text([
        `round ${value.round}: ${value.dispatched} reviewer(s), ${value.completed} reported, ${value.failures} failed `
        + `→ P0=${value.counts.P0} P1=${value.counts.P1} P2=${value.counts.P2} P3=${value.counts.P3}`
        + ` (clean: ${value.zeroP0})`,
        ...value.findings.map(finding => `- P${finding.severity.slice(1)} (round ${finding.sourceRound ?? '-'}): ${finding.summary}`),
        ...(value.reviewerErrors ?? []).map(error => `- reviewer failure: ${error}`),
      ].join('\n')),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const result = await runtime.round(agent, {
        plan: args.plan,
        ...args.files === undefined ? {} : { files: args.files },
        ...args.focus === undefined ? {} : { focus: args.focus },
        ...args.reviewers === undefined ? {} : { reviewers: args.reviewers },
      }, exec.signal)
      const reviewerErrors = result.results
        .map(row => row.value.error)
        .filter((error): error is string => error !== undefined)
      return {
        round: result.record.round,
        dispatched: result.record.dispatched,
        completed: result.record.completed,
        failures: result.record.failures,
        raised: result.record.raised,
        zeroP0: result.record.zeroP0,
        status: result.loop.status,
        counts: countsRow(result.record.counts),
        findings: result.loop.findings.map(findingRow),
        ...reviewerErrors.length === 0 ? {} : { reviewerErrors },
      }
    },
  })
}

/** `review_filter`: reject false positives so they stop counting. */
export function defineReviewFilterTool(runtime: OrchestratorRuntime): ToolDefinition {
  return defineTool({
    name: 'review_filter',
    description: 'Remove findings from the accepted union, so they stop counting toward the verdict. '
      + 'The delegating lead or the review-work carrier may call this (pass loopId when you lead several loops). '
      + 'Use reason "false-positive" for a finding you PROVED wrong (open the code and check), and "resolved" for one your revised plan now answers. '
      + 'Match a finding by its exact severity and summary as reported. The union is cumulative across rounds, so a P0 stays counted until you remove it here — '
      + 'but a wrongly removed P0 is a review that lied.',
    parameters: {
      reject: {
        type: 'array',
        required: true,
        description: 'Findings to remove, matched by severity + summary.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            severity: { type: 'string', required: true, enum: [...SEVERITIES] },
            summary: { type: 'string', required: true },
            reason: { type: 'string', enum: ['false-positive', 'resolved'], description: 'Why it leaves the union (default false-positive).' },
          },
        },
      },
      note: { type: 'string', description: 'Why these left the union (kept in the transcript for the audit).' },
      loopId: { type: 'string', description: 'The loop to filter when you lead more than one; the carrier may omit it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'array', required: true, items: FINDING_SCHEMA },
          unmatched: { type: 'array', required: true, items: FINDING_SCHEMA },
          counts: { ...COUNTS_SCHEMA, required: true },
          findings: { type: 'array', required: true, items: FINDING_SCHEMA },
          zeroP0: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => text([
        `filtered ${value.removed.length} finding(s)`
        + (value.unmatched.length === 0 ? '' : `; ${value.unmatched.length} rejection(s) matched no finding`)
        + ` → P0=${value.counts.P0} P1=${value.counts.P1} P2=${value.counts.P2} P3=${value.counts.P3} (clean: ${value.zeroP0})`,
        ...value.findings.map(finding => `- ${renderFinding(finding)}`),
      ].join('\n')),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const reject: RejectionRequest[] = args.reject.map(finding => ({
        severity: finding.severity,
        summary: finding.summary,
        ...finding.reason === undefined ? {} : { reason: finding.reason },
      }))
      const result = runtime.filter(agent, reject, args.loopId)
      return {
        removed: result.removed.map(findingRow),
        unmatched: result.unmatched.map(rawRow),
        counts: countsRow(result.loop.tally.counts),
        findings: result.loop.findings.map(findingRow),
        zeroP0: result.loop.tally.zeroP0,
      }
    },
  })
}

/** `review_finish`: the numeric zero-P0 gate on the review phase. */
export function defineReviewFinishTool(runtime: OrchestratorRuntime): ToolDefinition {
  return defineTool({
    name: 'review_finish',
    description: 'Close the review phase on the numeric verdict. It REFUSES while any accepted P0 remains, while a reviewer failure '
      + 'leaves the last round uncertified, or before any reviewer has reported — so a loop cannot "decide" it is clean. '
      + 'After it returns, implement the approved plan and verify it, then close the goal with `review_complete`.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          counts: { ...COUNTS_SCHEMA, required: true },
          rounds: { type: 'integer', required: true },
          reviewers: { type: 'integer', required: true },
          failures: { type: 'integer', required: true },
          findings: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(
        `review phase closed clean: ${value.rounds} round(s), ${value.reviewers} reviewer(s), `
        + `P0=0 (P1=${value.counts.P1} P2=${value.counts.P2} P3=${value.counts.P3}), ${value.findings} accepted finding(s). `
        + 'Implement the approved plan, verify it, then call review_complete.',
      ),
    },
    async execute(_args, exec) {
      const agent = requireAgent(exec)
      const { verdict } = runtime.finish(agent)
      return {
        counts: countsRow(verdict.counts),
        rounds: verdict.rounds,
        reviewers: verdict.reviewers,
        failures: verdict.failures,
        findings: verdict.findings,
      }
    },
  })
}

/** `review_complete`: exit A — close the goal and report. */
export function defineReviewCompleteTool(runtime: OrchestratorRuntime): ToolDefinition {
  return defineTool({
    name: 'review_complete',
    description: 'EXIT A: close this review loop\'s goal and report the outcome to whoever delegated the objective. '
      + 'Requires a closed review phase (`review_finish`) whose verdict is still zero-P0, plus the done and verified work — '
      + 'the goal is the promise that the objective was actually met, not that the review ended.',
    parameters: {
      summary: { type: 'string', description: 'One-line outcome for the report (what was done and how it was verified).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goalId: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          reported: { type: 'boolean', required: true },
          rounds: { type: 'integer', required: true },
          reviewers: { type: 'integer', required: true },
          counts: { ...COUNTS_SCHEMA, required: true },
        },
      },
      render: (_args, value) => text(
        `review loop complete: goal ${value.goalId} is ${value.phase} after ${value.rounds} round(s) / ${value.reviewers} reviewer(s)`
        + (value.reported ? '; the report reached the delegating session.' : '; the report could NOT be delivered — tell your parent directly.'),
      ),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const result = await runtime.complete(agent, args.summary, exec.signal)
      return {
        goalId: result.goal.id,
        phase: result.goal.phase,
        reported: result.reported,
        rounds: result.loop.tally.rounds,
        reviewers: result.loop.tally.reviewers,
        counts: countsRow(result.loop.tally.counts),
      }
    },
  })
}

/** `review_block`: exit B — wait for a human decision. */
export function defineReviewBlockTool(runtime: OrchestratorRuntime): ToolDefinition {
  return defineTool({
    name: 'review_block',
    description: 'EXIT B: stop the loop and wait for a human decision. Use it only for a genuine judgment call or something irreversible — '
      + 'anything you can settle yourself, settle yourself. The delegating session is told the reason; when the answer comes back to you as a '
      + 'message, continue with `review_resume`.',
    parameters: {
      code: { type: 'string', required: true, description: 'Stable lower-kebab-case classification, e.g. "scope-tradeoff".' },
      message: { type: 'string', required: true, description: 'What must be decided, and the options you see.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goalId: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          code: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(
        `review loop blocked (${value.code}): ${value.message}\nGoal ${value.goalId} is ${value.phase}; waiting for the decision.`,
      ),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const reason: GoalBlockReason = { code: args.code, message: args.message }
      const result = await runtime.block(agent, reason, exec.signal)
      return { goalId: result.goal.id, phase: result.goal.phase, code: reason.code, message: reason.message }
    },
  })
}

/** `review_resume`: continue after the human answered. */
export function defineReviewResumeTool(runtime: OrchestratorRuntime): ToolDefinition {
  return defineTool({
    name: 'review_resume',
    description: 'Continue this review loop after the blocked decision was answered. Call it once your parent has relayed the decision to you; '
      + 'the goal goes back to active and another round may run against the answer.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goalId: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(`review loop resumed: goal ${value.goalId} is ${value.phase}.`),
    },
    async execute(_args, exec) {
      const agent = requireAgent(exec)
      const result = runtime.resume(agent)
      return { goalId: result.goal.id, phase: result.goal.phase, status: result.loop.status }
    },
  })
}

/** Every orchestrator tool, in registration order. */
export function defineOrchestratorTools(runtime: OrchestratorRuntime): ToolDefinition[] {
  return [
    defineSubtaskParallelTool(runtime),
    defineReviewLoopTool(runtime),
    defineReviewRoundTool(runtime),
    defineReviewFilterTool(runtime),
    defineReviewFinishTool(runtime),
    defineReviewCompleteTool(runtime),
    defineReviewBlockTool(runtime),
    defineReviewResumeTool(runtime),
  ]
}

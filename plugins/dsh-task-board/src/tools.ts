/**
 * The coordinator-scoped task-board tools (§5.10 shared tool group, §13.3):
 * `task_new` / `task_update` / `task_close` / `task_reopen` / `task_list`.
 *
 * Registration is global (the plugin's own context) because a role layer
 * grants them by name through `tools.restrict({ allow: [...] })` — a scoped
 * registration would be invisible to that allow-list. Each tool is a thin
 * leaf over {@link TaskBoardHost}; all durable state lives in the service's
 * session events.
 *
 * @module @dsh-plugin/dsh-task-board/tools
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { FINDING_SEVERITIES, TASK_STATUSES, type Finding, type TaskPatch, type TaskSnapshot } from './types.ts'
import type { TaskBoardHost } from './service.ts'

/** Registered tool names (the allow-list vocabulary the role layer uses). */
export const TASK_TOOLS = {
  create: 'task_new',
  update: 'task_update',
  close: 'task_close',
  reopen: 'task_reopen',
  list: 'task_list',
} as const

const FINDING_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    severity: { type: 'string', required: true, enum: FINDING_SEVERITIES, description: 'Finding grade, P0 = must fix.' },
    summary: { type: 'string', required: true, description: 'One-line, actionable statement of the defect.' },
    sourceRound: { type: 'integer', required: true, description: 'Review round the finding came from, 0 outside a review loop.' },
  },
} as const

const TASK_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Session-local task id, task-<n>.' },
    revision: { type: 'integer', required: true, description: 'Compare-and-set revision to pass back to task_update.' },
    subject: { type: 'string', required: true, description: 'Requirement-level description.' },
    status: { type: 'string', required: true, enum: TASK_STATUSES, description: 'Life-cycle state.' },
    owner: { type: 'string', description: 'Session id accountable for the task, when assigned.' },
    reviewRound: { type: 'integer', required: true, description: 'Number of review rounds this task went through.' },
    findings: { type: 'array', required: true, items: FINDING_VALUE_SCHEMA, description: 'Cross-round union of review findings.' },
    filteredFindings: { type: 'array', required: true, items: FINDING_VALUE_SCHEMA, description: 'Findings filtered out as false positives.' },
    inContext: { type: 'boolean', required: true, description: 'Whether the task belongs to the work set injected into the prompt.' },
  },
} as const

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'string', description: 'New requirement-level description.' },
    status: { type: 'string', enum: TASK_STATUSES, description: 'New life-cycle state; a terminal state also clears inContext.' },
    owner: { type: 'string', description: 'Session id to assign the task to.' },
    reviewRound: { type: 'integer', description: 'Review rounds completed so far.' },
    findings: { type: 'array', items: FINDING_VALUE_SCHEMA, description: 'Findings to accumulate (whole accumulated union, not a delta).' },
    filteredFindings: { type: 'array', items: FINDING_VALUE_SCHEMA, description: 'Findings filtered out as false positives.' },
    inContext: { type: 'boolean', description: 'Explicit work-set membership, overriding the terminal-state default.' },
  },
} as const

/** Canonical task value (JSON form of {@link TaskSnapshot}); the brand is compile-time only. */
function taskValue(task: TaskSnapshot) {
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    status: task.status,
    reviewRound: task.reviewRound,
    findings: task.findings.map(findingValue),
    filteredFindings: task.filteredFindings.map(findingValue),
    inContext: task.inContext,
    ...task.owner === undefined ? {} : { owner: String(task.owner) },
  }
}

/** Canonical finding value. */
function findingValue(finding: Finding) {
  return { severity: finding.severity, summary: finding.summary, sourceRound: finding.sourceRound }
}

/** One text block — the shape every task tool renders. */
function resultText(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Resolve the calling session (the task board is per-session). */
function requireSession(exec: ToolRunContext, tool: string): Session {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Error(`${tool}: no agent session on this execution — the task board is per-session`)
  }
  return session
}

/**
 * Build the five tool definitions bound to one board host.
 * @param host - the board service (the plugin registers these globally).
 * @returns registry-ready tool definitions, in listing order.
 */
export function defineTaskTools(host: TaskBoardHost): ToolDefinition[] {
  return [
    defineTool({
      name: TASK_TOOLS.create,
      description: 'Record a requirement-level task on the session task board and put it in the work set. '
        + 'One task = one requirement the user handed you (not an internal implementation step; use todo_write for those). '
        + 'Returns the created task including the revision to pass back to task_update.',
      parameters: {
        subject: { type: 'string', required: true, description: 'The requirement, one line, imperative and specific.' },
      },
      output: {
        schema: TASK_VALUE_SCHEMA,
        render: (_args, value) => resultText(
          `Created ${value.id} (${value.status}${value.inContext ? ', in work set' : ''}) at revision ${value.revision}: ${value.subject}`,
        ),
      },
      execute: async (args, exec) => taskValue(host.create(requireSession(exec, TASK_TOOLS.create), { subject: args.subject })),
    }),

    defineTool({
      name: TASK_TOOLS.update,
      description: 'Update one task on the session task board. Pass `revision` to compare-and-set: a stale revision is rejected, '
        + 'and the error names the current revision so you can re-read with task_list and retry. '
        + 'findings/filteredFindings are whole accumulated arrays, never deltas.',
      parameters: {
        id: { type: 'string', required: true, description: 'Task id from task_new/task_list, task-<n>.' },
        patch: { ...PATCH_SCHEMA, required: true, description: 'Fields to change; absent fields keep their value.' },
        revision: { type: 'integer', description: 'The revision you read. Required for a safe compare-and-set; omit only for an intentional last-write-wins update.' },
      },
      output: {
        schema: TASK_VALUE_SCHEMA,
        render: (_args, value) => resultText(
          `Updated ${value.id} → revision ${value.revision} (${value.status}${value.inContext ? ', in work set' : ', out of work set'})`,
        ),
      },
      execute: async (args, exec) => taskValue(host.update(
        requireSession(exec, TASK_TOOLS.update),
        args.id,
        args.patch satisfies TaskPatch,
        args.revision,
      )),
    }),

    defineTool({
      name: TASK_TOOLS.close,
      description: 'Close a task and take it out of the work set. The task stays on the board as a replayable tombstone '
        + 'and can be restored with task_reopen — use it for work the user cancelled or that is no longer wanted.',
      parameters: {
        id: { type: 'string', required: true, description: 'Task id, task-<n>.' },
        reason: { type: 'string', description: 'Short reason kept on the durable task/closed event.' },
      },
      output: {
        schema: TASK_VALUE_SCHEMA,
        render: (_args, value) => resultText(`Closed ${value.id} at revision ${value.revision}; task_reopen restores it.`),
      },
      execute: async (args, exec) => taskValue(host.close(
        requireSession(exec, TASK_TOOLS.close),
        args.id,
        args.reason,
      )),
    }),

    defineTool({
      name: TASK_TOOLS.reopen,
      description: 'Reopen a closed (or otherwise terminal) task: status goes back to pending and the task returns to the work set.',
      parameters: {
        id: { type: 'string', required: true, description: 'Task id, task-<n>.' },
      },
      output: {
        schema: TASK_VALUE_SCHEMA,
        render: (_args, value) => resultText(`Reopened ${value.id} at revision ${value.revision} — back in the work set (${value.status}).`),
      },
      execute: async (args, exec) => taskValue(host.reopen(requireSession(exec, TASK_TOOLS.reopen), args.id)),
    }),

    defineTool({
      name: TASK_TOOLS.list,
      description: 'List the session task board (requirement-level tasks, closed ones included; deleted tombstones excluded), '
        + 'with status, revision, work-set membership, and review findings.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tasks: { type: 'array', required: true, items: TASK_VALUE_SCHEMA, description: 'Every task on the board, in creation order.' },
          },
        },
        render: (_args, value) => resultText(value.tasks.length === 0
          ? 'Task board is empty.'
          : value.tasks.map(task => `${task.id} [${task.status}] rev ${task.revision}${task.inContext ? ' ★' : ''} — ${task.subject}`).join('\n')),
      },
      execute: async (_args, exec) => ({ tasks: host.list(requireSession(exec, TASK_TOOLS.list)).map(taskValue) }),
    }),
  ]
}

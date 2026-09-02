/**
 * The reviewer's scoped `advise` tool. Registered on the reviewer agent's
 * context only (mask-immune scoped registration, invisible to the primary
 * agent and to the restrict() allow-mask). The tool is a pure leaf: it
 * validates and echoes the advisory; the plugin observes the reviewer's
 * `tool/call` + `tool/result` session events and routes delivery to the
 * primary agent.
 *
 * @module @dsh-plugin/dsh-advisor/advise-tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Severity } from './severity.ts'
import { isSeverity } from './severity.ts'

/** The reviewer tool's registered name. */
export const ADVISE_TOOL = 'advise'

/** Arguments the reviewer model passes to `advise`. */
export interface AdviseArgs {
  readonly severity: Severity
  readonly note: string
}

/** Canonical value returned by the tool. */
export interface AdviseValue {
  readonly severity: Severity
  readonly note: string
}

/**
 * Build the `advise` tool definition. `execute` only validates and returns
 * the advisory; delivery routing lives in the plugin's session-event
 * observation, so the tool stays a leaf with no cross-agent side effects.
 */
export function defineAdviseTool(): ToolDefinition {
  return defineTool({
    name: ADVISE_TOOL,
    description: 'Report a graded advisory about the reviewed session. '
      + 'Call this exactly once per review, after verifying the issue against the workspace with read/grep/glob when needed. '
      + 'severity "nit" is a non-interrupting aside, "concern" a substantive risk that should steer the primary agent, '
      + '"blocker" a defect that makes continued work wasted. Keep the note concise and actionable.',
    parameters: {
      severity: {
        type: 'string',
        required: true,
        enum: ['nit', 'concern', 'blocker'],
        description: 'The advisory grade: nit = non-interrupting aside, concern = substantive risk, blocker = continued work is wasted.',
      },
      note: {
        type: 'string',
        required: true,
        description: 'The advisory note, one to three sentences, actionable and specific.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', required: true, enum: ['nit', 'concern', 'blocker'] },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Advisory recorded: ${value.severity} — ${value.note}`,
      }],
    },
    execute: async (args) => {
      if (!isSeverity(args.severity)) {
        throw new Error(`advise: invalid severity ${JSON.stringify(args.severity)} (expected nit|concern|blocker)`)
      }
      if (args.note.trim() === '') {
        throw new Error('advise: note must be non-empty')
      }
      return { severity: args.severity, note: args.note } satisfies AdviseValue
    },
  })
}

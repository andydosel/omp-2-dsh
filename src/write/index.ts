/**
 * The unified `write` tool: full-file UTF-8 writes, archive entry writes
 * (`container:inner/path`), and SQLite row writes (`container:table[:key]`),
 * all routed through the `fs/write-intent` waterfall and recorded with
 * `fs/observed` so the retained observation policy keeps guarding mutations.
 * @module dsh-tool-read-write/write
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { computeHunkDiffs, diffsFromMeta } from '../diff.ts'
import { remediateFsError } from '../error.ts'
import { sessionResolveOptions } from '../session-cwd.ts'
import type { FsSandboxController } from '../sandbox.ts'
import { writeArchiveEntry } from './archive-write.ts'
import { writeSqliteRow } from './sqlite-write.ts'

/** Write-side config knobs. */
export interface WriteToolConfig {
  writeEnabled: boolean
  sqliteWriteEnabled: boolean
  archiveWriteEnabled: boolean
  /** Byte cap on archive container reads and old-entry diff text. */
  maxBytes: number
}

/**
 * Validate value constraints the schema DSL can't express: only a non-blank
 * `path` — an empty `content` is legitimate (it writes an empty file, or
 * deletes a SQLite row).
 * @param args - the schema-validated raw tool arguments.
 * @returns the validated input.
 */
export function parseWriteArgs(args: { path: string; content: string }): { path: string; content: string } {
  if (args.path.trim().length === 0) throw new Error('path must be a non-empty string')
  return { path: args.path, content: args.content }
}

/**
 * Format a file/archive write outcome as the omp-style confirmation message.
 * @param displayPath - the backend-resolved path shown to the model.
 * @param chars - the number of UTF-16 code units written (omp counts these as "bytes").
 * @returns the confirmation sentence.
 */
export function formatWriteOutput(displayPath: string, chars: number): string {
  return `Successfully wrote ${chars} bytes to ${displayPath}`
}

/** Format a SQLite row write outcome. */
export function formatSqliteWriteOutput(result: { path: string; operation: 'insert' | 'update' | 'delete'; key?: string }): string {
  switch (result.operation) {
    case 'insert':
      return `Inserted a row into ${result.path}`
    case 'update':
      return `Updated row ${result.key ?? ''} in ${result.path}`
    case 'delete':
      return `Deleted row ${result.key ?? ''} from ${result.path}`
  }
}

/** The `write` tool's validated arguments, including the sandbox escalation fields. */
interface WriteToolArgs {
  path: string
  content: string
  sandbox_permissions?: string
  justification?: string
}

/** The canonical `write` value declared by the output schema. */
interface WriteValue {
  path: string
  kind: 'file' | 'archive' | 'sqlite'
  operation: 'create' | 'update' | 'delete' | 'insert'
  before: string | null
  after: string | null
}

/**
 * Register the `write` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param sandbox - the shared sandbox-escalation API.
 * @param config - write-side config knobs.
 */
export function applyWriteTool(ctx: Context, sandbox: FsSandboxController, config: WriteToolConfig): void {
  ctx.systemPrompt.section({
    name: 'tool:write',
    order: 101,
    text: 'Use the write tool to create files or completely replace file contents, write entries inside archives '
      + '(path like archive.zip:inner/path), and write rows in SQLite databases (path like data.db:table or data.db:table:key, '
      + 'with content as a JSON5 object; empty content deletes the row). Existing files are overwritten, so read an existing '
      + 'file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.',
  })

  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file, write an archive entry, or write a SQLite row.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to write, resolved by the filesystem backend; archive entries and SQLite rows use : selectors.' },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content (files/archive entries) or a JSON5 object (SQLite rows; empty deletes).' },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['file', 'archive', 'sqlite'] },
          operation: { type: 'string', required: true, enum: ['create', 'update', 'delete', 'insert'] },
          before: {
            required: true,
            oneOf: [
              { type: 'string' },
              { type: 'null' },
            ],
          },
          after: {
            required: true,
            oneOf: [
              { type: 'string' },
              { type: 'null' },
            ],
          },
        },
      },
      render: (args, value) => {
        const text = value.kind === 'sqlite'
          ? formatSqliteWriteOutput({
            path: value.path,
            operation: value.operation as 'insert' | 'update' | 'delete',
            ...value.operation === 'update' || value.operation === 'delete' ? { key: args.path.split(':').at(-1) ?? '' } : {},
          })
          : formatWriteOutput(value.path, args.content.length)
        return [{ type: 'text', text }]
      },
      presentationMeta: (args, value) => ({
        diffs: value.before === null
          ? []
          : computeHunkDiffs(args.path, value.before, value.after ?? '')
            .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: WriteToolArgs, exec): Promise<WriteValue> {
      if (!config.writeEnabled) throw new Error('write is disabled by configuration')
      const input = parseWriteArgs(args)
      // Resolve the per-call sandbox policy BEFORE anything executes.
      const sandboxPolicy = await sandbox.resolvePolicy('write', args, exec)

      // Archive entry write (container:inner) — returns undefined when the path
      // is not an archive selector target.
      const archive = await writeArchiveEntry(ctx, exec, input.path, input.content, sandboxPolicy, config)
      if (archive !== undefined) return archive

      // SQLite row write (container:table[:key]) — emits its own observation.
      const sqlite = await writeSqliteRow(ctx, exec, input.path, input.content, sandboxPolicy, config)
      if (sqlite !== undefined) return sqlite

      // Plain file write.
      const target = await ctx.fs.resolve(input.path, sessionResolveOptions(exec, input.path, sandboxPolicy?.workspaceRoot))
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      let outcome: FsWriteOutcome
      try {
        outcome = await ctx.fs.writeText(target, input.content, intent, exec.signal, sandboxPolicy)
      } catch (error: unknown) {
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy))
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        path: target.displayPath,
        kind: 'file',
        operation: outcome.operation,
        before: outcome.before,
        after: outcome.after,
      }
    },
    // Pure display: a diff card. A call-time presenter has no access to prior
    // content, so `oldText: null` also represents an overwrite here.
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Write ${args.path}`,
        diffs: [{ path: args.path, oldText: null, newText: args.content }],
        locations: [{ path: args.path }],
      }
    },
    // Result-time display repeats the diff; creates and identical overwrites
    // use the replay-safe args fallback.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
        ?? [{ path: args.path, oldText: null, newText: args.content }]
      return { card: 'diff', title: `Write ${args.path}`, diffs }
    },
  }))
}

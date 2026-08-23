/**
 * dsh-tool-read-write: the unified omp-style read/write tool suite for dsh.
 * Replaces `@deepseek-ai/dsh-tool-fs` wholesale — the same-name `read`,
 * `write`, `edit`, and `read_image` tools (so model behavior and the retained
 * `fs-observation-policy` keep working) plus the new `inspect_image` tool.
 *
 * Every file operation routes through `ctx.fs` with the `fs/*` event gates:
 * reads record `fs/observed`, mutations run the `fs/write-intent` /
 * `fs/edit-intent` waterfalls. Archive-entry and SQLite-row mutations must
 * touch the process path directly because the `ctx.fs` seam offers no binary
 * or SQLite write path — the gates still run through `ctx.fs` (documented in
 * the write modules).
 * @module @dsh-plugin/dsh-tool-read-write
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-user-approval'
import { AGENT_TOOL_RESULT_CHARS } from './read/agent.ts'
import { applyReadTool } from './read/index.ts'
import type { ReadToolCaps } from './read/index.ts'
import { applyWriteTool } from './write/index.ts'
import { applyEditTool } from './edit.ts'
import { applyReadImageTool } from './read-image.ts'
import { applyInspectImageTool } from './inspect-image.ts'
import type { InspectImageMode } from './inspect-image.ts'
import { READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from './read/render.ts'
import { FsSandboxController } from './sandbox.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-tool-read-write'

export const inject = ['tools', 'fs', 'systemPrompt', 'sessions']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Default lines returned when the read path carries no selector. */
  readDefaultLimit?: number
  /** Maximum lines returned by one `read` call. */
  readMaxLines?: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength?: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes?: number
  /** Directory tree recursion depth beyond the root. */
  directoryDepth?: number
  /** Maximum entries shown per directory. */
  directoryPerDir?: number
  /** Maximum archive entries listed per read. */
  archiveListLimit?: number
  /** Default row limit for `?`-configured SQLite table reads. */
  sqliteQueryLimit?: number
  /** Maximum accepted SQLite `limit`. */
  sqliteQueryMax?: number
  /** Maximum rows a raw SQLite query returns. */
  sqliteRawQueryMaxRows?: number
  /** URL output line cap. */
  urlMaxLines?: number
  /** URL output byte cap. */
  urlMaxBytes?: number
  /** Characters of one agent:// tool-result body kept before elision. */
  agentToolResultChars?: number
  /** `inspect_image` registration mode: auto|on|off. */
  inspectImageMode?: InspectImageMode
  /** `inspect_image` vision-call timeout (ms). */
  inspectImageTimeoutMs?: number
  /** `inspect_image` input byte cap (default 20 MiB). */
  inspectImageMaxBytes?: number
  /** `inspect_image` vision route provider; empty = the main route. */
  visionProvider?: string
  /** `inspect_image` vision route model; empty = the main route. */
  visionModel?: string
  /** Master switch for the `write` tool. */
  writeEnabled?: boolean
  /** Switch for SQLite row writes. */
  sqliteWriteEnabled?: boolean
  /** Switch for archive entry writes. */
  archiveWriteEnabled?: boolean
}

export const Config: z<Config> = z.object({
  readDefaultLimit: z.number().default(300),
  readMaxLines: z.number().default(2000),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
  directoryDepth: z.number().default(2),
  directoryPerDir: z.number().default(12),
  archiveListLimit: z.number().default(500),
  sqliteQueryLimit: z.number().default(20),
  sqliteQueryMax: z.number().default(500),
  sqliteRawQueryMaxRows: z.number().default(1000),
  urlMaxLines: z.number().default(300),
  urlMaxBytes: z.number().default(READ_MAX_BYTES),
  agentToolResultChars: z.number().default(AGENT_TOOL_RESULT_CHARS),
  inspectImageMode: z.union(['auto', 'on', 'off'] as const).default('auto'),
  inspectImageTimeoutMs: z.number().default(300_000),
  inspectImageMaxBytes: z.number().default(20 * 1024 * 1024),
  visionProvider: z.string().default(''),
  visionModel: z.string().default(''),
  writeEnabled: z.boolean().default(true),
  sqliteWriteEnabled: z.boolean().default(true),
  archiveWriteEnabled: z.boolean().default(true),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Every cap counts lines/chars/bytes — a positive integer, or windowing arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-tool-read-write: ${name} must be a positive integer`)
  }
}

/**
 * Register the full `read`/`write`/`edit` filesystem tool suite, plus
 * `read_image`/`inspect_image` while `attachments` is mounted.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  for (const key of [
    'readDefaultLimit', 'readMaxLines', 'readMaxLineLength', 'readMaxBytes',
    'directoryDepth', 'directoryPerDir', 'archiveListLimit',
    'sqliteQueryLimit', 'sqliteQueryMax', 'sqliteRawQueryMaxRows',
    'urlMaxLines', 'urlMaxBytes', 'agentToolResultChars',
    'inspectImageTimeoutMs', 'inspectImageMaxBytes',
  ]) {
    assertPositiveInteger(key, resolved[key as keyof ResolvedConfig] as number)
  }

  const caps: ReadToolCaps = {
    limit: resolved.readDefaultLimit,
    maxLines: resolved.readMaxLines,
    maxLineLength: resolved.readMaxLineLength,
    maxBytes: resolved.readMaxBytes,
    directory: { depth: resolved.directoryDepth, perDir: resolved.directoryPerDir },
    archiveListLimit: resolved.archiveListLimit,
    sqliteQueryLimit: resolved.sqliteQueryLimit,
    sqliteQueryMax: resolved.sqliteQueryMax,
    sqliteRawQueryMaxRows: resolved.sqliteRawQueryMaxRows,
    urlMaxLines: resolved.urlMaxLines,
    urlMaxBytes: resolved.urlMaxBytes,
    agentToolResultChars: resolved.agentToolResultChars,
  }
  applyReadTool(ctx, caps)

  // read_image and inspect_image are composition-conditional: without a
  // mounted attachment store their image blocks cannot be durably committed,
  // so neither registers; the execute bodies keep defensive re-checks.
  ctx.inject(['attachments'], (imageCtx) => {
    applyReadImageTool(imageCtx)
    applyInspectImageTool(imageCtx, {
      mode: resolved.inspectImageMode,
      timeoutMs: resolved.inspectImageTimeoutMs,
      maxBytes: resolved.inspectImageMaxBytes,
      visionProvider: resolved.visionProvider,
      visionModel: resolved.visionModel,
    })
  })

  // One escalation API shared by both mutating tools: advertisement gating,
  // per-call policy resolution, and denial-marker mapping, all keyed off
  // whether the mounted ctx.fs confines (ctx.fs.sandboxMode).
  const sandbox = new FsSandboxController(ctx)
  applyWriteTool(ctx, sandbox, {
    writeEnabled: resolved.writeEnabled,
    sqliteWriteEnabled: resolved.sqliteWriteEnabled,
    archiveWriteEnabled: resolved.archiveWriteEnabled,
    maxBytes: resolved.readMaxBytes,
  })
  applyEditTool(ctx, sandbox)
}

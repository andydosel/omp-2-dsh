/**
 * The unified `read` tool: one `path` argument covering URLs, literal paths,
 * archives (`container:inner`), SQLite databases (`container:table[:key][?…]`),
 * text files (with `:raw`/`:N`/`:A-B`/`:A+C`/multi-range selectors), and
 * directories. Every successful read records `fs/observed` so the retained
 * observation policy keeps guarding edits.
 * @module dsh-tool-read-write/read
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ReadResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { parseSelectors } from './selectors.ts'
import type { ParsedSelectors } from './selectors.ts'
import type { LineSelector } from './selectors.ts'
import { buildWindow, formatNumberedRead, formatRawRead, langFromPath, readMetaFromMeta } from './render.ts'
import type { FileTextLine, WindowRequest, WindowResult } from './render.ts'
import { buildDirectoryTree, renderDirectoryTree } from './directory.ts'
import type { DirectoryCaps } from './directory.ts'
import {
  ARCHIVE_MAX_BYTES,
  archiveKindForPath,
  decodeEntryText,
  findArchiveEntry,
  formatArchiveListing,
  listArchiveChildren,
  normalizeArchiveEntryPath,
  parseTarContainer,
  parseZipContainer,
  readTarEntryData,
  readZipEntryData,
  sniffBinary,
} from './archive.ts'
import type { TarEntry, ZipEntry } from './archive.ts'
import {
  isSqliteExtension,
  listSqliteTables,
  parseSqliteSpec,
  querySqliteKey,
  querySqliteTable,
  runSqliteQuery,
  sqliteSchemaOf,
  tryOpenSqliteReadOnly,
} from './sqlite.ts'
import type { SqliteReadSpec } from './sqlite.ts'
import type { DatabaseSync } from 'node:sqlite'
import type { SqliteCell, SqliteRow } from './sqlite.ts'
import { fetchUrlText, formatUrlRead, isUrlPath } from './url.ts'
import { sessionResolveOptions } from '../session-cwd.ts'

/** Files at or above this size stream instead of loading whole into memory. */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

/** Resolved read-tool caps — plugin config after defaulting. */
export interface ReadToolCaps {
  /** Default lines returned when the path carries no selector. */
  limit: number
  /** Maximum lines returned by one call. */
  maxLines: number
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes returned for selected lines. */
  maxBytes: number
  /** Directory tree caps. */
  directory: DirectoryCaps
  /** Maximum archive entries listed. */
  archiveListLimit: number
  /** Default row limit for `?`-configured table reads. */
  sqliteQueryLimit: number
  /** Maximum accepted `limit`. */
  sqliteQueryMax: number
  /** Maximum rows a raw `?q=` query returns. */
  sqliteRawQueryMaxRows: number
  /** URL output caps. */
  urlMaxLines: number
  urlMaxBytes: number
}

/** Canonical `read` value: one object, closed schema, kind-specific optional fields. */
export type ReadValue = {
  path: string
  kind: 'file' | 'directory' | 'archive' | 'sqlite' | 'url'
  offset?: number
  lines?: FileTextLine[]
  text?: string
  totalLines?: number
  truncated?: boolean
  outOfRange?: boolean
  tree?: string
  entries?: string[]
  entryPath?: string
  entryText?: string
  entryBytes?: number
  binary?: boolean
  tables?: string[]
  table?: string
  schema?: string
  columns?: string[]
  rows?: SqliteRow[]
  key?: string | number
  query?: string
  statusCode?: number
  failed?: string
}

/** Probe a path for existence and type without emitting observations. */
async function probePath(
  ctx: Context,
  exec: ToolExecution,
  rawPath: string,
): Promise<{ target: FsTarget; info: FsInfo } | undefined> {
  const target = await ctx.fs.resolve(rawPath, sessionResolveOptions(exec, rawPath))
  const info = await ctx.fs.stat(target, exec.signal)
  return info === undefined ? undefined : { target, info }
}

/** Find the first `:`/`?` separator, skipping a Windows drive-letter colon. */
function firstSeparator(path: string): number | undefined {
  const start = /^[A-Za-z]:[\\/]/.test(path) ? 2 : 0
  for (let i = start; i < path.length; i++) {
    const char = path[i]
    if (char === ':' || char === '?') return i
  }
  return undefined
}

/** Build the window request for a parsed selector. */
export function windowRequestFromSelector(selector: LineSelector | undefined, caps: ReadToolCaps): WindowRequest {
  const base = {
    maxLines: caps.maxLines,
    maxLineLength: caps.maxLineLength,
    maxBytes: caps.maxBytes,
  }
  if (selector === undefined || selector.kind === 'plain') {
    return { offset: 1, mode: 'numbered', ranges: [{ start: 1, end: caps.limit }], context: false, ...base }
  }
  switch (selector.kind) {
    case 'raw':
      return { offset: 1, mode: 'raw', ranges: [], context: false, ...base }
    case 'range': {
      if (selector.raw) {
        return { offset: selector.start, mode: 'raw', ranges: [{ start: selector.start, end: selector.end }], context: false, ...base }
      }
      return { offset: selector.start, mode: 'numbered', ranges: [{ start: selector.start, end: selector.end }], context: true, ...base }
    }
    case 'ranges': {
      const ranges = [...selector.ranges].sort((a, b) => a.start - b.start)
      return {
        offset: ranges[0]?.start ?? 1,
        mode: selector.raw ? 'raw' : 'numbered',
        ranges,
        context: false,
        ...base,
      }
    }
  }
}

/** Read a text file with the selector-derived window, then record the observation. */
async function readFile(
  ctx: Context,
  caps: ReadToolCaps,
  target: FsTarget,
  info: FsInfo,
  selector: LineSelector | undefined,
  exec: ToolExecution,
): Promise<ReadValue> {
  const request = windowRequestFromSelector(selector, caps)
  const chunks = info.size === undefined || info.size >= STREAM_MIN_SIZE
    ? await ctx.fs.streamText(target, exec.signal)
    : [await ctx.fs.readText(target, exec.signal)]
  const window = await buildWindow(chunks, request)
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return {
    path: target.displayPath,
    kind: 'file',
    offset: window.offset,
    ...window.lines.length > 0 ? { lines: window.lines } : {},
    ...window.rawText !== '' ? { text: window.rawText } : {},
    totalLines: window.totalLines,
    truncated: window.truncatedByBytes || window.truncatedByLines,
    ...window.outOfRange ? { outOfRange: true } : {},
  }
}

/** Read a directory into a bounded tree, then record the observation. */
async function readDirectory(
  ctx: Context,
  caps: ReadToolCaps,
  target: FsTarget,
  info: FsInfo,
  exec: ToolExecution,
): Promise<ReadValue> {
  const tree = await buildDirectoryTree(
    (t, signal) => ctx.fs.listDir(t, signal),
    target,
    caps.directory,
    exec.signal,
  )
  const rendered = renderDirectoryTree(tree, target.displayPath)
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return { path: target.displayPath, kind: 'directory', tree: rendered }
}

/** Read a whole archive listing or one entry, then record the observation. */
async function readArchiveValue(
  ctx: Context,
  caps: ReadToolCaps,
  target: FsTarget,
  info: FsInfo,
  inner: string,
  exec: ToolExecution,
): Promise<ReadValue> {
  const data = await ctx.fs.readBytes(target, exec.signal, ARCHIVE_MAX_BYTES)
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  const kind = archiveKindForPath(target.displayPath)
  if (kind === undefined) throw new FsError(`cannot read "${target.displayPath}": not an archive`, 'FS_NOT_REGULAR_FILE')

  if (inner === '') {
    const names = kind === 'tar' || kind === 'tar-gz'
      ? parseTarContainer(data).entries.map(entry => entry.type === 'dir' ? `${entry.name}/` : entry.name)
      : parseZipContainer(data).entries.map(entry => entry.name)
    names.sort((a, b) => a.localeCompare(b, 'en'))
    const limited = names.slice(0, caps.archiveListLimit)
    return { path: target.displayPath, kind: 'archive', entries: limited, truncated: names.length > limited.length }
  }

  const normalized = normalizeArchiveEntryPath(inner)
  const displayEntryPath = `${target.displayPath}:${normalized}`
  if (kind === 'tar' || kind === 'tar-gz') {
    const { entries, bytes } = parseTarContainer(data)
    return archiveEntryValue(displayEntryPath, normalized, entries, caps,
      entry => readTarEntryData(bytes, entry))
  }
  const { entries } = parseZipContainer(data)
  return archiveEntryValue(displayEntryPath, normalized, entries, caps,
    entry => readZipEntryData(data, entry))
}

/** Shared entry resolution: exact entry → text; directory entry or prefix → child listing. */
function archiveEntryValue<E extends { name: string; type?: string; isDir?: boolean }>(
  displayEntryPath: string,
  normalized: string,
  entries: readonly E[],
  caps: ReadToolCaps,
  readData: (entry: E) => Uint8Array,
): ReadValue {
  const exact = findArchiveEntry(entries, normalized) ?? findArchiveEntry(entries, `${normalized}/`)
  if (exact === undefined) {
    const children = listArchiveChildren(entries, normalized)
    if (children.length > 0) {
      const limited = children.slice(0, caps.archiveListLimit)
      return {
        path: displayEntryPath,
        kind: 'archive',
        entries: limited,
        truncated: children.length > limited.length,
      }
    }
    throw new FsError(`cannot read "${displayEntryPath}": entry "${normalized}" not found in the archive`, 'FS_NOT_FOUND')
  }
  const isDir = exact.isDir === true || exact.type === 'dir'
  if (isDir) {
    const children = listArchiveChildren(entries, normalized)
    const limited = children.slice(0, caps.archiveListLimit)
    return {
      path: displayEntryPath,
      kind: 'archive',
      entries: limited,
      truncated: children.length > limited.length,
    }
  }
  const data = readData(exact)
  const binary = sniffBinary(data)
  if (binary) {
    return {
      path: displayEntryPath,
      kind: 'archive',
      entryPath: normalized,
      binary: true,
      entryBytes: data.length,
      truncated: false,
    }
  }
  const maxBytes = caps.maxBytes
  const truncatedBytes = data.length > maxBytes ? data.subarray(0, maxBytes) : data
  return {
    path: displayEntryPath,
    kind: 'archive',
    entryPath: normalized,
    entryText: decodeEntryText(truncatedBytes),
    entryBytes: data.length,
    binary: false,
    truncated: data.length > maxBytes,
  }
}

/** Try the `container:inner` archive branch; `undefined` means the path is not an archive selector. */
async function readArchiveSelector(
  ctx: Context,
  caps: ReadToolCaps,
  rawPath: string,
  exec: ToolExecution,
): Promise<ReadValue | undefined> {
  const sep = firstSeparator(rawPath)
  if (sep === undefined) return undefined
  const containerPath = rawPath.slice(0, sep)
  const inner = rawPath.slice(sep + 1)
  if (containerPath === '') return undefined
  const probe = await probePath(ctx, exec, containerPath)
  if (probe === undefined || probe.info.type !== 'file') return undefined
  if (archiveKindForPath(probe.target.displayPath) === undefined) return undefined
  return readArchiveValue(ctx, caps, probe.target, probe.info, inner, exec)
}

/** Read a SQLite container: tables list, table schema+rows, key lookup, or raw query. */
async function readSqliteValue(
  ctx: Context,
  caps: ReadToolCaps,
  target: FsTarget,
  info: FsInfo,
  spec: string,
  exec: ToolExecution,
  db: DatabaseSync,
): Promise<ReadValue> {
  let parsed: SqliteReadSpec
  let outcome: Record<string, unknown>
  try {
    parsed = parseSqliteSpec(spec, caps.sqliteQueryLimit, caps.sqliteQueryMax, caps.sqliteRawQueryMaxRows)
    switch (parsed.kind) {
      case 'tables':
        outcome = { tables: listSqliteTables(db) }
        break
      case 'table': {
        const schema = sqliteSchemaOf(db, parsed.table)
        const { columns, rows, truncated } = querySqliteTable(db, parsed.table, parsed.limit, parsed.where)
        outcome = { table: parsed.table, schema, columns, rows, truncated }
        break
      }
      case 'key': {
        const schema = sqliteSchemaOf(db, parsed.table)
        const { columns, rows } = querySqliteKey(db, parsed.table, parsed.key)
        outcome = { table: parsed.table, schema, key: parsed.key, columns, rows }
        break
      }
      case 'query': {
        const { columns, rows, truncated } = runSqliteQuery(db, parsed.query, caps.sqliteRawQueryMaxRows)
        outcome = { query: parsed.query, columns, rows, truncated }
        break
      }
    }
  } finally {
    db.close()
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return { path: target.displayPath, kind: 'sqlite', ...outcome }
}

/** Try the SQLite branch (container + `:`/`?` spec, container must open as SQLite). */
async function readSqliteSelector(
  ctx: Context,
  caps: ReadToolCaps,
  rawPath: string,
  exec: ToolExecution,
): Promise<ReadValue | undefined> {
  const sep = firstSeparator(rawPath)
  if (sep === undefined) return undefined
  const containerPath = rawPath.slice(0, sep)
  // `:table` specs drop the colon; `?q=…` keeps the question mark.
  const spec = rawPath[sep] === '?' ? rawPath.slice(sep) : rawPath.slice(sep + 1)
  if (containerPath === '') return undefined
  const probe = await probePath(ctx, exec, containerPath)
  if (probe === undefined || probe.info.type !== 'file') return undefined
  const db = tryOpenSqliteReadOnly(ctx.fs.processPath(probe.target))
  if (db === undefined) return undefined
  return readSqliteValue(ctx, caps, probe.target, probe.info, spec, exec, db)
}

/** Read a URL (fetch failures are values, not throws). */
async function readUrlValue(ctx: Context, caps: ReadToolCaps, rawPath: string, exec: ToolExecution): Promise<ReadValue> {
  const result = await fetchUrlText(rawPath, caps.urlMaxLines, caps.urlMaxBytes, exec.signal)
  return {
    path: result.path,
    kind: 'url',
    statusCode: result.statusCode,
    text: result.text,
    truncated: result.truncated,
    ...result.failed !== undefined ? { failed: result.failed } : {},
  }
}

/** The unified dispatch: URL → literal path → archive → SQLite → file → directory. */
async function executeRead(ctx: Context, caps: ReadToolCaps, rawPath: string, exec: ToolExecution): Promise<ReadValue> {
  if (rawPath.trim().length === 0) throw new Error('path must be a non-empty string')

  // 1. URL (including a trailing :raw)
  if (isUrlPath(rawPath) || (rawPath.endsWith(':raw') && isUrlPath(rawPath.slice(0, rawPath.length - 4)))) {
    return readUrlValue(ctx, caps, rawPath, exec)
  }

  // 2. Literal path first; archive/SQLite files defer to their branches so a
  //    bare `foo.zip` lists entries and a bare `data.db` lists tables.
  const literal = await probePath(ctx, exec, rawPath)
  if (literal !== undefined) {
    if (literal.info.type === 'directory') return readDirectory(ctx, caps, literal.target, literal.info, exec)
    if (literal.info.type === 'file') {
      if (archiveKindForPath(literal.target.displayPath) !== undefined) {
        return readArchiveValue(ctx, caps, literal.target, literal.info, '', exec)
      }
      if (isSqliteExtension(literal.target.displayPath)) {
        const db = tryOpenSqliteReadOnly(ctx.fs.processPath(literal.target))
        if (db !== undefined) return readSqliteValue(ctx, caps, literal.target, literal.info, '', exec, db)
      }
      return readFile(ctx, caps, literal.target, literal.info, undefined, exec)
    }
    throw new FsError(`cannot read "${literal.target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }

  // 3. Archive selector (`container:inner`).
  const archiveValue = await readArchiveSelector(ctx, caps, rawPath, exec)
  if (archiveValue !== undefined) return archiveValue

  // 4. SQLite selector (`container:table[:key][?…]`).
  const sqliteValue = await readSqliteSelector(ctx, caps, rawPath, exec)
  if (sqliteValue !== undefined) return sqliteValue

  // 5. Local file with selectors.
  const parsed = parseSelectors(rawPath)
  const target = await ctx.fs.resolve(parsed.base, sessionResolveOptions(exec, parsed.base))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type === 'directory') return readDirectory(ctx, caps, target, info, exec)
  if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return readFile(ctx, caps, target, info, parsed.selector, exec)
}

/** Parse selectors defensively for render/present paths: a filename that merely
 *  looks like a selector tail must never crash presentation of a valid read. */
function safeParseSelectors(path: string): ParsedSelectors {
  try {
    return parseSelectors(path)
  } catch {
    return { base: path, selector: { kind: 'plain' } }
  }
}

function cellText(cell: SqliteCell): string {
  return cell === null ? 'NULL' : String(cell)
}

/** Render SQLite rows as an aligned text table with a truncation footer. */
function renderSqliteRows(columns: string[], rows: SqliteRow[], truncated: boolean): string {
  const cell = (value: SqliteCell): string => {
    const text = cellText(value)
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  }
  const widths = columns.map((column, i) => {
    let width = column.length
    for (const row of rows) {
      const text = cell(row[i]!)
      if (text.length > width) width = text.length
    }
    return Math.min(width, 120)
  })
  const line = (cells: string[]) => cells.map((text, i) => text.padEnd(widths[i]!)).join(' | ').trimEnd()
  const out = [line(columns)]
  for (const row of rows) out.push(line(row.map(cell)))
  if (truncated) out.push(`(showing first ${rows.length} rows)`)
  return out.join('\n')
}

/** Render one canonical `read` value as the model-facing text. */
export function renderReadValue(args: { path: string }, value: ReadValue, caps: ReadToolCaps): ContentBlock[] {
  switch (value.kind) {
    case 'file': {
      const selector = safeParseSelectors(args.path).selector
      const request = windowRequestFromSelector(selector, caps)
      const window: WindowResult = {
        offset: value.offset ?? 1,
        lines: value.lines ?? [],
        rawText: value.text ?? '',
        totalLines: value.totalLines ?? 0,
        truncatedByBytes: false,
        truncatedByLines: value.truncated ?? false,
        outOfRange: value.outOfRange ?? false,
        requestedEnd: request.ranges[0]?.end ?? 0,
      }
      const text = request.mode === 'raw'
        ? formatRawRead(value.path, window)
        : formatNumberedRead(value.path, window)
      return [{ type: 'text', text }]
    }
    case 'directory':
      return [{ type: 'text', text: `<path>${value.path}</path>\n<type>directory</type>\n<content>\n${value.tree ?? ''}\n</content>` }]
    case 'archive': {
      if (value.entryText !== undefined || value.binary) {
        const body = value.binary
          ? `(binary file — ${value.entryBytes ?? 0} bytes; read_image is for images, and other binary formats need a dedicated tool)`
          : `${value.entryText ?? ''}${value.truncated ? '\n\n(entry output truncated)' : ''}`
        return [{ type: 'text', text: `<path>${value.path}</path>\n<type>archive</type>\n<content>\n${body}\n</content>` }]
      }
      const listing = value.entries?.join('\n') ?? ''
      return [{ type: 'text', text: `<path>${value.path}</path>\n<type>archive</type>\n<content>\n${listing}\n</content>` }]
    }
    case 'sqlite': {
      let body: string
      if (value.tables !== undefined) {
        body = value.tables.length > 0 ? value.tables.join('\n') : '(no tables)'
      } else if (value.query !== undefined) {
        body = renderSqliteRows(value.columns ?? [], value.rows ?? [], value.truncated ?? false)
      } else if (value.key !== undefined) {
        body = renderSqliteRows(value.columns ?? [], value.rows ?? [], false)
      } else {
        body = `${value.schema ?? ''}\n\n${renderSqliteRows(value.columns ?? [], value.rows ?? [], value.truncated ?? false)}`
      }
      return [{ type: 'text', text: `<path>${value.path}</path>\n<type>sqlite</type>\n<content>\n${body}\n</content>` }]
    }
    case 'url':
      return [{
        type: 'text',
        text: formatUrlRead({
          path: value.path,
          statusCode: value.statusCode ?? 0,
          text: value.text ?? '',
          truncated: value.truncated ?? false,
          ...value.failed !== undefined ? { failed: value.failed } : {},
        }),
      }]
  }
}

/**
 * Register the `read` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param caps - the deployment's resolved read caps.
 */
export function applyReadTool(ctx: Context, caps: ReadToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: 100,
    text: 'Use the read tool — not shell commands like cat — to inspect files, directories, archives, SQLite databases, and URLs. '
      + 'For text files the path may end with a selector: :raw (no line numbers), :N (one line), :A-B (line range), :A+C (C lines from A), '
      + 'comma-separated ranges like :A-B,C-D, or :range:raw (raw range). Line numbers are 1-based. '
      + 'Archives read as path:inner/path; SQLite as path:table, path:table:key, or path?q=SELECT…. '
      + 'URLs are fetched and converted to text (append :raw for the raw body).',
  })

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a text file (with line selectors), directory tree, archive entry, SQLite table/row/query, or URL.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path, URL, or archive/SQLite selector to read.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['file', 'directory', 'archive', 'sqlite', 'url'] },
          offset: { type: 'integer' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          text: { type: 'string' },
          totalLines: { type: 'integer' },
          truncated: { type: 'boolean' },
          outOfRange: { type: 'boolean' },
          tree: { type: 'string' },
          entries: { type: 'array', items: { type: 'string' } },
          entryPath: { type: 'string' },
          entryText: { type: 'string' },
          entryBytes: { type: 'integer' },
          binary: { type: 'boolean' },
          tables: { type: 'array', items: { type: 'string' } },
          table: { type: 'string' },
          schema: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' } },
          rows: {
            type: 'array',
            items: {
              type: 'array',
              items: {
                oneOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'null' },
                  { type: 'boolean' },
                ],
              },
            },
          },
          key: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          query: { type: 'string' },
          statusCode: { type: 'integer' },
          failed: { type: 'string' },
        },
      },
      render: (args, value) => renderReadValue(args, value, caps),
      // Project the structured window into persisted `meta` so a UI's read card
      // survives replay; non-file kinds decline to the generic card.
      presentationMeta: (_args, value): JsonValue => {
        if (value.kind !== 'file') return { path: value.path, kind: value.kind }
        const lang = langFromPath(value.path)
        return {
          path: value.path,
          offset: value.offset ?? 1,
          lines: value.lines ?? [],
          totalLines: value.totalLines ?? 0,
          ...lang === undefined ? {} : { lang },
        }
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return executeRead(ctx, caps, args.path, exec)
    },
    // Pure display: a generic card titled by the target with a follow-along
    // location on the requested first line.
    presentCall(args): GenericCallView {
      const selector = safeParseSelectors(args.path).selector
      const line = selector.kind === 'range' ? selector.start
        : selector.kind === 'ranges' ? selector.ranges[0]?.start
        : undefined
      return {
        card: 'generic',
        title: `Read ${args.path}`,
        kind: 'read',
        locations: [{ path: args.path, ...line !== undefined ? { line } : {} }],
      }
    },
    // Result-time display: the read card from persisted meta when the content
    // is the file envelope; otherwise the generic fallback.
    presentResult(_args, result: ToolResult): ReadResultView | undefined {
      if (result.isError) return undefined
      const meta = readMetaFromMeta(result.meta)
      if (meta === undefined) return undefined
      const only = result.content.length === 1 ? result.content[0] : undefined
      const text = only?.type === 'text' ? only.text : undefined
      if (text === undefined) return undefined
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return {
        card: 'read',
        path: meta.path,
        offset: meta.offset,
        lines: meta.lines,
        totalLines: meta.totalLines,
        ...meta.lang === undefined ? {} : { lang: meta.lang },
        content: [{ type: 'text', text: body }],
      }
    },
  }))
}

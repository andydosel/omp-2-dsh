/**
 * SQLite row writing: INSERT into a table (`container:table`), UPDATE or
 * DELETE by single-column primary key / rowid (`container:table:key`).
 * Query parameters are rejected for writes. The mutation gates
 * (`fs/write-intent` + `fs/observed`) run through `ctx.fs`; the row mutation
 * itself opens the database with `node:sqlite` directly (the `ctx.fs` seam has
 * no SQLite API) — the same documented deviation as archive writes.
 * @module dsh-tool-read-write/write/sqlite-write
 */

import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import JSON5 from 'json5'
import { isSqliteExtension, primaryKeyColumn, validateSqliteIdentifier } from '../read/sqlite.ts'

/** The written SQLite row result the write tool folds into its canonical value. */
export interface SqliteWriteResult {
  path: string
  kind: 'sqlite'
  operation: 'insert' | 'update' | 'delete'
  before: string | null
  after: string | null
}

/** Parse the `:table` / `:table:key` spec after a SQLite container path. */
function parseSqliteWriteSpec(spec: string): { table: string; key?: string } {
  if (spec === '') throw new Error('invalid SQLite write target: missing table name (use path:table or path:table:key)')
  if (spec.includes('?') || spec.startsWith('q=')) {
    throw new Error('SQLite writes do not accept query parameters; use path:table or path:table:key')
  }
  const colon = spec.indexOf(':')
  if (colon !== -1) {
    const table = spec.slice(0, colon)
    const key = spec.slice(colon + 1)
    if (table === '' || key === '') throw new Error(`invalid SQLite write target "${spec}": expected table:key`)
    validateSqliteIdentifier(table)
    return { table, key }
  }
  validateSqliteIdentifier(spec)
  return { table: spec }
}

/** A JSON5 value that can bind as a SQLite parameter (SQLite has no boolean type). */
type BindValue = string | number | null

/** Convert a JSON5-parsed value into a bindable parameter (booleans → 1/0; objects/arrays serialize to JSON text). */
function toBindValue(value: unknown): BindValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') {
    return value
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  return JSON.stringify(value)
}

/** Validate a JSON5 object literal and return its key/value pairs in key order. */
function parseRowObject(content: string): Array<{ key: string; value: BindValue }> {
  let parsed: unknown
  try {
    parsed = JSON5.parse(content)
  } catch (error: unknown) {
    throw new Error(`invalid JSON5 row: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid JSON5 row: expected an object of column: value pairs')
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) throw new Error('invalid JSON5 row: the object must not be empty')
  return entries.map(([key, value]) => {
    validateSqliteIdentifier(key)
    return { key, value: toBindValue(value) }
  })
}

/** Refuse the mutation under a read-only sandbox policy. */
function refuseReadOnly(policy: SandboxExecutionPolicy | undefined, path: string): void {
  if (policy !== undefined && policy.mode === 'read-only') {
    throw new FsError(
      `${sandboxDenialMarker('read-only')}\nSQLite writes are not permitted under read-only sandbox mode for "${path}"`,
      'FS_SANDBOX_DENIED',
    )
  }
}

/**
 * Write one SQLite row. Returns `undefined` when the path is not a SQLite
 * write target (the caller falls through to a plain file write).
 */
export async function writeSqliteRow(
  ctx: Context,
  exec: ToolExecution,
  rawPath: string,
  content: string,
  policy: SandboxExecutionPolicy | undefined,
  config: { sqliteWriteEnabled: boolean },
): Promise<SqliteWriteResult | undefined> {
  if (!config.sqliteWriteEnabled) {
    throw new Error('SQLite writes are disabled by configuration')
  }
  const start = /^[A-Za-z]:[\\/]/.test(rawPath) ? 2 : 0
  let sep = -1
  for (let i = start; i < rawPath.length; i++) {
    if (rawPath[i] === ':' || rawPath[i] === '?') {
      sep = i
      break
    }
  }
  if (sep === -1) return undefined
  const containerPath = rawPath.slice(0, sep)
  const spec = rawPath.slice(sep + 1)
  if (containerPath === '') return undefined

  const target = await ctx.fs.resolve(containerPath, { ...policy !== undefined ? { cwd: policy.workspaceRoot } : {}, signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined || info.type !== 'file') return undefined
  // Only paths that CLAIM a SQLite extension reach the SQLite branch; a file
  // that claims it but is not a database is a hard error, never a file write.
  if (!isSqliteExtension(target.displayPath)) return undefined
  refuseReadOnly(policy, target.displayPath)

  const { table, key } = parseSqliteWriteSpec(spec)

  // The mutation gate runs through ctx.fs; the row mutation opens the database
  // directly (ctx.fs has no SQLite API).
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
  if (intent !== undefined) {
    if (intent.kind === 'createIfAbsent') {
      throw new FsError('cannot write SQLite: the database already exists', 'FS_STALE_VERSION')
    }
    if (intent.version !== info.version) {
      throw new FsError('cannot write SQLite: the database changed since it was last observed — re-read, then retry', 'FS_STALE_VERSION')
    }
  }

  const processPath = ctx.fs.processPath(target)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(processPath)
    // DatabaseSync validates the header lazily — force it now so a text file
    // claiming a .db name refuses with a clear error, not a late SQL error.
    db.prepare('SELECT 1').get()
  } catch {
    throw new Error(`cannot write "${rawPath}": "${containerPath}" is not a SQLite database`)
  }
  try {
    if (key === undefined) {
      // INSERT
      const fields = parseRowObject(content)
      const columns = fields.map(field => field.key)
      const values = fields.map(field => field.value)
      const placeholders = columns.map(() => '?').join(', ')
      db.prepare(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`).run(...values)
      const result: SqliteWriteResult = { path: `${target.displayPath}:${table}`, kind: 'sqlite', operation: 'insert', before: null, after: content }
      await observeAfter(ctx, target, exec)
      return result
    }
    // UPDATE or DELETE by primary key / rowid.
    const pk = primaryKeyColumn(db, table)
    const select = db.prepare(`SELECT * FROM "${table}" WHERE "${pk}" = ?`)
    const oldRow = select.get(key)
    const before = oldRow === undefined ? null : JSON.stringify(oldRow)
    if (content.trim() === '') {
      if (oldRow === undefined) throw new FsError(`cannot delete from "${table}": no row with ${pk} = ${key}`, 'FS_NOT_FOUND')
      db.prepare(`DELETE FROM "${table}" WHERE "${pk}" = ?`).run(key)
      const result: SqliteWriteResult = { path: `${target.displayPath}:${table}:${key}`, kind: 'sqlite', operation: 'delete', before, after: null }
      await observeAfter(ctx, target, exec)
      return result
    }
    const fields = parseRowObject(content)
    const sets = fields.map(field => `"${field.key}" = ?`).join(', ')
    const values = fields.map(field => field.value)
    const outcome = db.prepare(`UPDATE "${table}" SET ${sets} WHERE "${pk}" = ?`).run(...values, key)
    if (Number(outcome.changes) === 0) {
      throw new FsError(`cannot update "${table}": no row with ${pk} = ${key}`, 'FS_NOT_FOUND')
    }
    const result: SqliteWriteResult = { path: `${target.displayPath}:${table}:${key}`, kind: 'sqlite', operation: 'update', before, after: content }
    await observeAfter(ctx, target, exec)
    return result
  } finally {
    db.close()
  }
}

/** Re-stat the container after the row mutation and record the present observation. */
async function observeAfter(ctx: Context, target: FsTarget, exec: ToolExecution): Promise<void> {
  const after = await ctx.fs.stat(target, exec.signal)
  if (after === undefined) {
    throw new FsError(`cannot observe SQLite write: "${target.displayPath}" disappeared`, 'FS_NOT_FOUND')
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: after.version }, exec)
}


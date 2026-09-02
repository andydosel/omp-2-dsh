/**
 * SQLite reading: table list, table schema + sample rows, single-row lookup by
 * primary key or rowid, and raw SELECT queries — all through a read-only
 * `node:sqlite` handle. `node:sqlite` is stable and flag-free in Node 24
 * (verified: `DatabaseSync` with `readOnly` opens and queries work).
 * @module dsh-tool-read-write/read/sqlite
 */

import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

/** The SQLite file header magic ("SQLite format 3\0"). */
const SQLITE_MAGIC = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
])

/** Whether the first bytes of a file match the SQLite header magic. */
export function isSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC[i]) return false
  }
  return true
}

/** A JSON-safe SQLite cell value. */
export type SqliteCell = string | number | boolean | null

/** One row of cell values. */
export type SqliteRow = SqliteCell[]

/** The parsed `:table…` spec following a SQLite container path. */
export type SqliteReadSpec =
  | { kind: 'tables' }
  | { kind: 'table'; table: string; limit: number; where?: string }
  | { kind: 'key'; table: string; key: string }
  | { kind: 'query'; query: string }

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validate a table/column name as a bare SQLite identifier (quotes not allowed). */
export function validateSqliteIdentifier(name: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`invalid SQLite identifier "${name}": only bare [A-Za-z_][A-Za-z0-9_]* names are supported`)
  }
}

/** SQL keywords that must never appear in a `where` clause or raw query. */
const FORBIDDEN_KEYWORDS = [
  'union', 'insert', 'update', 'delete', 'drop', 'alter', 'create',
  'attach', 'detach', 'reindex', 'vacuum', 'pragma', 'begin', 'commit',
  'rollback', 'savepoint', 'replace', 'into', 'grant',
]

const FORBIDDEN_KEYWORD_RES = FORBIDDEN_KEYWORDS.map(keyword => new RegExp(`\\b${keyword}\\b`, 'i'))

/** Whether text contains a forbidden SQL keyword (word-boundary match). */
function hasForbiddenKeyword(text: string): boolean {
  return FORBIDDEN_KEYWORD_RES.some(re => re.test(text))
}

/** Reject comment/statement separators in user-supplied SQL fragments. */
function assertNoCommentsOrStatements(fragment: string, what: string): void {
  if (/;/.test(fragment)) throw new Error(`invalid ${what}: semicolons are not allowed`)
  if (/--|\/\*|\*\//.test(fragment)) throw new Error(`invalid ${what}: SQL comments are not allowed`)
}

/** Validate a `where` clause fragment (heuristic guard; the read-only open is the real safety). */
export function validateWhereClause(where: string): void {
  assertNoCommentsOrStatements(where, 'where clause')
  if (hasForbiddenKeyword(where)) throw new Error('invalid where clause: SQL mutations and UNION are not allowed')
}

/** Validate a raw `?q=` SELECT query. */
export function validateRawQuery(query: string): void {
  const trimmed = query.trim()
  if (!/^select\b/i.test(trimmed)) throw new Error('invalid query: only SELECT statements are allowed')
  assertNoCommentsOrStatements(query, 'query')
  if (hasForbiddenKeyword(query)) throw new Error('invalid query: SQL mutations and UNION are not allowed')
}

/** Convert a node:sqlite value into a JSON-safe cell. */
export function sqliteValueToCell(value: unknown): SqliteCell {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'bigint') {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
    return value.toString()
  }
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  return String(value)
}

/** Iterate a statement's rows, converting each to JSON-safe cells, capped at `maxRows`. */
function rowsOf(statement: StatementSync, params: readonly SQLInputValue[], maxRows: number): { rows: SqliteRow[]; truncated: boolean } {
  const rows: SqliteRow[] = []
  // StatementSync.iterate (Node 23.6+/24) bounds memory on huge tables; fall
  // back to all()+slice when the runtime lacks it.
  if (typeof statement.iterate === 'function') {
    for (const raw of statement.iterate(...params)) {
      if (rows.length >= maxRows) return { rows, truncated: true }
      rows.push(Object.values(raw).map(sqliteValueToCell))
    }
    return { rows, truncated: false }
  }
  const all = statement.all(...params)
  return { rows: all.slice(0, maxRows).map(raw => Object.values(raw).map(sqliteValueToCell)), truncated: all.length > maxRows }
}

/** Whether a path claims a SQLite database by extension. */
export function isSqliteExtension(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.sqlite') || lower.endsWith('.sqlite3') || lower.endsWith('.db') || lower.endsWith('.db3')
}

/** Open a database read-only; the caller owns closing the handle. */
export function openSqliteReadOnly(processPath: string): DatabaseSync {
  return new DatabaseSync(processPath, { readOnly: true })
}

/**
 * Try a read-only open, validating the SQLite header (DatabaseSync validates
 * lazily — the header check fires at the first statement, so the probe runs
 * `SELECT 1`). `undefined` when the file is not a SQLite database. This is the
 * capability probe the read/write dispatch uses — `readBytes` cannot be used
 * for header sniffing because it caps the WHOLE file. The returned handle is
 * open and the caller owns closing it.
 */
export function tryOpenSqliteReadOnly(processPath: string): DatabaseSync | undefined {
  let db: DatabaseSync | undefined
  try {
    db = openSqliteReadOnly(processPath)
    db.prepare('SELECT 1').get()
    return db
  } catch {
    if (db !== undefined) {
      try {
        db.close()
      } catch {
        // Close failures still leave the file untouched; nothing to recover.
      }
    }
    return undefined
  }
}

/** List user tables and views. */
export function listSqliteTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all()
  return rows.map(row => String((row as Record<string, unknown>).name))
}

/** The CREATE statement for one table/view. */
export function sqliteSchemaOf(db: DatabaseSync, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(table) as
    | Record<string, unknown>
    | undefined
  if (row === undefined || typeof row.sql !== 'string') {
    throw new Error(`table "${table}" does not exist`)
  }
  return row.sql
}

/** Query one table with an optional validated where clause and limit. */
export function querySqliteTable(
  db: DatabaseSync,
  table: string,
  limit: number,
  where?: string,
): { columns: string[]; rows: SqliteRow[]; truncated: boolean } {
  validateSqliteIdentifier(table)
  // No SQL LIMIT: the row iterator stops at `limit`, so `truncated` reports
  // whether MORE rows exist (a SQL LIMIT would hide them from the iterator).
  const whereSql = where === undefined || where.trim() === '' ? '' : ` WHERE ${where}`
  const statement = db.prepare(`SELECT * FROM "${table}"${whereSql}`)
  const { rows, truncated } = rowsOf(statement, [], limit)
  return { columns: statement.columns().map(column => column.name), rows, truncated }
}

/** The single-column primary key of a table, or `rowid` when it has none. */
export function primaryKeyColumn(db: DatabaseSync, table: string): string {
  validateSqliteIdentifier(table)
  const info = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<Record<string, unknown>>
  const pkColumns = info.filter(row => Number(row.pk) > 0)
  if (pkColumns.length === 1) return String(pkColumns[0]!.name)
  return 'rowid'
}

/** Fetch one row by single-column primary key or rowid. */
export function querySqliteKey(
  db: DatabaseSync,
  table: string,
  key: string,
): { columns: string[]; rows: SqliteRow[] } {
  const pk = primaryKeyColumn(db, table)
  const statement = db.prepare(`SELECT * FROM "${table}" WHERE "${pk}" = ?`)
  const { rows } = rowsOf(statement, [key], 1)
  return { columns: statement.columns().map(column => column.name), rows }
}

/**
 * Parse the spec following a SQLite container path: empty (tables), `?q=…`
 * (raw query), `table` / `table?limit=…&where=…` (schema + rows), or
 * `table:key` (single-row lookup).
 * @param spec - everything after the container path's first `:` or `?`.
 * @param queryLimit - default row limit for `?`-configured table queries.
 * @param queryMax - maximum accepted `limit`.
 * @param rawQueryMaxRows - maximum rows a raw query returns.
 */
export function parseSqliteSpec(
  spec: string,
  queryLimit: number,
  queryMax: number,
  rawQueryMaxRows: number,
): SqliteReadSpec {
  if (spec === '') return { kind: 'tables' }
  // ?q=… at the container level.
  if (spec.startsWith('?q=')) {
    const query = spec.slice(3)
    validateRawQuery(query)
    return { kind: 'query', query }
  }
  // table:key
  const colon = spec.indexOf(':')
  if (colon !== -1) {
    const table = spec.slice(0, colon)
    const key = spec.slice(colon + 1)
    if (table === '' || key === '') throw new Error(`invalid SQLite selector "${spec}": expected table:key`)
    validateSqliteIdentifier(table)
    return { kind: 'key', table, key }
  }
  // table?limit=…&where=…
  const question = spec.indexOf('?')
  if (question !== -1) {
    const table = spec.slice(0, question)
    if (table === '') throw new Error('invalid SQLite selector: missing table name before "?"')
    validateSqliteIdentifier(table)
    const params = new URLSearchParams(spec.slice(question + 1))
    if (params.has('q')) {
      const query = params.get('q')!
      validateRawQuery(query)
      return { kind: 'query', query }
    }
    let limit = queryLimit
    const limitRaw = params.get('limit')
    if (limitRaw !== null) {
      const parsed = Number(limitRaw)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > queryMax) {
        throw new Error(`invalid limit "${limitRaw}": must be an integer from 1 to ${queryMax}`)
      }
      limit = parsed
    }
    const where = params.get('where')
    if (where !== null && where.trim() !== '') validateWhereClause(where)
    return { kind: 'table', table, limit, ...where !== null && where.trim() !== '' ? { where } : {} }
  }
  validateSqliteIdentifier(spec)
  return { kind: 'table', table: spec, limit: 5 }
}

/** Run a raw validated query, capping rows. */
export function runSqliteQuery(
  db: DatabaseSync,
  query: string,
  maxRows: number,
): { columns: string[]; rows: SqliteRow[]; truncated: boolean } {
  validateRawQuery(query)
  const statement = db.prepare(query)
  const { rows, truncated } = rowsOf(statement, [], maxRows)
  return { columns: statement.columns().map(column => column.name), rows, truncated }
}

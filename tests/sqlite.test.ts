import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  isSqliteHeader,
  listSqliteTables,
  openSqliteReadOnly,
  parseSqliteSpec,
  primaryKeyColumn,
  querySqliteKey,
  querySqliteTable,
  runSqliteQuery,
  sqliteSchemaOf,
  sqliteValueToCell,
  validateRawQuery,
  validateSqliteIdentifier,
  validateWhereClause,
} from '../src/read/sqlite.ts'
import { tempDir } from './helpers.ts'
import { join } from 'node:path'

let dir: string
let dbPath: string

beforeEach(async () => {
  dir = await tempDir('sqlite-test')
  dbPath = join(dir, 'test.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER);
    INSERT INTO users (name, age) VALUES ('alice', 30), ('bob', 25), ('carol', 40);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, payload BLOB);
    INSERT INTO events (kind, payload) VALUES ('login', x'0102ff');
    CREATE TABLE logs (message TEXT);
    INSERT INTO logs (message) VALUES ('first'), ('second');
    CREATE VIEW adult_users AS SELECT id, name FROM users WHERE age >= 30;
  `)
  db.close()
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
})

describe('isSqliteHeader', () => {
  it('recognizes the SQLite magic and rejects others', () => {
    expect(isSqliteHeader(new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00]))).toBe(true)
    expect(isSqliteHeader(new Uint8Array(16))).toBe(false)
    expect(isSqliteHeader(new Uint8Array([1, 2, 3]))).toBe(false)
  })
})

describe('table listing and schema', () => {
  it('lists user tables and views, excluding sqlite_ internal tables', () => {
    const db = openSqliteReadOnly(dbPath)
    const tables = listSqliteTables(db)
    expect(tables).toEqual(['adult_users', 'events', 'logs', 'users'])
    db.close()
  })

  it('returns the CREATE statement for a table', () => {
    const db = openSqliteReadOnly(dbPath)
    expect(sqliteSchemaOf(db, 'users')).toContain('CREATE TABLE users')
    expect(() => sqliteSchemaOf(db, 'missing')).toThrow(/does not exist/)
    db.close()
  })
})

describe('querySqliteTable', () => {
  it('returns columns and rows with the limit', () => {
    const db = openSqliteReadOnly(dbPath)
    try {
      const { columns, rows, truncated } = querySqliteTable(db, 'users', 2)
      expect(columns).toEqual(['id', 'name', 'age'])
      expect(rows).toEqual([[1, 'alice', 30], [2, 'bob', 25]])
      expect(truncated).toBe(true)
    } finally {
      db.close()
    }
  })

  it('applies a validated where clause', () => {
    const db = openSqliteReadOnly(dbPath)
    const { rows } = querySqliteTable(db, 'users', 20, 'age >= 30')
    expect(rows).toEqual([[1, 'alice', 30], [3, 'carol', 40]])
    db.close()
  })
})

describe('querySqliteKey', () => {
  it('looks up by single-column primary key', () => {
    const db = openSqliteReadOnly(dbPath)
    const { rows } = querySqliteKey(db, 'users', '2')
    expect(rows).toEqual([[2, 'bob', 25]])
    const missing = querySqliteKey(db, 'users', '99')
    expect(missing.rows).toEqual([])
    db.close()
  })

  it('falls back to rowid for tables without a single-column PK', () => {
    const db = openSqliteReadOnly(dbPath)
    try {
      expect(primaryKeyColumn(db, 'logs')).toBe('rowid')
      const { rows } = querySqliteKey(db, 'logs', '2')
      expect(rows).toEqual([['second']])
      // AUTOINCREMENT id IS a single-column PK (unlike a PK-less table).
      expect(primaryKeyColumn(db, 'events')).toBe('id')
    } finally {
      db.close()
    }
  })
})

describe('runSqliteQuery', () => {
  it('runs a SELECT and caps rows', () => {
    const db = openSqliteReadOnly(dbPath)
    const { rows, truncated } = runSqliteQuery(db, 'SELECT id, name FROM users ORDER BY id', 2)
    expect(rows).toEqual([[1, 'alice'], [2, 'bob']])
    expect(truncated).toBe(true)
    db.close()
  })
})

describe('validation guards', () => {
  it('rejects mutations, comments, and UNION in raw queries', () => {
    expect(() => validateRawQuery('SELECT 1')).not.toThrow()
    expect(() => validateRawQuery('select * from users')).not.toThrow()
    expect(() => validateRawQuery('INSERT INTO users VALUES (1)')).toThrow(/only SELECT/)
    expect(() => validateRawQuery('DELETE FROM users')).toThrow(/only SELECT/)
    expect(() => validateRawQuery('SELECT 1; DROP TABLE users')).toThrow(/semicolons/)
    expect(() => validateRawQuery('SELECT 1 -- comment')).toThrow(/comments/)
    expect(() => validateRawQuery('SELECT * FROM a UNION SELECT * FROM b')).toThrow(/UNION/)
  })

  it('rejects injection in where clauses', () => {
    expect(() => validateWhereClause('age > 21')).not.toThrow()
    expect(() => validateWhereClause('age > 21; DROP TABLE users')).toThrow(/semicolons/)
    expect(() => validateWhereClause('1=1 /* x */')).toThrow(/comments/)
    expect(() => validateWhereClause('id IN (SELECT 1) UNION SELECT 2')).toThrow(/UNION/)
    expect(() => validateWhereClause("name = 'x--'")).toThrow(/comments/)
  })

  it('validates bare identifiers', () => {
    expect(() => validateSqliteIdentifier('users')).not.toThrow()
    expect(() => validateSqliteIdentifier('_weird1')).not.toThrow()
    expect(() => validateSqliteIdentifier('select')).not.toThrow() // keyword as name is allowed; quoting handles it
    expect(() => validateSqliteIdentifier('a b')).toThrow(/identifier/)
    expect(() => validateSqliteIdentifier('1abc')).toThrow(/identifier/)
    expect(() => validateSqliteIdentifier('a"b')).toThrow(/identifier/)
  })
})

describe('parseSqliteSpec', () => {
  it('parses the spec forms', () => {
    expect(parseSqliteSpec('', 20, 500, 1000)).toEqual({ kind: 'tables' })
    expect(parseSqliteSpec('users', 20, 500, 1000)).toEqual({ kind: 'table', table: 'users', limit: 5 })
    expect(parseSqliteSpec('users:42', 20, 500, 1000)).toEqual({ kind: 'key', table: 'users', key: '42' })
    expect(parseSqliteSpec('users?limit=7&where=age>21', 20, 500, 1000))
      .toEqual({ kind: 'table', table: 'users', limit: 7, where: 'age>21' })
    expect(parseSqliteSpec('?q=SELECT 1', 20, 500, 1000)).toEqual({ kind: 'query', query: 'SELECT 1' })
    expect(parseSqliteSpec('users?q=SELECT * FROM users', 20, 500, 1000)).toEqual({ kind: 'query', query: 'SELECT * FROM users' })
  })

  it('rejects invalid limits and where clauses', () => {
    expect(() => parseSqliteSpec('users?limit=0', 20, 500, 1000)).toThrow(/limit/)
    expect(() => parseSqliteSpec('users?limit=9999', 20, 500, 1000)).toThrow(/limit/)
    expect(() => parseSqliteSpec('users?where=1; DROP', 20, 500, 1000)).toThrow(/semicolons/)
    expect(() => parseSqliteSpec('users?q=DELETE FROM users', 20, 500, 1000)).toThrow(/only SELECT/)
    expect(() => parseSqliteSpec('a b:1', 20, 500, 1000)).toThrow(/identifier/)
  })
})

describe('sqliteValueToCell', () => {
  it('converts values to JSON-safe cells', () => {
    expect(sqliteValueToCell(null)).toBeNull()
    expect(sqliteValueToCell('x')).toBe('x')
    expect(sqliteValueToCell(42)).toBe(42)
    expect(sqliteValueToCell(2n)).toBe(2)
    expect(sqliteValueToCell(BigInt('12345678901234567890123'))).toBe('12345678901234567890123')
    expect(sqliteValueToCell(Uint8Array.of(1, 255))).toBe('0x01ff')
  })
})

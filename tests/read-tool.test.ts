import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyReadTool } from '../src/read/index.ts'
import type { ReadToolCaps } from '../src/read/index.ts'
import type { ReadValue } from '../src/read/index.ts'
import { HarnessCtx, HarnessFs, makeExec, tempDir } from './helpers.ts'
import { buildZip, text } from './archive-fixtures.ts'

const CAPS: ReadToolCaps = {
  limit: 300,
  maxLines: 2000,
  maxLineLength: 2000,
  maxBytes: 50 * 1024,
  directory: { depth: 2, perDir: 12 },
  archiveListLimit: 500,
  sqliteQueryLimit: 20,
  sqliteQueryMax: 500,
  sqliteRawQueryMaxRows: 1000,
  urlMaxLines: 300,
  urlMaxBytes: 50 * 1024,
}

let dir: string
let ctx: HarnessCtx
let read: (path: string) => Promise<ReadValue>

beforeEach(async () => {
  dir = await tempDir('read-tool-test')
  ctx = new HarnessCtx(new HarnessFs(dir))
  applyReadTool(ctx as never, CAPS)
  const definition = ctx.registered[0]!
  read = async (path: string) => definition.execute({ path }, makeExec()) as Promise<ReadValue>
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

describe('read tool: text files with selectors', () => {
  beforeEach(async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    await writeFile(join(dir, 'a.txt'), lines.join('\n'), 'utf8')
  })

  it('reads the default window and records fs/observed present', async () => {
    const value = await read('a.txt')
    expect(value.kind).toBe('file')
    expect(value.totalLines).toBe(20)
    expect(value.lines!.length).toBe(20)
    expect(value.offset).toBe(1)
    expect(ctx.observed).toHaveLength(1)
    const [target, obs] = ctx.observed[0] as [unknown, { kind: string }]
    expect((target as { displayPath: string }).displayPath).toContain('a.txt')
    expect(obs.kind).toBe('present')
  })

  it('applies :A-B with 1+3 context lines', async () => {
    const value = await read('a.txt:10-12')
    expect(value.lines!.map(line => line.number)).toEqual([9, 10, 11, 12, 13, 14, 15])
  })

  it('applies :N with context', async () => {
    const value = await read('a.txt:5')
    expect(value.lines!.map(line => line.number)).toEqual([4, 5, 6, 7, 8])
  })

  it('applies multi-ranges without context', async () => {
    const value = await read('a.txt:1-2,5-6')
    expect(value.lines!.map(line => line.number)).toEqual([1, 2, 5, 6])
  })

  it('returns raw text with :raw', async () => {
    const value = await read('a.txt:raw')
    expect(value.text).toBe(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'))
    expect(value.lines).toBeUndefined()
    expect(value.kind).toBe('file')
  })

  it('returns a raw range with :A-B:raw', async () => {
    const value = await read('a.txt:3-5:raw')
    expect(value.text).toBe('line 3\nline 4\nline 5')
  })

  it('reports out-of-range with a hint instead of throwing', async () => {
    const value = await read('a.txt:100-110')
    expect(value.outOfRange).toBe(true)
    expect(value.lines).toBeUndefined()
  })

  it('throws FS_NOT_FOUND for a missing file and records absence', async () => {
    await expect(read('missing.txt')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    const [target, obs] = ctx.observed[0] as [unknown, { kind: string }]
    expect(obs.kind).toBe('absent')
    expect((target as { displayPath: string }).displayPath).toContain('missing.txt')
  })
})

describe('read tool: directories', () => {
  beforeEach(async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'README.md'), 'hi', 'utf8')
    await writeFile(join(dir, 'src', 'index.ts'), 'x', 'utf8')
  })

  it('renders a directory tree', async () => {
    const value = await read(dir)
    expect(value.kind).toBe('directory')
    expect(value.tree).toContain('README.md')
    expect(value.tree).toContain('src/')
    expect(value.tree).toContain('index.ts')
  })
})

describe('read tool: archives', () => {
  beforeEach(async () => {
    const zip = buildZip([
      { name: 'dir/', data: new Uint8Array(0) },
      { name: 'dir/hello.txt', data: text('hello from zip') },
      { name: 'dir/nested.bin', data: Uint8Array.of(0, 1, 2) },
    ])
    await writeFile(join(dir, 'archive.zip'), zip)
  })

  it('lists a bare archive', async () => {
    const value = await read('archive.zip')
    expect(value.kind).toBe('archive')
    expect(value.entries).toEqual(['dir/', 'dir/hello.txt', 'dir/nested.bin'])
  })

  it('reads a text entry with :inner/path', async () => {
    const value = await read('archive.zip:dir/hello.txt')
    expect(value.kind).toBe('archive')
    expect(value.entryText).toBe('hello from zip')
    expect(value.binary).toBe(false)
  })

  it('hints on binary entries', async () => {
    const value = await read('archive.zip:dir/nested.bin')
    expect(value.kind).toBe('archive')
    expect(value.binary).toBe(true)
    expect(value.entryBytes).toBe(3)
  })

  it('lists children of a directory entry', async () => {
    const value = await read('archive.zip:dir')
    expect(value.kind).toBe('archive')
    expect(value.entries).toEqual(['hello.txt', 'nested.bin'])
  })

  it('throws FS_NOT_FOUND for a missing entry', async () => {
    await expect(read('archive.zip:nope.txt')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('records fs/observed for the container', async () => {
    await read('archive.zip')
    expect(ctx.observed).toHaveLength(1)
  })
})

describe('read tool: sqlite', () => {
  beforeEach(async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'data.db'))
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES (\'a\'), (\'b\'), (\'c\');')
    db.close()
  })

  it('lists tables for a bare database', async () => {
    const value = await read('data.db')
    expect(value.kind).toBe('sqlite')
    expect(value.tables).toEqual(['users'])
  })

  it('reads a table schema with sample rows', async () => {
    const value = await read('data.db:users')
    expect(value.kind).toBe('sqlite')
    expect(value.schema).toContain('CREATE TABLE users')
    expect(value.columns).toEqual(['id', 'name'])
    expect(value.rows).toEqual([[1, 'a'], [2, 'b'], [3, 'c']])
  })

  it('reads one row by primary key', async () => {
    const value = await read('data.db:users:2')
    expect(value.rows).toEqual([[2, 'b']])
    expect(value.key).toBe('2')
  })

  it('runs a raw query', async () => {
    const value = await read('data.db?q=SELECT name FROM users WHERE id >= 2')
    expect(value.query).toContain('SELECT name')
    expect(value.rows).toEqual([['b'], ['c']])
  })

  it('rejects injected raw queries', async () => {
    await expect(read('data.db?q=DELETE FROM users')).rejects.toThrow(/only SELECT/)
  })
})

describe('read tool: url', () => {
  it('fetches a URL and reports the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/plain' },
      text: async () => 'fetched body',
    })))
    const value = await read('https://example.com/x')
    expect(value.kind).toBe('url')
    expect(value.statusCode).toBe(200)
    expect(value.text).toBe('fetched body')
  })

  it('returns a failure value on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: { get: () => 'text/plain' },
      text: async () => '',
    })))
    const value = await read('https://example.com/down')
    expect(value.kind).toBe('url')
    expect(value.failed).toContain('HTTP 503')
  })
})

describe('read tool: dispatch order', () => {
  // `:` is invalid in Windows filenames, so the literal-file-priority case is POSIX-only.
  it.skipIf(process.platform === 'win32')('prefers a literal file over selector interpretation', async () => {
    await writeFile(join(dir, 'weird:10'), 'literal wins', 'utf8')
    const value = await read('weird:10')
    expect(value.kind).toBe('file')
    expect(value.lines![0]!.text).toBe('literal wins')
  })
})

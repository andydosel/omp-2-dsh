import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyWriteTool } from '../src/write/index.ts'
import type { WriteToolConfig } from '../src/write/index.ts'
import { FsSandboxController } from '../src/sandbox.ts'
import { HarnessCtx, HarnessFs, makeExec, ObservationPolicy, tempDir } from './helpers.ts'
import { buildZip, text } from './archive-fixtures.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const CONFIG: WriteToolConfig = {
  writeEnabled: true,
  sqliteWriteEnabled: true,
  archiveWriteEnabled: true,
  maxBytes: 50 * 1024,
}

type WriteValue = {
  path: string
  kind: 'file' | 'archive' | 'sqlite'
  operation: 'create' | 'update' | 'delete' | 'insert'
  before: string | null
  after: string | null
}

let dir: string
let ctx: HarnessCtx
let write: (args: { path: string; content: string }, exec?: ToolRunContext) => Promise<WriteValue>

function setup(policy?: ObservationPolicy): void {
  ctx = new HarnessCtx(new HarnessFs(dir), policy)
  const sandbox = new FsSandboxController(ctx as never)
  applyWriteTool(ctx as never, sandbox, CONFIG)
  const definition = ctx.registered[0]!
  write = (args, exec = makeExec()) => definition.execute(args, exec) as Promise<WriteValue>
}

beforeEach(async () => {
  dir = await tempDir('write-tool-test')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('write tool: file writes', () => {
  it('creates a file, fires fs/write-intent, and records fs/observed', async () => {
    setup()
    const result = await write({ path: 'new.txt', content: 'hello' })
    expect(result).toMatchObject({ kind: 'file', operation: 'create', before: null, after: 'hello' })
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('hello')
    expect(ctx.waterfallCalls.map(call => call.event)).toContain('fs/write-intent')
    expect(ctx.observed).toHaveLength(1)
    const [, obs] = ctx.observed[0] as [unknown, { kind: string }]
    expect(obs.kind).toBe('present')
  })

  it('overwrites an existing file and reports update', async () => {
    setup()
    await writeFile(join(dir, 'old.txt'), 'before', 'utf8')
    const result = await write({ path: 'old.txt', content: 'after' })
    expect(result).toMatchObject({ kind: 'file', operation: 'update', before: 'before', after: 'after' })
  })

  it('honors the observation policy CAS: unobserved write throws FS_NOT_OBSERVED', async () => {
    setup(new ObservationPolicy())
    await expect(write({ path: 'guarded.txt', content: 'x' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('honors the observation policy CAS: read then write succeeds', async () => {
    const policy = new ObservationPolicy()
    setup(policy)
    await writeFile(join(dir, 'guarded.txt'), 'v1', 'utf8')
    // Simulate a read that observed the present version.
    const fs = ctx.fs
    const target = await fs.resolve('guarded.txt')
    const info = await fs.stat(target)
    policy.record(target, { kind: 'present', version: info!.version })
    const result = await write({ path: 'guarded.txt', content: 'v2' })
    expect(result.operation).toBe('update')
  })

  it('fails stale when the file changed between observation and write', async () => {
    const policy = new ObservationPolicy()
    setup(policy)
    await writeFile(join(dir, 's.txt'), 'v1', 'utf8')
    const target = await ctx.fs.resolve('s.txt')
    policy.record(target, { kind: 'present', version: (await ctx.fs.stat(target))!.version })
    await writeFile(join(dir, 's.txt'), 'v1-changed', 'utf8')
    await expect(write({ path: 's.txt', content: 'v2' })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('refuses when writeEnabled is false', async () => {
    setup()
    const sandbox = new FsSandboxController(ctx as never)
    const { applyWriteTool } = await import('../src/write/index.ts')
    ctx.registered.length = 0
    applyWriteTool(ctx as never, sandbox, { ...CONFIG, writeEnabled: false })
    const definition = ctx.registered[0]!
    await expect(definition.execute({ path: 'x.txt', content: 'y' }, makeExec())).rejects.toThrow(/disabled/)
  })
})

describe('write tool: archive entry writes', () => {
  beforeEach(async () => {
    const zip = buildZip([
      { name: 'dir/', data: new Uint8Array(0) },
      { name: 'dir/a.txt', data: text('original') },
    ])
    await writeFile(join(dir, 'bundle.zip'), zip)
  })

  it('replaces an existing entry and rewrites the container atomically', async () => {
    setup()
    const result = await write({ path: 'bundle.zip:dir/a.txt', content: 'replaced' })
    expect(result).toMatchObject({ kind: 'archive', operation: 'update', before: 'original', after: 'replaced' })
    // Re-read the container with the plugin's own parser.
    const { parseZipContainer, findArchiveEntry, readZipEntryData, decodeEntryText } = await import('../src/read/archive.ts')
    const data = await readFile(join(dir, 'bundle.zip'))
    const { entries } = parseZipContainer(new Uint8Array(data))
    const entry = findArchiveEntry(entries, 'dir/a.txt')!
    expect(decodeEntryText(readZipEntryData(new Uint8Array(data), entry))).toBe('replaced')
    // Other entries survive.
    expect(entries.map(e => e.name)).toContain('dir/')
    expect(ctx.waterfallCalls.map(call => call.event)).toContain('fs/write-intent')
    expect(ctx.observed).toHaveLength(1)
  })

  it('adds a new entry and its missing parent directories', async () => {
    setup()
    const result = await write({ path: 'bundle.zip:new/sub/deep.txt', content: 'fresh' })
    expect(result).toMatchObject({ kind: 'archive', operation: 'create' })
    const { parseZipContainer, findArchiveEntry, readZipEntryData, decodeEntryText } = await import('../src/read/archive.ts')
    const data = new Uint8Array(await readFile(join(dir, 'bundle.zip')))
    const { entries } = parseZipContainer(data)
    expect(findArchiveEntry(entries, 'new/sub/deep.txt')).toBeDefined()
    expect(findArchiveEntry(entries, 'new/sub/')).toBeDefined()
    expect(decodeEntryText(readZipEntryData(data, findArchiveEntry(entries, 'new/sub/deep.txt')!))).toBe('fresh')
  })

  it('honors the observation policy for archive containers', async () => {
    setup(new ObservationPolicy())
    await expect(write({ path: 'bundle.zip:dir/a.txt', content: 'x' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('rejects parent traversal in entry paths', async () => {
    setup()
    await expect(write({ path: 'bundle.zip:../evil.txt', content: 'x' })).rejects.toThrow(/\.\./)
  })
})

describe('write tool: sqlite row writes', () => {
  beforeEach(async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'data.db'))
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER); INSERT INTO users (name, age) VALUES (\'alice\', 30);')
    db.close()
  })

  it('inserts a JSON5 row', async () => {
    setup()
    const result = await write({ path: 'data.db:users', content: '{ name: \'bob\', age: 25 }' })
    expect(result).toMatchObject({ kind: 'sqlite', operation: 'insert', after: "{ name: 'bob', age: 25 }" })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'data.db'), { readOnly: true })
    const rows = db.prepare('SELECT name, age FROM users ORDER BY id').all()
    expect(rows).toEqual([{ name: 'alice', age: 30 }, { name: 'bob', age: 25 }])
    db.close()
    expect(ctx.observed).toHaveLength(1)
  })

  it('updates a row by primary key with JSON5 content', async () => {
    setup()
    const result = await write({ path: 'data.db:users:1', content: '{ age: 31, name: "alice2" }' })
    expect(result).toMatchObject({ kind: 'sqlite', operation: 'update', before: '{"id":1,"name":"alice","age":30}' })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'data.db'), { readOnly: true })
    expect(db.prepare('SELECT name, age FROM users WHERE id = 1').get()).toEqual({ name: 'alice2', age: 31 })
    db.close()
  })

  it('deletes a row when content is empty', async () => {
    setup()
    const result = await write({ path: 'data.db:users:1', content: '' })
    expect(result).toMatchObject({ kind: 'sqlite', operation: 'delete', after: null })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'data.db'), { readOnly: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })
    db.close()
  })

  it('throws when updating a missing row', async () => {
    setup()
    await expect(write({ path: 'data.db:users:99', content: '{ name: "x" }' })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('rejects query parameters on writes', async () => {
    setup()
    await expect(write({ path: 'data.db:users?limit=5', content: '{}' })).rejects.toThrow(/query parameters/)
  })

  it('rejects invalid JSON5 rows', async () => {
    setup()
    await expect(write({ path: 'data.db:users', content: 'not an object' })).rejects.toThrow(/JSON5/)
  })

  it('honors the observation policy for the database container', async () => {
    setup(new ObservationPolicy())
    await expect(write({ path: 'data.db:users', content: '{ name: "x" }' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })
})

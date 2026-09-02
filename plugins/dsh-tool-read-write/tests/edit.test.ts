import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyEditTool, parseEditArgs } from '../src/edit.ts'
import { FsSandboxController } from '../src/sandbox.ts'
import { HarnessCtx, HarnessFs, makeExec, ObservationPolicy, tempDir } from './helpers.ts'

type EditValue = { path: string; before: string; after: string }

let dir: string
let ctx: HarnessCtx
let edit: (args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }) => Promise<EditValue>

function setup(policy?: ObservationPolicy): void {
  ctx = new HarnessCtx(new HarnessFs(dir), policy)
  const sandbox = new FsSandboxController(ctx as never)
  applyEditTool(ctx as never, sandbox)
  const definition = ctx.registered[0]!
  edit = (args) => definition.execute(args, makeExec()) as Promise<EditValue>
}

beforeEach(async () => {
  dir = await tempDir('edit-tool-test')
  await writeFile(join(dir, 'doc.txt'), 'one two three', 'utf8')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('parseEditArgs', () => {
  it('validates the argument constraints', () => {
    expect(parseEditArgs({ file_path: 'a.txt', old_string: 'x', new_string: 'y' }))
      .toEqual({ filePath: 'a.txt', oldString: 'x', newString: 'y', replaceAll: false })
    expect(() => parseEditArgs({ file_path: '', old_string: 'x', new_string: 'y' })).toThrow(/file_path/)
    expect(() => parseEditArgs({ file_path: 'a', old_string: '', new_string: 'y' })).toThrow(/old_string/)
    expect(() => parseEditArgs({ file_path: 'a', old_string: 'x', new_string: 'x' })).toThrow(/must differ/)
  })
})

describe('edit tool', () => {
  it('replaces a unique literal and records fs/observed', async () => {
    setup()
    const result = await edit({ file_path: 'doc.txt', old_string: 'two', new_string: '2' })
    expect(result).toMatchObject({ path: expect.stringContaining('doc.txt'), before: 'one two three', after: 'one 2 three' })
    expect(ctx.waterfallCalls.map(call => call.event)).toContain('fs/edit-intent')
    expect(ctx.observed).toHaveLength(1)
  })

  it('throws FS_AMBIGUOUS_EDIT for a non-unique literal without replace_all', async () => {
    setup()
    await writeFile(join(dir, 'dup.txt'), 'a a', 'utf8')
    await expect(edit({ file_path: 'dup.txt', old_string: 'a', new_string: 'b' }))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
  })

  it('replaces all occurrences with replace_all', async () => {
    setup()
    await writeFile(join(dir, 'dup.txt'), 'a a a', 'utf8')
    const result = await edit({ file_path: 'dup.txt', old_string: 'a', new_string: 'b', replace_all: true })
    expect(result.after).toBe('b b b')
  })

  it('throws FS_EDIT_NOT_FOUND for a missing literal', async () => {
    setup()
    await expect(edit({ file_path: 'doc.txt', old_string: 'zzz', new_string: 'x' }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
  })

  it('rejects edits to unobserved files under the observation policy', async () => {
    setup(new ObservationPolicy())
    await expect(edit({ file_path: 'doc.txt', old_string: 'two', new_string: '2' }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('succeeds after a read observed the file, and fails stale after an external change', async () => {
    const policy = new ObservationPolicy()
    setup(policy)
    const target = await ctx.fs.resolve('doc.txt')
    policy.record(target, { kind: 'present', version: (await ctx.fs.stat(target))!.version })
    const ok = await edit({ file_path: 'doc.txt', old_string: 'two', new_string: '2' })
    expect(ok.after).toBe('one 2 three')
    // External change between observation and edit → stale.
    const target2 = await ctx.fs.resolve('doc.txt')
    const current = await ctx.fs.stat(target2)
    await writeFile(join(dir, 'doc.txt'), 'changed externally', 'utf8')
    await expect(edit({ file_path: 'doc.txt', old_string: '2', new_string: 'TWO' }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    void current
  })

  it('appends the remediation hint to FS_NOT_OBSERVED', async () => {
    setup(new ObservationPolicy())
    try {
      await edit({ file_path: 'doc.txt', old_string: 'two', new_string: '2' })
      expect.unreachable('edit should have failed')
    } catch (error) {
      const err = error as { code: string; message: string }
      expect(err.code).toBe('FS_NOT_OBSERVED')
      expect(err.message).toContain('read the file, then retry')
    }
  })
})

/**
 * WATCHDOG discovery + parsing tests: upward walk, project-over-user
 * precedence, marker-bounded walk, roster schema validation, and attention
 * rendering.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverWatchdog, parseWatchdogYml, renderWatchdogGuidance, WATCHDOG_MD, WATCHDOG_YML } from '../src/watchdog.ts'

let root: string
let userDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'advisor-watchdog-'))
  userDir = join(root, 'user')
  await mkdir(userDir)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function projectTree(dir: string): Promise<void> {
  await mkdir(join(root, dir), { recursive: true })
}

describe('discoverWatchdog', () => {
  it('finds the nearest project WATCHDOG.md walking up to the git root', async () => {
    await projectTree('proj/.git')
    await projectTree('proj/src/deep')
    await writeFile(join(root, 'proj/WATCHDOG.md'), 'root guidance')
    await writeFile(join(root, 'proj/src/deep/WATCHDOG.md'), 'deep guidance')

    const source = await discoverWatchdog({ cwd: join(root, 'proj/src/deep'), userDir })
    expect(source.md?.path).toBe(join(root, 'proj/src/deep', WATCHDOG_MD))
    expect(source.md?.content).toBe('deep guidance')
  })

  it('stops the walk at the project root: files above it are not found', async () => {
    await projectTree('proj/.git')
    await writeFile(join(root, WATCHDOG_MD), 'above root')

    const source = await discoverWatchdog({ cwd: join(root, 'proj'), userDir })
    expect(source.md).toBeUndefined()
  })

  it('falls back to the user-level file when the project has none', async () => {
    await projectTree('proj/.git')
    await writeFile(join(userDir, WATCHDOG_MD), 'user guidance')

    const source = await discoverWatchdog({ cwd: join(root, 'proj'), userDir })
    expect(source.md?.content).toBe('user guidance')
  })

  it('prefers the project file over the user-level file', async () => {
    await projectTree('proj/.git')
    await writeFile(join(root, 'proj/WATCHDOG.md'), 'project')
    await writeFile(join(userDir, WATCHDOG_MD), 'user')

    const source = await discoverWatchdog({ cwd: join(root, 'proj'), userDir })
    expect(source.md?.content).toBe('project')
  })

  it('walks to the filesystem root without any project marker', async () => {
    await projectTree('no-marker/deep')
    await writeFile(join(root, WATCHDOG_MD), 'root-level guidance')

    const source = await discoverWatchdog({ cwd: join(root, 'no-marker/deep'), userDir })
    expect(source.md?.content).toBe('root-level guidance')
  })

  it('parses a WATCHDOG.yml roster found in the project', async () => {
    await projectTree('proj/.git')
    await writeFile(join(root, 'proj', WATCHDOG_YML), [
      'instructions: shared guidance',
      'roster:',
      '  - name: style',
      '    enabled: true',
      '    model: deepseek-chat',
      '    tools: [read, grep]',
      '    instructions: style rules',
      '  - name: off-reviewer',
      '    enabled: false',
    ].join('\n'))

    const source = await discoverWatchdog({ cwd: join(root, 'proj'), userDir })
    expect(source.roster?.path).toBe(join(root, 'proj', WATCHDOG_YML))
    expect(source.roster?.sharedInstructions).toBe('shared guidance')
    expect(source.roster?.entries).toHaveLength(2)
    expect(source.roster?.entries[0]).toMatchObject({
      name: 'style',
      enabled: true,
      model: 'deepseek-chat',
      tools: ['read', 'grep'],
      instructions: 'style rules',
    })
    expect(source.roster?.entries[1]).toMatchObject({ name: 'off-reviewer', enabled: false })
  })

  it('rejects oversized WATCHDOG files', async () => {
    await projectTree('proj/.git')
    await writeFile(join(root, 'proj', WATCHDOG_MD), 'x'.repeat(300 * 1024))
    const source = await discoverWatchdog({ cwd: join(root, 'proj'), userDir, fileSystem: undefined })
    expect(source.md).toBeUndefined()
  })
})

describe('parseWatchdogYml', () => {
  it('accepts a bare entry list', () => {
    const roster = parseWatchdogYml('- name: a\n  enabled: true\n- name: b\n', 'test.yml')
    expect(roster.entries.map(entry => entry.name)).toEqual(['a', 'b'])
    expect(roster.sharedInstructions).toBeUndefined()
  })

  it('applies defaults for optional entry fields', () => {
    const roster = parseWatchdogYml('roster:\n  - name: a\n', 'test.yml')
    expect(roster.entries[0]).toEqual({ name: 'a', enabled: true })
  })

  it('throws on a missing required name', () => {
    expect(() => parseWatchdogYml('roster:\n  - enabled: true\n', 'test.yml')).toThrow()
  })

  it('throws on malformed YAML', () => {
    expect(() => parseWatchdogYml('roster: [unclosed', 'test.yml')).toThrow(/invalid YAML/)
  })

  it('throws on a non-list, non-object document', () => {
    expect(() => parseWatchdogYml('42\n', 'test.yml')).toThrow()
  })
})

describe('renderWatchdogGuidance', () => {
  it('wraps markdown guidance in an attention block', () => {
    const text = renderWatchdogGuidance({ md: { path: '/x/WATCHDOG.md', content: 'rules' } })
    expect(text).toBe('<attention source="/x/WATCHDOG.md">\nrules\n</attention>')
  })

  it('returns empty with no markdown guidance', () => {
    expect(renderWatchdogGuidance({})).toBe('')
  })
})

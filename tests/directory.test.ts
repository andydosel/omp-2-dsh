import { describe, expect, it } from 'vitest'
import { buildDirectoryTree, formatSize, renderDirectoryTree } from '../src/read/directory.ts'
import type { DirectoryCaps } from '../src/read/directory.ts'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'

function target(name: string): FsTarget {
  return { targetKey: FsTargetKey(`key:${name}`), displayPath: `/abs/${name}` }
}

/** Build a fake listing from a map of name → type/size. */
function listing(entries: Record<string, { type: 'file' | 'directory' | 'other'; size?: number }>): FsDirEntry[] {
  return Object.entries(entries).map(([name, spec]) => ({
    name,
    type: spec.type,
    target: target(name),
    ...spec.size !== undefined ? { size: spec.size } : {},
  }))
}

const CAPS: DirectoryCaps = { depth: 2, perDir: 12 }

describe('buildDirectoryTree', () => {
  it('lists files with sizes and recurses directories to the depth cap', async () => {
    const dirs = new Map<string, FsDirEntry[]>()
    dirs.set('/abs/root', listing({
      'a.ts': { type: 'file', size: 1234 },
      'sub': { type: 'directory' },
    }))
    dirs.set('/abs/sub', listing({
      'b.ts': { type: 'file', size: 2345 },
      'deep': { type: 'directory' },
    }))
    dirs.set('/abs/deep', listing({ 'c.ts': { type: 'file', size: 10 } }))
    const listDir = async (t: FsTarget): Promise<FsDirEntry[]> => dirs.get(t.displayPath) ?? []
    const tree = await buildDirectoryTree(listDir, target('root'), CAPS)
    expect(tree.children!.map(child => child.name)).toEqual(['a.ts', 'sub'])
    expect(tree.children![1]!.children!.map(child => child.name)).toEqual(['b.ts', 'deep'])
    // depth 2: 'deep' is listed but not expanded.
    expect(tree.children![1]!.children![1]!.children).toBeUndefined()
  })

  it('caps entries per directory with an extraCount marker', async () => {
    const entries = listing(Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`f${i}.txt`, { type: 'file' as const, size: 5 }]),
    ))
    const tree = await buildDirectoryTree(async () => entries, target('root'), CAPS)
    expect(tree.children!.length).toBe(12)
    expect(tree.extraCount).toBe(3)
  })

  it('marks an empty directory', async () => {
    const tree = await buildDirectoryTree(async () => [], target('root'), CAPS)
    expect(tree.children).toEqual([])
    expect(tree.extraCount).toBe(0)
  })
})

describe('renderDirectoryTree', () => {
  it('renders a nested tree with sizes, dirs, empty markers, and the root label', async () => {
    const tree = await buildDirectoryTree(async (t) => {
      if (t.displayPath === '/abs/root') {
        return listing({ 'README.md': { type: 'file', size: 512 }, 'src': { type: 'directory' }, 'empty': { type: 'directory' } })
      }
      if (t.displayPath === '/abs/src') {
        return listing({ 'index.ts': { type: 'file', size: 1200 }, 'util.ts': { type: 'file', size: 300 } })
      }
      return []
    }, target('root'), CAPS)
    const text = renderDirectoryTree(tree, '/abs/root')
    expect(text).toContain('/abs/root/')
    expect(text).toContain('├── README.md (512 B)')
    expect(text).toContain('├── src/')
    expect(text).toContain('│   ├── index.ts (1.2 KB)')
    expect(text).toContain('│   └── util.ts (300 B)')
    expect(text).toContain('└── empty/')
    expect(text).toContain('    └── (empty directory)')
  })

  it('renders the +N more entries marker', async () => {
    const entries = listing(Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`f${i}.txt`, { type: 'file' as const, size: 5 }]),
    ))
    const tree = await buildDirectoryTree(async () => entries, target('root'), CAPS)
    const text = renderDirectoryTree(tree, '/abs/root')
    expect(text).toContain('└── +3 more entries')
  })

  it('renders (empty directory) for an empty root', () => {
    const tree = { name: '', isDir: true, children: [], extraCount: 0 }
    expect(renderDirectoryTree(tree, '/abs/root')).toBe('/abs/root/\n(empty directory)')
  })
})

describe('formatSize', () => {
  it('formats byte counts', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1234)).toBe('1.2 KB')
    expect(formatSize(1024 * 1024 * 2.5)).toBe('2.5 MB')
    expect(formatSize(1024 ** 3)).toBe('1 GB')
  })
})

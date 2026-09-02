/**
 * Directory tree reading: recursive listing bounded by depth and per-directory
 * entry caps, rendered as a box-drawing tree with human-readable sizes.
 * Pure over a `listDir` function so it is testable without a filesystem host.
 * @module dsh-tool-read-write/read/directory
 */

import type { FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'

/** Directory tree caps (the `directoryDepth` / `directoryPerDir` config). */
export interface DirectoryCaps {
  /** Recursion depth beyond the root directory (root = depth 0). */
  depth: number
  /** Maximum entries shown per directory before a `+N more entries` marker. */
  perDir: number
}

/** One node of the rendered tree. */
export interface DirectoryNode {
  /** Entry basename. */
  name: string
  /** Whether the entry is a directory. */
  isDir: boolean
  /** Byte size of a regular file. */
  size?: number
  /** Expanded children; `undefined` when not expanded (depth cap). */
  children?: DirectoryNode[]
  /** Number of entries hidden by the per-directory cap. */
  extraCount: number
}

/** The list-directory capability the tree builder needs (a `ctx.fs.listDir` view). */
export type ListDir = (target: FsTarget, signal?: AbortSignal) => Promise<FsDirEntry[]>

async function buildNode(
  listDir: ListDir,
  entryName: string,
  entry: FsDirEntry,
  depth: number,
  caps: DirectoryCaps,
  signal: AbortSignal | undefined,
): Promise<DirectoryNode> {
  if (entry.type !== 'directory' || depth >= caps.depth) {
    return {
      name: entryName,
      isDir: entry.type === 'directory',
      ...entry.type === 'file' && entry.size !== undefined ? { size: entry.size } : {},
      extraCount: 0,
    }
  }
  const children = await listDir(entry.target, signal)
  const shown = children.slice(0, caps.perDir)
  const built: DirectoryNode[] = []
  for (const child of shown) {
    built.push(await buildNode(listDir, child.name, child, depth + 1, caps, signal))
  }
  return {
    name: entryName,
    isDir: true,
    children: built,
    extraCount: children.length - shown.length,
  }
}

/**
 * Recursively list a directory into a bounded tree.
 * @param listDir - the directory-listing capability (typically `ctx.fs.listDir`).
 * @param target - the resolved root directory target.
 * @param caps - depth and per-directory caps.
 * @param signal - cancellation.
 * @returns the root tree node.
 */
export async function buildDirectoryTree(
  listDir: ListDir,
  target: FsTarget,
  caps: DirectoryCaps,
  signal?: AbortSignal,
): Promise<DirectoryNode> {
  const rootEntries = await listDir(target, signal)
  const shown = rootEntries.slice(0, caps.perDir)
  const children: DirectoryNode[] = []
  for (const child of shown) {
    children.push(await buildNode(listDir, child.name, child, 1, caps, signal))
  }
  return {
    name: '',
    isDir: true,
    children,
    extraCount: rootEntries.length - shown.length,
  }
}

/**
 * Format a byte count as a short human-readable size (`512 B`, `1.2 KB`, `2.5 MB`).
 * @param bytes - the byte count.
 * @returns the formatted size.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const candidate of units) {
    value /= 1024
    unit = candidate
    if (value < 1024) break
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
  return `${text} ${unit}`
}

function label(node: DirectoryNode): string {
  if (node.isDir) return `${node.name}/`
  return node.size === undefined ? node.name : `${node.name} (${formatSize(node.size)})`
}

function appendChildren(node: DirectoryNode, prefix: string, isLast: boolean, out: string[]): void {
  const connector = isLast ? '└── ' : '├── '
  out.push(`${prefix}${connector}${label(node)}`)
  if (node.children === undefined) return
  const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`
  const kids = node.children
  if (kids.length === 0 && node.extraCount === 0) {
    out.push(`${childPrefix}└── (empty directory)`)
    return
  }
  const tail: DirectoryNode[] = []
  if (node.extraCount > 0) tail.push({ name: `+${node.extraCount} more entries`, isDir: false, extraCount: 0 })
  for (let i = 0; i < kids.length; i++) {
    appendChildren(kids[i]!, childPrefix, i === kids.length - 1 && tail.length === 0, out)
  }
  if (tail.length > 0) {
    out.push(`${childPrefix}${tail.length > 0 ? '└── ' : ''}${label(tail[0]!)}`)
  }
}

/**
 * Render a directory tree as one text block: the root label line followed by
 * box-drawing children, `(empty directory)` markers, and `+N more entries`
 * truncation markers.
 * @param root - the tree root node.
 * @param rootLabel - the root directory's display label (its path).
 * @returns the rendered tree text.
 */
export function renderDirectoryTree(root: DirectoryNode, rootLabel: string): string {
  const lines: string[] = [`${rootLabel}/`]
  if (root.children === undefined) return lines.join('\n')
  if (root.children.length === 0 && root.extraCount === 0) {
    lines.push('(empty directory)')
    return lines.join('\n')
  }
  for (let i = 0; i < root.children.length; i++) {
    appendChildren(root.children[i]!, '', i === root.children.length - 1 && root.extraCount === 0, lines)
  }
  if (root.extraCount > 0) {
    lines.push(`└── +${root.extraCount} more entries`)
  }
  return lines.join('\n')
}

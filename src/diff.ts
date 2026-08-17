/**
 * Result-time contextual diff presentation for write and edit: derive one
 * three-line-context diff per applied hunk from before/after text. A small
 * internal LCS diff replaces the upstream `diff` dependency; inputs above the
 * fallback threshold degrade to one whole-text diff so memory stays bounded.
 * @module dsh-tool-read-write/diff
 */

import type { FileDiff } from '@deepseek-ai/dsh-tools'

/** Context lines shown on each side of an applied hunk. */
export const DIFF_CONTEXT = 3

/** Both sides above this many lines degrade to a single whole-text diff. */
const LCS_LINE_CAP = 800

/**
 * The `write`/`edit` tools' private `tool/result` `meta` payload.
 */
export type FsDiffMeta = { diffs: FileDiff[] }

/** Longest-common-subsequence edit script between two line arrays (bounded). */
function lcsDiff(before: string[], after: string[]): Array<{ type: 'same' | 'del' | 'add'; text: string }> {
  const n = before.length
  const m = after.length
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) {
    const row = new Uint32Array(m + 1)
    if (i > 0) {
      const prev = dp[i - 1]!
      for (let j = 1; j <= m; j++) {
        row[j] = before[i - 1] === after[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!)
      }
    }
    dp.push(row)
  }
  const ops: Array<{ type: 'same' | 'del' | 'add'; text: string }> = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && before[i - 1] === after[j - 1]) {
      ops.push({ type: 'same', text: before[i - 1]! })
      i -= 1
      j -= 1
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ type: 'add', text: after[j - 1]! })
      j -= 1
    } else {
      ops.push({ type: 'del', text: before[i - 1]! })
      i -= 1
    }
  }
  return ops.reverse()
}

/**
 * Compute one {@link FileDiff} per hunk between `before` and `after`, each
 * carrying the applied change plus {@link DIFF_CONTEXT} context lines. Pure
 * insertions use `oldText: null`; scattered replacements remain separate hunks.
 * @param path - the path stamped on every produced diff.
 * @param before - the file text before the change.
 * @param after - the file text after the change.
 * @returns one diff per applied hunk, in file order; empty when the texts are identical.
 */
export function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
  const beforeLines = before === '' ? [] : before.split('\n')
  const afterLines = after === '' ? [] : after.split('\n')
  if (before === after) return []

  let ops: Array<{ type: 'same' | 'del' | 'add'; text: string }>
  if (beforeLines.length > LCS_LINE_CAP || afterLines.length > LCS_LINE_CAP) {
    ops = [
      ...beforeLines.map(text => ({ type: 'del' as const, text })),
      ...afterLines.map(text => ({ type: 'add' as const, text })),
    ]
  } else {
    ops = lcsDiff(beforeLines, afterLines)
  }

  // Split the edit script into hunks: a change run plus DIFF_CONTEXT lines of
  // context on each side. Same-lines before the first change of a hunk are
  // claimed from a sliding window; once a hunk accumulates more than
  // DIFF_CONTEXT trailing context, it closes and the trailing context seeds the
  // next hunk (adjacent change runs within 2*DIFF_CONTEXT+1 lines stay one hunk).
  const hunks: Array<Array<{ type: 'same' | 'del' | 'add'; text: string }>> = []
  let current: Array<{ type: 'same' | 'del' | 'add'; text: string }> | undefined
  let contextAfter = 0
  let pendingSame: string[] = []
  for (const op of ops) {
    if (op.type === 'same') {
      if (current === undefined) {
        pendingSame.push(op.text)
        if (pendingSame.length > DIFF_CONTEXT) pendingSame.shift()
      } else {
        current.push(op)
        contextAfter += 1
        if (contextAfter > DIFF_CONTEXT) {
          const tail = current.slice(-DIFF_CONTEXT).map(line => line.text)
          hunks.push(current)
          current = undefined
          contextAfter = 0
          pendingSame = [...tail]
        }
      }
    } else {
      if (current === undefined) {
        current = pendingSame.map(text => ({ type: 'same' as const, text }))
        pendingSame = []
      }
      current.push(op)
      contextAfter = 0
    }
  }
  if (current !== undefined) hunks.push(current)

  const diffs: FileDiff[] = []
  for (const hunk of hunks) {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const op of hunk) {
      if (op.type === 'del') oldLines.push(op.text)
      else if (op.type === 'add') newLines.push(op.text)
      else {
        oldLines.push(op.text)
        newLines.push(op.text)
      }
    }
    diffs.push({ path, oldText: oldLines.length > 0 ? oldLines.join('\n') : null, newText: newLines.join('\n') })
  }
  return diffs
}

/** Whether `value` is a valid {@link FileDiff} (defensive narrowing from opaque `meta`). */
function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value as Record<string, unknown>
  return typeof path === 'string'
    && (oldText === null || typeof oldText === 'string')
    && typeof newText === 'string'
}

/**
 * Narrow opaque live or replayed result metadata to non-empty file diffs.
 * @param meta - result metadata.
 * @returns validated hunks, or `undefined` for absent or malformed data.
 */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined
  return diffs
}

/**
 * Pure selector parsing for the `read` tool. A trailing `:…` segment on the
 * path selects a line window: `:raw`, `:N`, `:A-B`, `:A+C`, comma-separated
 * ranges, and a `:range:raw` variant. Line numbers are 1-based; `:0` and
 * inverted ranges throw. An unrecognized `:…` tail falls through to the path
 * itself (archives and SQLite use such tails as their own selectors), and a
 * literal path that happens to contain `:` is untouched when the tail does not
 * parse as a selector.
 * @module dsh-tool-read-write/read/selectors
 */

export type LineSelector =
  /** No selector — the default window applies. */
  | { kind: 'plain' }
  /** `:raw` — the whole file without line numbers. */
  | { kind: 'raw' }
  /** `:N` / `:A-B` / `:A+C`, optionally `:raw`-suffixed. */
  | { kind: 'range'; start: number; end: number; raw?: true }
  /** `:A-B,C-D,…` — merged disjoint ranges, optionally `:raw`-suffixed. */
  | { kind: 'ranges'; ranges: ReadonlyArray<{ start: number; end: number }>; raw?: true }

/** The result of splitting a raw path into its base path and parsed selector. */
export interface ParsedSelectors {
  /** The path without the selector tail. */
  base: string
  /** The parsed selector; `plain` when the tail did not parse. */
  selector: LineSelector
}

function parsePositive(raw: string, what: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`invalid ${what} "${raw}" in selector: line numbers are 1-based positive integers`)
  }
  return value
}

/** Parse one selector tail into disjoint ranges, or `undefined` when it is not selector syntax. */
function parseRangeExpr(expr: string): Array<{ start: number; end: number }> | undefined {
  if (expr.length === 0) return undefined

  // :N — one line (a degenerate range so context rules apply uniformly).
  if (/^\d+$/.test(expr)) {
    const line = parsePositive(expr, 'line')
    return [{ start: line, end: line }]
  }
  // :A+C — C lines starting at A (A through A+C-1).
  if (/^\d+\+\d+$/.test(expr)) {
    const plus = expr.indexOf('+')
    const start = parsePositive(expr.slice(0, plus), 'range start')
    const count = parsePositive(expr.slice(plus + 1), 'count')
    return [{ start, end: start + count - 1 }]
  }
  // :A-B,C-D,… — comma-separated ranges.
  if (expr.includes(',') && /^[\d,+-]+$/.test(expr)) {
    const parts = expr.split(',')
    if (!parts.every(part => /^\d+-\d+$/.test(part))) return undefined
    return parts.map(part => {
      const dash = part.indexOf('-')
      const start = parsePositive(part.slice(0, dash), 'range start')
      const end = parsePositive(part.slice(dash + 1), 'range end')
      if (end < start) throw new Error(`invalid range "${part}": start must not exceed end`)
      return { start, end }
    })
  }
  // :A-B — one range.
  if (/^\d+-\d+$/.test(expr)) {
    const dash = expr.indexOf('-')
    const start = parsePositive(expr.slice(0, dash), 'range start')
    const end = parsePositive(expr.slice(dash + 1), 'range end')
    if (end < start) throw new Error(`invalid range "${expr}": start must not exceed end`)
    return [{ start, end }]
  }
  return undefined
}

/**
 * Split a raw `read` path into its base path and parsed selector. An
 * unrecognized `:…` tail leaves the whole string as the base with a `plain`
 * selector, so archive (`archive.zip:inner/path`) and SQLite (`db.sqlite:table`)
 * selectors pass through untouched.
 * @param input - the raw path argument.
 * @returns the base path and parsed selector; `:0` and inverted ranges throw.
 */
export function parseSelectors(input: string): ParsedSelectors {
  let raw = false
  let path = input
  if (input.endsWith(':raw')) {
    raw = true
    path = input.slice(0, input.length - ':raw'.length)
  }
  const idx = path.lastIndexOf(':')
  if (idx === -1) {
    if (!raw) return { base: input, selector: { kind: 'plain' } }
    if (path.length === 0) return { base: input, selector: { kind: 'plain' } }
    return { base: path, selector: { kind: 'raw' } }
  }
  const tail = path.slice(idx + 1)
  const ranges = parseRangeExpr(tail)
  if (ranges === undefined) {
    // Unknown tail (archive/SQLite selector or a literal `:` in the name).
    return { base: input, selector: { kind: 'plain' } }
  }
  const base = path.slice(0, idx)
  if (base.length === 0) return { base: input, selector: { kind: 'plain' } }
  if (ranges.length === 1) {
    const range = ranges[0]!
    return {
      base,
      selector: { kind: 'range', start: range.start, end: range.end, ...raw ? { raw: true } : {} },
    }
  }
  return {
    base,
    selector: { kind: 'ranges', ranges, ...raw ? { raw: true } : {} },
  }
}

/**
 * Merge overlapping and adjacent ranges into a sorted disjoint list.
 * @param ranges - arbitrary ranges; an empty list stays empty.
 * @returns the merged ranges sorted by start.
 */
export function mergeRanges(ranges: ReadonlyArray<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ start: range.start, end: range.end })
    }
  }
  return merged
}

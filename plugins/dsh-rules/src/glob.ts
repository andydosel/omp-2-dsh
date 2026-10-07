/**
 * Minimal glob matcher for gate-rule path patterns.
 *
 * dsh ships no path-glob primitive a host plugin can import (the search tools
 * own their own walker), and the gate runs on every tool call, so this module
 * compiles the handful of configured patterns once and keeps them side-effect
 * free. Supported syntax is deliberately small:
 *
 * - `**` matches any characters including `/`; a `**` segment immediately
 *   followed by `/` also matches zero directories, so any-prefix + `/src/**`
 *   matches both `src/a.ts` and `pkg/src/a.ts`.
 * - `*` matches any run of characters except `/`.
 * - `?` matches one character except `/`.
 * - everything else is literal (`!` has no negation meaning).
 *
 * Paths are compared with `/` separators and, on Windows, case-insensitively
 * (NTFS is case-insensitive, so a differently-cased absolute path must still
 * hit the same configured pattern).
 * @module @dsh-plugin/dsh-rules/glob
 */

const REGEX_META = /[.*+?^${}()|[\]\\]/

/** Windows paths are case-insensitive; POSIX ones are not. */
const CASE_INSENSITIVE = process.platform === 'win32'

/** Compiled patterns, keyed by the original pattern string. */
const COMPILED = new Map<string, RegExp>()

/**
 * Normalize one raw path (or pattern) to the comparison form: `/` separators,
 * no duplicate separators, no leading `./`, no trailing `/`.
 * @param value - raw path text from configuration or a tool call.
 * @returns the normalized path.
 */
export function normalizePath(value: string): string {
  let normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  normalized = normalized.replace(/\/{2,}/g, '/')
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.replace(/\/+$/, '') : normalized
}

/**
 * Translate one glob pattern into a regular-expression source string.
 * @param pattern - a normalized glob pattern.
 * @returns an anchored regex source.
 */
function globSource(pattern: string): string {
  let source = ''
  let index = 0
  while (index < pattern.length) {
    const character = pattern[index]!
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          // A `**/` segment matches zero or more leading directories.
          source += '(?:.*/)?'
          index += 3
        } else {
          source += '.*'
          index += 2
        }
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (character === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    source += REGEX_META.test(character) ? `\\${character}` : character
    index += 1
  }
  return `^${source}$`
}

/**
 * Compile one glob pattern (memoized).
 * @param pattern - the glob pattern, raw or normalized.
 * @returns the anchored matcher.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = COMPILED.get(pattern)
  if (cached !== undefined) return cached
  const compiled = new RegExp(globSource(normalizePath(pattern)), CASE_INSENSITIVE ? 'i' : '')
  COMPILED.set(pattern, compiled)
  return compiled
}

/**
 * Whether any of the candidate path spellings matches any of the patterns.
 * Callers pass several spellings of the same file (absolute and
 * session-cwd-relative) because a configured pattern may be written either way.
 * A directory target is also matched with a trailing `/`, because a search
 * rooted at `src` covers everything beneath it and must hit a `.../src/**`
 * pattern.
 * @param patterns - configured glob patterns.
 * @param candidates - normalized path spellings of one target.
 * @returns the winning `{ pattern, path }` pair, or undefined.
 */
export function firstPathMatch(
  patterns: readonly string[],
  candidates: readonly string[],
): { pattern: string; path: string } | undefined {
  for (const candidate of candidates) {
    for (const pattern of patterns) {
      const matcher = globToRegExp(pattern)
      if (matcher.test(candidate) || matcher.test(`${candidate}/`)) {
        return { pattern, path: candidate }
      }
    }
  }
  return undefined
}

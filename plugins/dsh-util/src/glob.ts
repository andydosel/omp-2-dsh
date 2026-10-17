/**
 * The suite's one glob engine.
 *
 * dsh ships no path-glob primitive a host plugin can import (the search tools
 * own their own walker), and every coordinator gate runs on hot paths, so this
 * module compiles patterns once and keeps them side-effect free. Supported
 * syntax is deliberately small:
 *
 * - `**` matches any characters including `/`; a `**` segment immediately
 *   followed by `/` also matches zero directories, so any-prefix + `/src/**`
 *   matches both `src/a.ts` and `pkg/src/a.ts`.
 * - `*` matches any run of characters except `/`.
 * - `?` matches one character except `/`.
 * - everything else is literal (`!` has no negation meaning).
 *
 * Case sensitivity is the ONE deliberate difference between the three former
 * copies, so it is an explicit option: Windows callers default to
 * case-insensitive (NTFS), the review-gate fence opts in on every platform,
 * and POSIX callers keep exact-case matching. Pattern normalization
 * ({@link normalizeGlobPath}) is likewise opt-in per caller: the rules gate
 * normalizes patterns, the review gate and the org envelope already hand in
 * resolved posix paths.
 *
 * @module @dsh-plugin/dsh-util/glob
 */

const REGEX_META = /[.*+?^${}()|[\]\\]/

/** Windows paths are case-insensitive; POSIX ones are not. */
const WINDOWS_DEFAULT = process.platform === 'win32'

/** Compiled patterns, keyed by effective case mode + normalized source. */
const COMPILED = new Map<string, RegExp>()

/** Per-call matching knobs. */
export interface GlobOptions {
  /**
   * Compile the pattern with the regex `i` flag.
   * Default: `true` on Windows, `false` elsewhere.
   */
  readonly caseInsensitive?: boolean
}

/** Knobs for {@link firstPathMatch}. */
export interface PathMatchOptions extends GlobOptions {
  /**
   * Normalize every pattern and candidate with {@link normalizeGlobPath}
   * before comparing (the rules gate's semantics). Default `false`: callers
   * hand in paths already normalized to their own comparison space.
   */
  readonly normalize?: boolean
  /**
   * Also test `<candidate>/`, so a directory target hits a `.../src/**`
   * pattern (a search rooted at `src` covers everything beneath it).
   * Default `false`.
   */
  readonly directorySuffix?: boolean
}

/**
 * Normalize one raw path (or pattern) to the comparison form: `/` separators,
 * no duplicate separators, no leading `./`, no trailing `/`.
 * @param value - raw path text from configuration or a tool call.
 * @returns the normalized path.
 */
export function normalizeGlobPath(value: string): string {
  let normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  normalized = normalized.replace(/\/{2,}/g, '/')
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.replace(/\/+$/, '') : normalized
}

/**
 * Translate one glob pattern into a regular-expression source string.
 * @param pattern - a pattern with posix separators.
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
          // A `**/` segment matches zero or more directories.
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
 * Compile one glob pattern (memoized by effective case mode + pattern).
 * @param pattern - a glob with posix separators (callers normalize first when
 *   their config vocabulary allows backslashes or `./` prefixes).
 * @param options - case-sensitivity knob.
 * @returns the anchored matcher.
 */
export function globToRegExp(pattern: string, options: GlobOptions = {}): RegExp {
  const caseInsensitive = options.caseInsensitive ?? WINDOWS_DEFAULT
  const source = pattern.replaceAll('\\', '/')
  const key = `${caseInsensitive ? 'i' : 's'}:${source}`
  const cached = COMPILED.get(key)
  if (cached !== undefined) return cached
  const compiled = new RegExp(globSource(source), caseInsensitive ? 'i' : '')
  COMPILED.set(key, compiled)
  return compiled
}

/**
 * Whether any of the candidate path spellings matches any of the patterns, in
 * candidate order then pattern order.
 * @param patterns - glob patterns (normalized here when `options.normalize`).
 * @param candidates - path spellings of one target.
 * @param options - case, normalization, and directory-suffix knobs.
 * @returns the winning `{ pattern, path }` pair (the ORIGINAL pattern string),
 *   or undefined.
 */
export function firstPathMatch(
  patterns: readonly string[],
  candidates: readonly string[],
  options: PathMatchOptions = {},
): { pattern: string; path: string } | undefined {
  const normalize = options.normalize ?? false
  for (const rawCandidate of candidates) {
    const candidate = normalize ? normalizeGlobPath(rawCandidate) : rawCandidate
    for (const rawPattern of patterns) {
      const matcher = globToRegExp(normalize ? normalizeGlobPath(rawPattern) : rawPattern, options)
      if (matcher.test(candidate) || (options.directorySuffix === true && matcher.test(`${candidate}/`))) {
        return { pattern: rawPattern, path: candidate }
      }
    }
  }
  return undefined
}

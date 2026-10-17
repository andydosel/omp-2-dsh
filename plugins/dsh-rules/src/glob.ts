/**
 * Gate-rule path matching: the shared glob engine with the rules gate's own
 * semantics pinned as explicit options — patterns are normalized (config may
 * be written with backslashes or `./`), case-insensitive on Windows only, and a
 * directory candidate also matches with a trailing `/` so a search rooted at
 * `src` hits a `.../src/**` rule.
 *
 * @module @dsh-plugin/dsh-rules/glob
 */

import {
  firstPathMatch as matchFirstPath,
  globToRegExp as compileGlob,
  normalizeGlobPath,
} from '@dsh-plugin/dsh-util/glob'

/** Windows paths are case-insensitive; POSIX ones are not. */
const CASE_INSENSITIVE = process.platform === 'win32'

/**
 * Normalize one raw path (or pattern) to the comparison form: `/` separators,
 * no duplicate separators, no leading `./`, no trailing `/`.
 * @param value - raw path text from configuration or a tool call.
 * @returns the normalized path.
 */
export function normalizePath(value: string): string {
  return normalizeGlobPath(value)
}

/**
 * Compile one glob pattern (memoized by the shared engine).
 * @param pattern - the glob pattern, raw or normalized.
 * @returns the anchored matcher.
 */
export function globToRegExp(pattern: string): RegExp {
  return compileGlob(normalizeGlobPath(pattern), { caseInsensitive: CASE_INSENSITIVE })
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
  return matchFirstPath(patterns, candidates, {
    caseInsensitive: CASE_INSENSITIVE,
    normalize: true,
    directorySuffix: true,
  })
}

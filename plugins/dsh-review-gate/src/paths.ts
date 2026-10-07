/**
 * Path classification for the review-gate write fence: a target is either the
 * planning scratch area (always writable), protected real source (fenced) or
 * something else (ordinary work).
 *
 * Matching is whitelist-shaped where it counts — the scratch area is checked
 * first and wins — and glob matching is case-insensitive on every platform, so
 * mis-cased input can only ever protect MORE, never less.
 *
 * @module @dsh-plugin/dsh-review-gate/paths
 */

import path from 'node:path'

/** Classification of one write target. */
export type PathClass = 'scratch' | 'protected' | 'other'

/** Inputs that classify one target path. */
export interface PathClassRequest {
  /** The raw `file_path` argument as the model wrote it. */
  readonly filePath: string
  /** Session workspace root (the base every relative target resolves against). */
  readonly cwd: string
  /** Protected globs. */
  readonly protectedPaths: readonly string[]
  /** Planning scratch area, relative to `cwd` or absolute. */
  readonly scratchDir: string
}

/** Regex metacharacters that must survive literal in a glob conversion. */
const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g

/**
 * Convert one glob to an anchored regular expression. Supports `**` (any run of
 * path segments), `*` (within one segment) and `?` (one non-separator
 * character); everything else is literal.
 * @param pattern - the glob, in posix form.
 * @returns a case-insensitive anchored matcher.
 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern.replaceAll('\\', '/')
  let out = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    if (char === '*') {
      if (source[index + 1] === '*') {
        index += 1
        if (source[index + 1] === '/') {
          index += 1
          out += '(?:[^/]+/)*'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(REGEX_SPECIAL, '\\$&')
  }
  return new RegExp(`^${out}$`, 'i')
}

/**
 * Resolve one target or directory against the workspace root and express it in
 * posix form, exactly the way the globs are written.
 * @param target - absolute or workspace-relative path.
 * @param cwd - session workspace root.
 * @returns the posix-normalized workspace-relative path.
 */
export function relativeToWorkspace(target: string, cwd: string): string {
  const resolved = path.resolve(cwd, target.replaceAll('\\', '/'))
  const relative = path.relative(cwd, resolved)
  return (relative === '' ? '.' : relative).replaceAll('\\', '/')
}

/**
 * Whether one workspace-relative path sits inside a directory.
 * @param relative - posix path relative to the workspace root.
 * @param directory - the directory, absolute or workspace-relative.
 * @param cwd - session workspace root.
 * @returns true for the directory itself and everything beneath it.
 */
export function isWithinDir(relative: string, directory: string, cwd: string): boolean {
  const dir = relativeToWorkspace(directory, cwd).replace(/\/+$/, '')
  if (dir === '' || dir === '.') return true
  return relative === dir || relative.startsWith(`${dir}/`)
}

/**
 * Classify one write target: the scratch area wins over every protected glob,
 * so a plan can always be drafted on disk. A target outside the workspace can
 * still match a protected glob (a `../` escape is not a way out of the fence).
 * @param request - the target and the fence configuration.
 * @returns the target's class.
 */
export function classifyPath(request: PathClassRequest): PathClass {
  const relative = relativeToWorkspace(request.filePath, request.cwd)
  if (isWithinDir(relative, request.scratchDir, request.cwd)) return 'scratch'
  const matchers = request.protectedPaths.map(globToRegExp)
  return matchers.some(matcher => matcher.test(relative)) ? 'protected' : 'other'
}

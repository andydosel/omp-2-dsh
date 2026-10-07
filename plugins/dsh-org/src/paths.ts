/**
 * The role capability envelope's PATH gate: a pure, mechanism-level whitelist
 * over the read/write path arguments of the file tools, installed as one
 * `tools/pre-execute` listener per role agent (see `envelope.ts`).
 *
 * Mapping (VERIFY-PATH-RESTRICT.md §3c):
 * - `read` / `read_image` / `lsp` → `file_path` → readPaths
 * - `glob` / `grep` → `path ?? workspace root` → readPaths (an ABSENT path is
 *   the session workspace root, which is routinely outside a secretary's read
 *   whitelist, so it denies — closing the "one `glob **​/*.ts` lists the
 *   source tree" hole)
 * - `str_replace_editor` → `command === 'view' ? path → readPaths : path → writePaths`
 * - `write` / `edit` → `file_path` → writePaths
 * - any other tool name → allow (tool-name masking is `tools.restrict`'s job)
 *
 * Fail-closed: a missing, non-string, or empty path argument denies.
 *
 * HONEST LIMITS (see VERIFY doc §4b/§4c): matching is TEXTUAL after
 * `path.resolve` + `path.normalize` only — symlinks, junctions, 8.3 short
 * names, UNC aliases, and `..` tricks that survive normalization are not
 * resolved against the real filesystem, so this is a strong envelope, not a
 * kernel boundary. `bash` has no path parameter and is NOT path-gated; the
 * only mechanism-level answer is keeping bash out of the role toolset, which
 * `config.secretaryBash` (default false) does.
 *
 * @module @dsh-plugin/dsh-org/paths
 */

import path from 'node:path'

/** The decision the path gate returns (a subset of `PreToolDecision`). */
export type PathGateDecision = { kind: 'allow' } | { kind: 'deny'; reason: string }

/**
 * The workspace root a session's path arguments are compared against. A session
 * created without an explicit `cwd` is anchored at the harness process
 * directory — the only root available — and that value is never used to GRANT
 * access, only to fix the base of the textual comparison.
 * @param headerCwd - the session header's optional `cwd`.
 * @returns an absolute root.
 */
export function workspaceRoot(headerCwd: string | undefined): string {
  return headerCwd ?? process.cwd()
}

/** What {@link decidePathGate} needs to adjudicate one tool call. */
export interface PathGateInput {
  /** The tool name from the execution (already mask-filtered). */
  toolName: string
  /** The deep-frozen parsed arguments, or anything else the caller saw. */
  args: unknown
  /** The acting session's absolute workspace root. */
  cwd: string
  /** Read whitelist globs, relative to `cwd` unless absolute. */
  readPaths: readonly string[]
  /** Write whitelist globs, relative to `cwd` unless absolute. */
  writePaths: readonly string[]
}

/** Escape one character for a regular expression. */
function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Normalize one candidate path: resolve relative candidates against `cwd`,
 * collapse `..`/`.` segments, use forward slashes, and lowercase on win32 so
 * comparison is case-insensitive there. A NUL byte is rejected outright — it
 * can only appear in an adversarial argument.
 * @param candidate - the model-supplied path.
 * @param cwd - the session workspace root.
 * @returns the normalized absolute path.
 * @throws when the candidate contains a NUL byte.
 */
export function normalizeCandidate(candidate: string, cwd: string): string {
  if (candidate.includes('\0')) {
    throw new Error('dsh-org: path gate rejected a candidate containing a NUL byte')
  }
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate)
  const slashed = path.normalize(absolute).split(path.sep).join('/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * Normalize one whitelist pattern to the same space as
 * {@link normalizeCandidate}. A pattern rooted in a wildcard (`**`,
 * `**​/x`, `*.md`) is left unanchored so it matches at any depth; a
 * literal-rooted pattern (`docs/**`, `{handoff}/**`) is anchored at `cwd`.
 * @param pattern - the configured glob.
 * @param cwd - the session workspace root.
 * @returns the normalized glob (or the bare `**` match-any sentinel).
 * @throws when the pattern is empty.
 */
export function normalizePattern(pattern: string, cwd: string): string {
  const trimmed = pattern.trim()
  if (trimmed === '') {
    throw new Error('dsh-org: config path glob must not be empty')
  }
  const lower = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
  const first = lower.split('/')[0] ?? ''
  if (first.includes('*') || first.includes('?')) {
    return first.startsWith('**') ? lower : `**/${lower}`
  }
  return normalizeCandidate(trimmed, cwd)
}

/** Compiled glob cache: one RegExp per pattern (`glob → regex once`). */
const REGEX_CACHE = new Map<string, RegExp>()

/** Compile one normalized glob to an anchored RegExp (`**`, `*`, `?` supported). */
function compileGlob(glob: string): RegExp {
  const key = process.platform === 'win32' ? glob.toLowerCase() : glob
  const cached = REGEX_CACHE.get(key)
  if (cached !== undefined) return cached
  let source = ''
  for (let index = 0; index < key.length; index++) {
    const char = key[index] ?? ''
    if (char === '*') {
      if (key[index + 1] === '*') {
        index++
        if (key[index + 1] === '/') {
          index++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegExp(char)
    }
  }
  const regex = new RegExp(`^${source}$`)
  REGEX_CACHE.set(key, regex)
  return regex
}

/**
 * Whether a normalized candidate path matches any normalized whitelist glob.
 * @param normalized - a {@link normalizeCandidate} result.
 * @param patterns - {@link normalizePattern} results.
 * @returns true when at least one glob matches.
 */
export function matchesAnyPath(normalized: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => compileGlob(pattern).test(normalized))
}

/** Read one field off a parsed-arguments record, if the value is a string. */
function stringField(args: unknown, field: string): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  // The field name is dynamic, so `in`-narrowing cannot express the read; the
  // typeof check below is what actually validates the value.
  const fields = args as Readonly<Record<string, unknown>>
  const value = fields[field]
  return typeof value === 'string' ? value : undefined
}

/** Build the fail-closed denial for a path outside the envelope. */
function denyOutside(toolName: string, candidate: string, kind: 'read' | 'write', patterns: readonly string[]): PathGateDecision {
  return {
    kind: 'deny',
    reason: `${toolName} is outside this session's ${kind} capability envelope: "${candidate}" does not match [${patterns.join(', ')}]. `
      + 'This is a capability limit, not a fault — use the tools you were given, or hand the work to a session with the needed access.',
  }
}

/** Build the fail-closed denial for an unverifiable (missing/empty) argument. */
function denyUnverifiable(toolName: string, param: string): PathGateDecision {
  return {
    kind: 'deny',
    reason: `${toolName} carries no usable "${param}" for this session's capability envelope to check. `
      + 'This is a capability limit, not a fault — supply an explicit path inside your allowed roots.',
  }
}

/** Adjudicate one candidate path against one whitelist. */
function gateCandidate(
  toolName: string,
  candidate: string,
  kind: 'read' | 'write',
  cwd: string,
  paths: readonly string[],
): PathGateDecision {
  const normalized = normalizeCandidate(candidate, cwd)
  const compiled = paths.map(pattern => normalizePattern(pattern, cwd))
  return matchesAnyPath(normalized, compiled) ? { kind: 'allow' } : denyOutside(toolName, candidate, kind, paths)
}

/** Adjudicate a tool that names a file through one path parameter. */
function gateFile(
  toolName: string,
  args: unknown,
  param: string,
  kind: 'read' | 'write',
  cwd: string,
  readPaths: readonly string[],
  writePaths: readonly string[],
): PathGateDecision {
  const value = stringField(args, param)
  if (value === undefined || value.trim() === '') return denyUnverifiable(toolName, param)
  return gateCandidate(toolName, value, kind, cwd, kind === 'read' ? readPaths : writePaths)
}

/**
 * Decide one tool call against a role's read/write path whitelists.
 * @param input - tool name, parsed arguments, workspace cwd, and the whitelists.
 * @returns `{ kind: 'allow' }`, or a `deny` whose reason explains the envelope.
 */
export function decidePathGate(input: PathGateInput): PathGateDecision {
  const { toolName, args, cwd, readPaths, writePaths } = input
  switch (toolName) {
    case 'read':
    case 'read_image':
    case 'lsp':
      return gateFile(toolName, args, 'file_path', 'read', cwd, readPaths, writePaths)
    case 'glob':
    case 'grep': {
      const value = stringField(args, 'path')
      // An absent path means the whole session workspace: the gate must treat
      // that as the cwd, not as "unbounded", or one `glob **/*.ts` defeats it.
      const candidate = value === undefined || value.trim() === '' ? cwd : value
      return gateCandidate(toolName, candidate, 'read', cwd, readPaths)
    }
    case 'str_replace_editor': {
      const command = stringField(args, 'command')
      return gateFile(toolName, args, 'path', command === 'view' ? 'read' : 'write', cwd, readPaths, writePaths)
    }
    case 'write':
    case 'edit':
      return gateFile(toolName, args, 'file_path', 'write', cwd, readPaths, writePaths)
    default:
      return { kind: 'allow' }
  }
}

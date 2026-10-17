/**
 * Advisory rules: read the configured rule files and render them as one
 * system-prompt section in the high-priority persona band.
 *
 * These rules are **reminder-type** by construction (design §5.8): they live in
 * the prompt, so they only work through the model's attention. Gate rules are
 * the mechanically-enforced half and live in the gate module.
 *
 * Rule files are read once at mount (the design's "persist to file, mount at
 * startup"); a config hot-reload re-reads them. A missing or unreadable source
 * is skipped with a warning so a stale path never blocks boot.
 * @module @dsh-plugin/dsh-rules/advisory
 */

import { readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { describeError } from '@dsh-plugin/dsh-util/error'

/**
 * The unique system-prompt section slot for advisory rules. Deliberately not
 * `deployment:persona(-prefix)`: that slot is the deployment's own persona and
 * a scoped registration would shadow it — the prompt registry rejects only
 * duplicate names, so a distinct name coexists in the same persona band.
 */
export const ADVISORY_SECTION = 'rules:advisory'

/** Default bytes read from one advisory source before truncation. */
export const DEFAULT_ADVISORY_MAX_BYTES = 16_384

/** One successfully loaded advisory source. */
export interface AdvisorySource {
  /** Absolute path the text was read from. */
  readonly path: string
  /** File text, truncated to the configured byte cap with a marker. */
  readonly text: string
}

/** How advisory sources are located and read. */
export interface AdvisoryLoadOptions {
  /** Harness home for `$DSH_HOME` and bare entries; defaults to `resolveDshHome()`. */
  readonly dshHome?: string
  /** Bytes read per source before truncation; defaults to {@link DEFAULT_ADVISORY_MAX_BYTES}. */
  readonly maxBytes?: number
  /** Called for every configured source that was skipped, with the reason. */
  readonly onSkip?: (path: string, reason: string) => void
}

/**
 * Resolve one configured advisory entry to an absolute file path:
 * `~` expands to the OS home, `$DSH_HOME` / `${DSH_HOME}` to the harness home,
 * a relative path against the harness home, and a bare token (no separator, no
 * extension) to `<harness home>/<token>.md` — so the default `persona` means
 * `$DSH_HOME/persona.md`.
 * @param entry - one configured source.
 * @param dshHome - resolved harness home.
 * @returns the absolute path.
 */
export function resolveAdvisoryPath(entry: string, dshHome: string): string {
  const trimmed = entry.trim()
  if (trimmed.length === 0) throw new Error('dsh-rules: advisoryFiles entries must be non-empty')
  let value = expandHomePath(trimmed)
  if (value.startsWith('${DSH_HOME}')) value = dshHome + value.slice('${DSH_HOME}'.length)
  else if (value.startsWith('$DSH_HOME')) value = dshHome + value.slice('$DSH_HOME'.length)
  if (!isAbsolute(value)) {
    if (!/[\\/]/.test(value) && extname(value) === '') value += '.md'
    value = resolve(dshHome, value)
  }
  return value
}

/**
 * Read every configured advisory source that exists, in configuration order
 * and deduplicated by resolved path.
 * @param entries - configured sources.
 * @param options - harness home override and skip reporting.
 * @returns the loaded sources; empty when nothing exists yet.
 */
export function loadAdvisorySources(
  entries: readonly string[],
  options: AdvisoryLoadOptions = {},
): AdvisorySource[] {
  const dshHome = options.dshHome ?? resolveDshHome()
  const maxBytes = options.maxBytes ?? DEFAULT_ADVISORY_MAX_BYTES
  const sources: AdvisorySource[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const path = resolveAdvisoryPath(entry, dshHome)
    if (seen.has(path)) continue
    seen.add(path)
    try {
      if (!statSync(path).isFile()) {
        options.onSkip?.(path, 'not a regular file')
        continue
      }
    } catch (error) {
      options.onSkip?.(path, describeError(error))
      continue
    }
    let raw: Buffer
    try {
      raw = readFileSync(path)
    } catch (error) {
      options.onSkip?.(path, describeError(error))
      continue
    }
    const text = raw.byteLength <= maxBytes
      ? raw.toString('utf8')
      : `${raw.subarray(0, maxBytes).toString('utf8')}\n…[truncated at ${maxBytes} bytes]`
    sources.push({ path, text })
  }
  return sources
}

/**
 * Render the loaded sources as one section text: a header that states the
 * binding strength, then each source labelled by path. Text is registered with
 * `interpolate: false`, so braces inside a rule file are preserved literally.
 * @param sources - loaded advisory sources.
 * @returns the section text, or `''` when there is nothing to say.
 */
export function composeAdvisoryText(sources: readonly AdvisorySource[]): string {
  if (sources.length === 0) return ''
  const body = sources
    .map(source => `### ${source.path}\n\n${source.text.trim()}`)
    .join('\n\n')
  return [
    'Standing rules configured by dsh-rules. They are advisory guidance: weigh them, they are not mechanically enforced.',
    body,
  ].join('\n\n')
}

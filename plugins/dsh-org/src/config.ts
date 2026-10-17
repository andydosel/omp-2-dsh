/**
 * dsh-org configuration: the raw shape, validation, and the detached resolved
 * shape the role envelopes consume.
 *
 * The defaults encode the design's §5.9 gradient honestly:
 * - the secretary reads documents only (`docs/**`, `**​/*.md`, the handoff
 *   area) and writes ONLY the handoff area, so its "no source-code" boundary is
 *   a capability envelope, not a promise;
 * - `secretaryBash` defaults to `false`. The path gate cannot police bash
 *   (bash is an unmanaged read surface), so keeping bash out of the secretary
 *   toolset is what makes "cannot read code"
 *   mechanism-enforced. Turning it on downgrades that boundary to
 *   best-effort and the module comment says so;
 * - the lead reads everything and writes documents/handoff.
 *
 * @module @dsh-plugin/dsh-org/config
 */

import z from '@deepseek-ai/schemastery'

/** Raw (user-written) configuration. Every field optional. */
export interface OrgConfig {
  /** Directory the secretary may write handoff/brief files into (default `.dsh-handoff`). */
  handoffDir?: string
  /** Read whitelist handed to the secretary envelope (default docs + markdown + handoff). */
  secretaryReadPaths?: string[]
  /** Write whitelist handed to the secretary envelope (default the handoff area only). */
  secretaryWritePaths?: string[]
  /** Whether the secretary may keep `bash` in its toolset (default `false`). */
  secretaryBash?: boolean
  /** Read whitelist handed to the lead envelope (default everything). */
  leadReadPaths?: string[]
  /** Write whitelist handed to the lead envelope (default docs + handoff). */
  leadWritePaths?: string[]
  /** Whether `org_claim` asks for approval before taking over a session (default `false`). */
  strictMode?: boolean
}

/** Detached, validated configuration consumed by the envelopes and tools. */
export interface ResolvedOrgConfig {
  readonly handoffDir: string
  readonly secretaryReadPaths: readonly string[]
  readonly secretaryWritePaths: readonly string[]
  readonly secretaryBash: boolean
  readonly leadReadPaths: readonly string[]
  readonly leadWritePaths: readonly string[]
  readonly strictMode: boolean
}

/** The complete set of accepted configuration keys (unknown keys fail loud). */
export const KNOWN_CONFIG_KEYS: Record<keyof OrgConfig, true> = {
  handoffDir: true,
  secretaryReadPaths: true,
  secretaryWritePaths: true,
  secretaryBash: true,
  leadReadPaths: true,
  leadWritePaths: true,
  strictMode: true,
}

/**
 * Schema of the org row configuration. Dependent defaults (the path lists
 * derive from `handoffDir`) are materialized by {@link resolveOrgConfig}, so
 * the schema carries the accepted shape and the loader-level validation.
 */
export const Config: z<OrgConfig> = z.object({
  handoffDir: z.string().default('.dsh-handoff'),
  secretaryReadPaths: z.array(z.string()),
  secretaryWritePaths: z.array(z.string()),
  secretaryBash: z.boolean().default(false),
  leadReadPaths: z.array(z.string()),
  leadWritePaths: z.array(z.string()),
  strictMode: z.boolean().default(false),
  // `z.object` is non-strict by default; the resolver's own key check is what
  // makes a typo fail at load instead of being silently merged in.
})

/** The accepted configuration key names, for error messages. */
export const ORG_CONFIG_KEYS: readonly string[] = Object.keys(KNOWN_CONFIG_KEYS)

/** Reject a value that is not a non-empty, non-whitespace string. */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`dsh-org: config.${field} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Validate and detach one path whitelist (each entry a non-empty string). */
function requirePathList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`dsh-org: config.${field} must be an array of path globs, got ${JSON.stringify(value)}`)
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${field}[${index}]`))
}

/** The default read whitelist of a secretary, around one handoff directory. */
export function defaultSecretaryReadPaths(handoffDir: string): readonly string[] {
  return ['docs/**', '**/*.md', `${handoffDir}/**`]
}

/** The default write whitelist of a secretary (handoff area only). */
export function defaultSecretaryWritePaths(handoffDir: string): readonly string[] {
  return [`${handoffDir}/**`]
}

/** The default write whitelist of a lead (documents + handoff area). */
export function defaultLeadWritePaths(handoffDir: string): readonly string[] {
  return ['docs/**', '**/*.md', `${handoffDir}/**`]
}

/**
 * Validate raw configuration and return a detached resolved copy. Unknown keys
 * and ill-typed values throw (fail loud; no silent fallback).
 * @param config - the raw plugin configuration.
 * @returns the resolved, frozen-by-convention configuration.
 */
export function resolveOrgConfig(config: OrgConfig = {}): ResolvedOrgConfig {
  for (const key of Object.keys(config)) {
    if (!(key in KNOWN_CONFIG_KEYS)) {
      throw new Error(`dsh-org: unknown config key ${JSON.stringify(key)} (known: ${ORG_CONFIG_KEYS.join(', ')})`)
    }
  }
  const handoffDir = config.handoffDir === undefined ? '.dsh-handoff' : requireNonEmptyString(config.handoffDir, 'handoffDir')
  if (config.secretaryBash !== undefined && typeof config.secretaryBash !== 'boolean') {
    throw new Error(`dsh-org: config.secretaryBash must be a boolean, got ${JSON.stringify(config.secretaryBash)}`)
  }
  if (config.strictMode !== undefined && typeof config.strictMode !== 'boolean') {
    throw new Error(`dsh-org: config.strictMode must be a boolean, got ${JSON.stringify(config.strictMode)}`)
  }
  return {
    handoffDir,
    // Schemastery materializes an absent array as `[]`, so an empty list means
    // "no override" here — the handoff-dependent default is the only sane
    // reading before the resolver has seen `handoffDir`.
    secretaryReadPaths: config.secretaryReadPaths === undefined || config.secretaryReadPaths.length === 0
      ? defaultSecretaryReadPaths(handoffDir)
      : requirePathList(config.secretaryReadPaths, 'secretaryReadPaths'),
    secretaryWritePaths: config.secretaryWritePaths === undefined || config.secretaryWritePaths.length === 0
      ? defaultSecretaryWritePaths(handoffDir)
      : requirePathList(config.secretaryWritePaths, 'secretaryWritePaths'),
    secretaryBash: config.secretaryBash ?? false,
    leadReadPaths: config.leadReadPaths === undefined || config.leadReadPaths.length === 0
      ? ['**']
      : requirePathList(config.leadReadPaths, 'leadReadPaths'),
    leadWritePaths: config.leadWritePaths === undefined || config.leadWritePaths.length === 0
      ? defaultLeadWritePaths(handoffDir)
      : requirePathList(config.leadWritePaths, 'leadWritePaths'),
    strictMode: config.strictMode ?? false,
  }
}

/**
 * dsh-rules configuration: advisory rule files plus gate rules.
 *
 * The two halves are deliberately separate (design §5.8): **advisory** rules
 * are prompt-level text that the model may ignore — they are mounted as one
 * high-priority system-prompt section. **Gate** rules are mechanism-enforced —
 * they become approval gates on `tools/pre-execute` and do not depend on the
 * model's attention.
 * @module @dsh-plugin/dsh-rules/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_ADVISORY_MAX_BYTES } from './advisory.ts'

/**
 * One gate rule: gates calls of `tool`, optionally only those touching `paths`.
 */
export interface GateRule {
  /** Model-facing tool name the rule gates (exact match, e.g. `write`, `edit`, `bash`). */
  tool: string
  /**
   * Glob patterns matched against the call's path argument (see the gate
   * module for the per-tool argument map). Omitted or empty gates every call
   * of `tool` regardless of arguments.
   */
  paths?: string[]
}

/** dsh-rules configuration (schemastery fills every default). */
export interface RulesConfig {
  /**
   * Ordered advisory rule sources, read once at mount. A `$DSH_HOME` (or
   * `${DSH_HOME}`) prefix and `~` expand; a bare token without a separator or
   * extension is a file under `$DSH_HOME` with `.md` appended.
   */
  advisoryFiles: string[]
  /** Bytes read from each advisory source before truncation (default `16384`). */
  advisoryMaxBytes: number
  /** Gate rules turned into per-call approval gates. */
  gateRules: GateRule[]
  /** System-prompt section order for the advisory rules (the persona band is `0`). */
  advisoryOrder: number
}

/** Advisory sources mounted when the row config lists none. */
export const DEFAULT_ADVISORY_FILES: readonly string[] = ['$DSH_HOME/AGENTS.md', 'persona']

/** Runtime schema for the rules row. */
export const Config: z<RulesConfig> = z.object({
  advisoryFiles: z.array(z.string()).default([...DEFAULT_ADVISORY_FILES]),
  advisoryMaxBytes: z.number().step(1).min(1).default(DEFAULT_ADVISORY_MAX_BYTES),
  gateRules: z.array(z.object({
    tool: z.string().required(),
    paths: z.array(z.string()).default([]),
  })).default([]),
  advisoryOrder: z.number().default(0),
})

/** Config after normalization: trimmed entries, empty paths lists collapsed away. */
export interface ResolvedRulesConfig {
  advisoryFiles: string[]
  advisoryMaxBytes: number
  gateRules: GateRule[]
  advisoryOrder: number
}

/**
 * Normalize a validated config: trim every entry and drop empty path lists so
 * the runtime never has to re-decide what "no paths" means.
 * @param config - the schemastery-validated config.
 * @returns the normalized config.
 * @throws when an advisory source or a gate tool name is blank.
 */
export function resolveConfig(config: RulesConfig): ResolvedRulesConfig {
  // Schemastery merges unknown keys silently; the loader must reject a typo.
  const known: Readonly<Record<string, true>> = {
    advisoryFiles: true,
    advisoryMaxBytes: true,
    gateRules: true,
    advisoryOrder: true,
  }
  for (const key of Object.keys(config)) {
    if (known[key] === undefined) {
      throw new Error(`dsh-rules: unknown config key "${key}" (known: advisoryFiles, advisoryMaxBytes, gateRules, advisoryOrder)`)
    }
  }
  const advisoryMaxBytes = config.advisoryMaxBytes ?? DEFAULT_ADVISORY_MAX_BYTES
  if (!Number.isInteger(advisoryMaxBytes) || advisoryMaxBytes <= 0) {
    throw new Error(`dsh-rules: advisoryMaxBytes must be a positive integer (got ${JSON.stringify(config.advisoryMaxBytes)})`)
  }
  const advisoryFiles = config.advisoryFiles.map((entry) => {
    const trimmed = entry.trim()
    if (trimmed.length === 0) throw new Error('dsh-rules: advisoryFiles entries must be non-empty')
    return trimmed
  })
  const gateRules = config.gateRules.map((rule) => {
    const tool = rule.tool.trim()
    if (tool.length === 0) throw new Error('dsh-rules: gateRules[].tool must be non-empty')
    const paths = (rule.paths ?? []).map(path => path.trim()).filter(path => path.length > 0)
    return paths.length === 0 ? { tool } : { tool, paths }
  })
  return { advisoryFiles, advisoryMaxBytes, gateRules, advisoryOrder: config.advisoryOrder }
}

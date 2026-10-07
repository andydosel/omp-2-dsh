/**
 * dsh-rules: the rule layer of the coordinator suite (design §5.8 / §13.4).
 *
 * Two halves, never mixed:
 *
 * - **Advisory** — `advisoryFiles` are read at mount and rendered as one
 *   prompt section (`rules:advisory`) in the persona band, with
 *   `interpolate: false` so literal braces survive. Prompt-level, attention-
 *   dependent.
 * - **Gate** — `gateRules` become approval gates: one `tools/pre-execute`
 *   listener on this (global) context turns a matching call into
 *   `{ kind: 'ask' }`, which the approval service adjudicates before the body
 *   runs. The same rules are published as `ctx.rules` for review-gate / org.
 *
 * ```yaml
 * - insert:
 *     - id: rules
 *       name: '@dsh-plugin/dsh-rules'
 *       config:
 *         advisoryFiles: ['$DSH_HOME/AGENTS.md', 'persona']
 *         gateRules:
 *           - tool: write
 *             paths: ['src/**']   # see the glob module for the pattern syntax
 * ```
 * @module @dsh-plugin/dsh-rules
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  ADVISORY_SECTION,
  composeAdvisoryText,
  loadAdvisorySources,
} from './advisory.ts'
import { resolveConfig } from './config.ts'
import type { RulesConfig } from './config.ts'
import { RulesGate } from './gate.ts'

export { ADVISORY_SECTION, ADVISORY_MAX_BYTES, composeAdvisoryText, loadAdvisorySources, resolveAdvisoryPath } from './advisory.ts'
export type { AdvisoryLoadOptions, AdvisorySource } from './advisory.ts'
export { Config, DEFAULT_ADVISORY_FILES, resolveConfig } from './config.ts'
export type { GateRule, ResolvedRulesConfig, RulesConfig } from './config.ts'
export { matchGateRule, RulesGate } from './gate.ts'
export type { GateMatch } from './gate.ts'
export { firstPathMatch, globToRegExp, normalizePath } from './glob.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-rules'

/** Services this row needs: the prompt registry and the tool pipeline. */
export const inject = ['systemPrompt', 'tools']

/**
 * Mount the rule layer: advisory section first, then the gate listener.
 *
 * Advisory sources that do not exist yet are skipped with a warning, so a
 * profile can ship a rule path before the user writes the file. The gate
 * listener is registered only when at least one rule is configured, keeping an
 * unconfigured row off the hot path entirely.
 * @param ctx - the mounting context; unscoped registrations apply globally.
 * @param config - the schemastery-validated row config.
 */
export function apply(ctx: Context, config: RulesConfig): void {
  const resolved = resolveConfig(config)

  const sources = loadAdvisorySources(resolved.advisoryFiles, {
    onSkip: (path, reason) => ctx.logger.warn('dsh-rules: skipping advisory source %s: %s', path, reason),
  })
  const advisoryText = composeAdvisoryText(sources)
  if (advisoryText.length > 0) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: ADVISORY_SECTION,
      order: resolved.advisoryOrder,
      text: advisoryText,
      interpolate: false,
    }), 'dsh-rules.advisory-section')
  }

  const gate = new RulesGate(ctx, resolved.gateRules)
  if (resolved.gateRules.length > 0) {
    ctx.on('tools/pre-execute', (exec: ToolExecution, next) => {
      const decision = gate.evaluate(exec)
      return decision.kind === 'allow' ? next() : Promise.resolve(decision)
    })
  }
}

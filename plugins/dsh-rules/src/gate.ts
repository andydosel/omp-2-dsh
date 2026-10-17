/**
 * Gate rules: turn `{ tool, paths? }` configuration into per-call approval
 * decisions on `tools/pre-execute`.
 *
 * The gate is the mechanically-enforced half of dsh-rules (design §5.8): a
 * matching call returns `{ kind: 'ask' }` so the approval service decides, and
 * the tool body never runs unapproved. Path matching is **whitelist-agnostic**
 * and deliberately matches configured globs against both the absolute and the
 * session-cwd-relative spelling of the call's path argument, because dsh also
 * resolves relative paths against the session workspace.
 * @module @dsh-plugin/dsh-rules/gate
 */

import { isAbsolute, relative, resolve } from 'node:path'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { GateRule } from './config.ts'
import { firstPathMatch, normalizePath } from './glob.ts'

/**
 * The path argument of every tool whose calls a path-scoped rule can evaluate.
 * A tool absent from this record cannot be path-scoped; a rule that tries still
 * fails closed (see {@link RulesGate.evaluate}).
 */
const PATH_ARGUMENTS: Record<string, string> = {
  read: 'file_path',
  read_image: 'file_path',
  lsp: 'file_path',
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path',
  glob: 'path',
  grep: 'path',
}

/** One matched gate rule and the audited reason it produced. */
export interface GateMatch {
  /** The rule that matched. */
  readonly rule: GateRule
  /** English approval reason naming the rule and the matched path. */
  readonly reason: string
}

/** Defensive string read of one argument field (arguments arrive unvalidated). */
function stringArgument(callArguments: unknown, field: string): string | undefined {
  if (typeof callArguments !== 'object' || callArguments === null) return undefined
  const value = (callArguments as Record<string, unknown>)[field]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** The session workspace a relative path argument resolves against. */
function workspaceCwd(exec: Readonly<ToolExecution>): string | undefined {
  const cwd = exec.agent?.session.header.cwd
  return cwd !== undefined && cwd.trim().length > 0 ? cwd : undefined
}

/**
 * Every spelling under which the call's path argument may be compared to a
 * configured pattern: the raw path, plus the session-cwd-relative form for an
 * absolute path (and the absolute form for a relative one). Callers pass no
 * candidate when the argument is absent — an omitted search scope spans the
 * whole workspace, which no path scope can prove exclusion from.
 */
function pathCandidates(raw: string | undefined, cwd: string | undefined): string[] {
  if (raw === undefined) return []
  const candidates = [normalizePath(raw)]
  if (isAbsolute(raw)) {
    if (cwd !== undefined) candidates.push(normalizePath(relative(cwd, raw)))
  } else if (cwd !== undefined) {
    candidates.push(normalizePath(resolve(cwd, raw)))
  }
  return candidates
}

/**
 * Decide whether one rule gates one call.
 * @param rule - the configured rule (its `tool` already equals the call's name).
 * @param exec - the pending call.
 * @returns the match with its reason, or undefined when the call passes.
 */
export function matchGateRule(rule: GateRule, exec: Readonly<ToolExecution>): GateMatch | undefined {
  const patterns = rule.paths ?? []
  if (patterns.length === 0) {
    return { rule, reason: `dsh-rules gate: tool "${exec.name}" is gated by a configured rule` }
  }
  const field = PATH_ARGUMENTS[exec.name]
  if (field === undefined) {
    return {
      rule,
      reason: `dsh-rules gate: tool "${exec.name}" is gated by a path-scoped rule (${patterns.join(', ')}) `
        + 'but exposes no path argument to evaluate; failing closed',
    }
  }
  const candidates = pathCandidates(stringArgument(exec.arguments, field), workspaceCwd(exec))
  if (candidates.length === 0) {
    return {
      rule,
      reason: `dsh-rules gate: tool "${exec.name}" is gated by a path-scoped rule but the call carried no usable `
        + `"${field}" (an omitted search scope spans the whole workspace); failing closed`,
    }
  }
  const hit = firstPathMatch(patterns, candidates)
  if (hit === undefined) return undefined
  return {
    rule,
    reason: `dsh-rules gate: tool "${exec.name}" touches "${hit.path}", matching gate pattern "${hit.pattern}"; approval required`,
  }
}

/**
 * The mounted gate rules, as this plugin's `tools/pre-execute` decision source.
 */
export class RulesGate {
  /** The normalized rules this gate evaluates, in configuration order. */
  readonly gateRules: readonly GateRule[]

  /** @param gateRules - the normalized rules, in configuration order. */
  constructor(gateRules: readonly GateRule[]) {
    this.gateRules = gateRules
  }

  /**
   * The first configured rule that gates this call.
   * @param exec - the pending call.
   * @returns the match, or undefined when no rule applies.
   */
  match(exec: Readonly<ToolExecution>): GateMatch | undefined {
    for (const rule of this.gateRules) {
      if (rule.tool !== exec.name) continue
      const match = matchGateRule(rule, exec)
      if (match !== undefined) return match
    }
    return undefined
  }

  /**
   * The pre-execute decision for this call: `ask` (approval) on a match, else
   * `allow` so later listeners still run.
   * @param exec - the pending call.
   * @returns the decision.
   */
  evaluate(exec: Readonly<ToolExecution>): PreToolDecision {
    const match = this.match(exec)
    if (match === undefined) return { kind: 'allow' }
    return {
      kind: 'ask',
      reason: match.reason,
      displayReason: {
        en: `Approve this gated ${exec.name} call? ${match.reason}`,
        zh: `是否批准这次被门禁拦截的 ${exec.name} 调用？${match.reason}`,
      },
    }
  }
}

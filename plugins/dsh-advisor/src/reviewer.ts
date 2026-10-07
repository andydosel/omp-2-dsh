/**
 * Shared reviewer construction: compose one clean, read-only reviewer agent
 * scope over an unpublished `agentCtx`. Extracted from the advisor runtime so
 * any reviewer-style agent (the advisor's own reviewers, and the future
 * `dsh-orchestrator` one-shot clean reviewer) is built by one implementation.
 *
 * The composition is exactly the advisor's confirmed v1.1 recipe, minus the
 * role/watchdog prompt section (which is caller-specific):
 * 1. join the primary agent's preset composition (`composeFrom`);
 * 2. restrict inherited global tools to the allow-list, intersected with the
 *    tools actually present in the reviewer's agent scope;
 * 3. register the scoped `advise` tool (mask-immune scoped registration);
 * 4. pin delegated policy (read-only sandbox + approval `never`).
 *
 * Synchronous by contract: it runs inside an agent factory `setup` callback,
 * which must compose and never drive.
 *
 * @module @dsh-plugin/dsh-advisor/reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendDelegatedPolicyOverrides, captureDelegatedPolicyOverrides } from '@deepseek-ai/dsh-subagent'
import { defineAdviseTool } from './advise-tool.ts'

/** Options for {@link composeReviewer}. */
export interface ComposeReviewerOptions {
  /** Human-readable reviewer name, used in drop warnings and empty-toolset errors. */
  readonly name: string
  /** Tool allow-list, intersected with the tools actually present in the reviewer scope. */
  readonly tools: readonly string[]
  /** The primary agent whose preset composition and delegated policy the reviewer joins. */
  readonly primary: Agent
  /** Optional warn sink for dropped tool names (the caller's plugin logger). */
  readonly warn?: (message: string, ...args: unknown[]) => void
}

/** The effective composition {@link composeReviewer} installed. */
export interface ComposedReviewer {
  /** Allow-list names that survived the intersection with the reviewer toolset. */
  readonly allowedTools: readonly string[]
  /** Configured names absent from the reviewer toolset (dropped, warned). */
  readonly droppedTools: readonly string[]
}

/**
 * Compose one reviewer scope: preset join, tool restriction, scoped `advise`
 * registration, and delegated policy pin.
 * @param agentCtx - the reviewer's unpublished agent scope.
 * @param agent - the reviewer agent being composed.
 * @param options - reviewer name, tool allow-list, primary agent, and warn sink.
 * @returns the allow-list intersection actually applied.
 * @throws when no allowed tool survives the intersection (nothing to restrict to).
 */
export function composeReviewer(agentCtx: Context, agent: Agent, options: ComposeReviewerOptions): ComposedReviewer {
  // 1. Join the primary's preset composition (required: rosterless global
  //    layers resolve empty otherwise).
  agentCtx.get('agentPresets')?.composeFrom(agentCtx, options.primary.ctx)
  // 2. Restrict inherited global tools to the allow-list, INTERSECTED with
  //    the tools actually present in the reviewer's agent scope: the
  //    default list names standard-preset tools, and a narrower preset
  //    (e.g. minimal) simply does not carry every name. Dropped names are
  //    logged as a warning; an empty intersection fails loud (nothing to
  //    restrict to), which the caller surfaces as a visible reviewer error.
  const present = new Set(agentCtx.tools.schemas(agent).map(schema => schema.name))
  const allowed = options.tools.filter(name => present.has(name))
  const dropped = options.tools.filter(name => !present.has(name))
  if (dropped.length > 0) {
    options.warn?.(
      'dsh-advisor: reviewer "%s" tool names not present in the agent toolset (dropped): %s',
      options.name,
      dropped.join(', '),
    )
  }
  if (allowed.length === 0) {
    throw new Error(
      `dsh-advisor: reviewer "${options.name}" has no usable tools in the agent toolset `
      + `(configured: ${options.tools.join(', ') || '(none)'}; `
      + `known global tools: ${[...present].sort().join(', ') || '(none)'})`,
    )
  }
  agentCtx.tools.restrict({ allow: allowed })
  // 3. Register the scoped advise tool (mask-immune: scoped registrations
  //    are not affected by the allow mask).
  agentCtx.tools.register(defineAdviseTool())
  // 4. Pin delegated policy: inherit the primary's explicit sandbox override
  //    and pin approval to 'never' (read-only + advise-only permissions).
  const inherited = captureDelegatedPolicyOverrides(options.primary)
  appendDelegatedPolicyOverrides(agent.session, inherited)
  return { allowedTools: allowed, droppedTools: dropped }
}

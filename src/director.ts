/**
 * Director-scope narrowing: apply and restore the toolset mask, presentation
 * mode, the five vibe tools, and the director instruction sections on ONE
 * agent's scoped ctx. Every registration is scoped to the director's
 * `agent.ctx`, so it is visible only to that agent, is exempt from the
 * inherited-layer restriction, and auto-unwinds if the agent is disposed
 * before `/vibe off`.
 *
 * @module @dsh-plugin/dsh-vibe-mode/director
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedVibeModeConfig } from './types.ts'
import { foldVibeMode } from './types.ts'
import { WorkerRegistry } from './workers.ts'
import { defineVibeTools } from './tools.ts'

/** Prompt-section order; plan-mode's `plan:policy` uses 50. */
export const DIRECTOR_SECTION_ORDER = 51
/** Prompt-section name for the DIRECTOR instructions. */
export const DIRECTOR_SECTION_NAME = 'director:instructions'

/** Prompt-section order for the DIRECTOR delegation-loop tool guidance (tool guidance band is 100–199). */
export const DIRECTOR_TOOL_GUIDANCE_ORDER = 150
/** Prompt-section name for the DIRECTOR delegation-loop guidance. */
export const DIRECTOR_TOOL_GUIDANCE_NAME = 'director:tool-guidance'

/** The fold-driven tool-guidance text: the delegation loop in one glance, placed beside the tool catalog. */
const DIRECTOR_TOOL_GUIDANCE_TEXT =
  'vibe tools: vibe_spawn (start a worker to do the actual work — cli=fast for mechanical work, cli=good for judgment), '
  + 'vibe_wait (block until workers finish and return their results), '
  + 'vibe_send (direct a worker\'s next turn), vibe_kill (park a running worker), vibe_list (show all workers). '
  + 'Delegate every working step: you decompose, brief, review, and merge — workers do the doing.'

/** The five narrowing registrations, disposed together. */
export interface DirectorScope {
  /** The exact live director agent. */
  readonly agent: Agent
  /** This director's worker bookkeeping. */
  readonly registry: WorkerRegistry
  /** Restore every narrowing registration. Idempotent. */
  dispose(): void
}

/**
 * Apply the DIRECTOR narrowing to one agent: restrict the inherited toolset
 * to the configured read-only allow-list, force the native presentation (the
 * code-mode `run_code` transport cannot be removed by `restrict`), register
 * the five vibe tools on the agent's own scope, and mount the director
 * instruction sections. All disposers are collected; `scope.dispose()` rolls
 * them back in reverse order.
 *
 * @param ctx - plugin root ctx (services resolve through `agent.ctx`).
 * @param agent - the director to narrow.
 * @param config - validated deployment config.
 * @param sectionSource - live DIRECTOR-instructions text; defaults to the
 *   frozen config, and the controller swaps in the settings-backed thunk
 *   (settings override → config → shipped default) once the settings seam
 *   is attached. Re-evaluated per prompt assembly, so a settings change
 *   reaches the very next request without restart or re-entry.
 * @returns the composite scope with its unified disposer.
 */
export function applyDirectorScope(
  ctx: Context,
  agent: Agent,
  config: ResolvedVibeModeConfig,
  sectionSource: () => string = () => config.section,
): DirectorScope {
  const disposers: Array<() => void> = []
  const registry = new WorkerRegistry(ctx, agent, config.maxConsecutiveWakes)

  try {
    // 1. Mask the inherited toolset. Intersect the configured allow-list with
    // the tools actually present in this agent's scope: the default list names
    // standard-preset tools, and a narrower preset (e.g. minimal) simply does
    // not carry every name. Dropped names are logged as a warning; an empty
    // intersection still fails loud (nothing to restrict to).
    const present = new Set(agent.ctx.tools.schemas(agent).map(schema => schema.name))
    const allowed = config.readOnlyTools.filter(name => present.has(name))
    const dropped = config.readOnlyTools.filter(name => !present.has(name))
    if (dropped.length > 0) {
      ctx.logger.warn(
        'dsh-vibe-mode: readOnlyTools names not present in the agent toolset (dropped): %s',
        dropped.join(', '),
      )
    }
    if (allowed.length === 0) {
      throw new Error(
        `dsh-vibe-mode: none of the configured readOnlyTools are present in the agent toolset `
        + `(configured: ${config.readOnlyTools.join(', ') || '(none)'}; `
        + `known global tools: ${[...present].sort().join(', ') || '(none)'})`,
      )
    }
    disposers.push(agent.ctx.tools.restrict({ allow: allowed }))
    // 2. Force native presentation so code-mode `run_code` cannot bypass the
    // mask. Throws if the scope already declared a mode (one composition).
    disposers.push(agent.ctx.tools.presentAs('native'))
    // 3. The five vibe tools on the director's own scope: visible only to the
    // director, unaffected by the restriction, auto-unwinding with the agent.
    for (const tool of defineVibeTools(ctx, registry, config)) {
      disposers.push(agent.ctx.tools.register(tool))
    }
    // 4. The DIRECTOR instructions, fold-driven: the text renders only while
    // the session log says vibe mode is active (resume/fork restore it).
    disposers.push(agent.ctx.systemPrompt.section({
      name: DIRECTOR_SECTION_NAME,
      order: DIRECTOR_SECTION_ORDER,
      text: (context) => {
        const subject = context.agent ?? agent
        return foldVibeMode(subject.session.events) ? sectionSource() : ''
      },
    }))
    // 5. The delegation-loop tool guidance, fold-driven with the same state:
    // a short reminder beside the tool catalog (order 150) that the five
    // vibe tools exist and that the director only briefs, reviews, and merges.
    disposers.push(agent.ctx.systemPrompt.section({
      name: DIRECTOR_TOOL_GUIDANCE_NAME,
      order: DIRECTOR_TOOL_GUIDANCE_ORDER,
      text: (context) => {
        const subject = context.agent ?? agent
        return foldVibeMode(subject.session.events) ? DIRECTOR_TOOL_GUIDANCE_TEXT : ''
      },
    }))
  } catch (error) {
    // Roll back whatever applied before the failure so a partial enter never
    // leaves a half-narrowed director.
    for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]!()
    throw error
  }

  let disposed = false
  return {
    agent,
    registry,
    dispose: () => {
      if (disposed) return
      disposed = true
      registry.dispose()
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        disposers[index]!()
      }
    },
  }
}

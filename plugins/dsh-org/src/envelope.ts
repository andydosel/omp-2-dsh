/**
 * The mechanism-enforced role capability envelopes, applied to one agent's
 * unpublished (or live) scope.
 *
 * An envelope is three cooperating mechanisms on the SAME agent scope:
 * 1. `tools.restrict({ allow })` — the tool-NAME mask over everything the
 *    scope INHERITS, intersected with the names actually present (a narrower
 *    preset simply lacks some names). The role's own tools are registered
 *    AFTER the restriction, because a restriction never filters a scope's own
 *    layer and would be pointless before registration.
 * 2. ONE `tools/pre-execute` listener — the PATH gate (`decidePathGate`),
 *    because mask-visible tools like `read`/`glob`/`grep` still need a
 *    read/write whitelist. A listener registered on an agent ctx sees only
 *    that agent's calls.
 * 3. A role system-prompt section — the methodology and an honest account of
 *    the envelope (delegate rather than reach).
 *
 * The envelope is idempotent per agent object (`WeakMap`), because creation
 * paths overlap: `spawnLead` composes the lead during `setup`, and the same
 * agent is announced through `agent/created` afterwards. A different role on
 * the same live agent replaces the envelope, and `disposeEnvelope` unwinds
 * every effect (the `/org off` path).
 *
 * @module @dsh-plugin/dsh-org/envelope
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the `ctx.systemPrompt` Context merge into the compilation.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { describeError } from '@dsh-plugin/dsh-util/error'
import { decidePathGate, workspaceRoot } from './paths.ts'
import { defineReportTool, defineSecretaryTools } from './tools.ts'
import type { OrgDeps, OrgRole } from './types.ts'

/** One applied envelope: the role it composed and the exact effects to unwind. */
interface AppliedEnvelope {
  readonly role: OrgRole
  readonly disposers: readonly (() => unknown)[]
}

/** Dispose every collected effect; returns the failures rather than throwing mid-way. */
function disposeAll(disposers: readonly (() => unknown)[]): unknown[] {
  const failures: unknown[] = []
  // Reverse install order: the listener and tools unwind before the mask.
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

/** Agents currently carrying an envelope (idempotence across creation paths). */
const APPLIED = new WeakMap<Agent, AppliedEnvelope>()

/** Whether this exact agent object already carries a role envelope. */
export function isEnvelopeApplied(agent: Agent): boolean {
  return APPLIED.has(agent)
}

/**
 * Unwind one agent's role envelope: dispose the tool restriction, every
 * scoped role tool, the path-gate listener, and the role prompt section.
 * Without this, `/org off` would only clear the folded ROLE while the
 * mechanism-level envelope (a mask the model cannot see past plus the role's
 * own tools) stayed installed — the session would remain a secretary in
 * everything but name. Idempotent: a later `apply*` re-installs the envelope.
 * @param agent - the agent whose envelope is lifted.
 * @throws when an effect disposer throws (after disposing every other effect).
 */
export function disposeEnvelope(agent: Agent): void {
  const applied = APPLIED.get(agent)
  if (applied === undefined) return
  APPLIED.delete(agent)
  const failures = disposeAll(applied.disposers)
  if (failures.length > 0) {
    throw new Error(`dsh-org: ${failures.length} envelope effect(s) failed to dispose: ${String(failures[0])}`)
  }
}

/**
 * Inherited tool names a secretary keeps. Its nine role tools are registered
 * after the restriction and are deliberately absent here.
 *
 * `write`/`edit` are present because §5.9 gives the secretary the handoff area
 * (long task briefs): the path gate (`decidePathGate`) confines them to
 * `secretaryWritePaths`, so the authority is "handoff only", never real
 * source. Reads stay on the scoped `read_project_docs`/`project_structure`
 * tools, so no global `read`/`glob`/`grep` is granted.
 */
export const SECRETARY_INHERITED_TOOLS: readonly string[] = [
  'peer_send',
  'task_new',
  'task_update',
  'task_close',
  'task_reopen',
  'task_list',
  'ask_question',
  'todo_write',
  'write',
  'edit',
]

/**
 * Inherited tool names a lead keeps (`report` is scoped and registered after
 * the restriction; `subtask_parallel`, the dsh-orchestrator `review_loop` that
 * starts a requirement's review loop, and `review_filter` (which §5.7 puts on
 * the delegating lead so false positives stop counting) survive only when that
 * plugin is composed — the intersection handles that). `bash` is deliberately
 * absent: the path gate cannot inspect a shell command's write target, so
 * keeping bash in the envelope would let a lead bypass it. A lead reports the
 * need for shell work to its secretary instead. The review-work subagent's
 * remaining tools (`review_round`/`review_finish`/`review_complete`/
 * `review_block`/`review_resume`) are gated to the carrier child's scope by the
 * orchestrator, never granted here.
 */
export const LEAD_INHERITED_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'glob',
  'grep',
  'lsp',
  'write',
  'edit',
  'subtask_parallel',
  'review_loop',
  'review_filter',
  'peer_send',
  'task_new',
  'task_update',
  'task_close',
  'task_reopen',
  'task_list',
  'ask_question',
]

/** The role system-prompt band (100-999 is the plugin range). */
export const ROLE_SECTION_ORDER = 200

const SECRETARY_SECTION = 'You are the workspace SECRETARY: the human-facing coordinator. You do not implement. '
  + 'Your capability envelope is mechanism-enforced: you may read documents (markdown, docs/**) and the handoff area, '
  + 'you may write ONLY the handoff area, and your toolset excludes the source-code file tools. Work by delegation:\n'
  + '- `org_claim` a session to take over its coordination (one secretary per session); `org_relinquish` / `org_forbid` to let go.\n'
  + '- `org_spawn_lead` to create a lead for a workstream, then `assign_task` to give it a scoped brief.\n'
  + '- `read_project_docs` and `project_structure` to understand the project without reading code.\n'
  + '- `summarize_reports` to digest leads\' reports; `notify_user` to surface a durable note to the human.\n'
  + 'If a request needs code work, hand it to a lead instead of trying to read or write code yourself.'

const LEAD_SECTION = 'You are a LEAD: an implementation owner in this workspace. You may read the codebase and write '
  + 'within your envelope (documents and the handoff area). Do the work with your tools, keep changes focused, and '
  + 'close the loop with `report` back to the secretary that manages this session — state what you did, what you '
  + 'verified, what is blocked, and what comes next. If you have no manager, ask for one rather than assuming.'

/** Shared envelope body for both roles. */
function applyEnvelope(agentCtx: Context, agent: Agent, deps: OrgDeps, role: OrgRole): void {
  const applied = APPLIED.get(agent)
  if (applied?.role === role) return
  // A different role on the same live agent (a lead promoted through
  // `/org on`) REPLACES its envelope rather than layering a second one.
  if (applied !== undefined) disposeEnvelope(agent)
  const disposers: Array<() => unknown> = []
  try {
    // 1. Read the INHERITED tool names before touching the scope.
    const present = new Set(agentCtx.tools.schemas(agent).map(schema => schema.name))
    const configured = role === 'secretary'
      ? [...SECRETARY_INHERITED_TOOLS, ...(deps.config.secretaryBash ? ['bash'] : [])]
      : LEAD_INHERITED_TOOLS
    const allow = configured.filter(name => present.has(name))
    if (allow.length === 0) {
      throw new Error(
        `dsh-org: the ${role} envelope found no usable inherited tools to keep `
        + `(wanted: ${configured.join(', ') || '(none)'}; present: ${[...present].sort().join(', ') || '(none)'}). `
        + 'The agent scope has not joined a preset composition that carries the standard tools.',
      )
    }
    disposers.push(agentCtx.tools.restrict({ allow }))
    // 2. Register the role's own (scoped, mask-immune) tools.
    if (role === 'secretary') {
      for (const tool of defineSecretaryTools(deps.org, deps)) disposers.push(agentCtx.tools.register(tool))
    } else {
      disposers.push(agentCtx.tools.register(defineReportTool(deps.org, deps)))
    }
    // 3. One path-gate listener for this agent's calls.
    const readPaths = role === 'secretary' ? deps.config.secretaryReadPaths : deps.config.leadReadPaths
    const writePaths = role === 'secretary' ? deps.config.secretaryWritePaths : deps.config.leadWritePaths
    disposers.push(agentCtx.on('tools/pre-execute', async (exec, next) => {
      const decision = decidePathGate({
        toolName: exec.name,
        args: exec.arguments,
        cwd: workspaceRoot(agent.session.header.cwd),
        readPaths,
        writePaths,
      })
      return decision.kind === 'deny' ? decision : next()
    }))
    // 4. The role methodology section.
    disposers.push(agentCtx.systemPrompt.section({
      name: `dsh-org-role-${role}`,
      order: ROLE_SECTION_ORDER,
      text: role === 'secretary' ? SECRETARY_SECTION : LEAD_SECTION,
    }))
  } catch (error) {
    // A half-installed envelope is worse than none: unwind what landed and
    // report the original failure (plus any teardown failure) at one site.
    const failures = disposeAll(disposers)
    const suffix = failures.length === 0 ? '' : ` (and ${failures.length} effect(s) failed to unwind: ${String(failures[0])})`
    throw new Error(`dsh-org: ${role} envelope install failed: ${describeError(error)}${suffix}`)
  }
  APPLIED.set(agent, { role, disposers })
}

/**
 * Apply the secretary envelope: keep only the coordination tool names, register
 * the nine secretary tools, install the docs-only read/write path gate, and add
 * the secretary section.
 * @param agentCtx - the secretary's agent scope.
 * @param agent - the secretary agent.
 * @param deps - the organisation seams and resolved configuration.
 * @throws when no inherited tool survives the intersection, or config is invalid.
 */
export function applySecretaryEnvelope(agentCtx: Context, agent: Agent, deps: OrgDeps): void {
  applyEnvelope(agentCtx, agent, deps, 'secretary')
}

/**
 * Apply the lead envelope: keep the code-working tool names, register the
 * scoped `report` tool, install the lead read/write path gate, and add the lead
 * section.
 * @param agentCtx - the lead's agent scope.
 * @param agent - the lead agent.
 * @param deps - the organisation seams and resolved configuration.
 * @throws when no inherited tool survives the intersection, or config is invalid.
 */
export function applyLeadEnvelope(agentCtx: Context, agent: Agent, deps: OrgDeps): void {
  applyEnvelope(agentCtx, agent, deps, 'lead')
}

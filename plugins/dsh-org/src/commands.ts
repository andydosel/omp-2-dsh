/**
 * `/org` commands: `on|off|claim <id>|relinquish <id>|forbid <id>|list`.
 *
 * The handler takes the live API, the seams, and the invocation explicitly, so
 * it is unit-testable without a command registry. `on` is the only place an
 * envelope is applied OUTSIDE agent creation: it composes the secretary
 * envelope onto the invoking agent immediately; `off` lifts that envelope
 * (every scoped tool, the tool mask, the path gate, and the role section are
 * disposed) and clears the folded role, so the session really is demoted.
 *
 * @module @dsh-plugin/dsh-org/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { applySecretaryEnvelope, disposeEnvelope } from './envelope.ts'
import type { OrgApi, OrgDeps } from './types.ts'

/** The slice of a command invocation the `/org` handler needs. */
export interface OrgCommandInvocation {
  readonly rawInput: string
  readonly agent: Agent
}

/** The usage line returned for every unrecognized input. */
export const ORG_USAGE = 'usage: /org [on|off|claim <id>|relinquish <id>|forbid <id>|list]'

/**
 * Handle one `/org` invocation.
 * @param org - the live organisation API.
 * @param deps - the seams and resolved configuration (used by `on`).
 * @param invocation - the raw input and the invoking agent.
 * @returns the command result rendered by the dispatching UI.
 */
export function orgCommandHandler(org: OrgApi, deps: OrgDeps, invocation: OrgCommandInvocation): CommandResult {
  const parts = invocation.rawInput.trim().split(/\s+/).filter(part => part !== '')
  const verb = parts[0]
  const argument = parts[1]
  switch (verb) {
    case 'on': {
      try {
        applySecretaryEnvelope(invocation.agent.ctx, invocation.agent, deps)
        org.setRole(invocation.agent.id, 'secretary')
      } catch (error) {
        return { kind: 'error', text: `org: cannot enable the secretary envelope: ${error instanceof Error ? error.message : String(error)}` }
      }
      return {
        kind: 'success',
        text: `Secretary mode on for ${invocation.agent.id}. Delegate with org_spawn_lead/assign_task; documents and the handoff area are your only file surface.`,
      }
    }
    case 'off': {
      try {
        disposeEnvelope(invocation.agent)
        org.setRole(invocation.agent.id, undefined)
      } catch (error) {
        return { kind: 'error', text: `org: ${error instanceof Error ? error.message : String(error)}` }
      }
      return {
        kind: 'success',
        text: `Coordinator role cleared for ${invocation.agent.id}: the capability envelope is lifted and the global tool set is back. Run /org on to become a secretary again.`,
      }
    }
    case 'claim':
    case 'relinquish':
    case 'forbid': {
      if (argument === undefined) return { kind: 'error', text: ORG_USAGE }
      try {
        if (verb === 'claim') org.claim(invocation.agent, argument)
        else if (verb === 'relinquish') org.relinquish(invocation.agent, argument)
        else org.forbid(invocation.agent, argument)
      } catch (error) {
        return { kind: 'error', text: `org ${verb}: ${error instanceof Error ? error.message : String(error)}` }
      }
      const done = verb === 'claim' ? 'now manages' : verb === 'relinquish' ? 'released' : 'now forbids'
      return { kind: 'success', text: `${invocation.agent.id} ${done} ${argument}.` }
    }
    case 'list': {
      const role = org.roleOf(invocation.agent.id) ?? 'independent'
      const manages = org.managesOf(invocation.agent.id)
      const forbidden = org.forbiddenOf(invocation.agent.id)
      return {
        kind: 'success',
        text: [
          `role: ${role}`,
          `manages: ${manages.length === 0 ? '(none)' : manages.join(', ')}`,
          `forbidden: ${forbidden.length === 0 ? '(none)' : forbidden.join(', ')}`,
        ].join('\n'),
      }
    }
    default:
      return { kind: 'error', text: ORG_USAGE }
  }
}

/**
 * Register `/org` when a command registry is composed.
 * @param ctx - the plugin context.
 * @param org - the live organisation API.
 * @param deps - the seams and resolved configuration.
 */
export function registerOrgCommands(ctx: Context, org: OrgApi, deps: OrgDeps): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'org',
      description: 'Manage the session organisation (secretary/lead claims)',
      input: { hint: '[on|off|claim <id>|relinquish <id>|forbid <id>|list]' },
      handler: ({ rawInput, agent }) => orgCommandHandler(org, deps, { rawInput, agent }),
    })
  })
}

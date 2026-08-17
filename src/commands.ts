/**
 * `/advisor` commands: on|off|status. Results are rendered by the command
 * adapter and never enter model history (the `command/run`/`command/done`
 * records are log-only).
 *
 * @module @dsh-plugin/dsh-advisor/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { AdvisorRuntime } from './advisor.ts'

/**
 * Handle one `/advisor` invocation. Pure enough to unit-test without a
 * command registry: `runtime` is the live advisor controller.
 * @param runtime - the advisor runtime.
 * @param rawInput - the trimmed command input after `/advisor`.
 * @returns the command result rendered by the dispatching UI.
 */
export function advisorCommandHandler(runtime: AdvisorRuntime, rawInput: string): CommandResult {
  const input = rawInput.trim().toLowerCase()
  switch (input) {
    case '':
    case 'on': {
      runtime.enable()
      return { kind: 'success', text: 'Advisor enabled. Use /advisor status to inspect reviewers, /advisor off to disable.' }
    }
    case 'off': {
      runtime.disable()
      return { kind: 'success', text: 'Advisor disabled.' }
    }
    case 'status': {
      return { kind: 'success', text: runtime.statusText() }
    }
    default: {
      return { kind: 'error', text: 'usage: /advisor [on|off|status]' }
    }
  }
}

/**
 * Register the `/advisor` command. The command child activates only when a
 * command registry is composed (`ctx.inject` pattern, plan-mode precedent).
 * @param ctx - the plugin context.
 * @param runtime - the advisor runtime the command drives.
 */
export function registerAdvisorCommands(ctx: Context, runtime: AdvisorRuntime): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'advisor',
      description: 'Toggle or report the session advisor (reviewer models)',
      input: { hint: '[on|off|status]' },
      handler: ({ rawInput }) => advisorCommandHandler(runtime, rawInput),
    })
  })
}

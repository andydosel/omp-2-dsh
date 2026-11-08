/**
 * `/advisor` commands: on|off|status, plus `model` for the reviewer model
 * route. Results are rendered by the command adapter and never enter model
 * history (the `command/run`/`command/done` records are log-only).
 *
 * @module @dsh-plugin/dsh-advisor/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { AdvisorRuntime } from './advisor.ts'

/** Usage line shared by the error branch and the command registration. */
const USAGE = '用法:/advisor [on|off|status|model [<provider/model>|follow]]'

/**
 * Render a model route for a Chinese status line.
 * @param route - the effective route; empty means "follow the primary session".
 * @returns user-facing copy.
 */
function modelText(route: string): string {
  return route === '' ? '跟随主会话模型' : route
}

/**
 * Handle one `/advisor` invocation. Pure enough to unit-test without a
 * command registry: `runtime` is the live advisor controller.
 *
 * The first word is the verb (case-insensitive); everything after it is the
 * argument and keeps its case, because provider and model ids are
 * case-sensitive.
 * @param runtime - the advisor runtime.
 * @param rawInput - the trimmed command input after `/advisor`.
 * @returns the command result rendered by the dispatching UI.
 */
export function advisorCommandHandler(runtime: AdvisorRuntime, rawInput: string): CommandResult {
  const input = rawInput.trim()
  const space = input.search(/\s/)
  const verb = (space === -1 ? input : input.slice(0, space)).toLowerCase()
  const argument = space === -1 ? '' : input.slice(space).trim()
  switch (verb) {
    case '':
    case 'on': {
      runtime.enable()
      return { kind: 'success', text: '顾问已启用。用 /advisor status 查看审查者,用 /advisor off 关闭。' }
    }
    case 'off': {
      runtime.disable()
      return { kind: 'success', text: '顾问已关闭。' }
    }
    case 'status': {
      return { kind: 'success', text: runtime.statusText() }
    }
    case 'model': {
      if (argument === '') {
        return {
          kind: 'success',
          text: `顾问模型:${modelText(runtime.effectiveModel)}。用 /advisor model <provider/model> 设置,用 /advisor model follow 恢复跟随主会话。`,
        }
      }
      const lowered = argument.toLowerCase()
      if (lowered === 'follow' || lowered === 'default' || lowered === '-') {
        const effective = runtime.setReviewerModel('')
        return { kind: 'success', text: `顾问模型已恢复为${modelText(effective)}。` }
      }
      const effective = runtime.setReviewerModel(argument)
      return {
        kind: 'success',
        text: `顾问模型已设为 ${modelText(effective)}。${runtime.isEnabled ? '正在重启审查者以套用新模型。' : '开启顾问后生效。'}`,
      }
    }
    default: {
      return { kind: 'error', text: USAGE }
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
      description: 'Toggle the session advisor or pick the reviewer model',
      input: { hint: '[on|off|status|model]' },
      handler: ({ rawInput }) => advisorCommandHandler(runtime, rawInput),
    })
  })
}

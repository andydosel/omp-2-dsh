/**
 * WeChat channel UI plugin, browser half: registers the WECHAT status badge in
 * the session header's `conversation.session.header.utilities` band.
 *
 * The badge reads the host-computed `wechatChannel` projection (zero
 * client-side folding) and executes `/wechat status` through
 * `ctx.remote.commands`, mirroring the advisor badge's standard-kit shape.
 * This face ships in the channel's own package (`dsh.client`), so installing
 * the channel alone is enough — no dsh-mode-ui dependency, no cross-package
 * import.
 *
 * @module @dsh-plugin/dsh-channel-wechat/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ui-conversation Service merge and the header.utilities
// list seat.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the SessionStandardProps merge delivered to a session-scope seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the `ctx.slots` renderer registry merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `ctx.remote` Client Remote surface (commands included).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the wechatChannel SessionProjectionMap key.
import type {} from '../../src/types.ts'
import { WechatBadge } from './badge/WechatBadge.tsx'

export type { ModeBadgeInjected, ModeBadgeProps } from './badge/ModeBadge.tsx'
export type { WechatBadgeProps } from './badge/WechatBadge.tsx'

/** Services required by this client face: slot registrar + remote command runner. */
export const inject = ['slots', 'remote', 'remote.commands']

/** The admission envelope the host returns for one slash command. */
interface CommandAdmission {
  readonly ok: boolean
  readonly error?: { readonly message: string; readonly code: string }
  readonly value?: {
    readonly result?: { readonly kind: 'success' | 'error'; readonly text?: string }
  }
}

/**
 * Execute one slash command in the owning session and turn a rejection into a
 * user-visible line; `null` means the command was admitted.
 * @param ctx - the plugin context (remote commands face).
 * @param sessionId - the session the header belongs to.
 * @param command - the slash command line to run.
 * @returns the failure line, or null on admitted execution.
 */
async function executeCommand(ctx: Context, sessionId: SessionId, command: string): Promise<string | null> {
  const execute = ctx.remote.commands.execute as (
    agentId: SessionId,
    line: string,
    submittedAttachments: readonly unknown[],
  ) => Promise<CommandAdmission>
  const result = await execute(sessionId, command, [])
  if (!result.ok) {
    return '命令执行失败:' + (result.error?.message ?? '未知错误') + '(' + (result.error?.code ?? '未知错误码') + ')'
  }
  if (result.value === undefined) return '未知命令:' + command
  if (result.value.result?.kind === 'error') return result.value.result.text ?? '命令执行失败'
  return null
}

/**
 * Register the WECHAT badge. The slot id differs from dsh-mode-ui's legacy
 * `mode-ui-wechat` entry so both can coexist while the mode-ui half is
 * retired.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'wechat-channel',
      order: 30,
      inject: (sessionId: SessionId) => ({
        runCommand: (command: string) => executeCommand(ctx, sessionId, command),
      }),
    }, WechatBadge)),
    'dsh-channel-wechat: header badge',
  )
}

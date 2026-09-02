/**
 * Mode-status UI plugin, browser half: registers four status badges into the
 * session header's `conversation.session.header.utilities` list slot
 * (right-aligned utilities band). Each badge reads its host-computed
 * projection via the standard-kit `useProjection` (zero client-side folding)
 * and executes the matching slash command through `ctx.remote.commands`
 * (plan-chip interaction pattern). The `dsh.client.inject` edges name the
 * boot modules this face depends on, copied from the ui-plan package
 * declaration: api-remotes (ctx.remote), client-locale (dictionary infra),
 * and ui-conversation (the header utilities SlotMap declaration); the
 * runtime edge arrives transitively through ui-conversation's own inject.
 *
 * @module @dsh-plugin/dsh-mode-ui/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the header.utilities
// list seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the four SessionProjectionMap merges for useProjection.
import type {} from '../../src/types.ts'
import { AdvisorBadge } from './badges/AdvisorBadge.tsx'
import { CompactBadge } from './badges/CompactBadge.tsx'
import { VibeBadge } from './badges/VibeBadge.tsx'
import { WechatBadge } from './badges/WechatBadge.tsx'

export type { ModeBadgeInjected } from './badges/ModeBadge.tsx'

/** Required services: the header slot registry and the command Remote. */
export const inject = ['slots', 'remote', 'remote.commands']

/** The admission-shaped result of one slash-command execution. */
interface CommandAdmission {
  ok: boolean
  error?: { message: string; code: string }
  value?: unknown
}

/**
 * Execute one slash command for the owning session. The published
 * `commands/execute` Remote carries an `images` parameter the local host
 * wire does not expect (the runtime itself calls the same Remote with
 * `(sessionId, line)` only), so the call is narrowed to the 2-argument
 * admission shape.
 * @returns null on admitted execution; a user-visible failure line otherwise.
 */
async function executeCommand(ctx: ClientContext, sessionId: SessionId, command: string): Promise<string | null> {
  const execute = ctx.remote.commands.execute as unknown as (agentId: SessionId, line: string) => Promise<CommandAdmission>
  const result = await execute(sessionId, command)
  if (!result.ok) return `${result.error?.message ?? 'command failed'} (${result.error?.code ?? 'unknown'})`
  if (result.value === undefined) return `unknown command: ${command}`
  return null
}

/**
 * Client plugin body: register the four mode-status badges over the command
 * channel. Four independent list entries, ascending order (compact → vibe →
 * advisor → wechat), each with its own inject face closing over
 * `ctx.remote.commands` (plan-chip pattern).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject(
    'conversation.session.header.utilities',
    () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'mode-ui-compact',
      order: 10,
      inject: (sessionId: SessionId) => ({
        // Failure strings stay English (error-surface policy: not localized).
        runCommand: (command: string) => executeCommand(ctx, sessionId, command),
      }),
    }, CompactBadge),
  )
  ctx.slots.inject(
    'conversation.session.header.utilities',
    () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'mode-ui-vibe',
      order: 20,
      inject: (sessionId: SessionId) => ({
        runCommand: (command: string) => executeCommand(ctx, sessionId, command),
      }),
    }, VibeBadge),
  )
  ctx.slots.inject(
    'conversation.session.header.utilities',
    () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'mode-ui-advisor',
      order: 30,
      inject: (sessionId: SessionId) => ({
        runCommand: (command: string) => executeCommand(ctx, sessionId, command),
      }),
    }, AdvisorBadge),
  )
  ctx.slots.inject(
    'conversation.session.header.utilities',
    () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'mode-ui-wechat',
      order: 40,
      inject: (sessionId: SessionId) => ({
        runCommand: (command: string) => executeCommand(ctx, sessionId, command),
      }),
    }, WechatBadge),
  )
}

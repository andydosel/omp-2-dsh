/**
 * Task-board UI plugin, browser half: one Chat business node. The
 * `ConversationNodeDefinition` in `./definition.ts` folds the session's
 * `task/*` ledger events into the singleton `task-board` node, and the keyed
 * `conversation.chat.node` seat renders it with `./TaskBoardNode.tsx` (work
 * set highlighted + the full ledger, per-row status badge, work-set checkbox,
 * close/reopen buttons).
 *
 * Data flows the projection path (host-computed `taskBoard` via the standard
 * `useProjection` seat; zero client-side folding) and mutations flow back as
 * `/task …` lines through `ctx.remote.commands` — the same client→host channel
 * mode-ui's badges and the plan chip use, and the only one available to an
 * out-of-tree plugin (the client bundle purity gate rejects cross-plugin
 * value imports, so no generated `/remote` module can be consumed).
 *
 * The `dsh.client.inject` edges name the boot modules this face depends on:
 * ui-chat (the `conversation.chat.node` keyed seat + `ChatNodeDataMap`),
 * ui-conversation (the `uiConversation` registries), ui-renderer (`ctx.slots`),
 * ui-session (the session-scope standard props: sessionId + useProjection) and
 * api-remotes (`ctx.remote.commands`).
 *
 * @module @dsh-plugin/dsh-task-board/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the `ctx.remote` Client Remote surface (commands included).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-chat contract — the `conversation.chat.node` keyed
// seat, the ChatNodeDataMap merge, and the composed Chat node props.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the ui-conversation client surface (`ctx.uiConversation`).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the `ctx.slots` renderer registry merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the SessionStandardProps merge (sessionId + useProjection).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the `task/*` event and `taskBoard` projection merges.
import type {} from '../../src/types.ts'
import { TASK_BOARD_NODE_KIND, taskBoardDefinition } from './definition.ts'
import { TaskBoardNode, type TaskBoardNodeInjected } from './TaskBoardNode.tsx'

export { TASK_BOARD_NODE_ID, TASK_BOARD_NODE_KIND, taskBoardDefinition } from './definition.ts'
export type { TaskBoardNodeData, TaskBoardViewNode } from './definition.ts'
export type { TaskBoardNodeInjected, TaskBoardNodeProps } from './TaskBoardNode.tsx'

/** Required services: the slot registry, the conversation registries, and the command Remote. */
export const inject = ['slots', 'uiConversation', 'remote', 'remote.commands']

/** The admission-shaped result of one slash-command execution. */
interface CommandAdmission {
  ok: boolean
  error?: { message: string; code: string }
  value?: unknown
}

/**
 * Execute one `/task …` line for the owning session. The published
 * `commands/execute` Remote carries an `images` parameter the local host wire
 * does not expect (the runtime itself calls the same Remote with
 * `(sessionId, line)` only), so the call is narrowed to the 2-argument
 * admission shape.
 * @returns null on admitted execution; a user-visible failure line otherwise.
 */
async function executeCommand(ctx: Context, sessionId: SessionId, line: string): Promise<string | null> {
  const execute = ctx.remote.commands.execute as unknown as (agentId: SessionId, line: string) => Promise<CommandAdmission>
  const result = await execute(sessionId, line)
  if (!result.ok) return `${result.error?.message ?? 'command failed'} (${result.error?.code ?? 'unknown'})`
  if (result.value === undefined) return `unknown command: ${line}`
  return null
}

/**
 * Client plugin body: register the task-board Definition and its keyed
 * renderer, whose injected face closes over `ctx.remote.commands` for the
 * owning session.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.uiConversation.events.register(taskBoardDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: TASK_BOARD_NODE_KIND,
    inject: (sessionId: SessionId): TaskBoardNodeInjected => ({
      runTaskCommand: (line: string) => executeCommand(ctx, sessionId, line),
    }),
  }, TaskBoardNode))
}

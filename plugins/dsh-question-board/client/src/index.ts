/**
 * Question-inbox UI plugin, browser half: registers the `question-board`
 * ConversationNode definition (one keyed node per asker, anchored at that
 * asker's first question) and the keyed `conversation.chat.node` renderer
 * behind the same kind.
 *
 * The renderer reads the host-folded `questionBoard` projection and dispatches
 * the plugin's own `/answer_question` and `/dismiss_question` commands for its
 * actions: an out-of-tree package has no typert `/remote` contribution (the
 * bundle purity gate rejects a `@deepseek-ai/*` value import, and a
 * `@dsh-plugin/*` package cannot register one), so `ctx.remote.commands` is the
 * only client→host channel available — the same one the mode badges use.
 *
 * @module @dsh-plugin/dsh-question-board/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the `ctx.remote` Client Remote surface (commands included).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-chat SlotMap merge (the conversation.chat.node seat).
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the ui-conversation Service merge (ctx.uiConversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the `ctx.slots` renderer registry merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the SessionStandardProps merge (branded sessionId + useProjection).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the questionBoard SessionProjectionMap merge.
import type {} from '../../src/types.ts'
import { ANSWER_QUESTION_COMMAND, DISMISS_QUESTION_COMMAND } from '../../src/commands.ts'
import { QuestionBoardPanel, type QuestionBoardInjected } from './QuestionBoardPanel.tsx'
import { QUESTION_BOARD_NODE_KIND, questionBoardDefinition } from './question-board-node.ts'

export type { QuestionBoardInjected } from './QuestionBoardPanel.tsx'

/** Required services: conversation registries, the slot registry, and the command Remote. */
export const inject = ['slots', 'uiConversation', 'remote', 'remote.commands']

/** The settled execution one command Remote call carries back. */
interface CommandExecution {
  readonly result?: { readonly kind?: string; readonly text?: string }
}

/** The admission-shaped result of one slash-command execution. */
interface CommandAdmission {
  ok: boolean
  error?: { message: string; code: string }
  value?: CommandExecution
}

/**
 * Execute one slash command for the owning session. The published
 * `commands/execute` Remote carries an `attachments` parameter and an
 * `AbortSignal` the local host wire fills in itself, so the call is narrowed
 * to the admission shape the badge precedent uses.
 * @returns null on admitted execution; a user-visible failure line otherwise.
 */
async function executeCommand(ctx: Context, sessionId: SessionId, line: string): Promise<string | null> {
  const execute = ctx.remote.commands.execute as unknown as (agentId: SessionId, line: string) => Promise<CommandAdmission>
  const result = await execute(sessionId, line)
  if (!result.ok) return `${result.error?.message ?? 'command failed'} (${result.error?.code ?? 'unknown'})`
  const outcome = result.value?.result
  if (outcome === undefined) return `unknown command: ${line}`
  if (outcome.kind === 'error') return outcome.text ?? 'command failed'
  return null
}

/**
 * Client plugin body: register the asker-keyed question definition and the
 * renderer that occupies the matching `conversation.chat.node` cell.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.uiConversation.events.register(questionBoardDefinition),
    'dsh-question-board: question-board node definition',
  )
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: QUESTION_BOARD_NODE_KIND,
    inject: (sessionId: SessionId): QuestionBoardInjected => ({
      answer: (id, value) => executeCommand(ctx, sessionId, `/${ANSWER_QUESTION_COMMAND} ${id} ${value}`),
      dismiss: (id) => executeCommand(ctx, sessionId, `/${DISMISS_QUESTION_COMMAND} ${id}`),
    }),
  }, QuestionBoardPanel)), 'dsh-question-board: question-board renderer')
}

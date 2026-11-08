/**
 * Advisor UI plugin, browser half: the in-conversation advice card and the
 * session-header status badge.
 *
 * The card registers the `advisor-advice` ConversationNode definition and the
 * keyed `conversation.chat.node` renderer behind the same kind. It is a
 * read-only view of the durable `advisor/advice` event the host runtime
 * appends when it accepts an advisory; model-side delivery keeps its own path
 * (the plugin-sourced `user/message` with steer/immune semantics). This face
 * only makes the same advisory visible to the human, and replays identically
 * after a refresh because the event is in the session log.
 *
 * The badge registers one entry in the `conversation.session.header.utilities`
 * band and reads the host-computed `advisorStatus` projection (zero
 * client-side folding). Clicking it opens a settings panel whose switch and
 * reviewer-model picker travel as slash commands through `ctx.remote.commands`,
 * so the host stays the only writer of persisted advisor state.
 *
 * @module @dsh-plugin/dsh-advisor/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ui-chat SlotMap merge (the conversation.chat.node seat).
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the ui-conversation Service merge (ctx.uiConversation) and
// the header.utilities list seat.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the `ctx.slots` renderer registry merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the SessionStandardProps merge delivered to a session-scope seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the `ctx.remote` Client Remote surface (commands included).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the advisorStatus SessionProjectionMap key.
import type {} from '../../src/types.ts'
import { AdvisorAdviceCard } from './AdvisorAdviceCard.tsx'
import { ADVISOR_ADVICE_NODE_KIND, advisorAdviceDefinition } from './advisor-advice-node.ts'
import { AdvisorBadge } from './badge/AdvisorBadge.tsx'
import type { ModelDirectoryFace } from './badge/model-directory.ts'
import { adaptModelDirectory } from './badge/model-directory.ts'

export type { AdvisorAdviceCardProps } from './AdvisorAdviceCard.tsx'
export { ADVISOR_ADVICE_NODE_KIND, advisorAdviceDefinition } from './advisor-advice-node.ts'
export { AdvisorBadge } from './badge/AdvisorBadge.tsx'
export type { AdvisorBadgeInjected, AdvisorBadgeProps } from './badge/AdvisorBadge.tsx'
export { AdvisorPanel, FOLLOW_PRIMARY_LABEL } from './badge/AdvisorPanel.tsx'
export type { AdvisorPanelProps } from './badge/AdvisorPanel.tsx'
export type { ModeBadgeInjected, ModeBadgeProps } from './badge/ModeBadge.tsx'
export { adaptModelDirectory, EMPTY_DIRECTORY_SNAPSHOT, normalizeDirectory } from './badge/model-directory.ts'
export type {
  ModelChoice,
  ModelDirectoryFace,
  ModelDirectorySnapshot,
  ModelProviderChoice,
} from './badge/model-directory.ts'

/**
 * Required services: the conversation and slot registries (card), plus the
 * command Remote (badge).
 */
export const inject = ['slots', 'uiConversation', 'remote', 'remote.commands']

/** The dispatch result: transport admission wrapping the handler's own outcome. */
interface CommandAdmission {
  ok: boolean
  error?: { message: string; code: string }
  value?: {
    readonly result?: {
      readonly kind: 'success' | 'error'
      readonly text?: string
    }
  }
}

/**
 * Execute one slash command for the owning session. The published
 * `commands/execute` Remote requires `(agentId, line, submittedAttachments)`;
 * the badge submits no attachments, but the batch is still required.
 * @returns null on admitted execution; a user-visible failure line otherwise.
 */
async function executeCommand(ctx: Context, sessionId: SessionId, command: string): Promise<string | null> {
  const execute = ctx.remote.commands.execute as unknown as (
    agentId: SessionId,
    line: string,
    submittedAttachments: readonly unknown[],
  ) => Promise<CommandAdmission>
  const result = await execute(sessionId, command, [])
  if (!result.ok) return `命令执行失败:${result.error?.message ?? '未知错误'}(${result.error?.code ?? '未知错误码'})`
  if (result.value === undefined) return `未知命令:${command}`
  // A settled handler error is a successful DISPATCH: the admission `ok` only
  // says the line ran. Pass the handler's own message through, or the badge
  // would report success for a refused toggle.
  if (result.value.result?.kind === 'error') return result.value.result.text ?? '命令执行失败'
  return null
}

/**
 * Resolved model directories, one per session and cached for the page's
 * lifetime. The adapter keeps `getSnapshot()` referentially stable, which the
 * panel's `useSyncExternalStore` needs; rebuilding it per render would loop.
 */
const modelDirectories = new Map<string, ModelDirectoryFace>()

/**
 * Resolve the session's model directory through the web app's optional
 * `modelDirectories` service.
 *
 * The service belongs to `ui-model-selection`, which this bundle must not
 * depend on: a profile without that client plugin simply has no catalog, and
 * the panel must degrade instead of failing. So the lookup is structural and
 * every failure (missing service, unbound session scope, unusable value)
 * collapses to undefined.
 * @returns the adapter, or undefined when no catalog can be read.
 */
function resolveModelDirectory(ctx: Context, sessionId: SessionId): ModelDirectoryFace | undefined {
  const cached = modelDirectories.get(sessionId)
  if (cached !== undefined) return cached
  // `ctx.get` is typed through cordis' reflect map; an unregistered key falls
  // back to the string overload, so no import of the owning package is needed.
  const resolver = ctx.get('modelDirectories') as { directoryFor?: (id: SessionId) => unknown } | undefined
  if (resolver === undefined || typeof resolver.directoryFor !== 'function') return undefined
  try {
    const face = adaptModelDirectory(resolver.directoryFor(sessionId))
    if (face === undefined) return undefined
    modelDirectories.set(sessionId, face)
    return face
  } catch {
    // Unknown session scope or unbound binding: no catalog for this session.
    return undefined
  }
}

/**
 * Client plugin body: register the advice card and the header badge.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.uiConversation.events.register(advisorAdviceDefinition),
    'dsh-advisor: advisor-advice node definition',
  )
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: ADVISOR_ADVICE_NODE_KIND,
  }, AdvisorAdviceCard)), 'dsh-advisor: advisor-advice renderer')
  ctx.effect(() => ctx.slots.inject(
    'conversation.session.header.utilities',
    () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'advisor-status',
      order: 20,
      inject: (sessionId: SessionId) => ({
        // Failure copy is user-facing Chinese; the badge renders it as 失败: …
        runCommand: (command: string) => executeCommand(ctx, sessionId, command),
        // Optional seat: undefined disables the panel's model picker.
        modelDirectory: () => resolveModelDirectory(ctx, sessionId),
      }),
    }, AdvisorBadge),
  ), 'dsh-advisor: header badge')
}

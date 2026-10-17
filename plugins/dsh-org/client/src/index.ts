/**
 * dsh-org's browser half: one session panel registered into the
 * `conversation.input.dock` list seat (the full-width strip above the composer,
 * the todo/queue dock posture). The panel reads the host-computed `org`
 * projection through the standard-kit `useProjection` (zero client-side
 * folding) and drives `relinquish`/`forbid` through the session's own `/org`
 * slash command — the command registry is the only client-reachable mutation
 * channel here, and it is the same `/org` family the CLI/TUI uses.
 *
 * The `dsh.client.inject` edges name the boot modules this face depends on
 * (copied from dsh-mode-ui's declaration): api-remotes (ctx.remote.commands),
 * ui-conversation (the input-dock SlotMap declaration), ui-renderer (ctx.slots)
 * and ui-session (the session-scope standard props: sessionId + useProjection).
 * They are informational for the boot graph — activation is Cordis fiber inject
 * waiting on the `slots`/`remote.commands` services, and the slot contribution
 * itself waits on the seat's declaration via `ctx.slots.inject`.
 *
 * @module @dsh-plugin/dsh-org/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ui-conversation SlotMap merge (the input-dock list seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the SessionStandardProps merge (sessionId + useProjection).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the `ctx.slots` renderer registry merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `ctx.remote` Client Remote surface (commands included).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: loads the augmented module itself. `src/types.ts` merges into
// `@deepseek-ai/dsh-session-projection/types`, and TypeScript rejects a
// `declare module` augmentation whose target module no program file names
// directly (TS2664) — the client program is rooted at client/src, so it names
// it here. Erased from the emit; never reaches the bundle purity gate.
import type {} from '@deepseek-ai/dsh-session-projection/types'
// Type-only: pulls the `org` SessionProjectionMap merge for useProjection.
import type {} from '../../src/types.ts'
import { OrgPanel } from './OrgPanel.tsx'
import { OrgSessionRowMark, OrgSessionRowRelation } from './org-session-marks.tsx'

export type { OrgPanelInjected, OrgPanelProps } from './OrgPanel.tsx'
export { OrgPanel } from './OrgPanel.tsx'
export type { OrgPanelModel } from './org-panel-model.ts'
export { orgPanelModel, orgSessionMark } from './org-panel-model.ts'
export type { OrgSessionMark } from './org-panel-model.ts'
export type { OrgSessionRowProps } from './org-session-marks.tsx'
export { OrgSessionRowMark, OrgSessionRowRelation } from './org-session-marks.tsx'

/** Required services: the slot registry and the command Remote. */
export const inject = ['slots', 'remote', 'remote.commands']

/** The admission-shaped result of one slash-command execution. */
interface CommandAdmission {
  ok: boolean
  error?: { message: string; code: string }
  value?: unknown
}

/**
 * Execute one slash command for the owning session. 0.2.1's published
 * `commands/execute` Remote requires `(agentId, line, submittedAttachments
 * [, signal])`; the panel has no attachments, but the batch is still required
 * (omitting it fails client-side arity validation).
 * @param ctx - the client plugin context (holds the Remote).
 * @param sessionId - the session whose agent runs the command.
 * @param command - the full slash line (e.g. `/org relinquish s-123`).
 * @returns null on admitted execution; a user-visible failure line otherwise.
 */
async function executeCommand(ctx: Context, sessionId: SessionId, command: string): Promise<string | null> {
  const execute = ctx.remote.commands.execute as unknown as (
    agentId: SessionId,
    line: string,
    submittedAttachments: readonly unknown[],
  ) => Promise<CommandAdmission>
  const result = await execute(sessionId, command, [])
  if (!result.ok) return `${result.error?.message ?? 'command failed'} (${result.error?.code ?? 'unknown'})`
  if (result.value === undefined) return `unknown command: ${command}`
  return null
}

/**
 * Client plugin body: register the organisation panel over the command
 * channel. One list entry with an inject face closing over `ctx.remote.commands`
 * for the session the dock renders for.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'org',
    // Between the todo strip (0) and the queue dock (20): organisation state
    // sits above the transient queue.
    order: 10,
    inject: (sessionId: SessionId) => ({
      runCommand: (command: string) => executeCommand(ctx, sessionId, command),
    }),
  }, OrgPanel))
  // Global session list: mark who manages each session (or an orphaned lead).
  // The 16px leading cell carries a dot; the hover card carries the full text.
  // Both seats are declared by ui-workspace, so registration waits for them.
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading',
    id: 'org-relation',
    order: 20,
  }, OrgSessionRowMark))
  ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
    name: 'sidebar.session.row.hover',
    id: 'org-relation',
    order: 20,
  }, OrgSessionRowRelation))
}

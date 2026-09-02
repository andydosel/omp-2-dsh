/**
 * dsh-vibe-mode browser half: the worker dock (`conversation.input.dock`
 * seat — the full-width row above the composer card, QueueDock/TodoPanel
 * posture) and the DIRECTOR-instructions settings page
 * (`settings.section` seat, id `vibe-director`).
 *
 * The dock reads the host-computed `vibeWorkers` projection
 * (`useProjection`, zero client-side folding), opens worker sessions through
 * `ctx.sessions`, and remembers the director session id in module panel
 * state so a worker session can offer "返回主会话". The settings page binds
 * the `dsh-vibe-mode` namespace through `ctx.settingsScope` and writes the
 * `section` field — the host api-proxy whitelist (annex worker) is what
 * exposes that namespace to the browser.
 *
 * @module @dsh-plugin/dsh-vibe-mode/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input dock seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the settings.section SlotMap merge and ctx.settingsScope.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the vibeWorkers SessionProjectionMap merge.
import type {} from '../../src/types.ts'
import { WorkerDock } from './dock/WorkerDock.tsx'
import type { WorkerDockInjected } from './dock/WorkerDock.tsx'
import { DirectorSection } from './settings/DirectorSection.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'sessions', 'settingsScope']

/**
 * Module-level panel state: the director session id last seen by the dock.
 * The dock records it whenever it renders a non-worker session with a
 * non-empty roster; a worker session's dock reads it for "返回主会话".
 */
let rememberedDirectorSessionId: string | undefined

/** Record the director session id on the panel state. */
export function rememberDirector(sessionId: string): void {
  rememberedDirectorSessionId = sessionId
}

/** The remembered director session id, if any. */
export function directorOf(): string | undefined {
  return rememberedDirectorSessionId
}

/**
 * Client plugin body: register the worker dock and the settings page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'vibe-workers',
    order: 30,
    inject: (): WorkerDockInjected => ({
      openSession: (id: string) => { ctx.sessions.open(id as SessionId) },
      parentOf: (id: string) => ctx.sessions.subagentAddress(id as SessionId)?.parentSessionId,
      rememberedDirector: () => rememberedDirectorSessionId,
      rememberDirector,
    }),
  }, WorkerDock))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'vibe-director',
    order: 25,
    label: () => 'Vibe 指令',
    inject: () => ({ scope: ctx.settingsScope.bind({ namespace: 'dsh-vibe-mode' }) }),
  }, DirectorSection))
}

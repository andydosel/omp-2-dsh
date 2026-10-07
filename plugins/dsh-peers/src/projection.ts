/**
 * The `peers` session-projection unit: the inbox of messages addressed to one
 * session, folded from the target session's own `peer/message` events. Host
 * state and wire value are the same JSON array, so clients receive the inbox
 * verbatim (the fold already reuses its reference unless a `peer/message`
 * event changed it — the registry's `Object.is` gate).
 *
 * This package ships no browser face (`dsh.client`): the served array is the
 * full client contract, and an inbox renderer belongs with the session UI that
 * consumes it.
 *
 * @module @dsh-plugin/dsh-peers/projection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { applyPeerEvent } from './inbox.ts'
import { isPeerMessageSnapshot } from './types.ts'
import type { PeerMessageSnapshot } from './types.ts'

/**
 * Validate one snapshot with the real runtime guard. zod cannot express a
 * `ContentBlock[]` structurally, so the guard checks the fields the fold and
 * the service depend on and leaves the block array opaque.
 */
export const peerMessageSchema = zod.custom<PeerMessageSnapshot>(isPeerMessageSnapshot)

/** Validate the whole persisted inbox. The cast is the mode-ui precedent: zod's array output type is structurally the same but not assignable nominally. */
export const peersStateSchema = zod.array(peerMessageSchema) as unknown as ZodType<PeerMessageSnapshot[]>

/** The wire schema reuses the state schema: the served value IS the folded inbox. */
export const peersViewSchema = peersStateSchema as unknown as ZodType<PeerMessageSnapshot[]>

/**
 * State → wire payload. Returning the fold state reference is intentional: the
 * registry compares the raw view result with `Object.is`, and the fold already
 * reuses its reference unless a `peer/message` event changed it.
 * @param state - the current inbox.
 * @returns the inbox as served to clients.
 */
export function viewPeers(state: PeerMessageSnapshot[]): PeerMessageSnapshot[] {
  return state
}

/** The `peers` projection unit, registered on `ctx.sessionProjections`. */
export const peersProjection = {
  key: 'peers',
  stateSchema: peersStateSchema,
  init: () => [],
  apply: applyPeerEvent,
  wire: { viewSchema: peersViewSchema, view: viewPeers },
  stateVersion: 1,
} satisfies ProjectionDefinition<'peers', PeerMessageSnapshot[]>

/**
 * Register the `peers` unit. The projection registry is an optional seam (the
 * unit activates only when a `sessionProjections` provider is composed).
 * @param ctx - the plugin context.
 */
export function registerPeersProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(peersProjection)
  })
}

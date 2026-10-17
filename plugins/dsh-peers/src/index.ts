/**
 * dsh-peers: the peer channel between live sessions
 * (DESIGN-COORDINATOR-SUITE.md §5.1/§5.6/§5.9/§5.10/§13.6).
 *
 * One durable `peer/message` event, appended to the TARGET session's log (that
 * log IS the inbox), one `ctx.peers` send/list service with a self-built
 * `senderId+messageId` dedupe key, one `peers` projection, and one global
 * `peer_send` tool. The channel is meaningful without any session org: a
 * coordinator (secretary) may address any session it has not forbidden, while
 * every other session may address only its manager, a session it manages, or a
 * durable ancestor/descendant; `dsh-org` only layers a role envelope (the
 * `tools.restrict` allow-mask plus a structural `isForbidden` probe) on top,
 * and is never imported here.
 *
 * @module @dsh-plugin/dsh-peers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { PeersService, type PeersConfig } from './service.ts'

/** The plugin's cordis runtime name. */
export const name = 'dsh-peers'

export { Config, PeersService, PeerSendError, resolvePeersConfig, snapshotText, renderPeerMessage, deliveryMessage } from './service.ts'
export type { PeersConfig, ResolvedPeersConfig, PeerSendErrorCode } from './service.ts'
export { PEER_SEND_TOOL, definePeerSendTool } from './tool.ts'
export type { PeerSendValue } from './tool.ts'
export { registerPeersProjection, peersProjection, viewPeers, peersStateSchema, peersViewSchema, peerMessageSchema } from './projection.ts'
export { applyPeerEvent, foldPeerInbox, listMessages, findMessage, hasKey } from './inbox.ts'
// The `peer/message` SessionEventMap merge and the two projection-table merges
// live in src/types.ts (their one home); this re-export keeps the module edge
// in the emitted index.d.ts, so aggregate programs consuming the declarations
// still receive them.
export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    peers: PeersService
  }
}

// The plugin's own message-source kind: a `wakeup` delivery is announced to the
// target as `{ kind: 'dsh-peers', form: 'notice', … }`.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-peers': { kind: 'dsh-peers' } & ContextFormed
  }
}

export default PeersService

/**
 * Function-shaped entry equivalent to the default Service export. cordis
 * instantiates the default export (a `Service` class) with the row's config;
 * this exists for callers that mount the plugin explicitly.
 * @param ctx - the plugin context.
 * @param config - the raw configuration.
 * @returns the constructed service.
 */
export function apply(ctx: Context, config: PeersConfig = {}): PeersService {
  return new PeersService(ctx, config)
}

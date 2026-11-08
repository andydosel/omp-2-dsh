/**
 * The `wechatChannel` session projection: the host-computed value behind the
 * session-header WECHAT badge.
 *
 * This unit used to live in dsh-mode-ui. It ships with the channel now so the
 * badge, the `wechat` service and the fold that feeds them are one installable
 * package — installing dsh-channel-wechat alone is enough to get the badge.
 * The state is channel-global (not per-session): every session folds the same
 * live adapter status, exactly like the mode-ui unit did.
 *
 * @module @dsh-plugin/dsh-channel-wechat/status-projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { WechatChannelProjection, WechatChannelUnitState } from './types.ts'

export type { WechatChannelProjection, WechatChannelUnitState } from './types.ts'

/** Structural probe for the channel service this plugin provides. */
export interface WechatProbe {
  status(): { connected: boolean; account?: string }
}

const wechatChannelSchema = zod.object({
  connected: zod.boolean(),
  account: zod.string().optional(),
}) as ZodType<WechatChannelProjection>

/**
 * Project one unit state into its browser-visible wire value. The account key
 * is dropped while undefined so the wire payload carries no `account: undefined`
 * sentinel.
 * @param state - the folded unit state.
 * @returns the wire-visible projection.
 */
export function viewWechatChannel(state: WechatChannelUnitState): WechatChannelProjection {
  return state.account === undefined
    ? { connected: state.connected }
    : { connected: state.connected, account: state.account }
}

/**
 * Register the `wechatChannel` projection unit (composition-conditional on the
 * `sessionProjections` service). The fold reads this plugin's own `wechat`
 * service, which apply() provides after building the adapter — hence the
 * service is resolved lazily inside `apply`, not at registration time.
 * @param ctx - the plugin context.
 */
export function registerWechatStatusProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const read = (): { connected: boolean; account?: string } =>
      (ctx.get('wechat') as WechatProbe | undefined)?.status() ?? { connected: false }

    projectionCtx.sessionProjections.register<'wechatChannel', WechatChannelUnitState>({
      key: 'wechatChannel',
      stateSchema: wechatChannelSchema,
      init: () => ({ connected: false }),
      apply: (state) => {
        const next = read()
        return next.connected === state.connected && next.account === state.account ? state : next
      },
      wire: { viewSchema: wechatChannelSchema, view: viewWechatChannel },
      stateVersion: 1,
    })
  })
}

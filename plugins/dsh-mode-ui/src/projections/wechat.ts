/**
 * `wechatChannel` projection unit: the read-side view. The `apply` transition
 * is re-sourced in `src/index.ts` to read the sibling dsh-channel-wechat
 * adapter status (the connected/account state is plugin-owned, not a session
 * event).
 *
 * @module @dsh-plugin/dsh-mode-ui/projections/wechat
 */

import type { WechatChannelProjection, WechatChannelUnitState } from '../types.ts'

export type { WechatChannelUnitState } from '../types.ts'

/** State → wire payload (the read-side projection). */
export function viewWechatChannel(state: WechatChannelUnitState): WechatChannelProjection {
  return state.account === undefined ? { connected: state.connected } : { connected: state.connected, account: state.account }
}

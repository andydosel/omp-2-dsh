/**
 * `wechatChannel` projection unit: folds the `wechat/channel` whole-value
 * events dsh-channel-wechat appends on connect/disconnect/account change.
 * `account` is carried only when the channel reports one (the single-account
 * adapter always does). Pure mathematics only.
 *
 * @module @dsh-plugin/dsh-mode-ui/projections/wechat
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls dsh-channel-wechat's SessionEventMap merge
// (`wechat/channel`).
import type {} from '@dsh-plugin/dsh-channel-wechat'
import type { WechatChannelProjection } from '../types.ts'

/** Fold state of the wechatChannel unit. */
export interface WechatChannelUnitState {
  connected: boolean
  account?: string
}

/**
 * Pure transition: whole-value replace on `wechat/channel`; any other event
 * returns the same state reference (zero downstream work). An absent
 * `account` drops the previous one (whole-value semantics).
 */
export function applyWechatChannelEvent(state: WechatChannelUnitState, event: SessionEvent): WechatChannelUnitState {
  if (event.type !== 'wechat/channel') return state
  const { connected, account } = event.data
  if (account === undefined) {
    return connected === state.connected && state.account === undefined
      ? state
      : { connected }
  }
  return connected === state.connected && account === state.account ? state : { connected, account }
}

/** State → wire payload (the read-side projection). */
export function viewWechatChannel(state: WechatChannelUnitState): WechatChannelProjection {
  return state.account === undefined ? { connected: state.connected } : { connected: state.connected, account: state.account }
}

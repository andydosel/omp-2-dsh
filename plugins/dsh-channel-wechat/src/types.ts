/**
 * WeChat channel domain types.
 *
 * Plugin-only rework: the `wechat/channel` session event is gone — the
 * channel-global connected/account state is plugin-owned (live on the adapter)
 * and surfaced through the `wechatChannel` projection, not a session event.
 *
 * @module @dsh-plugin/dsh-channel-wechat/types
 */

/** The WeChat channel's whole value (connected flag + account). */
export interface WechatChannelEvent {
  connected: boolean
  account?: string
}

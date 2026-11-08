/**
 * WeChat channel domain types.
 *
 * The `wechatChannel` session projection is owned by this package end to end:
 * the host runtime publishes the channel-global state through the `wechat`
 * Context service, src/status-projection.ts registers the projection unit that
 * folds it, and the header badge shipped in client/ reads the wire value. The
 * `SessionProjectionMap` merge therefore lives here, next to the state it
 * describes.
 *
 * The `wechat/channel` session event is gone — the channel-global
 * connected/account state is plugin-owned (live on the adapter), never a
 * session event.
 *
 * @module @dsh-plugin/dsh-channel-wechat/types
 */

/** The WeChat channel's whole value (connected flag + account). */
export interface WechatChannelEvent {
  connected: boolean
  account?: string
}

/** Browser-visible WeChat channel state folded from this plugin's runtime state. */
export interface WechatChannelProjection {
  connected: boolean
  account?: string
}

/** Host fold state of the `wechatChannel` unit. State and wire value share one shape. */
export interface WechatChannelUnitState {
  connected: boolean
  account?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    wechatChannel: WechatChannelProjection
  }

  interface SessionProjectionStateMap {
    wechatChannel: WechatChannelUnitState
  }
}

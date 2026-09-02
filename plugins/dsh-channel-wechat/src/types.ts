/**
 * Session-event type declarations of the WeChat channel domain.
 *
 * `wechat/channel` is appended by the adapter (src/adapter.ts) on
 * connect/disconnect; `account` names the iLink account (single account in
 * v1). The projection unit in @dsh-plugin/dsh-mode-ui folds it per-session.
 * Like the sibling mode events, it is log-only and non-surface: the model
 * never sees it, the client projection does.
 *
 * NOTE ON PERSISTENCE CATALOG: this standalone out-of-tree plugin consumes
 * the event only from OUR code, so no persistence catalog regeneration is
 * needed.
 *
 * @module @dsh-plugin/dsh-channel-wechat/types
 */

/** Whole-value payload of the `wechat/channel` session event. */
export interface WechatChannelEvent {
  connected: boolean
  account?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The WeChat channel's whole value: whether the poll loop is running and
     * which account it runs under. Log-only, non-surface, whole-value
     * replace — the last `wechat/channel` wins; a log with none folds to
     * disconnected. Appended on connect/disconnect (and on account change,
     * future multi-account adapters).
     */
    'wechat/channel': WechatChannelEvent
  }
}

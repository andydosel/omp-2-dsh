/**
 * Pure types of the mode-status domain: the ONE home of the four
 * projection-key declarations (`compactMode` / `vibeMode` / `advisorStatus` /
 * `wechatChannel`), free of this package's host-side value imports. The
 * projection units in `src/projections/` and the client badges both read
 * this single table; the declaration merge lands every key in
 * `SessionProjectionMap`, so `useProjection('compactMode')` is typed for
 * client code.
 *
 * @module @dsh-plugin/dsh-mode-ui/types
 */

/** Compact-mode state folded from `compact/mode` events (whole-value replace). */
export interface CompactModeProjection {
  active: boolean
}

/** Vibe-mode state folded from `vibe/mode` events (whole-value replace). */
export interface VibeModeProjection {
  active: boolean
}

/** Advisor state folded from `advisor/status` events (whole-value replace). */
export interface AdvisorStatusProjection {
  enabled: boolean
  reviewers: number
}

/** WeChat channel state folded from `wechat/channel` events (whole-value replace). */
export interface WechatChannelProjection {
  connected: boolean
  account?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Compact-mode collaboration state folded from `compact/mode` events. */
    compactMode: CompactModeProjection
    /** Vibe-mode collaboration state folded from `vibe/mode` events. */
    vibeMode: VibeModeProjection
    /** Advisor runtime state folded from `advisor/status` events. */
    advisorStatus: AdvisorStatusProjection
    /** WeChat channel state folded from `wechat/channel` events. */
    wechatChannel: WechatChannelProjection
  }
}

/**
 * Pure types of the mode-status domain: the ONE home of the three
 * projection-key declarations (`compactMode` / `advisorStatus` /
 * `wechatChannel`), free of this package's host-side value imports. The
 * projection units in `src/projections/` and the client badges both read
 * this single table; the declaration merges land every key in both
 * `SessionProjectionMap` (client wire) and `SessionProjectionStateMap`
 * (host fold state), so `useProjection('compactMode')` is typed for client
 * code and the host register call is typed end to end.
 *
 * @module @dsh-plugin/dsh-mode-ui/types
 */

/** Compact-mode state folded from the sibling plugin's runtime state (whole-value replace). */
export interface CompactModeProjection {
  active: boolean
}

/** Advisor state folded from the sibling plugin's runtime state (whole-value replace). */
export interface AdvisorStatusProjection {
  enabled: boolean
  reviewers: number
}

/** WeChat channel state folded from the sibling plugin's runtime state (whole-value replace). */
export interface WechatChannelProjection {
  connected: boolean
  account?: string
}

/** Host fold state of the `compactMode` unit. State and wire value are the same shape. */
export interface CompactModeUnitState {
  active: boolean
}

/** Host fold state of the `advisorStatus` unit. State and wire value are the same shape. */
export interface AdvisorStatusUnitState {
  enabled: boolean
  reviewers: number
}

/** Host fold state of the `wechatChannel` unit. State and wire value are the same shape. */
export interface WechatChannelUnitState {
  connected: boolean
  account?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Compact-mode collaboration state folded from the sibling plugin's runtime state. */
    compactMode: CompactModeProjection
    /** Advisor runtime state folded from the sibling plugin's runtime state. */
    advisorStatus: AdvisorStatusProjection
    /** WeChat channel state folded from the sibling plugin's runtime state. */
    wechatChannel: WechatChannelProjection
  }

  interface SessionProjectionStateMap {
    /** Compact-mode host fold state. */
    compactMode: CompactModeUnitState
    /** Advisor host fold state. */
    advisorStatus: AdvisorStatusUnitState
    /** WeChat channel host fold state. */
    wechatChannel: WechatChannelUnitState
  }
}

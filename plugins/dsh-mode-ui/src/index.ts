/**
 * dsh-mode-ui host half: registers the four mode-status projection units
 * (`compactMode`, `vibeMode`, `advisorStatus`, `wechatChannel`) on
 * `ctx.sessionProjections`. The `apply` transitions read the sibling plugins'
 * plugin-owned state through their Context services (the mode flags and
 * statuses are no longer session events), and the unit child activates only
 * when a projection registry is composed.
 *
 * The browser half (`client/src/`) is a separate `dsh.client` face of this
 * same package — see the package.json `dsh.client` declaration and
 * `exports["./client"]`.
 *
 * @module @dsh-plugin/dsh-mode-ui
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
import { viewCompactMode, type CompactModeUnitState } from './projections/compact.ts'
import { viewVibeMode, type VibeModeUnitState } from './projections/vibe.ts'
import { viewAdvisorStatus, type AdvisorStatusUnitState } from './projections/advisor.ts'
import { viewWechatChannel, type WechatChannelUnitState } from './projections/wechat.ts'
import type {
  AdvisorStatusProjection,
  CompactModeProjection,
  VibeModeProjection,
  WechatChannelProjection,
} from './types.ts'

export type {
  AdvisorStatusProjection,
  CompactModeProjection,
  VibeModeProjection,
  WechatChannelProjection,
} from './types.ts'

export { viewCompactMode } from './projections/compact.ts'
export type { CompactModeUnitState } from './projections/compact.ts'
export { viewVibeMode } from './projections/vibe.ts'
export type { VibeModeUnitState } from './projections/vibe.ts'
export { viewAdvisorStatus } from './projections/advisor.ts'
export type { AdvisorStatusUnitState } from './projections/advisor.ts'
export { viewWechatChannel } from './projections/wechat.ts'
export type { WechatChannelUnitState } from './projections/wechat.ts'

/** The plugin's cordis runtime name. */
export const name = 'dsh-mode-ui'

/** Structural probe for a sibling mode store (compact-mode / vibe-mode). */
interface ModeStoreProbe {
  store: { current(): { active: boolean } }
}

/** Structural probe for the sibling advisor runtime. */
interface AdvisorProbe {
  runtime: { status(): { enabled: boolean; reviewers: number } }
}

/** Structural probe for the sibling wechat channel. */
interface WechatProbe {
  status(): { connected: boolean; account?: string }
}

/** Wire payload schemas of the four projections (validated before leaving the host). */
const compactModeSchema: ZodType<CompactModeProjection> = zod.object({ active: zod.boolean() })
const vibeModeSchema: ZodType<VibeModeProjection> = zod.object({ active: zod.boolean() })
const advisorStatusSchema: ZodType<AdvisorStatusProjection> = zod.object({
  enabled: zod.boolean(),
  reviewers: zod.number().int().nonnegative(),
})
// `account` is optional on the wire (the single-account adapter always
// carries it; the schema allows a future anonymous channel). The annotation
// keeps the wire value's optionality exact.
const wechatChannelSchema = zod.object({
  connected: zod.boolean(),
  account: zod.string().optional(),
}) as ZodType<WechatChannelProjection>

/**
 * Host plugin body: register the four projection units. Each `apply` re-reads
 * the sibling plugin's state on every committed event and returns the same
 * reference when unchanged (the registry's Object.is gate), so the badges
 * re-sync to plugin state without any session event.
 * @param ctx - host root context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const registry = projectionCtx.sessionProjections

    // Sibling state readers — process-global getters (the projections are
    // session-agnostic; the runtime narrowing/mutex stays per-session in the
    // sibling plugins).
    const compactActive = (): boolean =>
      (ctx.get('compactMode') as ModeStoreProbe | undefined)?.store.current().active ?? false
    const vibeActive = (): boolean =>
      (ctx.get('vibeMode') as ModeStoreProbe | undefined)?.store.current().active ?? false
    const advisorStatus = (): { enabled: boolean; reviewers: number } =>
      (ctx.get('advisor') as AdvisorProbe | undefined)?.runtime.status() ?? { enabled: false, reviewers: 0 }
    const wechatStatus = (): { connected: boolean; account?: string } =>
      (ctx.get('wechat') as WechatProbe | undefined)?.status() ?? { connected: false }

    registry.register<'compactMode', CompactModeUnitState>({
      key: 'compactMode',
      stateSchema: compactModeSchema,
      init: () => ({ active: false }),
      apply: (state) => {
        const active = compactActive()
        return active === state.active ? state : { active }
      },
      wire: { viewSchema: compactModeSchema, view: viewCompactMode },
      stateVersion: 1,
    })
    registry.register<'vibeMode', VibeModeUnitState>({
      key: 'vibeMode',
      stateSchema: vibeModeSchema,
      init: () => ({ active: false }),
      apply: (state) => {
        const active = vibeActive()
        return active === state.active ? state : { active }
      },
      wire: { viewSchema: vibeModeSchema, view: viewVibeMode },
      stateVersion: 1,
    })
    registry.register<'advisorStatus', AdvisorStatusUnitState>({
      key: 'advisorStatus',
      stateSchema: advisorStatusSchema,
      init: () => ({ enabled: false, reviewers: 0 }),
      apply: (state) => {
        const next = advisorStatus()
        return next.enabled === state.enabled && next.reviewers === state.reviewers ? state : next
      },
      wire: { viewSchema: advisorStatusSchema, view: viewAdvisorStatus },
      stateVersion: 1,
    })
    registry.register<'wechatChannel', WechatChannelUnitState>({
      key: 'wechatChannel',
      stateSchema: wechatChannelSchema,
      init: () => ({ connected: false }),
      apply: (state) => {
        const next = wechatStatus()
        return next.connected === state.connected && next.account === state.account ? state : next
      },
      wire: { viewSchema: wechatChannelSchema, view: viewWechatChannel },
      stateVersion: 1,
    })
  })
}

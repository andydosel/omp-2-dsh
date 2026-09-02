/**
 * dsh-mode-ui host half: registers the four mode-status projection units
 * (`compactMode`, `vibeMode`, `advisorStatus`, `wechatChannel`) on
 * `ctx.sessionProjections`, following the rc.2 ProjectionDefinition shape
 * (key/stateSchema/init/apply/wire/stateVersion). The unit child activates
 * only when a projection registry is composed, so headless assemblies
 * without the registry stay unaffected.
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
import { applyCompactModeEvent, viewCompactMode, type CompactModeUnitState } from './projections/compact.ts'
import { applyVibeModeEvent, viewVibeMode, type VibeModeUnitState } from './projections/vibe.ts'
import { applyAdvisorStatusEvent, viewAdvisorStatus, type AdvisorStatusUnitState } from './projections/advisor.ts'
import { applyWechatChannelEvent, viewWechatChannel, type WechatChannelUnitState } from './projections/wechat.ts'
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

export { applyCompactModeEvent, viewCompactMode } from './projections/compact.ts'
export type { CompactModeUnitState } from './projections/compact.ts'
export { applyVibeModeEvent, viewVibeMode } from './projections/vibe.ts'
export type { VibeModeUnitState } from './projections/vibe.ts'
export { applyAdvisorStatusEvent, viewAdvisorStatus } from './projections/advisor.ts'
export type { AdvisorStatusUnitState } from './projections/advisor.ts'
export { applyWechatChannelEvent, viewWechatChannel } from './projections/wechat.ts'
export type { WechatChannelUnitState } from './projections/wechat.ts'

/** The plugin's cordis runtime name. */
export const name = 'dsh-mode-ui'

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
 * Host plugin body: register the four projection units over the session log.
 * @param ctx - host root context.
 */
export function apply(ctx: Context): void {
  // The unit child activates only when a projection registry is composed
  // (plan-mode precedent).
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const registry = projectionCtx.sessionProjections
    registry.register<'compactMode', CompactModeUnitState>({
      key: 'compactMode',
      stateSchema: compactModeSchema,
      init: () => ({ active: false }),
      apply: applyCompactModeEvent,
      wire: { viewSchema: compactModeSchema, view: viewCompactMode },
      stateVersion: 1,
    })
    registry.register<'vibeMode', VibeModeUnitState>({
      key: 'vibeMode',
      stateSchema: vibeModeSchema,
      init: () => ({ active: false }),
      apply: applyVibeModeEvent,
      wire: { viewSchema: vibeModeSchema, view: viewVibeMode },
      stateVersion: 1,
    })
    registry.register<'advisorStatus', AdvisorStatusUnitState>({
      key: 'advisorStatus',
      stateSchema: advisorStatusSchema,
      init: () => ({ enabled: false, reviewers: 0 }),
      apply: applyAdvisorStatusEvent,
      wire: { viewSchema: advisorStatusSchema, view: viewAdvisorStatus },
      stateVersion: 1,
    })
    registry.register<'wechatChannel', WechatChannelUnitState>({
      key: 'wechatChannel',
      stateSchema: wechatChannelSchema,
      init: () => ({ connected: false }),
      apply: applyWechatChannelEvent,
      wire: { viewSchema: wechatChannelSchema, view: viewWechatChannel },
      stateVersion: 1,
    })
  })
}

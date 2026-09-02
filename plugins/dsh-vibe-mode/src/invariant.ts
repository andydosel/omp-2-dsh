/**
 * Package-owned durable vibe-mode invariants.
 *
 * Plugin-only rework: the plugin no longer appends `vibe/mode` / `vibe/workers`
 * session events (the active flag and worker roster live in the plugin-owned
 * store), so there are no custom session events left to validate. The companion
 * still registers with the invariants service (a package that declares
 * `./invariant` must provide the companion contract), but its installer is a
 * no-op.
 *
 * @module @dsh-plugin/dsh-vibe-mode/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-plugin/dsh-vibe-mode'

/** Cordis companion plugin name. */
export const name = 'vibe-mode-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install a no-op invariant companion: plugin-owned state carries no session
 * events, so nothing needs validation.
 */
const install: InvariantInstaller = Object.assign(() => {}, { inject: [] })

/**
 * Register the vibe-mode invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

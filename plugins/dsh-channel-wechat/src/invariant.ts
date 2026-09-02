/**
 * Package-owned runtime invariants for dsh-channel-wechat.
 *
 * Companion plugin loaded beside `@deepseek-ai/dsh-invariants` (dsh package
 * convention: each package registers its checks from a `./invariant`
 * companion; ordinary entrypoints stay independent). The checks are the
 * plugin's configuration invariants — strict keys, policy enums, token
 * shape, and deployment preconditions — so a typo'd config fails loudly at
 * load time instead of mid-poll with confusing protocol errors.
 *
 * The same pure validators are also called directly from the main plugin's
 * `apply`, so misconfiguration fails fast even when the companion is not
 * mounted.
 * @module @dsh-plugin/dsh-channel-wechat/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure } from '@deepseek-ai/dsh-invariants'
import type { Config } from './config.ts'
import { assertStrictConfigKeys, resolveStateDir } from './config.ts'
import { DM_POLICIES, GROUP_POLICIES } from './invariant-values.ts'

/** Cordis companion plugin name. */
export const name = 'dsh-channel-wechat-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Companion entry: validates the same config block the main plugin loads. */
export function apply(ctx: Context, config: Record<string, unknown>): () => void {
  return ctx.invariants.register(
    '@dsh-plugin/dsh-channel-wechat',
    (invariantCtx: Context, fail: InvariantFailure) => {
      validateConfig(config, fail)
    },
  )
}

/**
 * Validate a raw (pre-schema) config object against plugin invariants.
 * @param config - raw config object as written by the user.
 * @param fail - invariant failure reporter bound to this package.
 */
export function validateConfig(config: Record<string, unknown>, fail: InvariantFailure): void {
  try {
    assertStrictConfigKeys(config)
  } catch (error) {
    const message = (error as Error).message
    fail(message.replace(/^dsh-channel-wechat: /, ''))
    return
  }

  if (config.dmPolicy !== undefined && !DM_POLICIES.has(String(config.dmPolicy))) {
    fail(`dmPolicy must be one of ${[...DM_POLICIES].join('|')}, got "${config.dmPolicy}"`)
  }
  if (config.groupPolicy !== undefined && !GROUP_POLICIES.has(String(config.groupPolicy))) {
    fail(`groupPolicy must be one of ${[...GROUP_POLICIES].join('|')}, got "${config.groupPolicy}"`)
  }
  if (config.longPollTimeoutMs !== undefined && Number(config.longPollTimeoutMs) < 1000) {
    fail('longPollTimeoutMs must be >= 1000ms')
  }
  if (config.sendChunkRetries !== undefined && Number(config.sendChunkRetries) < 0) {
    fail('sendChunkRetries must be >= 0')
  }
  const accountId = String(config.accountId ?? '').trim()
  const token = String(config.token ?? '').trim()
  if (accountId && token && !token.startsWith(accountId)) {
    fail('token must be "{account_id}:{secret}" (should start with accountId)')
  }
}

/**
 * Enforce deployment preconditions that must hold before the poll loop
 * starts (mirrors hermes `connect()` failures for missing token/account).
 * @param config - resolved plugin config.
 * @param fail - failure reporter (throws in the main plugin).
 * @param env - environment access (injectable for tests).
 */
export function assertDeployableConfig(
  config: Config,
  fail: (message: string) => never,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!config.accountId.trim()) {
    fail('accountId is required (e.g. "c5610f3ce386@im.bot")')
  }
  if (!config.token.trim()) {
    fail('token is required ("{account_id}:{secret}")')
  }
  if (config.dmPolicy === 'allowlist' && config.allowedUsers.length === 0) {
    fail('dmPolicy "allowlist" requires at least one allowedUsers entry')
  }
  if (config.groupPolicy === 'allowlist' && config.groupAllowedUsers.length === 0) {
    fail('groupPolicy "allowlist" requires at least one groupAllowedUsers entry')
  }
  const stateDir = resolveStateDir(config, env)
  if (!stateDir) {
    fail('stateDir is empty and $DSH_HOME is not set — cannot persist state')
  }
}

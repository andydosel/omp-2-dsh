/**
 * Package-owned config checks for dsh-channel-wechat.
 *
 * The checks are the plugin's configuration invariants — strict keys, policy
 * enums, token shape, and deployment preconditions — so a typo'd config fails
 * loudly at load time instead of mid-poll with confusing protocol errors.
 *
 * These validators are pure (they report through a caller-supplied `fail`
 * callback) and are called directly from the main plugin's `apply`. The
 * `apply` exported here is the standalone loud-fail entry: it runs the same
 * checks and throws, instead of registering with the retired runtime invariant
 * registry (removed upstream in 0.2.1).
 * @module @dsh-plugin/dsh-channel-wechat/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { assertStrictConfigKeys, resolveStateDir } from './config.ts'
import { DM_POLICIES, GROUP_POLICIES } from './invariant-values.ts'

/** Cordis companion plugin name. */
export const name = 'dsh-channel-wechat-invariant'

/** Standalone entry: validates the same config block the main plugin loads, throwing on any violation. */
export function apply(_ctx: Context, config: Record<string, unknown>): void {
  validateConfig(config, (message) => {
    throw new Error(`dsh-channel-wechat: ${message}`)
  })
}

/**
 * Validate a raw (pre-schema) config object against plugin invariants.
 * @param config - raw config object as written by the user.
 * @param fail - failure reporter bound to this package.
 */
export function validateConfig(config: Record<string, unknown>, fail: (message: string) => void): void {
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

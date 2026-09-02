/**
 * dsh-channel-wechat configuration: all fields, Schemastery schema, and
 * strict-key validation.
 *
 * Field set mirrors hermes's Weixin platform config surface
 * (WEIXIN_* env vars / `gateway.platforms.weixin.extra.*`, see
 * `gateway/config.py:1694-1735` and the design doc §5.5) plus the dsh-only
 * `stateDir` (design §5.5).
 * @module @dsh-plugin/dsh-channel-wechat/config
 */

import z from '@deepseek-ai/schemastery'

/** DM access policy (hermes `WEIXIN_DM_POLICY`). */
export type DmPolicy = 'open' | 'allowlist' | 'pairing' | 'disabled'

/** Group access policy (hermes `WEIXIN_GROUP_POLICY`). */
export type GroupPolicy = 'disabled' | 'open' | 'allowlist'

/** Plugin configuration. */
export interface Config {
  /** Master switch; `false` stops the poll loop and all I/O. */
  enabled: boolean
  /** iLink bot account id, e.g. `c5610f3ce386@im.bot` (`WEIXIN_ACCOUNT_ID`). */
  accountId: string
  /** iLink credential, `{account_id}:{secret}` (`WEIXIN_TOKEN`). */
  token: string
  /** iLink API base URL (`WEIXIN_BASE_URL`). */
  baseUrl: string
  /** WeChat media CDN base URL (`WEIXIN_CDN_BASE_URL`). */
  cdnBaseUrl: string
  /** DM access policy; `pairing` hands unknown users an 8-digit code. */
  dmPolicy: DmPolicy
  /** Allowlisted DM user ids (used when `dmPolicy: allowlist`). */
  allowedUsers: string[]
  /** Group access policy; groups are unreliable on iLink, default `disabled`. */
  groupPolicy: GroupPolicy
  /** Allowlisted group ids (used when `groupPolicy: allowlist`). */
  groupAllowedUsers: string[]
  /** Default delivery target for outbound pushes (tool/cron v1.2). */
  homeChannel: string
  /** Long-poll timeout for `getupdates` (server suggestion may override). */
  longPollTimeoutMs: number
  /** Delay between outbound text chunks (hermes default 1.5s). */
  sendChunkDelaySeconds: number
  /** Per-chunk send retries beyond the first attempt (hermes default 4). */
  sendChunkRetries: number
  /** Base delay between chunk retries; rate-limit backoff uses 3x this. */
  sendChunkRetryDelaySeconds: number
  /**
   * Legacy per-line bubble splitting; default `false` = compact delivery
   * (`WEIXIN_SPLIT_MULTILINE_MESSAGES`).
   */
  splitMultilineMessages: boolean
  /** Text debounce quiet period before dispatch (hermes default 3s). */
  textBatchDelaySeconds: number
  /** Debounce quiet period when the last chunk was >= 1800 chars (5s). */
  textBatchSplitDelaySeconds: number
  /** Isolate group sessions per participant (hermes default true). */
  groupSessionsPerUser: boolean
  /** Isolate thread sessions per participant (hermes default false). */
  threadSessionsPerUser: boolean
  /**
   * State root: `accounts/` (credentials/context-tokens/sync cursor) and
   * `pairing/` (approvals/pending/rate limits), hermes-compatible formats.
   * Empty = `$DSH_HOME/wechat`; may point at hermes's `weixin/` dir to
   * take over the same account's data.
   */
  stateDir: string
}

/** The set of accepted config keys, for strict-key validation. */
export const CONFIG_KEYS: readonly (keyof Config)[] = [
  'enabled', 'accountId', 'token', 'baseUrl', 'cdnBaseUrl', 'dmPolicy',
  'allowedUsers', 'groupPolicy', 'groupAllowedUsers', 'homeChannel',
  'longPollTimeoutMs', 'sendChunkDelaySeconds', 'sendChunkRetries',
  'sendChunkRetryDelaySeconds', 'splitMultilineMessages',
  'textBatchDelaySeconds', 'textBatchSplitDelaySeconds',
  'groupSessionsPerUser', 'threadSessionsPerUser', 'stateDir',
]

export const DEFAULT_STATE_DIR_NAME = 'wechat'

/** iLink protocol defaults (mirror `gateway/platforms/weixin.py:72-86`). */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  accountId: z.string().default(''),
  token: z.string().default(''),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  cdnBaseUrl: z.string().default(DEFAULT_CDN_BASE_URL),
  dmPolicy: z.union(['open', 'allowlist', 'pairing', 'disabled'] as const).default('pairing'),
  allowedUsers: z.array(z.string()).default([]),
  groupPolicy: z.union(['disabled', 'open', 'allowlist'] as const).default('disabled'),
  groupAllowedUsers: z.array(z.string()).default([]),
  homeChannel: z.string().default(''),
  longPollTimeoutMs: z.number().default(35_000),
  sendChunkDelaySeconds: z.number().default(1.5),
  sendChunkRetries: z.number().default(4),
  sendChunkRetryDelaySeconds: z.number().default(1.0),
  splitMultilineMessages: z.boolean().default(false),
  textBatchDelaySeconds: z.number().default(3.0),
  textBatchSplitDelaySeconds: z.number().default(5.0),
  groupSessionsPerUser: z.boolean().default(true),
  threadSessionsPerUser: z.boolean().default(false),
  stateDir: z.string().default(''),
})

/**
 * Reject unknown config keys loudly. Schemastery's object resolver merges
 * unknown keys by default (non-strict), so a typo like `dmPolicyy` would
 * otherwise pass silently and be ignored — the exact misconfiguration the
 * dsh playbook says must fail at load time.
 * @param input - raw config object before defaulting.
 * @returns the input unchanged when every key is known.
 * @throws on any unknown key.
 */
export function assertStrictConfigKeys(input: Record<string, unknown>): void {
  const known = new Set<string>(CONFIG_KEYS)
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new Error(
        `dsh-channel-wechat: unknown config key "${key}" (known: ${CONFIG_KEYS.join(', ')})`,
      )
    }
  }
}

/**
 * Resolve the effective state root: explicit `stateDir`, or
 * `$DSH_HOME/wechat` when empty.
 * @param config - resolved plugin config.
 * @param env - environment access (injectable for tests).
 */
export function resolveStateDir(
  config: Pick<Config, 'stateDir'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = config.stateDir.trim()
  if (raw) return raw
  return `${env.DSH_HOME ?? ''}${env.DSH_HOME ? '/' : ''}${DEFAULT_STATE_DIR_NAME}`
}

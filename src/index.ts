/**
 * dsh-channel-wechat: WeChat (Tencent iLink Bot / "ClawBot") channel plugin.
 *
 * A protocol driver: long-polls iLink `getupdates` for inbound messages,
 * maps each WeChat peer to a stable dsh agent session
 * (`weixin:dm:{userId}` / `weixin:group:{chatId}[:thread][:userId]`),
 * delivers inbound text via `agent.followup`, and renders assistant output
 * back as chunked WeChat messages (2000 chars / 1.5s, context_token echo,
 * -14 downgrade retry, -2 backoff, typing start/stop, media first).
 *
 * State files reuse hermes's formats (`accounts/`, `pairing/`) so `stateDir`
 * may point at a hermes `weixin/` directory to take over the same account.
 * @module @dsh-plugin/dsh-channel-wechat
 */

import type { Context } from '@deepseek-ai/cordis'
import { ILinkClient } from './ilink/client.ts'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { WeChatAdapter, chatIdFromSessionKey } from './adapter.ts'
import { WeChatSessionManager } from './session-map.ts'
import { WeChatOutbound } from './outbound.ts'
import { PairingStore } from './pairing.ts'
import { AccountStore, ContextTokenStore, SyncStore, resolvePairingDir } from './state.ts'
import { resolveStateDir } from './config.ts'
import { validateConfig, assertDeployableConfig } from './invariant.ts'
import { join } from 'node:path'

export { Config } from './config.ts'

export const name = 'dsh-channel-wechat'

/** Services required by the plugin. */
export const inject = ['agents', 'sessions']

/** Wire the WeChat channel: poll loop via ctx.effect + `/wechat` command. */
export function apply(ctx: Context, config: import('./config.ts').Config): void {
  // Loud config validation: strict keys, policy enums, numeric ranges,
  // token shape. Runs even without the dsh-invariants companion mounted.
  validateConfig(config as unknown as Record<string, unknown>, (message) => {
    throw new Error(`dsh-channel-wechat: ${message}`)
  })

  if (!config.enabled) return

  const fail = (message: string): never => {
    throw new Error(`dsh-channel-wechat: ${message}`)
  }
  const deployable = tryDeployableConfig(config, fail)
  if (!deployable) return

  const stateDir = resolveStateDir(config)
  const accountsDir = join(stateDir, 'accounts')
  const pairingDir = resolvePairingDir(stateDir)

  const accountStore = new AccountStore(accountsDir)
  const tokenStore = new ContextTokenStore(accountsDir)
  const syncStore = new SyncStore(accountsDir)
  tokenStore.restore(config.accountId)
  const pairingStore = new PairingStore(pairingDir)

  const logger = (message: string, ...args: unknown[]): void => {
    ctx.logger('wechat').info(message, ...args)
  }

  const client = new ILinkClient({
    baseUrl: config.baseUrl,
    token: config.token,
    cdnBaseUrl: config.cdnBaseUrl,
    longPollTimeoutMs: config.longPollTimeoutMs,
  })

  const outbound = new WeChatOutbound({
    client,
    tokenStore,
    options: {
      accountId: config.accountId,
      sendChunkDelaySeconds: config.sendChunkDelaySeconds,
      sendChunkRetries: config.sendChunkRetries,
      sendChunkRetryDelaySeconds: config.sendChunkRetryDelaySeconds,
      splitMultilineMessages: config.splitMultilineMessages,
    },
  })

  let adapter: WeChatAdapter | undefined
  const sessionManager = new WeChatSessionManager(ctx, {
    onAssistantMessage: (sessionId, text) => {
      adapter?.enqueueSend(chatIdFromSessionKey(sessionId), text)
    },
    onTurnStart: (sessionId) => {
      adapter?.enqueueTyping(chatIdFromSessionKey(sessionId), 'start')
    },
    onTurnEnd: (sessionId) => {
      adapter?.enqueueTyping(chatIdFromSessionKey(sessionId), 'stop')
    },
  })

  adapter = new WeChatAdapter({
    ctx,
    config,
    client,
    accountStore,
    tokenStore,
    syncStore,
    pairingStore,
    outbound,
    sessionManager,
    logger,
  })

  // The poll loop lives for the plugin's lifetime; the disposer stops it
  // gracefully (aborts the in-flight long poll, drains debounce queues and
  // per-peer send tails) and tears down the owned per-peer agents.
  ctx.effect(() => {
    adapter?.connect()
    return async () => {
      await adapter?.disconnect()
      await sessionManager.dispose()
    }
  }, 'dsh-channel-wechat.loop')

  // `/wechat` commands are composition-conditional: registered when the
  // commands service is mounted.
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'wechat',
      description: 'WeChat channel status, config, and DM pairing management',
      handler: (invocation) => handleWechatCommand(invocation.rawInput, {
        config,
        stateDir,
        adapter: adapter!,
        sessionManager,
        pairingStore,
        tokenStore,
        syncStore,
        accountId: config.accountId,
      }),
    })
  })
}

/** Guarded deployable-config check; mirrors hermes connect() failure handling (log + stay disconnected). */
function tryDeployableConfig(
  config: import('./config.ts').Config,
  fail: (message: string) => never,
): boolean {
  try {
    assertDeployableConfig(config, fail)
    return true
  } catch (error) {
    // The harness keeps running with the channel disabled, exactly like
    // hermes `connect()` returning False with a warning. The dsh-invariants
    // companion mounts the loud-fail variant.
    console.error(`[dsh-channel-wechat] startup skipped: ${(error as Error).message}`)
    return false
  }
}

/** Context passed to the `/wechat` command handler. */
export interface WechatCommandContext {
  config: import('./config.ts').Config
  stateDir: string
  adapter: WeChatAdapter
  sessionManager: WeChatSessionManager
  pairingStore: PairingStore
  tokenStore: ContextTokenStore
  syncStore: SyncStore
  accountId: string
}

/** Parse and run one `/wechat` command line (raw input after `/wechat`). */
export async function handleWechatCommand(rawInput: string, ctx: WechatCommandContext): Promise<CommandResult> {
  const parts = rawInput.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0]?.toLowerCase() ?? 'status'

  switch (sub) {
    case 'status': {
      const poll = ctx.adapter.pollState
      const pending = await ctx.pairingStore.listPending('weixin')
      const lines = [
        'WeChat (iLink) channel',
        `  account: ${ctx.accountId}`,
        `  stateDir: ${ctx.stateDir}`,
        `  poll: ${poll.running ? 'running' : 'stopped'}`,
        `  lastPollAt: ${poll.lastPollAt ? new Date(poll.lastPollAt).toISOString() : 'never'}`,
        `  consecutiveFailures: ${poll.consecutiveFailures}`,
        `  messagesProcessed: ${poll.messagesProcessed}`,
        `  lastError: ${poll.lastError ?? 'none'}`,
        `  sessions: ${ctx.sessionManager.size} (${ctx.sessionManager.managedSessionIds().join(', ') || '-'})`,
        `  contextTokens: ${ctx.tokenStore.size}`,
        `  pairing approved: ${ctx.pairingStore.listApproved('weixin').length}`,
        `  pairing pending: ${pending.length}`,
        `  dmPolicy: ${ctx.config.dmPolicy} | groupPolicy: ${ctx.config.groupPolicy}`,
        `  homeChannel: ${ctx.config.homeChannel || '-'}`,
      ]
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'config': {
      const c = ctx.config
      const lines = [
        `enabled: ${c.enabled}`,
        `accountId: ${c.accountId}`,
        `token: ${c.token ? `${c.token.slice(0, 8)}…` : '(empty)'}`,
        `baseUrl: ${c.baseUrl}`,
        `cdnBaseUrl: ${c.cdnBaseUrl}`,
        `dmPolicy: ${c.dmPolicy} (${c.allowedUsers.length} allowlisted)`,
        `groupPolicy: ${c.groupPolicy} (${c.groupAllowedUsers.length} allowlisted)`,
        `longPollTimeoutMs: ${c.longPollTimeoutMs}`,
        `sendChunkDelaySeconds: ${c.sendChunkDelaySeconds}`,
        `sendChunkRetries: ${c.sendChunkRetries}`,
        `splitMultilineMessages: ${c.splitMultilineMessages}`,
        `stateDir: ${ctx.stateDir}`,
      ]
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'pairing': {
      return handlePairingSubcommand(parts.slice(1), ctx)
    }
    default:
      return {
        kind: 'error',
        text: `Unknown /wechat subcommand "${sub}". Try: status, config, pairing approve <code>, pairing list, pairing pending, pairing revoke <user_id>, pairing clear-pending`,
      }
  }
}

async function handlePairingSubcommand(parts: string[], ctx: WechatCommandContext): Promise<CommandResult> {
  const sub = parts[0]?.toLowerCase()
  switch (sub) {
    case 'approve': {
      const code = parts[1] ?? ''
      if (!code) return { kind: 'error', text: 'Usage: /wechat pairing approve <8-char code>' }
      const result = await ctx.pairingStore.approveCode('weixin', code)
      if (result === undefined) {
        const locked = ctx.pairingStore.isLockedOut('weixin')
        return {
          kind: 'error',
          text: locked
            ? 'Pairing is locked out after too many failed attempts; try again later.'
            : 'Invalid or expired pairing code.',
        }
      }
      return { kind: 'success', text: `Approved ${result.user_name || result.user_id} (${result.user_id})` }
    }
    case 'list': {
      const approved = ctx.pairingStore.listApproved('weixin')
      if (approved.length === 0) return { kind: 'success', text: 'No approved users.' }
      const lines = approved.map((entry) => {
        const at = new Date(entry.approved_at * 1000).toISOString()
        return `  ${entry.user_id} (${entry.user_name}, approved ${at})`
      })
      return { kind: 'success', text: `Approved users:\n${lines.join('\n')}` }
    }
    case 'pending': {
      const pending = await ctx.pairingStore.listPending('weixin')
      if (pending.length === 0) return { kind: 'success', text: 'No pending pairing requests.' }
      const lines = pending.map((entry) => (
        `  ${entry.code} ${entry.user_id} (${entry.user_name}, ${entry.age_minutes}m old)`
      ))
      return { kind: 'success', text: `Pending pairing requests:\n${lines.join('\n')}` }
    }
    case 'revoke': {
      const userId = parts.slice(1).join(' ')
      if (!userId) return { kind: 'error', text: 'Usage: /wechat pairing revoke <user_id>' }
      const removed = await ctx.pairingStore.revoke('weixin', userId)
      return removed
        ? { kind: 'success', text: `Revoked ${userId}` }
        : { kind: 'error', text: `No approved user "${userId}".` }
    }
    case 'clear-pending': {
      const count = await ctx.pairingStore.clearPending('weixin')
      return { kind: 'success', text: `Cleared ${count} pending request(s).` }
    }
    default:
      return {
        kind: 'error',
        text: 'Usage: /wechat pairing {approve <code> | list | pending | revoke <user_id> | clear-pending}',
      }
  }
}

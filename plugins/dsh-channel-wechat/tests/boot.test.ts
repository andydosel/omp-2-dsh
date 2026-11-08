import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.ts'

/** Read the `text` field of a command result after checking its runtime shape. */
function commandText(result: unknown): string {
  if (result !== null && typeof result === 'object' && 'text' in result && typeof result.text === 'string') {
    return result.text
  }
  throw new Error(`command result has no text field: ${JSON.stringify(result)}`)
}

/** Boot the real Cordis plugin entry with stub services (no harness). */
async function bootPlugin(config: Record<string, unknown>, provideCommands = true): Promise<{
  followups: string[]
  commands: Map<string, (raw: string) => Promise<unknown>>
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const followups: string[] = []
  ctx.provide('agents', {
    get: () => undefined,
    resume: async () => {
      throw new Error('no persistence in smoke test')
    },
    create: async (options: { sessionId: string }) => ({
      agent: {
        id: options.sessionId,
        session: { id: options.sessionId },
        followup: () => { followups.push(options.sessionId) },
      },
      dispose: async () => undefined,
    }),
  } as never)
  ctx.provide('sessions', {
    get: () => undefined,
    create: () => undefined,
    list: () => [],
  } as never)
  const commands = new Map<string, (raw: string) => Promise<unknown>>()
  if (provideCommands) {
    ctx.provide('commands', {
      register: (definition: { name: string; handler: (inv: { rawInput: string }) => unknown }) => {
        commands.set(definition.name, async (raw: string) => definition.handler({ rawInput: raw } as never))
        return () => commands.delete(definition.name)
      },
    } as never)
  }
  const fiber = await ctx.plugin(plugin as never, config)
  return {
    followups,
    commands,
    dispose: async () => {
      await fiber.dispose()
    },
  }
}

describe('plugin boot (real Cordis)', () => {
  it('loads with valid config and starts the poll loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wechat-boot-'))
    try {
      const boot = await bootPlugin({
        accountId: 'c5610f3ce386@im.bot',
        token: 'c5610f3ce386@im.bot:secret',
        stateDir: dir,
      })
      // /wechat command registered
      expect(boot.commands.has('wechat')).toBe(true)
      const status = await boot.commands.get('wechat')!('status')
      expect(commandText(status)).toContain('poll: running')
      await boot.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects unknown config keys loudly', async () => {
    await expect(bootPlugin({ dmPolicyy: 'open' })).rejects.toThrow(/unknown config key/)
  })

  it('keeps the command registered and reports disabled when enabled=false', async () => {
    const boot = await bootPlugin({ enabled: false })
    // Registered before the startup gate so the mode-ui badge always resolves
    // the command and can surface why the channel is idle.
    expect(boot.commands.has('wechat')).toBe(true)
    const result = await boot.commands.get('wechat')!('status')
    expect(result).toMatchObject({ kind: 'success' })
    expect(commandText(result)).toContain('微信通道已禁用(config.enabled=false)')
    await boot.dispose()
  })

  it('keeps the command registered and reports the startup failure when credentials are missing', async () => {
    const boot = await bootPlugin({ accountId: '', token: '' })
    // Applied without throwing; the command explains why the channel is idle.
    expect(boot.commands.has('wechat')).toBe(true)
    const result = await boot.commands.get('wechat')!('status')
    expect(result).toMatchObject({ kind: 'error' })
    expect(commandText(result)).toContain('配置未通过启动检查')
    await boot.dispose()
  })
})

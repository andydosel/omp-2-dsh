/**
 * Runtime director settings: the `dsh-vibe-mode` namespace hot-reloads the
 * `director:instructions` section source, and the config schema stays strict
 * (waitMode and other unknown keys fail loudly).
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolveConfig } from '../src/index.ts'
import { agentWithSession, assembleFor, setupWithSettings, MockSubagents, VIBE_CONFIG } from './harness.ts'

/** Run the registered `/vibe` command exactly as the UI dispatches it. */
async function runVibe(ctx: Context, agent: Agent): Promise<void> {
  const command = ctx.commands.find(agent, 'vibe')
  if (!command) throw new Error('no /vibe command registered')
  const result = await command.handler({
    agent,
    rawInput: '',
    commandId: CommandId('cmd-settings'),
    attachments: [],
    signal: new AbortController().signal,
  })
  if (result.kind !== 'success') throw new Error(`vibe command failed: ${result.text}`)
}

describe('runtime director settings', () => {
  it('the director:instructions section switches to the settings value after a set (hot reload)', async () => {
    const ctx = await setupWithSettings(new MockSubagents())
    const director = await agentWithSession(ctx, 'settings-director')
    await runVibe(ctx, director)
    const section = async () => {
      const assembly = await assembleFor(ctx, director)
      return assembly.sections.find(entry => entry.name === 'director:instructions')?.text ?? ''
    }
    // Initially the composition config section is in force.
    expect(await section()).toBe(VIBE_CONFIG.section)
    // A settings write hot-reloads: the very next assembly uses the new text.
    await ctx.settings.update(settingsNamespace('dsh-vibe-mode'), { section: 'You are the NEW DIRECTOR.' })
    expect(await section()).toBe('You are the NEW DIRECTOR.')
    // Re-entry (fresh scope) also reads the live source.
    const command = ctx.commands.find(director, 'vibe')!
    await command.handler({
      agent: director,
      rawInput: 'off',
      commandId: CommandId('cmd-settings-off'),
      attachments: [],
      signal: new AbortController().signal,
    })
    await runVibe(ctx, director)
    expect(await section()).toBe('You are the NEW DIRECTOR.')
  })

  it('waitMode is absent: a config carrying it fails loudly (unknown key)', () => {
    expect(() => resolveConfig({ waitMode: 'block' } as never)).toThrow(/unknown key/)
  })
})

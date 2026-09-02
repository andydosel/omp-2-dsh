/**
 * Config validation tests.
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('applies documented defaults', () => {
    const config = resolveConfig()
    expect(config.enabled).toBe(true)
    expect(config.defaultTools).toEqual(['read', 'grep', 'glob'])
    expect(config.immuneTurns).toBe(3)
    expect(config.syncBacklog).toBe(0)
    expect(config.model).toBe('')
    expect(config.maxPromptTokens).toBe(8192)
    expect(config.watchdog).toEqual({ userDir: '', projectMarkers: ['.git'] })
    expect(config.costTable).toEqual({})
    expect(config.agentId).toBe('')
  })

  it('normalizes custom values', () => {
    const config = resolveConfig({
      enabled: false,
      defaultTools: ['read'],
      immuneTurns: 5,
      syncBacklog: 3,
      model: 'deepseek-chat',
      watchdog: { userDir: '/tmp/wd', projectMarkers: ['.git', '.hg'] },
      costTable: { 'deepseek/deepseek-chat': 0.2 },
      agentId: 'main',
    })
    expect(config.enabled).toBe(false)
    expect(config.defaultTools).toEqual(['read'])
    expect(config.immuneTurns).toBe(5)
    expect(config.syncBacklog).toBe(3)
    expect(config.model).toBe('deepseek-chat')
    expect(config.watchdog.userDir).toBe('/tmp/wd')
    expect(config.watchdog.projectMarkers).toEqual(['.git', '.hg'])
    expect(config.costTable).toEqual({ 'deepseek/deepseek-chat': 0.2 })
  })

  it('rejects invalid syncBacklog values', () => {
    expect(() => resolveConfig({ syncBacklog: 2 })).toThrow(/syncBacklog/)
    expect(() => resolveConfig({ syncBacklog: 7 })).toThrow(/syncBacklog/)
  })

  it('rejects an empty defaultTools allow-list', () => {
    expect(() => resolveConfig({ defaultTools: [] })).toThrow(/defaultTools/)
  })

  it('rejects a maxPromptTokens below the floor', () => {
    expect(() => resolveConfig({ maxPromptTokens: 100 })).toThrow(/maxPromptTokens/)
  })

  it('accepts the documented syncBacklog values', () => {
    for (const value of [0, 1, 3, 5]) {
      expect(resolveConfig({ syncBacklog: value }).syncBacklog).toBe(value)
    }
  })
})

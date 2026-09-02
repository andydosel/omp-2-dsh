import { describe, expect, it, vi } from 'vitest'
import { applyDirectorScope } from '../src/index.ts'
import { agentWithSession, assembleFor, setup, MockSubagents, VIBE_CONFIG, visibleToolNames } from './harness.ts'

const ALL_TOOLS = ['read', 'glob', 'grep', 'read_image', 'todo_write', 'write', 'bash']
const READ_ONLY = ['read', 'glob', 'grep', 'read_image', 'todo_write']
const VIBE_TOOLS = ['vibe_spawn', 'vibe_send', 'vibe_wait', 'vibe_kill', 'vibe_list']

describe('director narrowing', () => {
  it('restricts the director to read-only tools plus the five vibe tools', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'narrow-director')
    const other = await agentWithSession(ctx, 'narrow-other')
    // Before entry the full catalog is visible to everyone.
    expect(visibleToolNames(ctx, director).sort()).toEqual([...ALL_TOOLS].sort())
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config, ctx.vibeMode.store)
    const names = visibleToolNames(ctx, director)
    expect(names.sort()).toEqual([...READ_ONLY, ...VIBE_TOOLS].sort())
    // The other agent is untouched.
    expect(visibleToolNames(ctx, other).sort()).toEqual([...ALL_TOOLS].sort())
    scope.dispose()
    // Exit restores the full catalog.
    expect(visibleToolNames(ctx, director).sort()).toEqual([...ALL_TOOLS].sort())
  })

  it('applies native presentation so code-mode run_code cannot bypass the mask', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'narrow-native')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config, ctx.vibeMode.store)
    // No run_code transport appears in the director's native catalog.
    expect(visibleToolNames(ctx, director)).not.toContain('run_code')
    scope.dispose()
  })

  it('mounts the director:instructions section at order 51, fold-driven', async () => {
    const ctx = await setup(new MockSubagents())
    // Active fold: the section renders the directive.
    const active = await agentWithSession(ctx, 'narrow-section-active', { active: true })
    const activeScope = applyDirectorScope(ctx, active, ctx.vibeMode.config, ctx.vibeMode.store)
    const activeAssembly = await assembleFor(ctx, active)
    const activeSection = activeAssembly.sections.find(section => section.name === 'director:instructions')
    expect(activeSection?.text).toContain('DIRECTOR')
    // The section sits after the persona (order 0) in assembly order.
    const activeIndex = activeAssembly.sections.findIndex(section => section.name === 'director:instructions')
    const personaIndex = activeAssembly.sections.findIndex(section => section.name === 'deployment:persona')
    expect(activeIndex).toBeGreaterThan(personaIndex)
    // Inactive fold: the same registration renders empty (no directive leaks).
    const idle = await agentWithSession(ctx, 'narrow-section-idle')
    const idleScope = applyDirectorScope(ctx, idle, ctx.vibeMode.config, ctx.vibeMode.store)
    const idleAssembly = await assembleFor(ctx, idle)
    const idleSection = idleAssembly.sections.find(section => section.name === 'director:instructions')
    expect(idleSection?.text).toBe('')
    idleScope.dispose()
    activeScope.dispose()
    // Disposed: the registration is gone entirely.
    const after = await assembleFor(ctx, active)
    expect(after.sections.find(section => section.name === 'director:instructions')).toBeUndefined()
  })

  it('mounts the director:tool-guidance section at order 150, fold-driven', async () => {
    const ctx = await setup(new MockSubagents())
    const active = await agentWithSession(ctx, 'narrow-guidance-active', { active: true })
    const activeScope = applyDirectorScope(ctx, active, ctx.vibeMode.config, ctx.vibeMode.store)
    const activeAssembly = await assembleFor(ctx, active)
    const guidance = activeAssembly.sections.find(section => section.name === 'director:tool-guidance')
    expect(guidance?.text).toContain('vibe_spawn')
    expect(guidance?.text).toMatch(/delegate/i)
    // Sits inside the tool-guidance band, after the director instructions.
    const guidanceIndex = activeAssembly.sections.findIndex(section => section.name === 'director:tool-guidance')
    const directorIndex = activeAssembly.sections.findIndex(section => section.name === 'director:instructions')
    expect(guidanceIndex).toBeGreaterThan(directorIndex)
    // Inactive fold renders empty; dispose removes the registration.
    const idle = await agentWithSession(ctx, 'narrow-guidance-idle')
    const idleScope = applyDirectorScope(ctx, idle, ctx.vibeMode.config, ctx.vibeMode.store)
    const idleAssembly = await assembleFor(ctx, idle)
    expect(idleAssembly.sections.find(section => section.name === 'director:tool-guidance')?.text).toBe('')
    idleScope.dispose()
    activeScope.dispose()
    const after = await assembleFor(ctx, active)
    expect(after.sections.find(section => section.name === 'director:tool-guidance')).toBeUndefined()
  })

  it('a fold-active session re-applies narrowing on session-start (resume restore)', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'narrow-resume', { active: true })
    expect(ctx.vibeMode.store.get(director.session.id).active).toBe(true)
    // Emit session-start like a resumed director; the plugin re-applies the scope.
    ctx.emit('agent/session-start', { agent: director, source: 'resume' })
    const names = visibleToolNames(ctx, director)
    expect(names.sort()).toEqual([...READ_ONLY, ...VIBE_TOOLS].sort())
  })

  it('drops readOnlyTools names absent from the toolset with a warning', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'narrow-badname')
    const warn = vi.spyOn(ctx.logger, 'warn')
    const bad = { ...ctx.vibeMode.config, readOnlyTools: ['read', 'no_such_tool'] }
    const scope = applyDirectorScope(ctx, director, bad, ctx.vibeMode.store)
    // The unknown name is dropped; the surviving allow-list still restricts.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('readOnlyTools names not present'),
      'no_such_tool',
    )
    expect(visibleToolNames(ctx, director).sort()).toEqual([...['read'], ...VIBE_TOOLS].sort())
    scope.dispose()
  })

  it('throws when no readOnlyTools name is present in the toolset', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'narrow-empty')
    const empty = { ...ctx.vibeMode.config, readOnlyTools: ['no_such_tool', 'also_missing'] }
    expect(() => applyDirectorScope(ctx, director, empty, ctx.vibeMode.store)).toThrow(/none of the configured readOnlyTools/)
  })

  it('dispose is idempotent and rolls back every registration', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'narrow-idem')
    const scope = applyDirectorScope(ctx, director, ctx.vibeMode.config, ctx.vibeMode.store)
    scope.dispose()
    scope.dispose()
    expect(visibleToolNames(ctx, director).sort()).toEqual([...ALL_TOOLS].sort())
  })

  it('a partial application failure rolls back earlier registrations', async () => {
    const ctx = await setup(new MockSubagents())
    const director = await agentWithSession(ctx, 'narrow-partial')
    // Register a conflicting presentation on the director scope first: the
    // presentAs('native') call then throws, and the earlier restrict must roll back.
    const conflict = director.ctx.tools.presentAs('code')
    expect(() => applyDirectorScope(ctx, director, ctx.vibeMode.config, ctx.vibeMode.store)).toThrow()
    // The restrict was rolled back: the full catalog (plus run_code from the
    // still-declared code presentation) is visible again.
    expect(visibleToolNames(ctx, director).sort()).toEqual([...ALL_TOOLS, 'run_code'].sort())
    conflict()
  })
})

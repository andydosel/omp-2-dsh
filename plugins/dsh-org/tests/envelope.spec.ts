/**
 * Role-envelope lifecycle tests: `/org on` composes the mechanism-enforced
 * envelope (tool mask + scoped role tools + path gate + role section), `/org
 * off` REALLY lifts it (every effect is disposed, not just the folded role),
 * and a later `on` re-installs it. Also covers role REPLACEMENT: a lead
 * promoted through `/org on` swaps its envelope instead of layering a second.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import '../src/types.ts'
import { orgCommandHandler } from '../src/commands.ts'
import { applyLeadEnvelope, applySecretaryEnvelope, disposeEnvelope, isEnvelopeApplied } from '../src/envelope.ts'
import { OrgService } from '../src/service.ts'
import { SECRETARY_TOOL_NAMES } from '../src/tools.ts'
import { allowList, FakeAgentCtx, FakeCtx, registeredNames } from './harness.ts'

/** Inherited tool names a code-working agent scope exposes. */
const INHERITED = [
  'read', 'read_image', 'glob', 'grep', 'lsp', 'write', 'edit', 'bash', 'todo_write',
  'peer_send', 'ask_question', 'subtask_parallel',
  'task_new', 'task_update', 'task_close', 'task_reopen', 'task_list',
] as const

interface Rig {
  ctx: FakeCtx
  org: OrgService
  agent: Agent
  agentCtx: FakeAgentCtx
}

/** A fake context with one live session/agent (and its bound fake agent scope) plus a real org service. */
function rig(id: string): Rig {
  const ctx = new FakeCtx()
  const created = ctx.addAgent(id, INHERITED)
  const { agentCtx } = created
  if (agentCtx === undefined) throw new Error('the harness did not bind an agent scope')
  const org = new OrgService(ctx as unknown as Context, {})
  return { ctx, org, agent: created.agent, agentCtx }
}

/** The scope ctx handed to the envelope (the fake stands in for the real agent scope). */
function scopeOf(agentCtx: FakeAgentCtx): Context {
  return agentCtx as unknown as Context
}

describe('role envelope', () => {
  it('keeps only the coordination mask, registers the nine secretary tools, and adds one path gate plus one section', () => {
    const { org, agent, agentCtx } = rig('sec')

    applySecretaryEnvelope(scopeOf(agentCtx), agent, org.deps)

    expect(agentCtx.restrictSpy).toHaveBeenCalledTimes(1)
    expect(allowList(agentCtx.restrictSpy)).toEqual([
      'peer_send', 'task_new', 'task_update', 'task_close', 'task_reopen', 'task_list', 'ask_question', 'todo_write',
      'write', 'edit',
    ])
    expect(allowList(agentCtx.restrictSpy)).not.toContain('read')
    expect(allowList(agentCtx.restrictSpy)).not.toContain('bash')
    expect(registeredNames(agentCtx.registerSpy)).toEqual([...SECRETARY_TOOL_NAMES])
    expect(agentCtx.listeners.get('tools/pre-execute')).toHaveLength(1)
    expect(agentCtx.sectionSpy).toHaveBeenCalledTimes(1)
    expect(agentCtx.sectionSpy.mock.calls[0]?.[0]).toMatchObject({ name: 'dsh-org-role-secretary' })
    expect(isEnvelopeApplied(agent)).toBe(true)
  })

  it('keeps bash out of the lead mask (the path gate cannot police a shell)', () => {
    const { org, agent, agentCtx } = rig('lead')

    applyLeadEnvelope(scopeOf(agentCtx), agent, org.deps)

    const allow = allowList(agentCtx.restrictSpy)
    expect(allow).not.toContain('bash')
    expect(allow).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'subtask_parallel']))
  })

  it('confines the secretary write/edit tools to the handoff area', async () => {
    const { org, agent, agentCtx } = rig('sec')
    applySecretaryEnvelope(scopeOf(agentCtx), agent, org.deps)
    const listener = agentCtx.listeners.get('tools/pre-execute')?.[0]
    expect(listener).toBeDefined()
    const next = async (): Promise<{ kind: 'allow' }> => ({ kind: 'allow' })

    const denied = await listener!({ name: 'write', arguments: { file_path: 'docs/design.md' } }, next)
    expect(denied).toMatchObject({ kind: 'deny' })
    const handoff = await listener!({ name: 'write', arguments: { file_path: '.dsh-handoff/brief.md' } }, next)
    expect(handoff).toEqual({ kind: 'allow' })
    const source = await listener!({ name: 'edit', arguments: { file_path: 'src/app.ts' } }, next)
    expect(source).toMatchObject({ kind: 'deny' })
  })

  it('keeps bash for the secretary only when secretaryBash is configured', () => {
    const ctx = new FakeCtx()
    const created = ctx.addAgent('sec', INHERITED)
    if (created.agentCtx === undefined) throw new Error('the harness did not bind an agent scope')
    const org = new OrgService(ctx as unknown as Context, { secretaryBash: true })
    const agentCtx = created.agentCtx

    applySecretaryEnvelope(scopeOf(agentCtx), created.agent, org.deps)

    expect(allowList(agentCtx.restrictSpy)).toContain('bash')
  })

  it('is idempotent for the same role and swaps the envelope when the role changes', () => {
    const { org, agent, agentCtx } = rig('sec')

    applyLeadEnvelope(scopeOf(agentCtx), agent, org.deps)
    expect(registeredNames(agentCtx.registerSpy)).toEqual(['report'])
    applyLeadEnvelope(scopeOf(agentCtx), agent, org.deps)
    expect(registeredNames(agentCtx.registerSpy)).toEqual(['report'])
    expect(agentCtx.disposed).toEqual([])

    applySecretaryEnvelope(scopeOf(agentCtx), agent, org.deps)
    expect(agentCtx.disposed).toEqual([
      'section:dsh-org-role-lead',
      'listener:tools/pre-execute',
      'tool:report',
      'restrict',
    ])
    expect(registeredNames(agentCtx.registerSpy)).toEqual(['report', ...SECRETARY_TOOL_NAMES])
  })

  it('/org off lifts every installed effect and /org on re-installs it', async () => {
    const { org, agent, agentCtx } = rig('sec')

    expect((await orgCommandHandler(org, org.deps, { rawInput: 'on', agent })).kind).toBe('success')
    expect(org.roleOf(agent.id)).toBe('secretary')
    expect(isEnvelopeApplied(agent)).toBe(true)

    const off = await orgCommandHandler(org, org.deps, { rawInput: 'off', agent })
    expect(off.kind).toBe('success')
    expect(isEnvelopeApplied(agent)).toBe(false)
    expect(org.roleOf(agent.id)).toBeUndefined()
    expect(agentCtx.disposed).toEqual([
      'section:dsh-org-role-secretary',
      'listener:tools/pre-execute',
      ...[...SECRETARY_TOOL_NAMES].reverse().map(name => `tool:${name}`),
      'restrict',
    ])

    // A second off is a no-op, and on re-installs the whole envelope.
    expect((await orgCommandHandler(org, org.deps, { rawInput: 'off', agent })).kind).toBe('success')
    expect(registeredNames(agentCtx.registerSpy)).toEqual([...SECRETARY_TOOL_NAMES])
    expect((await orgCommandHandler(org, org.deps, { rawInput: 'on', agent })).kind).toBe('success')
    expect(registeredNames(agentCtx.registerSpy)).toEqual([...SECRETARY_TOOL_NAMES, ...SECRETARY_TOOL_NAMES])
    expect(agentCtx.restrictSpy).toHaveBeenCalledTimes(2)
    expect(org.roleOf(agent.id)).toBe('secretary')
  })

  it('reports an install failure instead of leaving a half-composed envelope', () => {
    const { org, agent, agentCtx } = rig('sec')
    // No inherited tool name survives the intersection → the mask cannot be built.
    const empty = new FakeAgentCtx([])

    expect(() => applySecretaryEnvelope(scopeOf(empty), agent, org.deps)).toThrow(/no usable inherited tools/)
    expect(isEnvelopeApplied(agent)).toBe(false)
    expect(agentCtx.disposed).toEqual([])
    expect(empty.disposed).toEqual([])
  })

  it('disposeEnvelope is idempotent', () => {
    const { org, agent, agentCtx } = rig('sec')

    disposeEnvelope(agent)
    expect(agentCtx.disposed).toEqual([])
    applySecretaryEnvelope(scopeOf(agentCtx), agent, org.deps)
    disposeEnvelope(agent)
    const disposed = [...agentCtx.disposed]
    expect(disposed).toHaveLength(SECRETARY_TOOL_NAMES.length + 3)
    disposeEnvelope(agent)
    expect(agentCtx.disposed).toEqual(disposed)
  })
})

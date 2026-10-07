/**
 * Organisation-service tests: the live fold over real session logs, the
 * one-secretary invariant, forbid/relinquish, `spawnLead` composing a lead
 * envelope through the fake agent factory, and delivery wiring.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import '../src/types.ts'
import { applyOrgView, emptyOrgView } from '../src/projection.ts'
import { OrgService } from '../src/service.ts'
import { defineReportTool } from '../src/tools.ts'
import type { OrgProjectionView } from '../src/types.ts'
import { allowList, FakeCtx } from './harness.ts'

interface Rig {
  ctx: FakeCtx
  org: OrgService
  sec: Agent
  tgt: Agent
}

/** A fake context with two live sessions/agents and a real org service. */
async function rig(): Promise<Rig> {
  const ctx = new FakeCtx()
  const sec = ctx.addAgent('sec').agent
  const tgt = ctx.addAgent('tgt').agent
  const org = new OrgService(ctx as unknown as Context, {})
  return { ctx, org, sec, tgt }
}

/** Fold one session's log into a fresh projection view. */
function foldView(events: readonly SessionEvent[]): OrgProjectionView {
  let view = emptyOrgView()
  for (const event of events) view = applyOrgView(view, event)
  return view
}

describe('OrgService', () => {
  it('claim records the edge, both roles, and mirrors the event to both logs', async () => {
    const { org, sec, tgt } = await rig()
    org.claim(sec, 'tgt')
    expect(org.managerOf('tgt')).toBe('sec')
    expect(org.managesOf('sec')).toEqual(['tgt'])
    expect(org.roleOf('tgt')).toBe('lead')
    expect(org.roleOf('sec')).toBe('secretary')
    expect(sec.session.snapshotEvents().some(event => event.type === 'org/claim')).toBe(true)
    expect(tgt.session.snapshotEvents().some(event => event.type === 'org/claim')).toBe(true)
  })

  it('rejects a second secretary and leaves the state untouched', async () => {
    const { ctx, org, sec } = await rig()
    org.claim(sec, 'tgt')
    const other = ctx.addAgent('other').agent
    expect(() => org.claim(other, 'tgt')).toThrow(/one secretary per session/)
    expect(org.managerOf('tgt')).toBe('sec')
    expect(org.managesOf('other')).toEqual([])
  })

  it('forbid releases the edge, blocks a later claim, and is idempotent', async () => {
    const { org, sec } = await rig()
    org.claim(sec, 'tgt')
    org.forbid(sec, 'tgt')
    expect(org.isForbidden('sec', 'tgt')).toBe(true)
    expect(org.managerOf('tgt')).toBeUndefined()
    expect(org.roleOf('tgt')).toBeUndefined()
    org.forbid(sec, 'tgt')
    expect(org.forbiddenOf('sec')).toEqual(['tgt'])
    expect(() => org.claim(sec, 'tgt')).toThrow(/forbidden/)
  })

  it('relinquish clears the edge and the lead role; forbidden is untouched', async () => {
    const { org, sec } = await rig()
    org.claim(sec, 'tgt')
    org.forbid(sec, 'other-placeholder')
    org.claim(sec, 'tgt')
    org.relinquish(sec, 'tgt')
    expect(org.managerOf('tgt')).toBeUndefined()
    expect(org.roleOf('tgt')).toBeUndefined()
    expect(org.forbiddenOf('sec')).toEqual(['other-placeholder'])
  })

  it('spawnLead composes a lead envelope and records the claim', async () => {
    const { ctx, org, sec } = await rig()
    const { sessionId } = await org.spawnLead(sec, { name: 'api-lead', prompt: 'build the api' })
    const created = ctx.created.at(-1)
    expect(created).toBeDefined()
    if (created === undefined) return
    expect(created.agentCtx.restrictSpy).toHaveBeenCalledTimes(1)
    const allow = allowList(created.agentCtx.restrictSpy)
    expect(allow).toContain('read')
    expect(allow).toContain('write')
    expect(created.agentCtx.registerSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'report' }))
    expect(created.agentCtx.sectionSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'dsh-org-role-lead' }))
    expect(org.managerOf(sessionId)).toBe('sec')
    expect(org.roleOf(sessionId)).toBe('lead')
    expect(created.agent.followup).toHaveBeenCalledTimes(1)
  })

  it('assign records the assignment and wakes the lead (no task board)', async () => {
    const { org, sec, tgt } = await rig()
    org.claim(sec, 'tgt')
    const result = org.assign(sec, { leadId: 'tgt', subject: 'ship it', brief: 'the brief' })
    expect(result).toEqual({})
    expect(tgt.followup).toHaveBeenCalledTimes(1)
    expect(sec.session.snapshotEvents().some(event => event.type === 'org/assign')).toBe(true)
  })

  it('assign mirrors onto a composed task board', async () => {
    const { ctx, org, sec } = await rig()
    ctx.provides.set('taskBoard', { create: () => ({ id: 't-1' }) })
    org.claim(sec, 'tgt')
    expect(org.assign(sec, { leadId: 'tgt', subject: 's', brief: 'b' })).toEqual({ taskId: 't-1' })
    const assign = sec.session.snapshotEvents().find(event => event.type === 'org/assign')
    expect(assign?.type === 'org/assign' && assign.data.taskId).toBe('t-1')
  })

  it('rejects assigning to a lead the secretary does not manage', async () => {
    const { org, sec } = await rig()
    expect(() => org.assign(sec, { leadId: 'tgt', subject: 's', brief: 'b' })).toThrow(/not managed/)
  })

  it('notify records a durable notice readable back', async () => {
    const { org, sec } = await rig()
    const { id } = org.notify(sec, 'heads up')
    expect(org.notices(sec.id)).toEqual([{ id, content: 'heads up', time: expect.any(Number) }])
  })

  it('the report tool delivers through the peers probe', async () => {
    const { ctx, org, sec, tgt } = await rig()
    org.claim(sec, 'tgt')
    const send = vi.fn(async () => ({ status: 'delivered' as const, message: { id: 'm-1' } }))
    ctx.provides.set('peers', { listMessages: () => [], send })
    const tool = defineReportTool(org, org.deps)
    const value = await tool.execute({ content: 'done' }, { agent: tgt } as never)
    expect(value).toEqual({ targetId: 'sec', delivered: true })
    expect(send).toHaveBeenCalledWith(tgt, expect.objectContaining({ targetId: 'sec', delivery: 'wakeup' }))
  })

  it('the org projection folds each log into its own self-describing view', async () => {
    const { org, sec, tgt } = await rig()
    org.claim(sec, 'tgt')
    org.notify(sec, 'note')
    const secretaryView = foldView(sec.session.snapshotEvents())
    expect(secretaryView.role).toBe('secretary')
    expect(secretaryView.manages).toEqual(['tgt'])
    expect(secretaryView.notices).toHaveLength(1)
    const targetView = foldView(tgt.session.snapshotEvents())
    expect(targetView.role).toBe('lead')
    expect(targetView.managedBy).toBe('sec')
  })
})

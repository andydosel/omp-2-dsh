/**
 * Organisation-service tests: the live fold over real session logs, the
 * one-secretary invariant, forbid/relinquish, `spawnLead` composing a lead
 * envelope through the fake agent factory, and delivery wiring.
 */

import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import '../src/types.ts'
import { resolveOrgConfig } from '../src/config.ts'
import { applyOrgView, emptyOrgView } from '../src/projection.ts'
import { OrgService } from '../src/service.ts'
import { defineProjectStructureTool, defineReadProjectDocsTool, defineReportTool } from '../src/tools.ts'
import type { OrgProjectionView } from '../src/types.ts'
import { allowList, FakeAgentCtx, FakeCtx } from './harness.ts'
import { orgCommandHandler } from '../src/commands.ts'

/** Inherited tool names a live code-working agent scope exposes. */
const INHERITED = [
  'read', 'read_image', 'glob', 'grep', 'lsp', 'write', 'edit', 'bash', 'todo_write',
  'peer_send', 'ask_question', 'subtask_parallel',
  'task_new', 'task_update', 'task_close', 'task_reopen', 'task_list',
] as const

interface Rig {
  ctx: FakeCtx
  org: OrgService
  sec: Agent
  tgt: Agent
  secCtx: FakeAgentCtx
  tgtCtx: FakeAgentCtx
}

/** A fake context with two live sessions/agents and a real org service. */
async function rig(): Promise<Rig> {
  const ctx = new FakeCtx()
  const secCreated = ctx.addAgent('sec', INHERITED)
  const tgtCreated = ctx.addAgent('tgt', INHERITED)
  const org = new OrgService(ctx as unknown as Context, {})
  return {
    ctx,
    org,
    sec: secCreated.agent,
    tgt: tgtCreated.agent,
    secCtx: secCreated.agentCtx!,
    tgtCtx: tgtCreated.agentCtx!,
  }
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
    await org.claim(sec, 'tgt')
    expect(org.managerOf('tgt')).toBe('sec')
    expect(org.managesOf('sec')).toEqual(['tgt'])
    expect(org.roleOf('tgt')).toBe('lead')
    expect(org.roleOf('sec')).toBe('secretary')
    expect(sec.session.snapshotEvents().some(event => event.type === 'org/claim')).toBe(true)
    expect(tgt.session.snapshotEvents().some(event => event.type === 'org/claim')).toBe(true)
  })

  it('applies the lead envelope to a LIVE claimed target (mask + role tool + path gate)', async () => {
    const { org, sec, tgtCtx } = await rig()
    await org.claim(sec, 'tgt')
    expect(tgtCtx.restrictSpy).toHaveBeenCalledTimes(1)
    const allow = allowList(tgtCtx.restrictSpy)
    expect(allow).toContain('read')
    expect(allow).toContain('write')
    expect(allow).not.toContain('bash')
    expect(tgtCtx.registerSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'report' }))
    expect(tgtCtx.listeners.get('tools/pre-execute')).toHaveLength(1)
    expect(tgtCtx.sectionSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'dsh-org-role-lead' }))
  })

  it('relinquish and forbid dispose the live target envelope', async () => {
    const { org, sec, tgtCtx } = await rig()
    await org.claim(sec, 'tgt')
    expect(tgtCtx.disposed).toEqual([])
    await org.relinquish(sec, 'tgt')
    expect(tgtCtx.disposed).toEqual([
      'section:dsh-org-role-lead',
      'listener:tools/pre-execute',
      'tool:report',
      'restrict',
    ])
    await org.claim(sec, 'tgt')
    await org.forbid(sec, 'tgt')
    expect(tgtCtx.disposed).toHaveLength(8)
  })

  it('/org off relinquishes every edge the secretary holds', async () => {
    const { ctx, org, sec } = await rig()
    const extra = ctx.addAgent('extra', INHERITED)
    await org.claim(sec, 'tgt')
    await org.claim(sec, 'extra')
    expect(org.managesOf('sec')).toEqual(['tgt', 'extra'])

    expect((await orgCommandHandler(org, org.deps, { rawInput: 'on', agent: sec })).kind).toBe('success')
    expect((await orgCommandHandler(org, org.deps, { rawInput: 'off', agent: sec })).kind).toBe('success')

    expect(org.managesOf('sec')).toEqual([])
    expect(org.managerOf('tgt')).toBeUndefined()
    expect(org.managerOf('extra')).toBeUndefined()
    expect(org.roleOf(sec.id)).toBeUndefined()
    expect(org.roleOf('tgt')).toBeUndefined()
    // The lifted targets' own projections are self-describing too.
    expect(foldView(extra.agent.session.snapshotEvents()).managedBy).toBeNull()
    expect(foldView(extra.agent.session.snapshotEvents()).role).toBeNull()
  })

  it('rejects a second secretary and leaves the state untouched', async () => {
    const { ctx, org, sec } = await rig()
    await org.claim(sec, 'tgt')
    const other = ctx.addAgent('other').agent
    await expect(org.claim(other, 'tgt')).rejects.toThrow(/one secretary per session/)
    expect(org.managerOf('tgt')).toBe('sec')
    expect(org.managesOf('other')).toEqual([])
  })

  it('forbid releases the edge, blocks a later claim, and is idempotent', async () => {
    const { org, sec } = await rig()
    await org.claim(sec, 'tgt')
    await org.forbid(sec, 'tgt')
    expect(org.isForbidden('sec', 'tgt')).toBe(true)
    expect(org.managerOf('tgt')).toBeUndefined()
    expect(org.roleOf('tgt')).toBeUndefined()
    await org.forbid(sec, 'tgt')
    expect(org.forbiddenOf('sec')).toEqual(['tgt'])
    await expect(org.claim(sec, 'tgt')).rejects.toThrow(/forbidden/)
  })

  it('relinquish clears the edge and the lead role; forbidden is untouched', async () => {
    const { org, sec } = await rig()
    await org.claim(sec, 'tgt')
    await org.forbid(sec, 'other-placeholder')
    await org.claim(sec, 'tgt')
    await org.relinquish(sec, 'tgt')
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
    await org.claim(sec, 'tgt')
    const result = org.assign(sec, { leadId: 'tgt', subject: 'ship it', brief: 'the brief' })
    expect(result).toEqual({})
    expect(tgt.followup).toHaveBeenCalledTimes(1)
    expect(sec.session.snapshotEvents().some(event => event.type === 'org/assign')).toBe(true)
  })

  it('assign mirrors onto a composed task board', async () => {
    const { ctx, org, sec } = await rig()
    ctx.provides.set('taskBoard', { create: () => ({ id: 't-1' }) })
    await org.claim(sec, 'tgt')
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
    await org.claim(sec, 'tgt')
    const send = vi.fn(async () => ({ status: 'delivered' as const, message: { id: 'm-1' } }))
    ctx.provides.set('peers', { listMessages: () => [], send })
    const tool = defineReportTool(org, org.deps)
    const value = await tool.execute({ content: 'done' }, { agent: tgt } as never)
    expect(value).toEqual({ targetId: 'sec', delivered: true })
    expect(send).toHaveBeenCalledWith(tgt, expect.objectContaining({ targetId: 'sec', delivery: 'wakeup' }))
  })

  it('the org projection folds each log into its own self-describing view', async () => {
    const { org, sec, tgt } = await rig()
    await org.claim(sec, 'tgt')
    org.notify(sec, 'note')
    const secretaryView = foldView(sec.session.snapshotEvents())
    expect(secretaryView.role).toBe('secretary')
    expect(secretaryView.manages).toEqual(['tgt'])
    expect(secretaryView.notices).toHaveLength(1)
    const targetView = foldView(tgt.session.snapshotEvents())
    expect(targetView.role).toBe('lead')
    expect(targetView.managedBy).toBe('sec')
  })

  it('claims a cold persisted session by resuming it with the lead envelope', async () => {
    const ctx = new FakeCtx()
    const sec = ctx.addAgent('sec').agent
    const persisted = ctx.addColdSession('cold')
    persisted.append('org/notice', { content: 'survived the restart' })
    const org = new OrgService(ctx as unknown as Context, {})

    await org.claim(sec, 'cold')

    expect(ctx.resumed).toEqual(['cold'])
    const resumed = ctx.created.at(-1)
    expect(resumed?.sessionId).toBe('cold')
    expect(allowList(resumed!.agentCtx.restrictSpy)).toContain('write')
    expect(resumed!.agentCtx.registerSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'report' }))
    expect(org.managerOf('cold')).toBe('sec')
    expect(org.roleOf('cold')).toBe('lead')
    expect(ctx.sessions.get(SessionId('cold'))).toBe(persisted)
    expect(org.notices('cold')).toMatchObject([{ content: 'survived the restart', time: expect.any(Number) }])
  })

  it('accepts strictMode and rejects the removed strictTakeover alias', () => {
    // A loader that runs the exported Config first materializes absent arrays
    // as []; the resolver must still apply the handoff-derived defaults.
    expect(resolveOrgConfig({ handoffDir: '.handoff', secretaryReadPaths: [], secretaryWritePaths: [] }))
      .toMatchObject({
        secretaryReadPaths: ['docs/**', '**/*.md', '.handoff/**'],
        secretaryWritePaths: ['.handoff/**'],
      })
    expect(resolveOrgConfig({ strictMode: true }).strictMode).toBe(true)
    expect(resolveOrgConfig({}).strictMode).toBe(false)
    expect(() => resolveOrgConfig({ strictTakeover: true } as never)).toThrow(/unknown config key/)
  })

  it('answers reads and mutations through a Proxy (the shape ctx.get("org") returns)', async () => {
    const { org, sec, tgt } = await rig()
    // Cordis wraps a provided service in a Proxy on `ctx.get`; a `#private`
    // field read through that Proxy throws and used to break `peer_send`.
    const proxied = new Proxy(org, {})
    await proxied.claim(sec, 'tgt')
    expect(proxied.managerOf('tgt')).toBe('sec')
    expect(proxied.roleOf('tgt')).toBe('lead')
    expect(proxied.isForbidden(sec.id, tgt.id)).toBe(false)
    await proxied.forbid(sec, 'tgt')
    expect(proxied.isForbidden(sec.id, tgt.id)).toBe(true)
    expect(proxied.forbiddenOf(sec.id)).toEqual(['tgt'])
  })

  it('indexes exported declaration names per file without reading non-source files', async () => {
    const ctx = new FakeCtx()
    const sec = ctx.addAgent('sec').agent
    const org = new OrgService(ctx as unknown as Context, {})
    const absRoot = path.resolve(process.cwd(), 'fixture')
    const sources: Record<string, string> = {
      'src/a.ts': 'export function foo(): void {}\nexport interface Bar { value: string }\nexport { local as baz }\n',
      'src/b.js': 'export const qux = 1\nexport default class Widget {}\n',
    }
    const read: string[] = []
    ctx.provides.set('fs', {
      resolve: (target: string) => target,
      readText: async (target: string) => {
        const relative = target.slice(absRoot.length + 1)
        read.push(relative)
        return sources[relative] ?? ''
      },
      stat: async () => ({}),
      listDir: async (target: string) => {
        const base = path.basename(target)
        if (base === 'fixture') {
          return [{ name: 'src', type: 'directory' }, { name: 'README.md', type: 'file' }]
        }
        if (base === 'src') {
          return [
            { name: 'a.ts', type: 'file' },
            { name: 'b.js', type: 'file' },
            { name: 'notes.txt', type: 'file' },
          ]
        }
        return []
      },
    })

    const structure = defineProjectStructureTool(org, org.deps)
    const result = await structure.execute({ path: 'fixture' }, { agent: sec } as never)

    expect(result.symbols).toEqual([
      { file: 'src/a.ts', symbols: ['foo', 'Bar', 'baz'] },
      { file: 'src/b.js', symbols: ['qux', 'Widget'] },
    ])
    expect(result.symbolsTruncated).toBe(false)
    expect(result.tree).toContain('src/')
    expect(read).toEqual(['src/a.ts', 'src/b.js'])
  })

  it('writes release and forbid records to a cold target\'s stored log', async () => {
    const ctx = new FakeCtx()
    const sec = ctx.addAgent('sec').agent
    const cold = ctx.addColdSession('cold')
    cold.append('org/claim', { secretaryId: sec.id, targetId: SessionId('cold') })
    cold.append('org/role', { sessionId: SessionId('cold'), role: 'lead' })
    sec.session.append('org/claim', { secretaryId: sec.id, targetId: SessionId('cold') })
    const org = new OrgService(ctx as unknown as Context, {})
    expect(org.managerOf('cold')).toBe('sec')

    const opened: string[] = []
    ctx.provides.set('sessionPersistence', {
      open: async (id: SessionId, access: string) => {
        opened.push(`${access}:${id}`)
        return {
          read: async () => ({ events: cold.snapshotEvents() }),
          append: async (events: readonly SessionEvent[]) => {
            for (const event of events) {
              switch (event.type) {
                case 'org/role':
                  cold.append('org/role', event.data)
                  break
                case 'org/relinquish':
                  cold.append('org/relinquish', event.data)
                  break
                case 'org/forbidden':
                  cold.append('org/forbidden', event.data)
                  break
                default:
                  throw new Error(`unexpected event ${event.type}`)
              }
            }
          },
          flush: async () => {},
          close: async () => {},
        }
      },
    })

    await org.relinquish(sec, 'cold')

    expect(opened).toEqual(['write:cold'])
    expect(org.managerOf('cold')).toBeUndefined()
    expect(cold.snapshotEvents().map(event => event.type)).toEqual([
      'org/claim', 'org/role', 'org/role', 'org/relinquish',
    ])
    expect(foldView(cold.snapshotEvents()).managedBy).toBeNull()
    expect(foldView(cold.snapshotEvents()).role).toBeNull()
  })

  it('forbids a cold target durably and refuses a later assign', async () => {
    const ctx = new FakeCtx()
    const sec = ctx.addAgent('sec').agent
    const cold = ctx.addColdSession('cold')
    cold.append('org/claim', { secretaryId: sec.id, targetId: SessionId('cold') })
    cold.append('org/role', { sessionId: SessionId('cold'), role: 'lead' })
    sec.session.append('org/claim', { secretaryId: sec.id, targetId: SessionId('cold') })
    const org = new OrgService(ctx as unknown as Context, {})
    ctx.provides.set('sessionPersistence', {
      open: async (id: SessionId, access: string) => {
        expect(access).toBe('write')
        expect(id).toBe('cold')
        return {
          read: async () => ({ events: cold.snapshotEvents() }),
          append: async (events: readonly SessionEvent[]) => {
            for (const event of events) {
              switch (event.type) {
                case 'org/role':
                  cold.append('org/role', event.data)
                  break
                case 'org/relinquish':
                  cold.append('org/relinquish', event.data)
                  break
                case 'org/forbidden':
                  cold.append('org/forbidden', event.data)
                  break
                default:
                  throw new Error(`unexpected event ${event.type}`)
              }
            }
          },
          flush: async () => {},
          close: async () => {},
        }
      },
    })

    await org.forbid(sec, 'cold')

    expect(cold.snapshotEvents().map(event => event.type)).toEqual([
      'org/claim', 'org/role', 'org/role', 'org/relinquish', 'org/forbidden',
    ])
    expect(org.isForbidden('sec', 'cold')).toBe(true)
    expect(org.managerOf('cold')).toBeUndefined()
    expect(foldView(cold.snapshotEvents()).managedBy).toBeNull()
    expect(foldView(cold.snapshotEvents()).role).toBeNull()
    expect(() => org.assign(sec, { leadId: 'cold', subject: 'later', brief: 'must not deliver' }))
      .toThrow(/forbidden/)
  })

  it('read_project_docs and project_structure honour exec.signal', async () => {
    const ctx = new FakeCtx()
    const sec = ctx.addAgent('sec').agent
    const org = new OrgService(ctx as unknown as Context, {})
    let listCalls = 0
    const controller = new AbortController()
    ctx.provides.set('fs', {
      resolve: (path: string) => path,
      readText: async () => 'document',
      stat: async () => ({}),
      listDir: async () => {
        listCalls += 1
        if (listCalls === 2) controller.abort()
        return listCalls === 1
          ? [{ name: 'a', type: 'directory' }, { name: 'b', type: 'directory' }]
          : []
      },
    })

    const docs = defineReadProjectDocsTool(org, org.deps)
    await expect(docs.execute(
      { path: 'docs/readme.md' },
      { agent: sec, signal: AbortSignal.abort() } as never,
    )).rejects.toThrow(/aborted/i)

    const structure = defineProjectStructureTool(org, org.deps)
    await expect(structure.execute(
      { path: '.' },
      { agent: sec, signal: controller.signal } as never,
    )).rejects.toThrow(/aborted/i)
  })
})

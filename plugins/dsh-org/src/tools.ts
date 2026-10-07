/**
 * The role tools. Each factory returns a `defineTool` definition and is
 * registered on the AGENT scope by the role envelope (`envelope.ts`), so a
 * secretary's tools are invisible to the lead and to the primary agent, and
 * the scoped registration is mask-immune (`tools.restrict` filters only what a
 * scope inherits).
 *
 * Secretary (`org_claim`/`org_relinquish`/`org_forbid`/`org_spawn_lead`/
 * `assign_task`/`read_project_docs`/`project_structure`/`summarize_reports`/
 * `notify_user`) and lead (`report`) tools program against the framework-free
 * `OrgApi`/`OrgDeps` seam, so they are unit-testable without a plugin host.
 * Optional sibling services (peers, task-board, approval, fs) are reached by
 * GLOBAL NAME through `deps` and fail loud at the exact call that needs them.
 *
 * @module @dsh-plugin/dsh-org/tools
 */

import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { matchesAnyPath, normalizeCandidate, normalizePattern, workspaceRoot } from './paths.ts'
import type { FsProbe, OrgApi, OrgDeps } from './types.ts'

/** The nine secretary tool names. */
export const SECRETARY_TOOL_NAMES = [
  'org_claim',
  'org_relinquish',
  'org_forbid',
  'org_spawn_lead',
  'assign_task',
  'read_project_docs',
  'project_structure',
  'summarize_reports',
  'notify_user',
] as const

/** The lead's scoped role tool. */
export const LEAD_TOOL_NAMES = ['report'] as const

/** One text content block. */
function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

/** Escape one XML text/value character (report/assignment wrappers). */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => (
    char === '&' ? '&amp;'
      : char === '<' ? '&lt;'
        : char === '>' ? '&gt;'
          : char === '"' ? '&quot;'
            : '&apos;'
  ))
}

/**
 * Resolve the calling agent from an execution. The role tools are registered
 * on one agent scope, so an agentless call is a composition fault, not a
 * user-visible outcome.
 * @param exec - the tool run context.
 * @param tool - the tool name, for the error.
 * @returns the calling agent.
 * @throws when no agent is attached to the execution.
 */
function requireAgent(exec: { agent?: Agent }, tool: string): Agent {
  if (exec.agent === undefined) {
    throw new Error(`dsh-org: ${tool} ran outside an agent scope (no acting agent to attribute the change to)`)
  }
  return exec.agent
}

/** Flatten content blocks to their text (non-text blocks are described, not dropped silently). */
function plainText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null || !('type' in block)) continue
    const { type } = block
    if (typeof type !== 'string') continue
    if (type === 'text' && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    parts.push(`[${type}]`)
  }
  return parts.join('\n')
}

/** The filesystem seam, or a loud failure naming the missing capability. */
function requireFs(deps: OrgDeps, tool: string): FsProbe {
  const fs = deps.fs()
  if (fs === undefined) {
    throw new Error(`dsh-org: ${tool} needs the filesystem service (ctx.fs), which is not composed`)
  }
  return fs
}

/** Whether a path names a markdown document (the only body the secretary may read). */
function isMarkdown(candidate: string): boolean {
  const lowered = candidate.toLowerCase()
  return lowered.endsWith('.md') || lowered.endsWith('.markdown')
}

// ── secretary tools ────────────────────────────────────────────────────────

/** `org_claim({sessionId})` — take over a session; honours `strictTakeover`. */
export function defineOrgClaimTool(org: OrgApi, deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'org_claim',
    description: 'Claim management of another session. One secretary per session: the claim fails when a different '
      + 'secretary already manages it, or when you have forbidden it. This is the only way to become its secretary.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'The session id to take over.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          managed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [text(`Claimed ${value.sessionId}: this session now manages it.`)],
    },
    execute: async (args, exec) => {
      const caller = requireAgent(exec, 'org_claim')
      if (deps.config.strictTakeover) {
        const approval = deps.approval()
        if (approval === undefined) {
          throw new Error('dsh-org: org_claim: strictTakeover is on but no approval service (ctx.approval) is composed')
        }
        const outcome = await approval.request({
          agent: caller,
          toolName: 'org_claim',
          reason: `Take over session ${args.sessionId}`,
        })
        if (outcome !== 'allowed-once') {
          throw new Error(`dsh-org: org_claim: takeover of ${args.sessionId} was not approved (${outcome})`)
        }
      }
      org.claim(caller, args.sessionId)
      return { sessionId: args.sessionId, managed: true }
    },
  })
}

/** `org_relinquish({sessionId})` — release a management edge. */
export function defineOrgRelinquishTool(org: OrgApi, _deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'org_relinquish',
    description: 'Release management of a session you manage, and clear its lead role. The session becomes independent '
      + '(its forbidden set is untouched).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'The managed session id to release.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          released: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [text(`Released ${value.sessionId}: it is independent again.`)],
    },
    execute: async (args, exec) => {
      org.relinquish(requireAgent(exec, 'org_relinquish'), args.sessionId)
      return { sessionId: args.sessionId, released: true }
    },
  })
}

/** `org_forbid({sessionId})` — never touch a session (release + forbid in one step). */
export function defineOrgForbidTool(org: OrgApi, _deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'org_forbid',
    description: 'Forbid yourself from touching a session. Idempotent; if you currently manage it, the edge is released '
      + 'in the same step. A forbidden pair can never be re-claimed.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'The session id to forbid.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          forbidden: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [text(`Forbidden: this session will not touch ${value.sessionId}.`)],
    },
    execute: async (args, exec) => {
      org.forbid(requireAgent(exec, 'org_forbid'), args.sessionId)
      return { sessionId: args.sessionId, forbidden: true }
    },
  })
}

/** `org_spawn_lead({name, cwd?, prompt})` — create a managed lead agent. */
export function defineOrgSpawnLeadTool(org: OrgApi, _deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'org_spawn_lead',
    description: 'Create a new lead agent (its own session) under your management and hand it an opening brief. '
      + 'Prefer this to implementing work yourself: the lead has the read/write toolset you do not.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short display name for the lead (e.g. "api-lead").' },
      cwd: { type: 'string', description: 'Absolute workspace directory for the lead (default: your own workspace).' },
      prompt: { type: 'string', required: true, description: 'The opening brief: the goal, the constraints, and what to report back.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (args, value) => [text(`Spawned lead "${args.name}" as ${value.sessionId} and delivered the brief.`)],
    },
    execute: async (args, exec) => {
      const caller = requireAgent(exec, 'org_spawn_lead')
      const input = {
        name: args.name,
        prompt: args.prompt,
        ...args.cwd === undefined ? {} : { cwd: args.cwd },
      }
      const { sessionId } = await org.spawnLead(caller, input)
      return { sessionId, name: args.name }
    },
  })
}

/** `assign_task({leadId, subject, brief})` — record and deliver a task to a managed lead. */
export function defineAssignTaskTool(org: OrgApi, _deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'assign_task',
    description: 'Assign work to a lead you manage. Records the assignment on your log, mirrors it onto the task board '
      + 'when one is composed, and wakes the lead with the brief.',
    parameters: {
      leadId: { type: 'string', required: true, description: 'The lead session id (must be managed by you).' },
      subject: { type: 'string', required: true, description: 'One-line task subject.' },
      brief: { type: 'string', required: true, description: 'The full brief: scope, constraints, and the expected report.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          leadId: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          taskId: { type: 'string' },
        },
      },
      render: (args, value) => [text(
        value.taskId === undefined
          ? `Assigned "${args.subject}" to ${value.leadId}.`
          : `Assigned "${args.subject}" to ${value.leadId} (task ${value.taskId}).`,
      )],
    },
    execute: async (args, exec) => {
      const caller = requireAgent(exec, 'assign_task')
      const result = org.assign(caller, { leadId: args.leadId, subject: args.subject, brief: args.brief })
      return {
        leadId: args.leadId,
        subject: args.subject,
        ...result.taskId === undefined ? {} : { taskId: result.taskId },
      }
    },
  })
}

/** `read_project_docs({path})` — read one markdown document (docs only; never code). */
export function defineReadProjectDocsTool(_org: OrgApi, deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'read_project_docs',
    description: 'Read one markdown document inside your allowed documentation roots. Non-document paths (source code, '
      + 'configs, binaries) are refused: use the structure tool or ask a lead instead.',
    parameters: {
      path: { type: 'string', required: true, description: 'Document path, relative to your workspace or absolute.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (args, value) => [text(`# ${args.path}\n\n${value.content}`)],
    },
    execute: async (args, exec) => {
      const caller = requireAgent(exec, 'read_project_docs')
      const fs = requireFs(deps, 'read_project_docs')
      const cwd = workspaceRoot(caller.session.header.cwd)
      if (!isMarkdown(args.path)) {
        throw new Error(
          `dsh-org: read_project_docs only reads markdown documents (.md/.markdown); "${args.path}" is outside that envelope. `
          + 'Use project_structure to inspect layout, or have a lead read the code.',
        )
      }
      const normalized = normalizeCandidate(args.path, cwd)
      const allowed = deps.config.secretaryReadPaths.map(pattern => normalizePattern(pattern, cwd))
      if (!matchesAnyPath(normalized, allowed)) {
        throw new Error(
          `dsh-org: read_project_docs: "${args.path}" is outside the documented roots [${deps.config.secretaryReadPaths.join(', ')}].`,
        )
      }
      const target = fs.resolve(args.path, { cwd })
      const content = await fs.readText(target)
      return { path: args.path, content }
    },
  })
}

/** `project_structure({path?})` — a bounded directory tree (names only, no contents). */
export function defineProjectStructureTool(_org: OrgApi, deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'project_structure',
    description: 'List a bounded directory tree (names and kinds only; never file contents) to understand the project '
      + 'layout. node_modules and .git are skipped and the walk is depth- and size-limited.',
    parameters: {
      path: { type: 'string', description: 'Directory to inspect (default: your workspace root).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          tree: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [text(
        `${value.root}${value.truncated ? ' (truncated)' : ''}\n${value.tree}`,
      )],
    },
    execute: async (args, exec) => {
      const caller = requireAgent(exec, 'project_structure')
      const fs = requireFs(deps, 'project_structure')
      const cwd = workspaceRoot(caller.session.header.cwd)
      const requested = args.path === undefined || args.path.trim() === '' ? '.' : args.path
      const absRoot = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested)
      const lines: string[] = []
      const state = { truncated: false }
      await renderTree(fs, fs.resolve(absRoot, { cwd }), absRoot, 0, lines, state)
      return { root: absRoot, tree: lines.join('\n'), truncated: state.truncated }
    },
  })
}

/** Directory names the structure walk never descends into. */
const TREE_SKIP: Record<string, true> = { node_modules: true, '.git': true }
const TREE_MAX_DEPTH = 3
const TREE_MAX_ENTRIES = 500

/** Recursively append one bounded directory level (names only). */
async function renderTree(
  fs: FsProbe,
  target: unknown,
  absDir: string,
  depth: number,
  lines: string[],
  state: { truncated: boolean },
): Promise<void> {
  if (state.truncated) return
  const entries = [...await fs.listDir(target)].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (TREE_SKIP[entry.name] === true) continue
    if (lines.length >= TREE_MAX_ENTRIES) {
      state.truncated = true
      return
    }
    const marker = entry.type === 'directory' ? '/' : entry.type === 'other' ? ' ~' : ''
    lines.push(`${'  '.repeat(depth)}${entry.name}${marker}`)
    if (entry.type === 'directory' && depth < TREE_MAX_DEPTH) {
      const child = `${absDir}/${entry.name}`
      await renderTree(fs, fs.resolve(child, { cwd: absDir }), child, depth + 1, lines, state)
    }
  }
}

/** `summarize_reports({reportIds})` — digest the reports in the caller's inbox. */
export function defineSummarizeReportsTool(_org: OrgApi, deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'summarize_reports',
    description: 'Read reports from your inbox and return a compact digest. Select specific report ids, or omit them '
      + 'to digest the whole inbox. Requires the peers service (dsh-peers).',
    parameters: {
      reportIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Report ids to include; omit or leave empty for every report in the inbox.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          digest: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [text(value.count === 0 ? 'No matching reports.' : value.digest)],
    },
    execute: async (args, exec) => {
      const caller = requireAgent(exec, 'summarize_reports')
      const peers = deps.peers()
      if (peers === undefined) {
        throw new Error('dsh-org: summarize_reports needs the peers service (ctx.peers / dsh-peers), which is not composed')
      }
      const wanted = args.reportIds === undefined || args.reportIds.length === 0 ? undefined : new Set(args.reportIds)
      const messages = peers.listMessages(caller.id).filter(message => wanted === undefined || wanted.has(message.id))
      const digest = messages.map(message => `- [${message.id}] from ${message.senderId}: ${plainText(message.content)}`).join('\n')
      return { count: messages.length, digest }
    },
  })
}

/** `notify_user({content})` — record a durable note for the human. */
export function defineNotifyUserTool(org: OrgApi, _deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'notify_user',
    description: 'Record a durable note for the human. Notices are surfaced by the session organisation panel; this is '
      + 'the coordinator suite channel for user-facing information (not a chat turn).',
    parameters: {
      content: { type: 'string', required: true, description: 'The note, one to three sentences.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [text(`Recorded notice ${value.id}.`)],
    },
    execute: async (args, exec) => {
      const caller = requireAgent(exec, 'notify_user')
      if (args.content.trim() === '') throw new Error('dsh-org: notify_user: content must be non-empty')
      return { id: org.notify(caller, args.content).id }
    },
  })
}

// ── lead tool ──────────────────────────────────────────────────────────────

/** `report({content})` — deliver a report to the caller's managing secretary. */
export function defineReportTool(org: OrgApi, deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'report',
    description: 'Report back to the secretary that manages this session. Delivers a wakeup message; a session with no '
      + 'manager cannot report.',
    parameters: {
      content: { type: 'string', required: true, description: 'The report: what was done, what is blocked, what is next.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: { type: 'string', required: true },
          delivered: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [text(`Report delivered to ${value.targetId}.`)],
    },
    execute: async (args, exec) => {
      const caller = requireAgent(exec, 'report')
      const manager = org.managerOf(caller.id)
      if (manager === undefined) {
        throw new Error('dsh-org: report: this session has no manager, so there is nothing to report to')
      }
      if (args.content.trim() === '') throw new Error('dsh-org: report: content must be non-empty')
      const peers = deps.peers()
      if (peers === undefined) {
        throw new Error('dsh-org: report needs the peers service (ctx.peers / dsh-peers), which is not composed')
      }
      const body = `<report from="${escapeXml(caller.id)}">${escapeXml(args.content)}</report>`
      await peers.send(caller, { targetId: manager, content: body, delivery: 'wakeup' })
      return { targetId: manager, delivered: true }
    },
  })
}

/** Every secretary tool factory, in registration order. */
export function defineSecretaryTools(org: OrgApi, deps: OrgDeps): ToolDefinition[] {
  return [
    defineOrgClaimTool(org, deps),
    defineOrgRelinquishTool(org, deps),
    defineOrgForbidTool(org, deps),
    defineOrgSpawnLeadTool(org, deps),
    defineAssignTaskTool(org, deps),
    defineReadProjectDocsTool(org, deps),
    defineProjectStructureTool(org, deps),
    defineSummarizeReportsTool(org, deps),
    defineNotifyUserTool(org, deps),
  ]
}

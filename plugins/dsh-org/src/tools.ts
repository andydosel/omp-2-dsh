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
import { escapeXml } from '@dsh-plugin/dsh-util/xml'
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

/** `org_claim({sessionId})` — take over a live or cold session; honours `strictMode`. */
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
      if (deps.config.strictMode) {
        const approval = deps.approval()
        if (approval === undefined) {
          throw new Error('dsh-org: org_claim: strictMode is on but no approval service (ctx.approval) is composed')
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
      await org.claim(caller, args.sessionId)
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
      await org.relinquish(requireAgent(exec, 'org_relinquish'), args.sessionId)
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
      await org.forbid(requireAgent(exec, 'org_forbid'), args.sessionId)
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
      exec.signal?.throwIfAborted()
      const target = fs.resolve(args.path, { cwd })
      const content = await fs.readText(target)
      exec.signal?.throwIfAborted()
      return { path: args.path, content }
    },
  })
}

/** `project_structure({path?})` — a bounded directory tree plus a per-file symbol index (names only). */
export function defineProjectStructureTool(_org: OrgApi, deps: OrgDeps): ToolDefinition {
  return defineTool({
    name: 'project_structure',
    description: 'List a bounded directory tree plus a per-file symbol index (exported declaration names only; never '
      + 'file contents) to understand the project layout and its public surface. node_modules and .git are skipped and '
      + 'the walk plus the symbol scan are depth- and size-limited.',
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
          symbols: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                symbols: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          symbolsTruncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [text([
        `${value.root}${value.truncated ? ' (truncated)' : ''}`,
        value.tree,
        '',
        symbolSection(value.symbols, value.symbolsTruncated),
      ].join('\n'))],
    },
    execute: async (args, exec) => {
      const caller = requireAgent(exec, 'project_structure')
      const fs = requireFs(deps, 'project_structure')
      const cwd = workspaceRoot(caller.session.header.cwd)
      const requested = args.path === undefined || args.path.trim() === '' ? '.' : args.path
      const absRoot = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested)
      const lines: string[] = []
      const files: TreeFile[] = []
      const state = { truncated: false }
      exec.signal?.throwIfAborted()
      await renderTree(fs, fs.resolve(absRoot, { cwd }), absRoot, absRoot, 0, lines, files, state, exec.signal)
      const index = await indexSymbols(fs, files, absRoot, exec.signal)
      return {
        root: absRoot,
        tree: lines.join('\n'),
        truncated: state.truncated,
        symbols: index.files,
        symbolsTruncated: index.truncated,
      }
    },
  })
}

/** Directory names the structure walk never descends into. */
const TREE_SKIP: Record<string, true> = { node_modules: true, '.git': true }
const TREE_MAX_DEPTH = 3
const TREE_MAX_ENTRIES = 500

/** One source file discovered by the walk, addressed for the symbol scan. */
interface TreeFile {
  /** Workspace-relative display path (the symbol index's grouping key). */
  readonly file: string
  /** Absolute path used to read and resolve the file. */
  readonly abs: string
}

/** A file's exported declaration names. */
interface FileSymbols {
  readonly file: string
  readonly symbols: string[]
}

/** Source extensions the symbol scan reads (documentation and data files stay unread). */
const SYMBOL_EXTENSIONS: Record<string, true> = {
  '.ts': true, '.tsx': true, '.mts': true, '.cts': true,
  '.js': true, '.jsx': true, '.mjs': true, '.cjs': true,
}

/** Bounds that keep the symbol index cheap and bounded (the tree is clipped independently). */
const SYMBOL_MAX_FILES = 200
const SYMBOL_MAX_PER_FILE = 40
const SYMBOL_MAX_TOTAL = 1200
const SYMBOL_MAX_SOURCE_CHARS = 512_000

/**
 * Exported declaration patterns. Matching is line-anchored and name-only: the
 * captured text is the symbol, never the declaration body.
 */
const SYMBOL_PATTERNS: readonly RegExp[] = [
  /^\s*export\s+(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:declare\s+)?(?:const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+default\s+(?:async\s+)?(?:class|function)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s*\{([^}]*)\}/gm,
]

/**
 * Extract exported declaration names from one source text, in declaration
 * order and deduplicated. `export { a, b as c }` contributes the exported
 * names (`a`, `c`), never aliases that stay private.
 * @param source - the file's text.
 * @returns the exported names (at most `SYMBOL_MAX_PER_FILE`).
 */
function extractSymbols(source: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const add = (name: string): void => {
    if (seen.has(name) || found.length >= SYMBOL_MAX_PER_FILE) return
    seen.add(name)
    found.push(name)
  }
  for (const pattern of SYMBOL_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] === undefined) continue
      if (pattern.source.includes('\\{')) {
        // `export { a, b as c }`: the clause is everything between the braces.
        for (const clause of match[1].split(',')) {
          const parts = clause.trim().split(/\s+as\s+/)
          const exported = (parts[1] ?? parts[0])?.trim()
          if (exported !== undefined && /^[A-Za-z_$][\w$]*$/.test(exported)) add(exported)
        }
        continue
      }
      add(match[1])
    }
  }
  return found
}

/**
 * Build the per-file symbol index over the files the tree walk discovered.
 * Each source file is read once; the returned names are the only code-derived
 * output (bodies never leave this function). A file that cannot be read is
 * skipped rather than failing the structure query.
 * @param fs - the filesystem seam.
 * @param files - source and non-source files discovered by the walk.
 * @param root - the walk root (resolve cwd for the read targets).
 * @param signal - cancellation for the scan.
 * @returns the per-file index (only files with symbols appear) and whether a bound clipped it.
 */
async function indexSymbols(
  fs: FsProbe,
  files: readonly TreeFile[],
  root: string,
  signal: AbortSignal | undefined,
): Promise<{ files: FileSymbols[]; truncated: boolean }> {
  const index: FileSymbols[] = []
  let scanned = 0
  let total = 0
  let truncated = false
  for (const file of files) {
    signal?.throwIfAborted()
    if (SYMBOL_EXTENSIONS[path.extname(file.file).toLowerCase()] !== true) continue
    if (scanned >= SYMBOL_MAX_FILES || total >= SYMBOL_MAX_TOTAL) {
      truncated = true
      break
    }
    scanned += 1
    let source: string
    try {
      source = await fs.readText(fs.resolve(file.abs, { cwd: root }))
    } catch {
      continue
    }
    if (source.length > SYMBOL_MAX_SOURCE_CHARS) {
      truncated = true
      continue
    }
    const symbols = extractSymbols(source)
    if (symbols.length === 0) continue
    total += symbols.length
    index.push({ file: file.file, symbols })
  }
  return { files: index, truncated }
}

/** Render the symbol index section (one line per file). */
function symbolSection(symbols: readonly FileSymbols[], truncated: boolean): string {
  if (symbols.length === 0) return 'Symbols (exported declarations): (none found in scanned source files)'
  const lines = [
    `Symbols (exported declarations${truncated ? ', truncated' : ''}):`,
    ...symbols.map(entry => `${entry.file}: ${entry.symbols.join(', ')}`),
  ]
  return lines.join('\n')
}

/** Recursively append one bounded directory level (names only) and collect its files. */
async function renderTree(
  fs: FsProbe,
  target: unknown,
  root: string,
  absDir: string,
  depth: number,
  lines: string[],
  files: TreeFile[],
  state: { truncated: boolean },
  signal: AbortSignal | undefined,
): Promise<void> {
  if (state.truncated) return
  signal?.throwIfAborted()
  const entries = [...await fs.listDir(target)].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (TREE_SKIP[entry.name] === true) continue
    if (lines.length >= TREE_MAX_ENTRIES) {
      state.truncated = true
      return
    }
    const marker = entry.type === 'directory' ? '/' : entry.type === 'other' ? ' ~' : ''
    lines.push(`${'  '.repeat(depth)}${entry.name}${marker}`)
    const child = `${absDir}/${entry.name}`
    if (entry.type === 'directory' && depth < TREE_MAX_DEPTH) {
      await renderTree(fs, fs.resolve(child, { cwd: absDir }), root, child, depth + 1, lines, files, state, signal)
    } else if (entry.type === 'file') {
      files.push({ file: child.slice(root.length + 1), abs: child })
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

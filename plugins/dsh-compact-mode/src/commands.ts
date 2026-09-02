/**
 * `/compact*` command registration: model-free, results visible immediately.
 *
 * Registered through `ctx.commands` (the command child activates only when a
 * command registry is composed). Command names follow `^[a-z][a-z0-9_-]*$`;
 * the profile must disable the `command-compact` row to avoid the duplicate
 * `compact` registration error.
 *
 * @module @dsh-plugin/dsh-compact-mode/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { TreeNodeWithChildren } from '@dsh-plugin/tree-engine'
import type { CompactModeEngine } from './engine.ts'
import type { ReviewNodeContent } from './tree.ts'

/** Structural probe for the optional plan-mode / vibe-mode services (type-only deps). */
interface ModeProbe {
  get(agent: Agent): { active: boolean; pending?: boolean }
}

/** Whether another exclusive mode (plan/vibe) is active for the agent. */
function conflictingMode(ctx: Context, agent: Agent): string | undefined {
  const plan = ctx.get('planMode') as ModeProbe | undefined
  if (plan?.get(agent).active) return 'plan mode'
  const vibe = ctx.get('vibeMode') as ModeProbe | undefined
  if (vibe?.get(agent).active) return 'vibe mode'
  return undefined
}

/** Success result with text. */
function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

/** Error result with text. */
function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

/** Register every `/compact*` command on the engine's context. */
export function registerCompactCommands(ctx: Context, engine: CompactModeEngine): void {
  ctx.inject(['commands'], (commandCtx) => {
    const commands = commandCtx.commands

    const enter: CommandDefinition['handler'] = async ({ agent, signal, commandId }) => {
      const mode = engine.mode.get(agent)
      if (mode.active || engine.reviews.isActive(agent.session)) {
        return ok('Compact mode is already active. Use /compact_edit <text> to revise the draft, /compact_apply to apply it, or /compact_abort to leave without applying.')
      }
      const conflict = conflictingMode(ctx, agent)
      if (conflict !== undefined) {
        return fail(`Cannot enter compact mode while ${conflict} is active. Exit ${conflict} first.`)
      }
      try {
        await engine.compactNow(agent, signal, commandId)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      return ok('Compact mode active: the live loop is paused; the first draft is being generated. Use /compact_edit <text> to revise, /compact view <n> to inspect, /compact_apply to apply, or /compact_abort to leave without applying.')
    }

    const treeCommand: CommandDefinition['handler'] = async ({ agent }) => {
      let state
      try {
        state = await engine.reviews.treeView(agent)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      const tree = await state.tree.engine.getTree()
      if (tree.length === 0) return ok('Review tree is empty.')
      const lines: string[] = []
      const visit = (nodes: TreeNodeWithChildren<ReviewNodeContent>[], depth: number): void => {
        for (const node of nodes) {
          const preview = node.content.draft.split('\n')[0]?.slice(0, 60) ?? ''
          lines.push(`${'  '.repeat(depth)}${node.id}${depth === 0 ? ' (root)' : ''}${preview ? `: ${preview}` : ''}`)
          visit(node.children, depth + 1)
        }
      }
      visit(tree, 0)
      return ok(lines.join('\n'))
    }

    const viewCommand: CommandDefinition['handler'] = async ({ agent, rawInput }) => {
      const nodeId = rawInput.trim()
      if (nodeId === '') return fail('Usage: /compact view <nodeId>')
      let state
      try {
        state = await engine.reviews.treeView(agent)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      const node = await state.tree.engine.getNode(nodeId)
      if (node === undefined) return fail(`No review node "${nodeId}".`)
      const instruction = node.content.instruction === '' ? '(seed draft)' : node.content.instruction
      return ok(`Node ${node.id} — instruction: ${instruction}\n\n${node.content.draft}`)
    }

    const jumpCommand: CommandDefinition['handler'] = async ({ agent, rawInput }) => {
      const nodeId = rawInput.trim()
      if (nodeId === '') return fail('Usage: /compact jump <nodeId>')
      let state
      try {
        state = await engine.reviews.treeView(agent)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      try {
        await state.tree.engine.branchTo(nodeId)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      const node = await state.tree.engine.getNode(nodeId)
      state.draft = node?.content.draft ?? state.draft
      return ok(`Branched to node ${nodeId}. Future revisions start from this draft.`)
    }

    const diffCommand: CommandDefinition['handler'] = async ({ agent, rawInput }) => {
      const [a, b] = rawInput.trim().split(/\s+/)
      if (a === undefined || b === undefined || a === '' || b === '') {
        return fail('Usage: /compact diff <nodeIdA> <nodeIdB>')
      }
      let state
      try {
        state = await engine.reviews.treeView(agent)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      const nodeA = await state.tree.engine.getNode(a)
      const nodeB = await state.tree.engine.getNode(b)
      if (nodeA === undefined || nodeB === undefined) return fail('One of the requested nodes does not exist.')
      return ok(`Diff ${a} → ${b}:\n${simpleDiff(nodeA.content.draft, nodeB.content.draft)}`)
    }

    commands.register({
      name: 'compact',
      description: 'Enter compact mode, or inspect the review tree',
      input: { hint: '[tree|view <node>|jump <node>|diff <a> <b>]' },
      handler: async (invocation) => {
        const sub = invocation.rawInput.trim()
        if (sub === '') return enter(invocation)
        if (sub === 'tree') return treeCommand(invocation)
        if (sub.startsWith('view ')) return viewCommand(invocation)
        if (sub.startsWith('jump ')) return jumpCommand(invocation)
        if (sub.startsWith('diff ')) return diffCommand(invocation)
        return fail(`Unknown /compact subcommand "${sub}". Supported: tree, view <node>, jump <node>, diff <a> <b>.`)
      },
    })

    commands.register({
      name: 'compact_edit',
      description: 'Revise the compact-mode draft with an instruction',
      input: { hint: '<instruction>' },
      handler: async ({ agent, rawInput, signal }) => {
        const instruction = rawInput.trim()
        if (instruction === '') return fail('Usage: /compact_edit <instruction>')
        try {
          const { nodeId } = await engine.reviews.edit(agent, instruction, signal)
          return ok(`Revision ${nodeId} landed. Use /compact view ${nodeId} to inspect, /compact_apply to apply.`)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      },
    })

    commands.register({
      name: 'compact_apply',
      description: 'Apply the current compact-mode draft and leave compact mode',
      handler: async ({ agent, signal, commandId }) => {
        try {
          const result = await engine.reviews.apply(agent, commandId, signal)
          return ok(`Compaction applied: shadowed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens). Compact mode off.`)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      },
    })

    commands.register({
      name: 'compact_abort',
      description: 'Leave compact mode without applying the draft',
      handler: async ({ agent, signal }) => {
        try {
          await engine.reviews.abort(agent, 'aborted by user', signal)
          return ok('Compact mode off; the review tree was preserved. It will be deleted if the conversation continues.')
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      },
    })
  })
}

/** Minimal line-level diff for two drafts (display only). */
export function simpleDiff(a: string, b: string): string {
  const linesA = a.split('\n')
  const linesB = b.split('\n')
  const out: string[] = []
  let i = 0
  let j = 0
  // Greedy alignment on the longest common prefix/suffix.
  while (i < linesA.length && j < linesB.length && linesA[i] === linesB[j]) {
    i++
    j++
  }
  let suffixA = linesA.length - 1
  let suffixB = linesB.length - 1
  while (suffixA >= i && suffixB >= j && linesA[suffixA] === linesB[suffixB]) {
    suffixA--
    suffixB--
  }
  for (let k = i; k <= suffixA; k++) out.push(`- ${linesA[k]}`)
  for (let k = j; k <= suffixB; k++) out.push(`+ ${linesB[k]}`)
  return out.length === 0 ? '(identical)' : out.join('\n')
}

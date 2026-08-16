/**
 * The five model-facing DIRECTOR tools: `vibe_spawn`, `vibe_send`,
 * `vibe_wait`, `vibe_kill`, `vibe_list`. They are registered on the
 * director's OWN scoped ctx (`agent.ctx.tools.register`), so they are visible
 * only to that agent, survive `tools.restrict` (scope-local registrations are
 * exempt from the inherited-layer mask), and unwind with the agent.
 *
 * @module @dsh-plugin/dsh-vibe-mode/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ResolvedVibeModeConfig, VibeTier } from './types.ts'
import { WorkerRegistry, childSessionEvents } from './workers.ts'

/** Shared output shape of one `vibe_wait` per-session result. */
const TURN_END_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session: { type: 'string', required: true },
    turn: { type: 'integer', required: true },
    status: { type: 'string', required: true, enum: ['completed', 'timeout', 'aborted', 'disposed'] },
    output: { type: 'string' },
  },
} as const

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Require the calling agent (the director) or fail loudly. */
function requireDirector(exec: { agent?: Agent }): Agent {
  if (exec.agent === undefined) {
    throw new Error('vibe tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/**
 * Build the five vibe tools bound to one director's worker registry.
 * @param ctx - the plugin root ctx (services resolve through the director's
 *   scoped ctx at execution time, but the registry/root listeners live here).
 * @param registry - this director's worker registry.
 * @param config - validated deployment config.
 * @returns the five tool definitions, ready for `agent.ctx.tools.register`.
 */
export function defineVibeTools(
  ctx: Context,
  registry: WorkerRegistry,
  config: ResolvedVibeModeConfig,
): ToolDefinition[] {
  const provider = config.provider
  const waitDefault = config.waitTimeoutMs
  const waitCap = config.maxWaitTimeoutMs

  const spawn = defineTool({
    name: 'vibe_spawn',
    description: 'Start a worker subagent that persists as its own session. '
      + 'Use only in vibe mode. Choose `fast` for quick mechanical work and `good` for harder tasks; '
      + '`fast` and `good` route to the models the deployment configured. '
      + 'The call returns immediately with the worker\'s durable id; get the result with `vibe_wait`. '
      + 'Workers run independently and keep their conversation across turns.',
    parameters: {
      cli: { type: 'string', required: true, enum: ['fast', 'good'], description: 'Worker tier: fast or good.' },
      prompt: { type: 'string', required: true, description: 'The task to delegate to the worker.' },
      name: { type: 'string', description: 'Optional short name used as the worker\'s session label.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subagentId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(`started vibe worker ${value.subagentId}`),
    },
    async execute(args, exec) {
      const director = requireDirector(exec)
      const tier: VibeTier = args.cli
      const tierConfig = config.tiers?.[tier]
      const request = {
        prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
        parent: director,
        ...tierConfig !== undefined && (tierConfig.provider !== undefined || tierConfig.model !== undefined)
          ? { agentOptions: { ...tierConfig.provider !== undefined ? { provider: tierConfig.provider } : {}, ...tierConfig.model !== undefined ? { model: tierConfig.model } : {} } }
          : {},
      }
      const started = await ctx.subagents.startContinuable({
        provider,
        label: args.name ?? `vibe ${tier} worker`,
        request,
        signal: exec.signal,
      })
      registry.spawn(started.childId, tier, args.name ?? `vibe ${tier} worker`, childSessionEvents(ctx, started.childId))
      return { subagentId: started.childId }
    },
  })

  const send = defineTool({
    name: 'vibe_send',
    description: 'Send a follow-up message to a vibe worker, starting its next turn. '
      + 'The worker keeps its full conversation history; the message joins its FIFO queue. '
      + 'Collect the reply with `vibe_wait`.',
    parameters: {
      session: { type: 'string', required: true, description: 'The worker\'s subagent id from vibe_spawn.' },
      message: { type: 'string', required: true, description: 'The message to deliver to the worker.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(`delivered to worker, inbox message ${value.messageId}`),
    },
    async execute(args, exec) {
      const director = requireDirector(exec)
      const childId = args.session as SessionId
      const messageId = await ctx.subagents.followup(director, childId, [{ type: 'text', text: args.message }], {
        source: { kind: 'coordinator', form: 'relay', senderSessionId: director.id },
        signal: exec.signal,
      })
      registry.send(childId, childSessionEvents(ctx, childId))
      return { messageId }
    },
  })

  const wait = defineTool({
    name: 'vibe_wait',
    description: 'Block until the named vibe workers finish their current turn, returning each worker\'s final reply. '
      + 'With no `sessions`, waits for every worker this director spawned. '
      + 'Each result reports the completed turn number, its status (completed/timeout/aborted/disposed), '
      + 'and the worker\'s final output text. A timed-out wait returns [status: timeout] and leaves the worker running.',
    parameters: {
      sessions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Worker subagent ids to wait for; omit to wait for all workers.',
      },
      timeout: {
        type: 'number',
        description: 'Max wait in milliseconds for each worker. Defaults to the configured wait timeout; capped by the configured maximum.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', required: true, items: TURN_END_RESULT_SCHEMA },
        },
      },
      render: (_args, value) => {
        const lines = (value.results as Array<{ session: string; turn: number; status: string; output?: string }>)
          .map(result => result.output !== undefined
            ? `[${result.session} turn ${result.turn} ${result.status}] ${result.output}`
            : `[${result.session} turn ${result.turn} ${result.status}]`)
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const timeout = Math.min(args.timeout ?? waitDefault, waitCap)
      const sessions: SessionId[] = Array.isArray(args.sessions) && args.sessions.length > 0
        ? args.sessions.map((id: string) => id as SessionId)
        : registry.list().map(worker => worker.childId)
      if (sessions.length === 0) {
        throw new Error('vibe_wait: no workers to wait for — spawn one with vibe_spawn first')
      }
      const results = await Promise.all(sessions.map(async (childId) => {
        const record = registry.get(childId)
        if (record === undefined) {
          throw new Error(`vibe_wait: unknown worker session ${childId} — spawn or send to it first`)
        }
        const target = record.lastTurn
        return registry.waitForTurn(childId, target, () => childSessionEvents(ctx, childId), {
          timeoutMs: timeout,
          signal: exec.signal,
        })
      }))
      return { results }
    },
  })

  const kill = defineTool({
    name: 'vibe_kill',
    description: 'Stop a vibe worker\'s current turn (park). The worker\'s session, queued messages, and '
      + 'descendants are preserved; a later `vibe_send` resumes it. The turn ends with status aborted.',
    parameters: {
      session: { type: 'string', required: true, description: 'The worker\'s subagent id from vibe_spawn.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          parked: { type: 'boolean', required: true },
        },
      },
      render: () => textBlock('worker parked (current turn interrupted; session preserved)'),
    },
    async execute(args, exec) {
      const director = requireDirector(exec)
      ctx.subagents.interrupt(args.session as SessionId, { kind: 'ancestor', agent: director })
      return { parked: true }
    },
  })

  const list = defineTool({
    name: 'vibe_list',
    description: 'List every worker this director spawned: its durable id, tier, label, dispatched turns, '
      + 'and live status (running/idle, or inactive when only persisted).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                session: { type: 'string', required: true },
                tier: { type: 'string', required: true, enum: ['fast', 'good'] },
                label: { type: 'string', required: true },
                turns: { type: 'integer', required: true },
                status: { type: 'string', required: true, enum: ['running', 'idle', 'inactive'] },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = (value.workers as Array<{ session: string; tier: string; label: string; turns: number; status: string }>)
          .map(worker => `${worker.session} [${worker.tier}] ${worker.label} turns=${worker.turns} ${worker.status}`)
        return textBlock(lines.length > 0 ? lines.join('\n') : '(no workers)')
      },
    },
    async execute(_args, exec) {
      const director = requireDirector(exec)
      const children = await ctx.subagents.listChildren(director.id, exec.signal)
      const workers = children
        .filter((entry): entry is typeof entry & { kind: 'child' } => entry.kind === 'child')
        .map((entry): {
          session: string
          tier: 'fast' | 'good'
          label: string
          turns: number
          status: 'running' | 'idle' | 'inactive'
        } => {
          const record = registry.get(entry.id)
          const live = ctx.get('agents')?.get(entry.id)
          return {
            session: entry.id,
            tier: record?.tier ?? 'good',
            label: record?.label ?? entry.label ?? entry.id,
            turns: record?.dispatched ?? 0,
            status: live === undefined ? 'inactive' : live.status,
          }
        })
      return { workers }
    },
  })

  return [spawn, send, wait, kill, list]
}

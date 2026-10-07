/**
 * The global `peer_send` tool: the coordinator-to-coordinator channel.
 *
 * It is registered on the root tool layer; WHO may call it is decided by the
 * role envelope's `tools.restrict` allow-mask, not by this tool — so the tool
 * itself carries only the addressing contract. It is deliberately NOT declared
 * concurrency-safe: a send appends to another session's log and may wake that
 * agent, so two in-flight sends must not interleave by the scheduler's choice.
 *
 * @module @dsh-plugin/dsh-peers/tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PeersServiceApi } from './types.ts'

/** The tool's registered name. */
export const PEER_SEND_TOOL = 'peer_send'

/** Canonical value returned by the tool. */
export interface PeerSendValue {
  /** `delivered` or `duplicate`. */
  status: string
  /** The delivered (or pre-existing) message id. */
  messageId: string
}

/**
 * Build the `peer_send` tool definition.
 * @param peers - the peer-channel service (structural contract).
 * @returns the tool definition registered on the global tool layer.
 */
export function definePeerSendTool(peers: PeersServiceApi): ToolDefinition {
  return defineTool({
    name: PEER_SEND_TOOL,
    description: 'Send a message to ONE live session by its id — the coordinator-to-coordinator channel '
      + '(e.g. a lead reporting to its secretary, or a secretary handing a lead its task). '
      + '"quiet" only records the message in the target\'s inbox (the target sees it when it next runs); '
      + '"wakeup" (default) also starts or steers the target\'s turn so it acts on the message now. '
      + 'Address a session id, never a role name; a forbidden or unknown target is rejected.',
    parameters: {
      targetId: {
        type: 'string',
        required: true,
        description: 'The session id of the single live session to address.',
      },
      content: {
        type: 'string',
        required: true,
        description: 'The message body, non-empty and self-contained.',
      },
      delivery: {
        type: 'string',
        enum: ['quiet', 'wakeup'],
        description: 'quiet = inbox only; wakeup (default) = also start/steer the target\'s turn.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, description: 'delivered or duplicate.' },
          messageId: { type: 'string', required: true, description: 'The message id.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'duplicate'
          ? `Peer message ${value.messageId} was already delivered; nothing new was sent.`
          : `Peer message ${value.messageId} delivered.`,
      }],
    },
    execute: async (args, exec): Promise<PeerSendValue> => {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('peer_send: no calling agent — a peer message must be sent on behalf of an agent')
      }
      const result = await peers.send(agent, {
        targetId: args.targetId,
        content: args.content,
        ...args.delivery === undefined ? {} : { delivery: args.delivery },
      })
      return { status: result.status, messageId: result.message.messageId }
    },
  })
}

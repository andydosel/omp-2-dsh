/**
 * The durable half of the advisor card: the `advisor-advice` ConversationNode
 * definition.
 *
 * One keyed node per accepted advisory, anchored at the durable
 * `advisor/advice` session event the host appended when it routed that
 * advisory. The event is log-only (it never enters model history or rewrites
 * the conversation surface), so replaying a window and watching live agree:
 * the card is the same record either way.
 *
 * @module @dsh-plugin/dsh-advisor/client/advisor-advice-node
 */

import type { ConversationNodeContext, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the `advisor/advice` SessionEventMap merge this face matches.
import type {} from '../../src/types.ts'
import type { AdvisorAdviceEvent } from '../../src/types.ts'

/** Renderer dispatch key of the advisor card (also the keyed slot key). */
export const ADVISOR_ADVICE_NODE_KIND = 'advisor-advice'

/** Payload of one advisor card: exactly the durable event's business fields. */
export interface AdvisorAdviceChatData {
  /** Advisory grade. */
  readonly severity: AdvisorAdviceEvent['severity']
  /** The reviewer's note. */
  readonly note: string
  /** Reviewer roster name that produced the advice. */
  readonly reviewer: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One accepted advisory rendered as a severity-graded card. */
    'advisor-advice': AdvisorAdviceChatData
  }
}

/** Final chat node produced by {@link advisorAdviceDefinition}. */
export interface AdvisorAdviceViewNode extends ChatConversationViewNode {
  readonly kind: typeof ADVISOR_ADVICE_NODE_KIND
  readonly data: AdvisorAdviceChatData
}

/** Read the advisory payload off one event, or null for any other event. */
function adviceOfEvent(event: { type: string; data?: unknown }): AdvisorAdviceEvent | null {
  if (event.type !== 'advisor/advice') return null
  const data = event.data as Partial<AdvisorAdviceEvent> | undefined
  if (data === undefined
    || (data.severity !== 'nit' && data.severity !== 'concern' && data.severity !== 'blocker')
    || typeof data.note !== 'string'
    || typeof data.reviewer !== 'string') return null
  return { severity: data.severity, note: data.note, reviewer: data.reviewer }
}

/** Build the card node for one advice event. */
function adviceNode(context: ConversationNodeContext<AdvisorAdviceChatData>, data: AdvisorAdviceChatData): AdvisorAdviceViewNode {
  return {
    key: context.key,
    kind: ADVISOR_ADVICE_NODE_KIND,
    id: context.id,
    target: 'chat',
    anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
    // Session location: a turn/step-located node would be folded into the
    // completed turn's "Called tools" disclosure and hidden. The advisory is a
    // root transcript entry at the seq where it was recorded.
    location: { kind: 'session' },
    visibility: 'visible',
    data,
  }
}

/**
 * The advisor card Definition: one card per `advisor/advice` event, keyed by
 * the event's seq so every advisory keeps its own place across replay.
 */
export const advisorAdviceDefinition: ConversationNodeDefinition<AdvisorAdviceChatData> = {
  kind: ADVISOR_ADVICE_NODE_KIND,
  target: 'chat',
  match: (event) => {
    const advice = adviceOfEvent(event as { type: string; data?: unknown })
    return advice === null
      ? null
      : { id: String((event as { seq: number }).seq), role: 'start' }
  },
  start: (_context, match) => {
    const advice = adviceOfEvent(match.event as { type: string; data?: unknown })
    if (advice === null) throw new Error('advisor-advice start requires advisor/advice')
    return advice
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: context => context.state === undefined ? null : adviceNode(context as ConversationNodeContext<AdvisorAdviceChatData>, context.state),
}

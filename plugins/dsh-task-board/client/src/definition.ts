/**
 * Task-board ConversationNode Definition (browser half): the session's
 * `task/*` ledger events fold into ONE singleton board panel —
 * `kind: 'task-board'`, `id: 'board'` — anchored at the earliest loaded
 * `task/*` event. The panel's payload is the board as of that anchor; the
 * renderer overlays the live host-computed `taskBoard` projection on top, so
 * tasks created AFTER the anchor still appear while history replay (where the
 * projection frame has not landed yet) renders the folded payload.
 *
 * Both halves read the same whole-value event contract the host projection
 * uses: every `task/*` event carries the complete post-change task, so the
 * client fold is an id-keyed upsert with the `deleted` tombstones dropped
 * (the projection's `viewTaskBoard` rule). The host's `projection.ts` is NOT
 * imported — it carries zod and the whole host-side unit, none of which a
 * browser bundle should inline.
 *
 * @module @dsh-plugin/dsh-task-board/client/definition
 */

import type {
  ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the `task/*` SessionEventMap merge (the payload types the
// fold reads) and the `taskBoard` SessionProjectionMap merge behind
// `useProjection('taskBoard')` in the renderer.
import type {} from '../../src/types.ts'
import type { TaskBoardState, TaskSnapshot } from '../../src/types.ts'

/** Renderer dispatch key of the task-board panel (also the keyed slot key). */
export const TASK_BOARD_NODE_KIND = 'task-board'

/** Definition-local identity of the singleton board panel. */
export const TASK_BOARD_NODE_ID = 'board'

/** Payload of the `task-board` chat node: the board at the node's anchor event. */
export interface TaskBoardNodeData {
  /** Tombstone-free board, in creation order. */
  readonly tasks: TaskBoardState
}

/** Final chat node produced by {@link taskBoardDefinition}. */
export interface TaskBoardViewNode extends ChatConversationViewNode {
  readonly kind: typeof TASK_BOARD_NODE_KIND
  readonly data: TaskBoardNodeData
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Coordinator task board: the attention work set plus the full ledger. */
    'task-board': TaskBoardNodeData
  }
}

/** The empty board (same value as the host's `EMPTY_TASK_BOARD`, redeclared to keep zod out of the bundle). */
const EMPTY_BOARD: TaskBoardState = []

/** Read the complete post-change task one `task/*` event carries, if any. */
function taskOfEvent(event: SessionEvent): TaskSnapshot | undefined {
  switch (event.type) {
    case 'task/new':
    case 'task/update':
    case 'task/closed':
    case 'task/reopened':
      return event.data.task
    default:
      return undefined
  }
}

/**
 * Fold one whole-value task event into the board: replace by id in place, or
 * append a new task; `deleted` tombstones leave the view (creation order is
 * preserved, so the panel's rows stay stable across updates).
 * @param tasks - current tombstone-free board.
 * @param task - complete post-change task from one `task/*` event.
 * @returns the next board.
 */
function upsertTask(tasks: TaskBoardState, task: TaskSnapshot): TaskBoardState {
  const index = tasks.findIndex(candidate => candidate.id === task.id)
  if (index < 0) return task.status === 'deleted' ? tasks : [...tasks, task]
  return task.status === 'deleted'
    ? [...tasks.slice(0, index), ...tasks.slice(index + 1)]
    : [...tasks.slice(0, index), task, ...tasks.slice(index + 1)]
}

/**
 * Build the final chat node for one folded board. Kept out of `buildViewNode`
 * so the node is a typed value rather than an object literal checked against
 * the wide `ConversationViewNode` return type.
 */
function boardNode(context: ConversationNodeContext<TaskBoardState>, tasks: TaskBoardState): TaskBoardViewNode {
  return {
    key: context.key,
    kind: TASK_BOARD_NODE_KIND,
    id: context.id,
    target: 'chat',
    anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
    location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    data: { tasks },
  }
}

/**
 * The task-board Definition: one board panel per session, updated by every
 * later `task/*` event. Every matching event is offered as a start so a
 * mid-history window still materializes the panel (the earliest loaded start
 * wins; the rest arrive as updates).
 */
export const taskBoardDefinition: ConversationNodeDefinition<TaskBoardState> = {
  kind: TASK_BOARD_NODE_KIND,
  target: 'chat',
  match: (event) => {
    const task = taskOfEvent(event as SessionEvent)
    return task === undefined ? null : { id: TASK_BOARD_NODE_ID, role: 'start' }
  },
  start: (_context, match) => {
    const task = taskOfEvent(match.event as SessionEvent)
    return task === undefined ? EMPTY_BOARD : upsertTask(EMPTY_BOARD, task)
  },
  update: (context, match) => {
    const task = taskOfEvent(match.event as SessionEvent)
    return task === undefined ? context.state : upsertTask(context.state, task)
  },
  publication: () => 'immediate',
  buildViewNode: (context) => boardNode(context, context.state ?? EMPTY_BOARD),
}

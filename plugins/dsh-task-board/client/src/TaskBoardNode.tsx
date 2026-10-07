/**
 * Task-board chat renderer: the `task-board` keyed `conversation.chat.node`
 * entry. Renders the attention work set (checked, highlighted — exactly the
 * tasks whose subjects the work-set prompt section injects) above the full
 * ledger, one row per task with a status badge, an id, the requirement
 * subject, the accumulated `P0` finding count, a work-set checkbox, and the
 * close/reopen button.
 *
 * Data comes from the host-computed `taskBoard` projection through the standard
 * `useProjection` seat (zero client-side folding); the node's own folded
 * payload is the fallback while the projection frame is absent (history
 * replay). Every mutation goes out as a `/task …` line through the injected
 * `runTaskCommand` face, so the host service stays the only writer.
 *
 * @module @dsh-plugin/dsh-task-board/client/TaskBoardNode
 */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `conversation.chat.node` keyed seat + ChatNodeDataMap
// merge (ui-chat) and the SessionStandardProps merge (sessionId +
// useProjection) a session-scope seat delivers.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TaskBoardState, TaskSnapshot, TaskStatus } from '../../src/types.ts'
import css from './TaskBoardNode.module.css'

/** Injected business face: the `/task` command runner of the owning session. */
export interface TaskBoardNodeInjected {
  /**
   * Execute one `/task …` line for the owning session.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  runTaskCommand: (line: string) => Promise<string | null>
}

/** Full props of the task-board panel: seat kit + injected command runner. */
export type TaskBoardNodeProps =
  PropsRuntime<'conversation.chat.node', 'task-board'> & InjectFace<TaskBoardNodeInjected>

/** Terminal states: no further work is expected and they left the work set. */
const TERMINAL_BY_STATUS: Record<TaskStatus, boolean> = {
  pending: false,
  in_progress: false,
  awaiting_approval: false,
  completed: true,
  closed: true,
  deleted: true,
}

/** Short badge label per life-cycle state. */
const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'pending',
  in_progress: 'working',
  awaiting_approval: 'approval',
  completed: 'done',
  closed: 'closed',
  deleted: 'deleted',
}

/** Class map of one status badge (CSS module lookups may resolve to undefined under noUncheckedIndexedAccess). */
const STATUS_CLASS: Record<TaskStatus, string | undefined> = {
  pending: css.statusPending,
  in_progress: css.statusWorking,
  awaiting_approval: css.statusApproval,
  completed: css.statusDone,
  closed: css.statusClosed,
  deleted: css.statusClosed,
}

/**
 * One task row: badge, id, subject, findings, work-set checkbox, and the
 * close/reopen button.
 */
function TaskRow({ task, busy, onToggleFocus, onClose, onReopen }: {
  task: TaskSnapshot
  busy: boolean
  onToggleFocus: (task: TaskSnapshot, focused: boolean) => void
  onClose: (task: TaskSnapshot) => void
  onReopen: (task: TaskSnapshot) => void
}) {
  const terminal = TERMINAL_BY_STATUS[task.status]
  const focused = task.inContext && !terminal
  const p0 = task.findings.filter(finding => finding.severity === 'P0').length
  return (
    <li className={focused ? css.rowFocused : css.row}>
      <input
        type="checkbox"
        className={css.check}
        checked={focused}
        disabled={busy || terminal}
        aria-label={`work set: ${task.subject}`}
        title={terminal
          ? 'terminal task — reopen it to put it back in the work set'
          : 'work set: checked subjects are injected into the prompt'}
        onChange={event => onToggleFocus(task, event.currentTarget.checked)}
      />
      <span className={`${css.status} ${STATUS_CLASS[task.status]}`}>{STATUS_LABEL[task.status]}</span>
      <code className={css.id}>{task.id}</code>
      <span className={css.subject} title={task.subject}>{task.subject}</span>
      {task.reviewRound > 0 && <span className={css.meta} title="review rounds">r{task.reviewRound}</span>}
      {p0 > 0 && <span className={css.p0} title="P0 findings">P0×{p0}</span>}
      {terminal
        ? (
            <button
              type="button"
              className={css.action}
              disabled={busy}
              title="reopen this task (back to pending, back in the work set)"
              onClick={() => onReopen(task)}
            >
              reopen
            </button>
          )
        : (
            <button
              type="button"
              className={css.action}
              disabled={busy}
              title="close this task (tombstone kept; reopen restores it)"
              onClick={() => onClose(task)}
            >
              close
            </button>
          )}
    </li>
  )
}

/**
 * The task-board panel. Renders unconditionally once the Definition produced a
 * node; the live projection wins over the folded payload whenever it is
 * present, so tasks created after the node's anchor event still show up.
 */
export function TaskBoardNode({ node, useProjection, runTaskCommand }: TaskBoardNodeProps) {
  const live: TaskBoardState | undefined = useProjection('taskBoard')
  const tasks = live ?? node.data.tasks
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const run = (task: TaskSnapshot, line: string): void => {
    setBusyId(task.id)
    setError(null)
    void runTaskCommand(line).then((failure) => {
      if (!aliveRef.current) return
      setBusyId(null)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setBusyId(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const workSet = tasks.filter(task => task.inContext && !TERMINAL_BY_STATUS[task.status])
  const closeCount = tasks.filter(task => task.status === 'closed').length
  const doneCount = tasks.filter(task => task.status === 'completed').length

  return (
    <section className={css.panel} data-task-board={node.id}>
      <header className={css.head}>
        <span className={css.title}>TASK BOARD</span>
        <span className={css.counts}>
          {`${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${workSet.length} in the work set`}
          {doneCount > 0 ? ` · ${doneCount} done` : ''}
          {closeCount > 0 ? ` · ${closeCount} closed` : ''}
        </span>
      </header>
      {workSet.length > 0 && (
        <div className={css.workSet}>
          <span className={css.sectionLabel} title="subjects injected into the coordinator's prompt">work set</span>
          <span className={css.chips}>
            {workSet.map(task => <code key={task.id} className={css.chip}>{task.id}</code>)}
          </span>
        </div>
      )}
      <ul className={css.list}>
        {tasks.map(task => (
          <TaskRow
            key={task.id}
            task={task}
            busy={busyId === task.id}
            onToggleFocus={(target, focused) => run(target, `/task ${focused ? 'focus' : 'unfocus'} ${target.id}`)}
            onClose={target => run(target, `/task close ${target.id}`)}
            onReopen={target => run(target, `/task reopen ${target.id}`)}
          />
        ))}
      </ul>
      {/* Failure copy stays English (error-surface policy: not localized). */}
      {error !== null && <p className={css.error} role="status">{error}</p>}
    </section>
  )
}

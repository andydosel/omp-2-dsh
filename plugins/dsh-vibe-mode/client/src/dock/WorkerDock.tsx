/**
 * Vibe worker dock: lists the director's live workers from the host-computed
 * `vibeWorkers` projection, with a per-row state icon (starting: gray pulse;
 * running: blue; idle: gray; parked: yellow; dead: red), a tier chip, and a
 * "隐藏已完成" filter that hides dead rows by default. Clicking a row opens
 * that worker's session (`ctx.sessions.open`); when the current session IS a
 * worker session the dock shows a "返回主会话" button back to the director.
 *
 * The dock is COLLAPSED by default (QueueDock/TodoPanel posture): it renders
 * a slim header bar (title + live-count badge + chevron) that takes
 * near-zero vertical space so it never obstructs the chat transcript; the
 * full list, the hide-completed filter, and the waiting hint appear only
 * when the user expands it.
 *
 * Waiting indicator (presentational only — wait behavior is host-side): any
 * `running` worker carries an extra animated spinner distinct from the plain
 * running dot, and while at least one worker runs the dock footer shows
 * `等待 worker 完成,你可随时发言` so the user knows the main session is NOT
 * blocked. The spinner is keyed by `id:turn`, so projection re-renders never
 * restart the CSS animation mid-turn (no flicker).
 *
 * @module @dsh-plugin/dsh-vibe-mode/client/dock
 */

import { useMemo, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the vibeWorkers SessionProjectionMap merge.
import type {} from '../../../src/types.ts'
import type { VibeWorkerState, VibeWorkerView } from '../../../src/types.ts'
import { dockPresentation, hasRunningWorker } from './dock-state.ts'
import styles from './WorkerDock.module.css'

/** Extra props the dock entry injects. */
export interface WorkerDockInjected {
  /** Open a session by id (session tree navigation). */
  openSession: (id: string) => void
  /** Direct-parent address of a session id, when the subagent catalog knows it. */
  parentOf: (id: string) => string | undefined
  /** The panel-state remembered director session id. */
  rememberedDirector: () => string | undefined
  /** Record the director session id on the panel state. */
  rememberDirector: (id: string) => void
}

/** Full props of a dock entry: InputZone owner share + session standard kit + injected face. */
export type WorkerDockProps = PropsRuntime<'conversation.input.dock'> & InjectFace<WorkerDockInjected>

/** State-icon modifier (CSS-driven). */
const STATE_CLASS: Record<VibeWorkerState, string | undefined> = {
  starting: styles.stateStarting,
  running: styles.stateRunning,
  idle: styles.stateIdle,
  parked: styles.stateParked,
  dead: styles.stateDead,
}

/** Tier chip label. */
function tierLabel(tier: VibeWorkerView['tier']): string {
  return tier === 'fast' ? 'fast' : 'good'
}

/** One worker row. */
function WorkerRow({ worker, open }: { worker: VibeWorkerView; open: () => void }): JSX.Element {
  const waiting = worker.state === 'running'
  return (
    <button type="button" className={styles.row} onClick={open} title={`打开会话 ${worker.id}`}>
      <span className={`${styles.stateIcon} ${STATE_CLASS[worker.state] ?? ''}`} aria-hidden="true">
        {/* The waiting spinner is a distinct, extra indicator on running workers. */}
        {waiting && <span key={`${worker.id}:${worker.turn ?? 0}`} className={styles.waitingSpinner} aria-hidden="true" />}
      </span>
      <span className={styles.name}>{worker.name === undefined ? worker.id : worker.name}</span>
      <span className={`${styles.tierChip} ${worker.tier === 'fast' ? styles.tierFast : styles.tierGood}`}>
        {tierLabel(worker.tier)}
      </span>
      <span className={styles.turn}>#{worker.turn}</span>
    </button>
  )
}

/**
 * Dock panel. Renders nothing when the current session carries no roster
 * (non-vibe sessions) — so it takes no vertical space when unused; it is
 * COLLAPSED by default (a slim header), and on the director session it lists
 * workers and records the director id on the panel state; on a worker
 * session (its id matches a roster row) it offers "返回主会话" back to the
 * remembered director.
 */
export function WorkerDock({ useProjection, sessionId, openSession, parentOf, rememberedDirector, rememberDirector }: WorkerDockProps): JSX.Element | null {
  const projection = useProjection('vibeWorkers')
  const workers = projection?.workers ?? []
  const [hideDone, setHideDone] = useToggle(true)
  const [collapsed, setCollapsed] = useToggle(true)

  const isWorkerSession = workers.some(worker => worker.id === sessionId)

  // Record the director id whenever this dock renders a non-worker session
  // with a live roster (the director session itself).
  useMemo(() => {
    if (!isWorkerSession && workers.length > 0) rememberDirector(sessionId)
  }, [isWorkerSession, workers.length, sessionId, rememberDirector])

  const { render, headerOnly, rows } = dockPresentation(workers, hideDone, collapsed)
  if (!render) return null

  const anyRunning = hasRunningWorker(workers)
  const directorId = isWorkerSession
    ? (parentOf(sessionId) ?? rememberedDirector())
    : undefined

  return (
    <div className={collapsed ? `${styles.dock} ${styles.dockCollapsed}` : styles.dock} data-vibe-dock="">
      <button
        type="button"
        className={styles.header}
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开 Vibe workers' : '收起 Vibe workers'}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={styles.title}>Vibe workers</span>
        <span className={styles.count}>{workers.length}</span>
        <span className={`${styles.chevron}${collapsed ? ` ${styles.chevronUp}` : ''}`} aria-hidden="true" />
      </button>
      {!headerOnly && (
        <div className={styles.panel}>
          <div className={styles.tools}>
            <button type="button" className={styles.filter} onClick={() => setHideDone(!hideDone)} aria-pressed={hideDone}>
              {hideDone ? '隐藏已完成' : '显示已完成'}
            </button>
            {directorId !== undefined && (
              <button type="button" className={styles.back} onClick={() => openSession(directorId)}>
                返回主会话
              </button>
            )}
          </div>
          {rows.length > 0 ? (
            <div className={styles.rows}>
              {rows.map(worker => (
                <WorkerRow key={worker.id} worker={worker} open={() => openSession(worker.id)} />
              ))}
            </div>
          ) : (
            <div className={styles.empty}>所有 worker 均已完成</div>
          )}
          {anyRunning && <div className={styles.hint}>等待 worker 完成,你可随时发言</div>}
        </div>
      )}
    </div>
  )
}

/** Small local toggle (useState with boolean). */
function useToggle(initial: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(initial)
  return [value, setValue]
}

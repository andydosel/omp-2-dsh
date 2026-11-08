/**
 * Shared session-header status badge: a small utility button that reads a
 * host projection through the standard-kit `useProjection` and executes a
 * slash command through the injected `runCommand` face (the seat registers the
 * component plus an inject face that closes over `ctx.remote.commands`).
 *
 * The advisor package carries this file so the badge ships with the advisor
 * itself: the header status is part of the capability, not a separate UI
 * plugin.
 *
 * @module @dsh-plugin/dsh-advisor/client/badge/ModeBadge
 */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ModeBadge.module.css'

/** Injected business face of the badge: the command runner. */
export interface ModeBadgeInjected {
  /**
   * Execute one slash command for the owning session.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  runCommand: (command: string) => Promise<string | null>
}

/** Inline failure-text budget (characters) before the tooltip carries the rest. */
const ERROR_SUMMARY_CHARS = 40

/** Full props of a status badge: injected runner + the badge's own literal face. */
export type ModeBadgeProps = InjectFace<ModeBadgeInjected> & {
  /** Stable entry id (also the CSS data attribute). */
  id: string
  /** Badge text (design literal, stays English in every locale). */
  label: string
  /** Accessible name / tooltip. */
  title: string
  /** The slash command the badge executes on click. */
  command: string
  /** Whether the mode is currently active (drives the attention style). */
  active: boolean
}

/**
 * One header-utility status badge. Renders unconditionally — the badge is an
 * always-visible status strip; an absent projection folds to the inactive
 * state (a mode never activated).
 * @param props - injected command runner plus the badge's literal face.
 * @returns the header badge.
 */
export function ModeBadge({ id, label, title, command, active, runCommand }: ModeBadgeProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const run = (): void => {
    // No busy guard: the disabled button stops further clicks.
    setBusy(true)
    setError(null)
    void runCommand(command).then((failure) => {
      if (!aliveRef.current) return
      setBusy(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.wrap} data-mode-id={id}>
      <button
        type="button"
        className={active ? css.badgeActive : css.badge}
        title={title}
        aria-label={title}
        disabled={busy}
        onClick={run}
      >
        {label}
      </button>
      {/* Failure copy is localized; the inline text is truncated to keep the
          header strip narrow and the full message is the tooltip. */}
      {error !== null && (
        <span className={css.error} role="status" title={error}>
          失败: {error.length > ERROR_SUMMARY_CHARS ? `${error.slice(0, ERROR_SUMMARY_CHARS)}…` : error}
        </span>
      )}
    </span>
  )
}

/**
 * Shared mode-status badge: a small session-header utility button that reads
 * a host projection through the standard-kit `useProjection` and executes a
 * slash command through the injected `runCommand` face (plan-chip
 * interaction pattern: the seat registers the component plus an inject face
 * that closes over `ctx.remote.commands`).
 *
 * @module @dsh-plugin/dsh-mode-ui/client/badges/ModeBadge
 */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ModeBadge.module.css'

/** Injected business face of every mode-status badge: the command runner. */
export interface ModeBadgeInjected {
  /**
   * Execute one slash command for the owning session.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  runCommand: (command: string) => Promise<string | null>
}

/** Full props of a mode-status badge: injected runner + the badge's own literal face. */
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
 * One header-utility status badge. Renders unconditionally — the badge set
 * is an always-visible status strip; an absent projection folds to the
 * inactive state (a mode never activated, or a channel never connected).
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
      {/* Failure copy stays English (error-surface policy: not localized). */}
      {error !== null && <span className={css.error} role="status" title={error}>failed</span>}
    </span>
  )
}

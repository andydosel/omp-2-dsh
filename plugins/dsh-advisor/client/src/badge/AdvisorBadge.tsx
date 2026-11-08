/**
 * Advisor header badge: renders the host-computed `advisorStatus` projection
 * (enabled + reviewer count) and toggles a settings panel instead of firing
 * the command on click. The panel carries the enable switch and the reviewer
 * model picker, so one click can no longer flip state by accident.
 *
 * @module @dsh-plugin/dsh-advisor/client/badge/AdvisorBadge
 */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header.utilities seat)
// and the advisorStatus SessionProjectionMap key.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AdvisorPanel } from './AdvisorPanel.tsx'
import type { ModelDirectoryFace } from './model-directory.ts'
import badgeCss from './ModeBadge.module.css'
import panelCss from './AdvisorPanel.module.css'

/** What the header seat injects: the command runner and the model catalog. */
export interface AdvisorBadgeInjected {
  /** Runs one slash command for the owning session; null on success. */
  runCommand(command: string): Promise<string | null>
  /** The session's model directory, or undefined when the web app has none. */
  modelDirectory(): ModelDirectoryFace | undefined
}

/** Full props of the advisor badge: standard kit + injected faces. */
export type AdvisorBadgeProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<AdvisorBadgeInjected>

/**
 * Render the advisor status badge and its settings panel.
 * @param props - the header seat props plus the injected faces.
 * @returns the always-visible advisor badge.
 */
export function AdvisorBadge({ useProjection, runCommand, modelDirectory }: AdvisorBadgeProps) {
  const projection = useProjection('advisorStatus')
  const active = projection?.enabled ?? false
  const reviewers = projection?.reviewers ?? 0
  const model = projection?.model ?? ''
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // Escape and click-outside close the popover; both are registered only while
  // it is open so a closed badge adds no document listeners.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && anchorRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const run = (command: string): void => {
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

  const label = active ? `ADVISOR · ${reviewers}` : 'ADVISOR off'
  const title = active
    ? `Advisor 已开启(${reviewers} 个审查者)— 点击打开设置`
    : 'Advisor 已关闭 — 点击打开设置'

  return (
    <span ref={anchorRef} className={panelCss.anchor} data-mode-id="advisor">
      <button
        type="button"
        className={active ? badgeCss.badgeActive : badgeCss.badge}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen((current) => !current) }}
      >
        {label}
      </button>
      {open ? (
        <AdvisorPanel
          active={active}
          reviewers={reviewers}
          model={model}
          busy={busy}
          error={error}
          directory={modelDirectory()}
          onToggle={() => { run(active ? '/advisor off' : '/advisor on') }}
          onSelectModel={(route) => {
            // '' is the follow-primary sentinel: the command takes a keyword,
            // never an empty argument.
            run(route === '' ? '/advisor model follow' : `/advisor model ${route}`)
          }}
          onClose={() => { setOpen(false) }}
        />
      ) : null}
    </span>
  )
}

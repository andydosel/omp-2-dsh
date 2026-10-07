/**
 * The dsh-org session panel: a `conversation.input.dock` entry that renders the
 * session's host-computed `org` projection — the sessions this secretary
 * manages, each row offering `解除` (/org relinquish) and `禁止` (/org forbid).
 *
 * Zero client-side folding: `useProjection('org')` serves the view the host
 * already folded, and every mutation runs through the session's own slash
 * command (`/org …`), the interaction pattern the mode-status badges use. The
 * command's durable `org/*` events travel back on the session stream, so the
 * view (and this panel) refresh without any local optimistic state.
 *
 * @module @dsh-plugin/dsh-org/client/OrgPanel
 */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input-dock seat and
// its session standard kit).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the SessionStandardProps merge (`useProjection`).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the `org` SessionProjectionMap key merge.
import type {} from '../../src/types.ts'
import { orgPanelModel } from './org-panel-model.ts'
import css from './OrgPanel.module.css'

/** Injected business face of the org panel: the session's command runner. */
export interface OrgPanelInjected {
  /**
   * Execute one slash command for the owning session.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  runCommand: (command: string) => Promise<string | null>
}

/** Full props of the org panel dock entry: InputZone owner share + session standard kit + injected runner. */
export type OrgPanelProps = PropsRuntime<'conversation.input.dock'> & InjectFace<OrgPanelInjected>

/** The two row verbs; both are `/org` subcommands verbatim. */
type OrgVerb = 'relinquish' | 'forbid'

/** Row button copy (the design's verbs). */
const VERB_LABEL: Record<OrgVerb, string> = { relinquish: '解除', forbid: '禁止' }

/** The verbs in button order: release first, the irreversible-ish forbid second. */
const VERBS: readonly OrgVerb[] = ['relinquish', 'forbid']

/** Header count line: managed (visible + hidden) and, when present, the hidden split. */
function countLabel(rows: readonly string[], hidden: readonly string[]): string {
  const managed = rows.length + hidden.length
  return hidden.length === 0
    ? `manages ${managed}`
    : `manages ${managed} · hidden ${hidden.length}`
}

/**
 * The org panel. Renders nothing for a session that is not a secretary and has
 * no forbidden entry (see {@link orgPanelModel}); rows are derived from the
 * projection on every render, so a command's committed events are the only
 * writer.
 */
export function OrgPanel({ useProjection, runCommand }: OrgPanelProps) {
  const view = useProjection('org')
  const model = orgPanelModel(view)
  // Open by default: the actions are the panel's reason to exist; the list is
  // height-capped by CSS so a long manage list cannot push the composer away.
  const [collapsed, setCollapsed] = useState(false)
  // One command in flight per panel: every action button disables until it lands.
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  if (model === undefined) return null

  const run = (verb: OrgVerb, id: string): void => {
    setPending(`${verb} ${id}`)
    setError(null)
    void runCommand(`/org ${verb} ${id}`).then((failure) => {
      if (!aliveRef.current) return
      setPending(null)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setPending(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <section className={css.root} data-testid="org-panel" aria-label="ORG panel">
      <div className={css.body}>
        <button
          type="button"
          className={css.header}
          aria-expanded={!collapsed}
          onClick={() => { setCollapsed(value => !value) }}
        >
          <span className={css.title}>ORG</span>
          <span className={css.role}>{model.role}</span>
          <span className={css.counts}>{countLabel(model.rows, model.hidden)}</span>
          <span className={css.chevron} aria-hidden>{collapsed ? '▸' : '▾'}</span>
        </button>
        {!collapsed && (
          <ul className={css.list}>
            {model.rows.map(id => (
              <li key={id} className={css.row} data-org-session={id}>
                <code className={css.id} title={id}>{id}</code>
                <span className={css.actions}>
                  {VERBS.map(verb => (
                    <button
                      key={verb}
                      type="button"
                      className={verb === 'forbid' ? css.actionDanger : css.action}
                      title={`/org ${verb} ${id}`}
                      disabled={pending !== null}
                      onClick={() => { run(verb, id) }}
                    >
                      {VERB_LABEL[verb]}
                    </button>
                  ))}
                </span>
              </li>
            ))}
            {model.rows.length === 0 && <li className={css.empty}>no managed session</li>}
          </ul>
        )}
        {!collapsed && model.forbidden.length > 0 && (
          <p className={css.footer}>
            {`forbidden (${model.forbidden.length}): ${model.forbidden.join(', ')} · /org list shows all`}
          </p>
        )}
        {/* Failure copy stays English (error-surface policy: not localized). */}
        {error !== null && <p className={css.error} role="status" title={error}>{`failed: ${error}`}</p>}
      </div>
    </section>
  )
}

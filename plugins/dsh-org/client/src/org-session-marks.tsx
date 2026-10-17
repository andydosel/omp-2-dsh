/**
 * Global session-list organisation markers. Two `ui-workspace` list seats per
 * row: the 16px leading cell gets a state dot, and the row's hover card gets
 * the full relation text. Both read the session's host-computed `org`
 * projection from the global `useSessions` snapshot (`projectionsBySession`,
 * falling back to the list's cached `projectionValues`) — zero client-side
 * folding, and no Session binding is opened just to label a list row.
 *
 * The marker is deliberately sparse: a managed session reads "归 X 管", a
 * lead whose manager edge is gone reads "孤儿", and every independent session
 * stays unlabelled.
 *
 * @module @dsh-plugin/dsh-org/client/org-session-marks
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the `org` SessionProjectionMap key merge.
import type {} from '../../src/types.ts'
import type { OrgProjectionView } from '../../src/types.ts'
import { orgSessionMark } from './org-panel-model.ts'
import css from './OrgPanel.module.css'

/**
 * The two `ui-workspace` row seats are declared by a package this client face
 * does not depend on (it may not even be present in every profile build), so
 * this module declares the seats it registers into. The shapes mirror the
 * upstream declarations exactly: a root-scope list whose owner share is the
 * row's session id.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Leading decoration of one global session row. */
    'sidebar.session.row.leading': {
      kind: 'list'
      scope: 'root'
      owner: { readonly sessionId: SessionId }
    }
    /** Section of one global session row's hover card. */
    'sidebar.session.row.hover': {
      kind: 'list'
      scope: 'root'
      owner: { readonly sessionId: SessionId }
    }
  }
}

/** Props both row seats receive: the row's identity plus the global standard kit. */
export interface OrgSessionRowProps {
  readonly sessionId: SessionId
  readonly useSessions: <Selected>(
    selector: (state: SessionListState) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ) => Selected
}

/**
 * Read one session's `org` projection from the global list snapshot. The
 * live/follow projection store wins over the list's persisted-checkpoint
 * cache when both carry the key.
 * @param useSessions - global session-list selector hook.
 * @param sessionId - the row's session.
 * @returns the view, or undefined until the host has computed one.
 */
function useOrgView(
  useSessions: OrgSessionRowProps['useSessions'],
  sessionId: SessionId,
): OrgProjectionView | undefined {
  return useSessions(state => state.projectionsBySession[sessionId]?.values.org
    ?? state.byId[sessionId]?.projectionValues?.org)
}

/**
 * The 16px leading-cell badge. The cell is a dot slot, so the visible mark is
 * a dot and the full relation travels in the title/accessible name.
 * @param props - row identity and the global standard kit.
 * @returns the badge, or null when the session has no organisation relation.
 */
export function OrgSessionRowMark({ sessionId, useSessions }: OrgSessionRowProps) {
  const mark = orgSessionMark(useOrgView(useSessions, sessionId))
  if (mark === undefined) return null
  return (
    <span
      className={css.rowMark}
      data-org-mark={mark.kind}
      title={mark.label}
      aria-label={mark.label}
    />
  )
}

/**
 * The hover-card relation line ("归 X 管" / "孤儿").
 * @param props - row identity and the global standard kit.
 * @returns the text line, or null when the session has no organisation relation.
 */
export function OrgSessionRowRelation({ sessionId, useSessions }: OrgSessionRowProps) {
  const mark = orgSessionMark(useOrgView(useSessions, sessionId))
  if (mark === undefined) return null
  return (
    <span className={css.rowRelation} data-org-mark={mark.kind}>
      {mark.label}
    </span>
  )
}

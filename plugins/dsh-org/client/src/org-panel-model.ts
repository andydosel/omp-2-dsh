/**
 * Pure projection → panel-model derivation for the dsh-org session panel. Kept
 * free of React and of every runtime import (the `org` view is a type-only
 * import) so the panel's row policy is unit-testable in plain Node and the
 * component stays a rendering shell over it.
 *
 * The policy the design asks for: the panel lists the sessions THIS session
 * manages, one row per managed session carrying `解除` (relinquish) and `禁止`
 * (forbid). A session this secretary has forbidden MUST NOT appear as an
 * actionable row (`禁止` on a managed session also releases the edge in the
 * same host operation, so the row normally leaves `manages` by itself — this
 * filter is the projection-level guarantee, not a copy of the service rule);
 * the forbidden set stays readable in the panel footer and in `/org list`,
 * which reads the service's global state.
 *
 * @module @dsh-plugin/dsh-org/client/org-panel-model
 */

import type { OrgProjectionView } from '../../src/types.ts'

/** What the org panel renders for one session's `org` projection. */
export interface OrgPanelModel {
  /** The session's own folded role (the panel only exists for a secretary). */
  readonly role: OrgProjectionView['role']
  /** Managed sessions offered with release/forbid actions (forbidden ones excluded). */
  readonly rows: readonly string[]
  /** Managed sessions hidden from {@link OrgPanelModel.rows} because this secretary forbade them. */
  readonly hidden: readonly string[]
  /** Every session this secretary forbade, in forbid order (the read-only footer). */
  readonly forbidden: readonly string[]
}

/**
 * Derive the panel model for one `org` projection view.
 * @param view - the session's host-computed `org` view, or undefined while absent.
 * @returns the model, or undefined when this session has nothing to show: a
 *   non-secretary (no manage list by construction) or a secretary with neither
 *   a managed session nor a forbidden one.
 */
export function orgPanelModel(view: OrgProjectionView | undefined): OrgPanelModel | undefined {
  if (view === undefined || view.role !== 'secretary') return undefined
  const forbidden = new Set(view.forbidden)
  const rows: string[] = []
  const hidden: string[] = []
  for (const id of view.manages) {
    if (forbidden.has(id)) hidden.push(id)
    else rows.push(id)
  }
  if (rows.length === 0 && view.forbidden.length === 0) return undefined
  return { role: view.role, rows, hidden, forbidden: view.forbidden }
}

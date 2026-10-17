/**
 * The `org` session-projection unit: the per-session organisation view folded
 * from that session's own `org/*` events, plus the host registration.
 *
 * The fold is owner-agnostic on purpose (the projection contract has no session
 * identity in `apply`): `org/role` and `org/forbid`/`org/notice` are appended
 * only to the log they describe, while `org/claim`/`org/relinquish` appear in
 * BOTH logs and are disambiguated by the session's folded `role` — a
 * `secretary`-role log reads the event as "what I manage", every other log
 * reads it as "who manages me". The service appends each log's self-describing
 * role event before its first claim, so the discriminator is always present.
 *
 * State is plain JSON and the wire view is the same shape; `apply` returns the
 * SAME reference for foreign or no-op events (the registry's `Object.is` gate).
 *
 * @module @dsh-plugin/dsh-org/projection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { OrgProjectionView, OrgRole } from './types.ts'

/** An empty organisation view (an independent session with no notices). */
export function emptyOrgView(): OrgProjectionView {
  return { role: null, managedBy: null, manages: [], forbidden: [], notices: [] }
}

/** Normalize a folded role value for the JSON view. */
function asRole(role: OrgRole | undefined): OrgRole | null {
  return role ?? null
}

const orgNoticeSchema = z.object({
  id: z.string(),
  content: z.string(),
  time: z.number(),
}).strict()

/**
 * The persisted/wire schema of the `org` view, structured like the task
 * board's. The cast only bridges the branded `SessionId` members: zod
 * validates the wire-JSON strings, and the brand is a compile-time refinement
 * with no runtime representation.
 */
export const orgViewSchema = z.object({
  role: z.enum(['secretary', 'lead']).nullable(),
  managedBy: z.string().nullable(),
  manages: z.array(z.string()),
  forbidden: z.array(z.string()),
  notices: z.array(orgNoticeSchema),
}).strict() as unknown as ZodType<OrgProjectionView>

/** Runtime guard for the persisted/wire `org` view. */
export function isOrgProjectionView(value: unknown): value is OrgProjectionView {
  return orgViewSchema.safeParse(value).success
}

/**
 * Fold one committed session event into a session's organisation view.
 * @param state - the view covering all prior events.
 * @param event - the next committed session event.
 * @returns the next view, or the same reference for a foreign/no-op event.
 */
export function applyOrgView(state: OrgProjectionView, event: SessionEvent): OrgProjectionView {
  switch (event.type) {
    case 'org/role': {
      const role = asRole(event.data.role)
      return role === state.role ? state : { ...state, role }
    }
    case 'org/claim': {
      const { secretaryId, targetId } = event.data
      if (state.role === 'secretary') {
        return state.manages.includes(targetId) ? state : { ...state, manages: [...state.manages, targetId] }
      }
      return state.managedBy === secretaryId ? state : { ...state, managedBy: secretaryId }
    }
    case 'org/relinquish': {
      const { secretaryId, targetId } = event.data
      if (state.role === 'secretary') {
        return state.manages.includes(targetId)
          ? { ...state, manages: state.manages.filter(entry => entry !== targetId) }
          : state
      }
      return state.managedBy === secretaryId ? { ...state, managedBy: null } : state
    }
    case 'org/forbid': {
      const { targetId } = event.data
      return state.forbidden.includes(targetId) ? state : { ...state, forbidden: [...state.forbidden, targetId] }
    }
    case 'org/forbidden':
      // Target-side mirror: this log belongs to the session that was forbidden,
      // so it must not enter that session's own "sessions I forbade" list.
      return state
    case 'org/notice':
      return {
        ...state,
        notices: [...state.notices, { id: `n-${event.seq}`, content: event.data.content, time: event.time }],
      }
    default:
      return state
  }
}

/** State → wire payload (the view IS the served value; reuse the reference). */
export function viewOrg(state: OrgProjectionView): OrgProjectionView {
  return state
}

/** The `org` projection unit, registered on `ctx.sessionProjections`. */
export const orgProjection = {
  key: 'org',
  stateSchema: orgViewSchema,
  init: () => emptyOrgView(),
  apply: applyOrgView,
  wire: { viewSchema: orgViewSchema, view: viewOrg },
  stateVersion: 1,
} satisfies ProjectionDefinition<'org', OrgProjectionView>

/**
 * Register the `org` projection when a projection registry is composed.
 * @param ctx - the plugin context.
 */
export function registerOrgProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(orgProjection)
  })
}

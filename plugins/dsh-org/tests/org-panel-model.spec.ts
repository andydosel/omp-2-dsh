/**
 * Panel-policy tests for the dsh-org browser half: the pure projection →
 * model derivation the dock entry renders (`client/src/org-panel-model.ts`).
 * No DOM and no React — the module is deliberately free of runtime imports.
 */

import { describe, expect, it } from 'vitest'
import { orgPanelModel, orgSessionMark } from '../client/src/org-panel-model.ts'
import { emptyOrgView } from '../src/projection.ts'
import type { OrgProjectionView } from '../src/types.ts'

/** One secretary view with the given manage/forbid sets. */
function secretaryView(manages: string[], forbidden: string[] = []): OrgProjectionView {
  return { ...emptyOrgView(), role: 'secretary', manages, forbidden }
}

describe('orgPanelModel', () => {
  it('renders nothing without a view or for a non-secretary', () => {
    expect(orgPanelModel(undefined)).toBeUndefined()
    expect(orgPanelModel(emptyOrgView())).toBeUndefined()
    // A managed (lead) session shows the manager edge, not a manage list.
    expect(orgPanelModel({ ...emptyOrgView(), role: 'lead', managedBy: 's-sec' })).toBeUndefined()
    // A secretary with neither a managed nor a forbidden session has no panel.
    expect(orgPanelModel(secretaryView([]))).toBeUndefined()
  })

  it('lists every managed session as an actionable row, in claim order', () => {
    const model = orgPanelModel(secretaryView(['s-a', 's-b', 's-c']))
    expect(model).toEqual({
      role: 'secretary',
      rows: ['s-a', 's-b', 's-c'],
      hidden: [],
      forbidden: [],
      notices: [],
    })
  })

  it('hides a forbidden session from the rows but keeps the forbidden set readable', () => {
    const model = orgPanelModel(secretaryView(['s-a', 's-b'], ['s-b']))
    expect(model).toEqual({
      role: 'secretary',
      rows: ['s-a'],
      hidden: ['s-b'],
      forbidden: ['s-b'],
      notices: [],
    })
  })

  it('still renders the forbidden footer when nothing is managed anymore', () => {
    // `forbid` releases the edge in the same host operation, so this is the
    // state a "release + forbid" click lands in: no rows, one forbidden id.
    const model = orgPanelModel(secretaryView([], ['s-gone']))
    expect(model).toEqual({ role: 'secretary', rows: [], hidden: [], forbidden: ['s-gone'], notices: [] })
  })

  it('surfaces notify_user notices, including after the role is cleared', () => {
    const notice = { id: 'n-3', content: 'The nightly build is green.', time: 1 }
    expect(orgPanelModel({ ...secretaryView([]), notices: [notice] })).toEqual({
      role: 'secretary',
      rows: [],
      hidden: [],
      forbidden: [],
      notices: [notice],
    })
    expect(orgPanelModel({ ...emptyOrgView(), notices: [notice] })).toEqual({
      role: null,
      rows: [],
      hidden: [],
      forbidden: [],
      notices: [notice],
    })
  })
})

describe('orgSessionMark', () => {
  it('labels a managed session with its secretary', () => {
    expect(orgSessionMark({ ...emptyOrgView(), role: 'lead', managedBy: 's-sec' }))
      .toEqual({ kind: 'managed', label: '归 s-sec 管' })
  })

  it('labels a lead whose manager edge is gone as an orphan', () => {
    expect(orgSessionMark({ ...emptyOrgView(), role: 'lead' })).toEqual({ kind: 'orphan', label: '孤儿' })
  })

  it('leaves independent sessions and absent views unlabelled', () => {
    expect(orgSessionMark(undefined)).toBeUndefined()
    expect(orgSessionMark(emptyOrgView())).toBeUndefined()
    expect(orgSessionMark({ ...emptyOrgView(), role: 'secretary' })).toBeUndefined()
  })
})

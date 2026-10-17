import { describe, expect, it } from 'vitest'
import { emptyOrgView, isOrgProjectionView, orgViewSchema } from '../src/projection.ts'

describe('org projection schema', () => {
  it('accepts the empty view', () => {
    expect(isOrgProjectionView(emptyOrgView())).toBe(true)
    expect(orgViewSchema.parse(emptyOrgView())).toEqual(emptyOrgView())
  })

  it('accepts a populated view', () => {
    const view = {
      role: 'secretary',
      managedBy: 'lead-1',
      manages: ['lead-1'],
      forbidden: ['lead-2'],
      notices: [{ id: 'n-1', content: 'ready', time: 123 }],
    }
    expect(isOrgProjectionView(view)).toBe(true)
  })

  it('rejects malformed members', () => {
    expect(isOrgProjectionView(null)).toBe(false)
    expect(isOrgProjectionView({ ...emptyOrgView(), role: 'manager' })).toBe(false)
    expect(isOrgProjectionView({ ...emptyOrgView(), manages: [1] })).toBe(false)
    expect(isOrgProjectionView({ ...emptyOrgView(), notices: [{ id: 'n-1' }] })).toBe(false)
  })
})

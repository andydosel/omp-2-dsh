import { describe, expect, it } from 'vitest'
import { escapeXml } from '../src/xml.ts'

describe('escapeXml', () => {
  it('escapes every XML special character in one pass', () => {
    expect(escapeXml(`<a href="x" data-y='z'>&</a>`))
      .toBe('&lt;a href=&quot;x&quot; data-y=&apos;z&apos;&gt;&amp;&lt;/a&gt;')
  })

  it('leaves plain text untouched', () => {
    expect(escapeXml('plain text / paths a+b')).toBe('plain text / paths a+b')
    expect(escapeXml('')).toBe('')
  })
})

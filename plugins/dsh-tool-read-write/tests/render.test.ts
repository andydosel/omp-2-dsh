import { describe, expect, it } from 'vitest'
import { buildWindow, formatNumberedRead, formatRawRead, readMetaFromMeta } from '../src/read/render.ts'
import type { WindowRequest } from '../src/read/render.ts'

const FILE = 'src/main.ts'

function request(overrides: Partial<WindowRequest>): WindowRequest {
  return {
    offset: 1,
    mode: 'numbered',
    ranges: [{ start: 1, end: 300 }],
    context: false,
    maxLines: 2000,
    maxLineLength: 2000,
    maxBytes: 50 * 1024,
    ...overrides,
  }
}

const LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') // 10 lines

describe('buildWindow', () => {
  it('returns the default window and exact total for a plain read', async () => {
    const window = await buildWindow([LINES], request({ ranges: [{ start: 1, end: 300 }] }))
    expect(window.totalLines).toBe(10)
    expect(window.lines.map(line => line.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(window.outOfRange).toBe(false)
    expect(window.truncatedByBytes).toBe(false)
  })

  it('adds 1+3 context lines around a single bounded non-raw range', async () => {
    const window = await buildWindow([LINES], request({ offset: 4, ranges: [{ start: 4, end: 6 }], context: true }))
    expect(window.lines.map(line => line.number)).toEqual([3, 4, 5, 6, 7, 8, 9])
  })

  it('clamps context at line 1', async () => {
    const window = await buildWindow([LINES], request({ offset: 1, ranges: [{ start: 1, end: 2 }], context: true }))
    expect(window.lines.map(line => line.number)).toEqual([1, 2, 3, 4, 5])
  })

  it('clamps context at EOF', async () => {
    const window = await buildWindow([LINES], request({ offset: 9, ranges: [{ start: 9, end: 10 }], context: true }))
    expect(window.lines.map(line => line.number)).toEqual([8, 9, 10])
  })

  it('merges nothing for multi-ranges and applies no context', async () => {
    const window = await buildWindow([LINES], request({ offset: 2, ranges: [{ start: 2, end: 3 }, { start: 5, end: 6 }], context: false }))
    expect(window.lines.map(line => line.number)).toEqual([2, 3, 5, 6])
  })

  it('returns raw whole-file text without numbers', async () => {
    const window = await buildWindow([LINES], request({ offset: 1, mode: 'raw', ranges: [] }))
    expect(window.rawText).toBe(LINES)
    expect(window.lines).toEqual([])
    expect(window.totalLines).toBe(10)
  })

  it('returns a raw range without context', async () => {
    const window = await buildWindow([LINES], request({ offset: 3, mode: 'raw', ranges: [{ start: 3, end: 5 }] }))
    expect(window.rawText).toBe('line 3\nline 4\nline 5')
  })

  it('handles an empty file', async () => {
    const window = await buildWindow([''], request({ offset: 1 }))
    expect(window.totalLines).toBe(0)
    expect(window.lines).toEqual([])
    expect(window.outOfRange).toBe(false)
  })

  it('reports out-of-range instead of throwing when the request starts past EOF', async () => {
    const window = await buildWindow([LINES], request({ offset: 100, ranges: [{ start: 100, end: 120 }], context: true }))
    expect(window.outOfRange).toBe(true)
    expect(window.lines).toEqual([])
    expect(window.requestedEnd).toBe(123) // context-expanded end
  })

  it('caps output by bytes and marks truncation', async () => {
    const window = await buildWindow([LINES], request({ ranges: [{ start: 1, end: 300 }], maxBytes: 20 }))
    expect(window.truncatedByBytes).toBe(true)
    expect(window.lines.length).toBeLessThan(10)
  })

  it('caps output by line count', async () => {
    const window = await buildWindow([LINES], request({ ranges: [{ start: 1, end: 300 }], maxLines: 4 }))
    expect(window.lines.map(line => line.number)).toEqual([1, 2, 3, 4])
    expect(window.truncatedByLines).toBe(true)
    expect(window.totalLines).toBe(10)
  })

  it('truncates a single oversized line with a suffix', async () => {
    const long = `x`.repeat(100)
    const window = await buildWindow([long], request({ ranges: [{ start: 1, end: 1 }], maxLineLength: 10 }))
    expect(window.lines[0]!.text).toBe(`x`.repeat(10) + '... (line truncated to 10 chars)')
  })

  it('strips carriage returns', async () => {
    const window = await buildWindow(['a\r\nb\r\n'], request({ ranges: [{ start: 1, end: 2 }] }))
    expect(window.lines.map(line => line.text)).toEqual(['a', 'b'])
  })

  it('streams chunk boundaries without meaning', async () => {
    const window = await buildWindow(['line 1\nlin', 'e 2\nline 3'], request({ ranges: [{ start: 1, end: 3 }] }))
    expect(window.lines.map(line => line.text)).toEqual(['line 1', 'line 2', 'line 3'])
  })

  it('scans to EOF for an exact total even when the window is capped', async () => {
    const window = await buildWindow([LINES], request({ ranges: [{ start: 1, end: 3 }], maxBytes: 12 }))
    expect(window.totalLines).toBe(10)
    expect(window.truncatedByBytes).toBe(true)
  })
})

describe('formatNumberedRead / formatRawRead', () => {
  it('renders the envelope with numbered lines and an end-of-file footer', async () => {
    const window = await buildWindow([LINES], request({ ranges: [{ start: 1, end: 10 }] }))
    const text = formatNumberedRead(FILE, window)
    expect(text).toContain(`<path>${FILE}</path>`)
    expect(text).toContain('<type>file</type>')
    expect(text).toContain('1: line 1')
    expect(text).toContain('10: line 10')
    expect(text).toContain('(End of file - total 10 lines)')
  })

  it('renders a continue footer when the window stops before EOF', async () => {
    const window = await buildWindow([LINES], request({ ranges: [{ start: 1, end: 4 }] }))
    expect(formatNumberedRead(FILE, window)).toContain('(Showing lines 1-4 of 10. Use offset=5 to continue.)')
  })

  it('renders the out-of-range hint without throwing', async () => {
    const window = await buildWindow([LINES], request({ offset: 100, ranges: [{ start: 100, end: 120 }], context: true }))
    const text = formatNumberedRead(FILE, window)
    expect(text).toContain('out of range')
    expect(text).toContain('the file has 10 lines')
  })

  it('renders raw text without numbers and with the total footer', async () => {
    const window = await buildWindow([LINES], request({ offset: 1, mode: 'raw', ranges: [] }))
    const text = formatRawRead(FILE, window)
    expect(text).toContain('line 1')
    expect(text).toContain('(End of file - total 10 lines)')
    expect(text).not.toContain('1: line 1')
  })

  it('renders a truncation footer for a capped raw read', async () => {
    const window = await buildWindow([LINES], request({ offset: 1, mode: 'raw', ranges: [], maxLines: 3 }))
    expect(formatRawRead(FILE, window)).toContain('(Output truncated: the file has 10 lines.)')
  })
})

describe('readMetaFromMeta', () => {
  it('accepts a valid window', () => {
    const meta = { path: 'a.ts', offset: 2, lines: [{ number: 2, text: 'x' }, { number: 3, text: 'y' }], totalLines: 5, lang: 'ts' }
    expect(readMetaFromMeta(meta)).toEqual(meta)
  })

  it('accepts context lines starting before the offset', () => {
    const meta = { path: 'a.ts', offset: 5, lines: [{ number: 4, text: 'x' }, { number: 5, text: 'y' }], totalLines: 9 }
    expect(readMetaFromMeta(meta)).toEqual(meta)
  })

  it('rejects malformed metadata', () => {
    expect(readMetaFromMeta(null)).toBeUndefined()
    expect(readMetaFromMeta({ path: 'a', offset: 1, lines: [{ number: 0, text: 'x' }], totalLines: 1 })).toBeUndefined()
    expect(readMetaFromMeta({ path: 'a', offset: 1, lines: [{ number: 2, text: 'x' }], totalLines: 1 })).toBeUndefined()
    expect(readMetaFromMeta({ path: 'a', offset: 1, lines: 'nope', totalLines: 1 })).toBeUndefined()
    expect(readMetaFromMeta({ path: 'a', offset: 0, lines: [], totalLines: 1 })).toBeUndefined()
  })
})

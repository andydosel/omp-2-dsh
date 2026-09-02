import { afterEach, describe, expect, it, vi } from 'vitest'
import { capText, fetchUrlText, htmlToText, isUrlPath, prettyJson, splitUrlRaw } from '../src/read/url.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockFetchOnce(status: number, body: string, contentType: string, headers?: Record<string, string>): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : status === 500 ? 'Internal Server Error' : '',
    headers: { get: (name: string) => (headers ?? {})[name.toLowerCase()] ?? contentType },
    text: async () => body,
  })))
}

describe('isUrlPath / splitUrlRaw', () => {
  it('recognizes http(s) and www, with :raw', () => {
    expect(isUrlPath('https://example.com/x')).toBe(true)
    expect(isUrlPath('http://example.com')).toBe(true)
    expect(isUrlPath('www.example.com')).toBe(true)
    expect(isUrlPath('example.com')).toBe(false)
    expect(isUrlPath('src/main.ts')).toBe(false)
    expect(splitUrlRaw('https://example.com/x')).toEqual({ url: 'https://example.com/x', raw: false })
    expect(splitUrlRaw('https://example.com/x:raw')).toEqual({ url: 'https://example.com/x', raw: true })
    expect(splitUrlRaw('src/main.ts')).toBeUndefined()
    expect(splitUrlRaw('https://example.com:8080/x')).toEqual({ url: 'https://example.com:8080/x', raw: false })
  })
})

describe('htmlToText', () => {
  it('strips tags and scripts, converts block boundaries, decodes entities', () => {
    const html = '<html><head><title>t</title></head><body><script>bad()</script>'
      + '<h1>Hello</h1><p>a &amp; b</p><ul><li>one</li><li>two</li></ul>'
      + '<style>.x{}</style><br>after</body></html>'
    const text = htmlToText(html)
    expect(text).not.toContain('bad()')
    expect(text).not.toContain('<h1>')
    expect(text).toContain('Hello')
    expect(text).toContain('a & b')
    expect(text).toContain('one')
    expect(text).toContain('two')
    expect(text).toContain('after')
    expect(text).toContain('\n')
  })

  it('handles numeric entities', () => {
    expect(htmlToText('&#65;&#x42;')).toBe('AB')
  })
})

describe('prettyJson / capText', () => {
  it('pretty-prints JSON and passes through non-JSON', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('not json')).toBe('not json')
  })

  it('caps by lines and bytes without splitting UTF-8 characters', () => {
    const text = 'a\nb\nc\nd'
    expect(capText(text, 2, 1000)).toEqual({ text: 'a\nb', truncated: true })
    const unicode = 'é'.repeat(100)
    const capped = capText(unicode, 1000, 10)
    expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(10)
    expect(capped.truncated).toBe(true)
    expect(() => Buffer.from(capped.text, 'utf8').toString('utf8')).not.toThrow()
  })
})

describe('fetchUrlText', () => {
  it('fetches plain text and reports HTTP status', async () => {
    mockFetchOnce(200, 'hello world', 'text/plain')
    const result = await fetchUrlText('https://example.com/hello', 300, 51200)
    expect(result.statusCode).toBe(200)
    expect(result.text).toBe('hello world')
    expect(result.failed).toBeUndefined()
    expect(result.truncated).toBe(false)
  })

  it('converts HTML to text', async () => {
    mockFetchOnce(200, '<html><body><h1>Hi</h1><p>there</p></body></html>', 'text/html')
    const result = await fetchUrlText('https://example.com/page', 300, 51200)
    expect(result.text).toContain('Hi')
    expect(result.text).toContain('there')
    expect(result.text).not.toContain('<h1>')
  })

  it('pretty-prints JSON bodies', async () => {
    mockFetchOnce(200, '{"x":1}', 'application/json')
    const result = await fetchUrlText('https://example.com/data', 300, 51200)
    expect(result.text).toBe('{\n  "x": 1\n}')
  })

  it('returns raw HTML with :raw', async () => {
    const html = '<html><body><b>raw</b></body></html>'
    mockFetchOnce(200, html, 'text/html')
    const result = await fetchUrlText('https://example.com/page:raw', 300, 51200)
    expect(result.text).toBe(html)
  })

  it('prefixes www. with https://', async () => {
    mockFetchOnce(200, 'ok', 'text/plain')
    const result = await fetchUrlText('www.example.com', 300, 51200)
    expect(result.path).toBe('https://www.example.com')
  })

  it('returns a failure value (not a throw) on HTTP errors', async () => {
    mockFetchOnce(404, 'nope', 'text/plain')
    const result = await fetchUrlText('https://example.com/missing', 300, 51200)
    expect(result.failed).toContain('HTTP 404')
    expect(result.text).toContain('Failed to fetch')
    expect(result.statusCode).toBe(404)
  })

  it('returns a failure value on network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    const result = await fetchUrlText('https://example.com/down', 300, 51200)
    expect(result.failed).toContain('ECONNREFUSED')
    expect(result.statusCode).toBe(0)
  })

  it('caps output by lines and bytes', async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    mockFetchOnce(200, body, 'text/plain')
    const result = await fetchUrlText('https://example.com/cap', 3, 51200)
    expect(result.text).toBe('line 0\nline 1\nline 2')
    expect(result.truncated).toBe(true)
  })
})

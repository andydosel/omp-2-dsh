/**
 * URL reading: node fetch plus a basic HTML→text converter, JSON pretty-
 * printing, `:raw` passthrough, and line/byte output caps. A failed fetch
 * returns an explanatory value instead of throwing (design: "method: failed").
 * @module dsh-tool-read-write/read/url
 */

/** Input cap on fetched bodies before conversion (guards synchronous work). */
export const URL_INPUT_CAP = 2 * 1024 * 1024

/** Backstop timeout for a URL fetch (the cooperative tool budget applies first when configured). */
export const URL_FETCH_TIMEOUT_MS = 60_000

/** Whether a raw path is a URL read target (`http(s)://` or `www.`). */
export function isUrlPath(path: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(path)
}

/** Split a raw URL path into the URL and whether `:raw` output was requested. */
export function splitUrlRaw(rawPath: string): { url: string; raw: boolean } | undefined {
  // The :raw suffix must win over the URL check (a URL tail can contain :raw).
  if (rawPath.endsWith(':raw')) {
    const base = rawPath.slice(0, rawPath.length - ':raw'.length)
    if (isUrlPath(base)) return { url: base, raw: true }
  }
  if (isUrlPath(rawPath)) return { url: rawPath, raw: false }
  return undefined
}

/** The outcome of a URL read. */
export interface UrlReadResult {
  path: string
  statusCode: number
  text: string
  truncated: boolean
  /** Set when the fetch itself failed (network or HTTP error). */
  failed?: string
}

/**
 * Naive HTML→text conversion: strips comments, script/style/head blocks and
 * remaining tags, converts block boundaries to newlines, decodes common
 * entities, and collapses blank runs. Deliberately basic — the design accepts
 * a naive converter for v1 (no markit rendering pipeline).
 * @param html - the raw HTML.
 * @returns converted text.
 */
export function htmlToText(html: string): string {
  let text = html
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<(script|style|noscript|head|title)[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|pre|blockquote|table|ul|ol|form)>/gi, '\n')
  text = text.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
  text = text.replace(/<[^>]*>/g, '')
  text = text.replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
  const lines = text.split('\n').map(line => line.trim())
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Pretty-print JSON text; pass through when it does not parse. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/**
 * Cap text to `maxLines` lines and `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character.
 * @param text - the full text.
 * @param maxLines - maximum lines retained.
 * @param maxBytes - maximum UTF-8 bytes retained.
 * @returns the capped prefix and whether anything was cut.
 */
export function capText(text: string, maxLines: number, maxBytes: number): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  let truncated = false
  let out = lines
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines)
    truncated = true
  }
  let result = out.join('\n')
  if (Buffer.byteLength(result, 'utf8') > maxBytes) {
    // Binary-search the longest safe prefix under maxBytes.
    let low = 0
    let high = result.length
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (Buffer.byteLength(result.slice(0, mid), 'utf8') <= maxBytes) low = mid
      else high = mid - 1
    }
    result = result.slice(0, low)
    truncated = true
  }
  return { text: result, truncated }
}

/**
 * Fetch and render one URL.
 * @param rawPath - the raw path argument (URL, possibly `:raw`-suffixed).
 * @param maxLines - output line cap.
 * @param maxBytes - output byte cap.
 * @param signal - cancellation; combined with an internal backstop timeout.
 * @returns the rendered outcome; fetch failures are values, not throws.
 */
export async function fetchUrlText(
  rawPath: string,
  maxLines: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<UrlReadResult> {
  const split = splitUrlRaw(rawPath)
  if (split === undefined) throw new Error(`not a URL: "${rawPath}"`)
  const { url, raw } = split
  const effectiveUrl = /^www\./i.test(url) ? `https://${url}` : url
  const abort = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(URL_FETCH_TIMEOUT_MS)])

  let response: Response
  try {
    response = await fetch(effectiveUrl, { signal: abort, redirect: 'follow' })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      path: effectiveUrl,
      statusCode: 0,
      text: `Failed to fetch ${effectiveUrl}: ${message}`,
      truncated: false,
      failed: message,
    }
  }
  if (!response.ok) {
    const message = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    return {
      path: effectiveUrl,
      statusCode: response.status,
      text: `Failed to fetch ${effectiveUrl}: ${message}`,
      truncated: false,
      failed: message,
    }
  }

  let body: string
  try {
    body = await response.text()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      path: effectiveUrl,
      statusCode: response.status,
      text: `Failed to fetch ${effectiveUrl}: ${message}`,
      truncated: false,
      failed: message,
    }
  }
  if (body.length > URL_INPUT_CAP) body = body.slice(0, URL_INPUT_CAP)

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  let converted: string
  if (raw) {
    converted = body
  } else if (contentType.includes('json')) {
    converted = prettyJson(body)
  } else if (contentType.includes('html')) {
    converted = htmlToText(body)
  } else {
    converted = body
  }
  const capped = capText(converted, maxLines, maxBytes)
  return {
    path: effectiveUrl,
    statusCode: response.status,
    text: capped.text,
    truncated: capped.truncated,
  }
}

/** Format a URL read result as the model-facing envelope. */
export function formatUrlRead(result: UrlReadResult): string {
  if (result.failed !== undefined) {
    return `<path>${result.path}</path>
<type>url</type>
<content>
${result.text}
</content>`
  }
  const header = `Fetched ${result.path} (HTTP ${result.statusCode})`
  const footer = result.truncated ? '\n\n(Content truncated. Fetch a more specific URL for the full text.)' : ''
  return `<path>${result.path}</path>
<type>url</type>
<content>
${header}

${result.text}${footer}
</content>`
}

/**
 * Pure read presentation: bounded, line-numbered windows over decoded text
 * with 1+3 context lines for single bounded non-raw selectors, raw whole-file
 * or raw-range output, per-line/byte caps, and the model-facing envelope.
 * Cordis-free so the windowing logic is unit-testable without a host.
 * @module dsh-tool-read-write/read/render
 */

/** Default maximum characters returned for a single line (the `readMaxLineLength` config). */
export const READ_MAX_LINE_LENGTH = 2000

/** Default maximum bytes returned for selected file lines (the `readMaxBytes` config). */
export const READ_MAX_BYTES = 50 * 1024

/** One line returned from a text file. */
export interface FileTextLine {
  /** 1-based line number in the file. */
  number: number
  /** Line text without its trailing newline. */
  text: string
}

/** The resolved window request; the caller applies its defaults and caps before calling. */
export interface WindowRequest {
  /** 1-based first line the caller requested (kept for the canonical value and out-of-range hints). */
  offset: number
  /** `numbered` renders `N: text` lines; `raw` renders bare text (no numbers). */
  mode: 'numbered' | 'raw'
  /**
   * Sorted disjoint ranges selecting lines; empty selects the whole file. In
   * `numbered` mode each single range gains 1 line before and 3 lines after
   * when `context` is set (EOF clamping happens naturally during the scan).
   */
  ranges: ReadonlyArray<{ start: number; end: number }>
  /** Whether to add 1+3 context lines around the (single) range. */
  context: boolean
  /** Maximum lines returned before truncation. */
  maxLines: number
  /** Maximum characters returned for a single line before truncation. */
  maxLineLength: number
  /** Maximum bytes of returned output before truncation. */
  maxBytes: number
}

/** The windowed result {@link buildWindow} produces. */
export interface WindowResult {
  /** Requested start line (unchanged from the request). */
  offset: number
  /** Returned numbered lines (empty in `raw` mode). */
  lines: FileTextLine[]
  /** Returned raw text (empty in `numbered` mode). */
  rawText: string
  /** Exact total line count in the file. */
  totalLines: number
  /** Whether the returned output hit the byte cap. */
  truncatedByBytes: boolean
  /** Whether a line cap cut the returned output. */
  truncatedByLines: boolean
  /** Whether the requested range starts past EOF (a hint, never a throw). */
  outOfRange: boolean
  /** The requested end of the first range, for the out-of-range hint. */
  requestedEnd: number
}

interface WindowAccumulator {
  lines: FileTextLine[]
  rawText: string
  rawLines: number
  totalLines: number
  outputBytes: number
  truncatedByBytes: boolean
  /** Number of selected (in-range) lines seen, regardless of caps. */
  selectedCount: number
}

function newAccumulator(): WindowAccumulator {
  return { lines: [], rawText: '', rawLines: 0, totalLines: 0, outputBytes: 0, truncatedByBytes: false, selectedCount: 0 }
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)` : line
}

function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0)
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Build one window from streamed or whole-file chunks. The scan always runs to
 * EOF so `totalLines` is exact; caps stop the OUTPUT from growing. A requested
 * range starting past EOF yields an empty window with `outOfRange` set rather
 * than throwing, matching the design's "out-of-range gives a hint" rule.
 * @param chunks - decoded text chunks in file order; chunk boundaries carry no meaning.
 * @param request - the resolved window request.
 * @returns the window plus exact total line count.
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: WindowRequest,
): Promise<WindowResult> {
  const acc = newAccumulator()
  const lineBufferCap = request.maxLineLength + 1
  let lineBuffer = ''

  // Context expansion: one line before, three after, clamped at line 1 (EOF
  // clamping happens naturally — a range past EOF matches nothing).
  let ranges = request.ranges
  if (request.context && ranges.length === 1) {
    const range = ranges[0]!
    ranges = [{ start: Math.max(1, range.start - 1), end: range.end + 3 }]
  }

  function selected(n: number): boolean {
    if (ranges.length === 0) return true
    for (const range of ranges) {
      if (n < range.start) return false
      if (n <= range.end) return true
    }
    return false
  }

  function consumeLine(rawLine: string): void {
    acc.totalLines += 1
    const n = acc.totalLines
    if (!selected(n)) return
    acc.selectedCount += 1
    if (request.mode === 'raw') {
      if (acc.truncatedByBytes || acc.rawLines >= request.maxLines) return
      const text = truncateLine(rawLine, request.maxLineLength)
      const bytes = lineByteSize(text, acc.rawLines)
      if (acc.outputBytes + bytes > request.maxBytes) {
        acc.truncatedByBytes = true
        return
      }
      acc.outputBytes += bytes
      acc.rawLines += 1
      acc.rawText += acc.rawText.length === 0 ? text : `\n${text}`
      return
    }
    if (acc.truncatedByBytes || acc.lines.length >= request.maxLines) return
    const text = truncateLine(rawLine, request.maxLineLength)
    const bytes = lineByteSize(text, acc.lines.length)
    if (acc.outputBytes + bytes > request.maxBytes) {
      acc.truncatedByBytes = true
      return
    }
    acc.outputBytes += bytes
    acc.lines.push({ number: n, text })
  }

  function appendToLineBuffer(segment: string): void {
    if (lineBuffer.length >= lineBufferCap) return
    lineBuffer += segment
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap)
  }

  function flushLine(): void {
    consumeLine(stripCarriageReturn(lineBuffer))
    lineBuffer = ''
  }

  for await (const chunk of chunks) {
    let startPos = 0
    let newlinePos: number
    while ((newlinePos = chunk.indexOf('\n', startPos)) !== -1) {
      appendToLineBuffer(chunk.slice(startPos, newlinePos))
      flushLine()
      startPos = newlinePos + 1
    }
    appendToLineBuffer(chunk.slice(startPos))
  }
  if (lineBuffer.length > 0) flushLine()

  const firstRange = ranges[0]
  const requestedEnd = firstRange === undefined ? 0 : firstRange.end
  const outOfRange = request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)
  const truncatedByLines = acc.selectedCount > (request.mode === 'raw' ? acc.rawLines : acc.lines.length)
  return {
    offset: request.offset,
    lines: acc.lines,
    rawText: acc.rawText,
    totalLines: acc.totalLines,
    truncatedByBytes: acc.truncatedByBytes,
    truncatedByLines,
    outOfRange,
    requestedEnd,
  }
}

/** Whether any output cap cut the window. */
export function windowTruncated(window: WindowResult): boolean {
  return window.truncatedByBytes || window.truncatedByLines
}

/**
 * Format a numbered file read as one OpenCode-style line-numbered block body.
 * @param displayPath - the resolved path rendered in the envelope's `<path>` element.
 * @param window - the windowed result to render.
 * @returns the model-facing envelope with numbered lines and a footer.
 */
export function formatNumberedRead(displayPath: string, window: WindowResult): string {
  const endLine = window.lines.at(-1)?.number ?? Math.max(0, window.offset - 1)
  let footer: string
  if (window.outOfRange) {
    footer = `(Lines ${window.offset}-${window.requestedEnd} are out of range: the file has ${window.totalLines} lines.)`
  } else if (window.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${window.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < window.totalLines) {
    footer = `(Showing lines ${window.offset}-${endLine} of ${window.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${window.totalLines} lines)`
  }
  const body = window.lines.length > 0
    ? `${window.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`
}

/**
 * Format a raw file read (whole-file or raw range) as a bare-text block body.
 * @param displayPath - the resolved path rendered in the envelope's `<path>` element.
 * @param window - the windowed result to render.
 * @returns the model-facing envelope with the raw text and a truncation/out-of-range footer.
 */
export function formatRawRead(displayPath: string, window: WindowResult): string {
  let footer: string
  if (window.outOfRange) {
    footer = `(Lines ${window.offset}-${window.requestedEnd} are out of range: the file has ${window.totalLines} lines.)`
  } else if (window.truncatedByBytes || window.truncatedByLines) {
    footer = `(Output truncated: the file has ${window.totalLines} lines.)`
  } else {
    footer = `(End of file - total ${window.totalLines} lines)`
  }
  const body = window.rawText.length > 0 ? `${window.rawText}\n\n${footer}` : footer
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`
}

/**
 * Lowercased file-extension to syntax-highlighting language hint — the same
 * intentionally small map as the upstream tool-fs, so a UI highlighting the
 * read card matches the retained experience.
 */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'cs', kt: 'kotlin', swift: 'swift', php: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'md', markdown: 'md', mdx: 'mdx',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', lua: 'lua',
}

/**
 * Derive a syntax-highlighting language hint from a read path's file extension.
 * Pure and case-insensitive; dotfiles and unknown extensions yield `undefined`.
 * @param path - the model-facing path the read reported.
 * @returns the language hint, or `undefined`.
 */
export function langFromPath(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined
}

/** Whether `value` is a valid {@link FileTextLine} (defensive narrowing from opaque `meta`). */
function isFileTextLine(value: unknown): value is FileTextLine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { number, text } = value as Record<string, unknown>
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && typeof text === 'string'
}

/** The `read` tool's private `tool/result` `meta` payload for file reads. */
export interface FsReadMeta {
  path: string
  offset: number
  lines: FileTextLine[]
  totalLines: number
  lang?: string
}

/**
 * Narrow opaque live or replayed result metadata to a structured read window.
 * Malformed or semantically invalid data returns `undefined` so presentation
 * falls back to the generic card instead of throwing during replay.
 * @param meta - result metadata.
 * @returns the validated read window, or `undefined`.
 */
export function readMetaFromMeta(meta: unknown): FsReadMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { path, offset, lines, totalLines, lang } = meta as Record<string, unknown>
  if (typeof path !== 'string' || typeof totalLines !== 'number' || typeof offset !== 'number') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (!Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines) || !lines.every(isFileTextLine)) return undefined
  if (lang !== undefined && typeof lang !== 'string') return undefined
  // Lines may start before `offset` (1+3 context lines), but must be strictly
  // increasing 1-based numbers within the file.
  let previous = 0
  for (const { number } of lines) {
    if (number <= previous || number > totalLines) return undefined
    previous = number
  }
  return { path, offset, lines, totalLines, ...lang === undefined ? {} : { lang } }
}

/**
 * Internal `agent://<sessionId>` URL reading: resolve a live session by id
 * and render its durable transcript to plain text, omp-style. The renderer is
 * Cordis-free — it works on any `Session` object — so elision and windowing
 * are unit-testable without a host.
 *
 * Transcript source: the append-only event log, projected per event. A human
 * transcript must keep the DURABLE conversation, so only append-origin
 * surface events (`user/message`, `assistant/message`, `tool/result`) render
 * in seq order; a compaction `replace` node shadowed conversation the user
 * already saw and would render out of order (the advisor's `delta.ts`
 * documents the same distinction). Log-only trace events (turn/step
 * boundaries, chunks, headers, tool/call) are skip data — except `tool/call`,
 * which is consumed solely to name the matching `tool/result`.
 * @module dsh-tool-read-write/read/agent
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message, TextBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { WindowResult } from './render.ts'

/** Default characters of one tool-result body kept before elision (the `agentToolResultChars` config). */
export const AGENT_TOOL_RESULT_CHARS = 2000

/** The `agent://` URL scheme prefix this module owns. */
export const AGENT_SCHEME = 'agent://'

/** The result of splitting an `agent://` read path into its session address. */
export interface AgentPath {
  /** The session id to resolve — the whole tail, or the final path segment of a nested address. */
  sessionId: string
  /** The leading segment of a nested `agent://<parent>/<child>` address, when present. */
  parentId?: string
}

/**
 * Split an `agent://` base path (selectors already stripped) into a session
 * address. dsh session ids are flat and globally unique — a child session is
 * addressed by its own id — so a nested omp-style address collapses to the
 * final segment, with the leading segment kept as a parent relation to verify.
 * @param base - the path after selector parsing, e.g. `agent://worker-1` or
 *   `agent://parent/child`.
 * @returns the session address, or undefined when the path is not an `agent://` URL.
 */
export function parseAgentPath(base: string): AgentPath | undefined {
  if (!base.startsWith(AGENT_SCHEME)) return undefined
  const rest = base.slice(AGENT_SCHEME.length)
  if (rest === '') return undefined
  const slash = rest.indexOf('/')
  if (slash === -1) return { sessionId: rest }
  const parentId = rest.slice(0, slash)
  const sessionId = rest.slice(slash + 1)
  if (sessionId === '') return undefined
  return { sessionId, parentId }
}

/** One rendered transcript plus the bookkeeping a read value needs. */
export interface AgentTranscript {
  /** The full transcript text (title block + events + final-output trailer). */
  text: string
  /** The number of rendered conversation entries (user/assistant/tool-result). */
  messageCount: number
  /** Whether any tool-result body was elided with a truncation marker. */
  elided: boolean
  /** The last assistant text output, when one exists (surfaced as `── final output ──`). */
  finalOutput?: string
}

/** Render one message's content blocks as readable text. */
function messageBody(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'reasoning':
        parts.push(`<reasoning>\n${block.text}\n</reasoning>`)
        break
      case 'image':
        parts.push('[image]')
        break
      case 'tool-call':
        parts.push(`[tool call: ${block.name} ${block.arguments}]`)
        break
      default:
        // Merge-extensible block vocabulary: render any unknown block by its tag.
        parts.push(`[${block.type}]`)
    }
  }
  return parts.join('\n')
}

/** The visible (non-tool-call) text of an assistant message — the final-output candidate. */
function assistantText(message: Message): string {
  const blocks = message.content.filter((block): block is TextBlock => block.type === 'text')
  return blocks.map(block => block.text).join('\n')
}

/**
 * Render a tool-result message body, eliding oversized output with the
 * truncation marker. A tool-role message carries its result blocks directly —
 * `toolCallId`/`isError` live at the message top level, not inside a wrapping
 * `tool-result` block.
 */
function toolResultBody(message: ToolResultMessage, maxChars: number): { text: string; elided: boolean } {
  const inner: string[] = []
  if (message.isError === true) inner.push(`[tool error: ${message.toolCallId}]`)
  for (const content of message.content) {
    if (content.type === 'text') inner.push(content.text)
    else inner.push(`[${content.type}]`)
  }
  const full = inner.join('\n')
  if (full.length <= maxChars) return { text: full, elided: false }
  return {
    text: `${full.slice(0, maxChars)}\n[tool output truncated — ${full.length} chars]`,
    elided: true,
  }
}

/**
 * Render a session's durable transcript as omp-like plain text.
 * @param session - the live session to read.
 * @param maxToolResultChars - characters of one tool-result body kept before elision.
 * @returns the rendered transcript text and its bookkeeping.
 */
export function renderAgentTranscript(session: Session, maxToolResultChars: number): AgentTranscript {
  const parts: string[] = []
  let messageCount = 0
  let elided = false
  let finalOutput: string | undefined

  // `tool/result` events name the call only by id; the log-only `tool/call`
  // events pair that id with the tool name.
  const toolNames = new Map<string, string>()

  for (const event of session.snapshotEvents()) {
    if (event.type === 'tool/call') {
      toolNames.set(event.data.callId, event.data.name)
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') {
      continue
    }
    // A compaction `replace` node is model-visible history, not durable
    // conversation — skip it so the transcript stays in log order.
    if (!isAppendSurfaceEvent(event)) continue

    switch (event.type) {
      case 'user/message':
        messageCount += 1
        parts.push(`── user (seq ${event.seq}) ──`, messageBody(event.data))
        break
      case 'assistant/message': {
        messageCount += 1
        parts.push(`── assistant (seq ${event.seq}) ──`, messageBody(event.data.message))
        const text = assistantText(event.data.message)
        if (text !== '') finalOutput = text
        break
      }
      case 'tool/result': {
        messageCount += 1
        const name = toolNames.get(event.data.message.toolCallId)
        parts.push(`── tool result${name !== undefined ? `: ${name}` : ''} (seq ${event.seq}) ──`)
        const body = toolResultBody(event.data.message, maxToolResultChars)
        if (body.elided) elided = true
        parts.push(body.text)
        break
      }
    }
  }

  // Title block: the address plus durable session metadata.
  const header: string[] = [`# ${AGENT_SCHEME}${session.id}`]
  header.push(`created: ${new Date(session.header.createdAt).toISOString()}`)
  const lastReal = session.snapshotEvents().findLast(event => event.type !== 'session/end-seed')
  header.push(`updated: ${new Date(lastReal?.time ?? session.header.createdAt).toISOString()}`)
  header.push(`messages: ${messageCount}`)
  if (session.header.parentSession !== undefined) header.push(`parent: ${session.header.parentSession}`)
  if (session.header.cwd !== undefined) header.push(`cwd: ${session.header.cwd}`)
  if (session.header.origin !== undefined) header.push(`origin: ${session.header.origin}`)
  if (session.header.agentPreset !== undefined) header.push(`agent preset: ${session.header.agentPreset}`)

  const body = parts.join('\n')
  const text = finalOutput === undefined
    ? `${header.join('\n')}\n\n${body}`
    : `${header.join('\n')}\n\n${body}\n\n── final output ──\n${finalOutput}`
  return { text, messageCount, elided, ...finalOutput === undefined ? {} : { finalOutput } }
}

/**
 * Format a numbered agent read as the model-facing envelope, mirroring the
 * file window formatter with transcript wording.
 * @param displayPath - the `agent://` URL rendered in the `<path>` element.
 * @param window - the windowed transcript to render.
 * @returns the envelope with numbered lines and a footer.
 */
export function formatAgentRead(displayPath: string, window: WindowResult): string {
  const endLine = window.lines.at(-1)?.number ?? Math.max(0, window.offset - 1)
  let footer: string
  if (window.outOfRange) {
    footer = `(Lines ${window.offset}-${window.requestedEnd} are out of range: the transcript has ${window.totalLines} lines.)`
  } else if (window.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${window.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < window.totalLines) {
    footer = `(Showing lines ${window.offset}-${endLine} of ${window.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of transcript - total ${window.totalLines} lines)`
  }
  const body = window.lines.length > 0
    ? `${window.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${displayPath}</path>
<type>agent</type>
<content>
${body}
</content>`
}

/**
 * Format a raw agent read (whole transcript or raw range) as a bare-text
 * block body, mirroring the file raw formatter with transcript wording.
 */
export function formatAgentRawRead(displayPath: string, window: WindowResult): string {
  let footer: string
  if (window.outOfRange) {
    footer = `(Lines ${window.offset}-${window.requestedEnd} are out of range: the transcript has ${window.totalLines} lines.)`
  } else if (window.truncatedByBytes || window.truncatedByLines) {
    footer = `(Output truncated: the transcript has ${window.totalLines} lines.)`
  } else {
    footer = `(End of transcript - total ${window.totalLines} lines)`
  }
  const body = window.rawText.length > 0 ? `${window.rawText}\n\n${footer}` : footer
  return `<path>${displayPath}</path>
<type>agent</type>
<content>
${body}
</content>`
}

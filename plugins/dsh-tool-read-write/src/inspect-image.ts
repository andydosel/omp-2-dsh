/**
 * The `inspect_image` tool: a local image + a question → one vision-model call
 * → text analysis, returned with `{model, mimeType}`. The image bytes are
 * format-sniffed (PNG/JPEG/GIF/WebP), capped at 20 MiB, and persisted through
 * the attachment service so the vision route's adapter can resolve them.
 *
 * Vision routing: `visionProvider`/`visionModel` config override the main
 * route; empty means the calling agent's route. The resolved vision model must
 * declare image input or the call refuses. `inspectImageMode`: `on` always
 * registers; `off` never; `auto` registers but refuses at execution when the
 * calling agent's MAIN route already accepts image input (registration-time
 * gating is impossible in dsh — routes are per-session, so auto is enforced at
 * the execution boundary, the closest faithful equivalent).
 * @module dsh-tool-read-write/inspect-image
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { sessionResolveOptions } from './session-cwd.ts'

/** `inspectImageMode` config values. */
export type InspectImageMode = 'auto' | 'on' | 'off'

/** Inspect-image config knobs. */
export interface InspectImageConfig {
  mode: InspectImageMode
  timeoutMs: number
  maxBytes: number
  visionProvider: string
  visionModel: string
}

/** Sniff the media type of an image from its leading magic bytes. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6) {
    const head = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!)
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12
    && String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF'
    && String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

/** Resolve the vision route: configured override, else the calling agent's route. */
export function resolveVisionRoute(
  exec: ToolExecution,
  visionProvider: string,
  visionModel: string,
): { provider: string; model: string } {
  if (visionProvider !== '' && visionModel !== '') return { provider: visionProvider, model: visionModel }
  if (visionProvider !== '' || visionModel !== '') {
    throw new Error('visionProvider and visionModel must be configured together (or both left empty to use the current model route)')
  }
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (provider === undefined || model === undefined) {
    throw new Error('inspect_image: the current model route could not be resolved; configure visionProvider/visionModel')
  }
  return { provider, model }
}

/** Whether the resolved route declares image input. */
async function routeAcceptsImages(ctx: Context, provider: string, model: string, exec: ToolExecution): Promise<boolean> {
  const llm = ctx.get('llm')
  if (llm === undefined) return false
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  return info.inputModalities !== undefined && info.inputModalities.includes('image')
}

/** Assemble the model text from a streamed vision response. */
export async function collectVisionText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(`inspect_image: the vision model call failed (${chunk.reason.failure.message})`)
    }
  }
  return text
}

/**
 * Register the `inspect_image` tool. The composing plugin owns the attachments
 * gate (the vision call needs a durable image reference); `mode: 'off'` skips
 * registration entirely.
 * @param ctx - the registration scope (attachments-mounted).
 * @param config - inspect-image config knobs.
 */
export function applyInspectImageTool(ctx: Context, config: InspectImageConfig): void {
  if (config.mode === 'off') return
  ctx.systemPrompt.section({
    name: 'tool:inspect_image',
    order: 110,
    text: 'Use the inspect_image tool to analyze a local image (PNG/JPEG/GIF/WebP) with a question; a vision model '
      + 'returns a text analysis. This is for images the main model cannot see directly; if the active model already '
      + 'accepts image input, prefer read_image.',
  })

  ctx.tools.register(defineTool({
    name: 'inspect_image',
    description: 'Analyze a local image by asking a vision model a question about it. Returns text.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the image file (PNG/JPEG/GIF/WebP), resolved by the filesystem backend.' },
      question: { type: 'string', required: true, description: 'The question to ask the vision model about the image.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { type: 'string', required: true },
          model: { type: 'string', required: true },
          mimeType: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: config.timeoutMs,
    // Reads the image, persists it content-addressed, and streams one model
    // call — no parent-owned state is mutated, so sibling calls are safe.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.path.trim().length === 0) throw new Error('path must be a non-empty string')
      if (args.question.trim().length === 0) throw new Error('question must be a non-empty string')

      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error(`cannot inspect "${args.path}": no attachment service is mounted`)
      }
      const llm = ctx.get('llm')
      if (llm === undefined) {
        throw new Error('cannot inspect an image: no llm service is mounted')
      }

      const { provider, model } = resolveVisionRoute(exec, config.visionProvider, config.visionModel)
      // Auto mode: when the MAIN route (no explicit vision route) already
      // accepts image input, inspect_image is redundant.
      if (config.mode === 'auto' && config.visionProvider === '') {
        const main = resolveVisionRoute(exec, '', '')
        if (await routeAcceptsImages(ctx, main.provider, main.model, exec)) {
          throw new Error(`inspect_image is unnecessary: the active model "${main.model}" already accepts image input; use read_image instead`)
        }
      }
      // The resolved vision model must declare image input.
      const info = await llm.resolveModelInfo(provider, model, exec.signal)
      if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
        throw new Error(`cannot inspect an image: model "${model}" does not declare image input; configure visionProvider/visionModel with an image-capable model`)
      }

      const target = await ctx.fs.resolve(args.path, sessionResolveOptions(exec, args.path))
      const fsInfo = await ctx.fs.stat(target, exec.signal)
      if (fsInfo === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`cannot inspect "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (fsInfo.type !== 'file') {
        throw new FsError(`cannot inspect "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      const byteCap = Math.min(config.maxBytes, attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
      const mimeType = sniffImageMediaType(data)
      if (mimeType === undefined) {
        throw new Error(`cannot inspect "${target.displayPath}": the bytes are not a PNG/JPEG/GIF/WebP image (or the file exceeds the ${byteCap}-byte cap)`)
      }
      const ref: ImageAttachmentRef = await attachments.saveImage({ data, mediaType: mimeType, name: basename(target.displayPath) })

      const message = createUserMessage({
        content: [
          { type: 'image', attachment: ref },
          { type: 'text', text: args.question },
        ],
        source: { kind: 'dsh-tool-read-write' },
      })
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
      const signal = AbortSignal.any([exec.signal, timeoutSignal])
      const text = await collectVisionText(llm.stream({ provider, model, messages: [message], signal }))

      ctx.emit('fs/observed', target, { kind: 'present', version: fsInfo.version }, exec)
      return { path: target.displayPath, text, model, mimeType }
    },
    // Pure display: a generic card in the read family.
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Inspect image ${args.path}`,
        kind: 'read',
        locations: [{ path: args.path }],
      }
    },
  }))
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageAttachmentLimits, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { applyReadImageTool, imageMediaTypeForPath } from '../src/read-image.ts'
import { applyInspectImageTool, collectVisionText, resolveVisionRoute, sniffImageMediaType } from '../src/inspect-image.ts'
import type { InspectImageConfig } from '../src/inspect-image.ts'
import { HarnessCtx, HarnessFs, makeExec, tempDir } from './helpers.ts'

/** A minimal 1x1 transparent PNG. */
const PNG_1X1 = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
)

/** Fake attachment store satisfying the AttachmentStore surface. */
class FakeAttachments {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 20 * 1024 * 1024,
    maxImagesPerMessage: 10,
    maxMessageImageBytes: 20 * 1024 * 1024,
    maxImagePixels: 10_000_000,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  }
  saved: SaveImageAttachment[] = []

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    return {
      attachmentId: AttachmentId(`test-${this.saved.length}`),
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    }
  }

  async validateImage(): Promise<void> {}

  async readImage(ref: ImageAttachmentRef): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }> {
    return { ref, data: PNG_1X1 }
  }
}

/** Fake llm service with per-model capability and recorded streams. */
class FakeLlm {
  modelInfo = new Map<string, { provider: string; id: string; name: string; inputModalities?: string[] }>()
  calls: Array<{ options: GenerateOptions; signal: AbortSignal | undefined }> = []
  chunks: StreamChunk[] = []

  async resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: string[] }> {
    return this.modelInfo.get(model) ?? { provider, id: model, name: model, inputModalities: ['text'] }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push({ options, signal: options.signal })
    return (async function* () {
      for (const chunk of this.chunks) yield chunk
    }).call(this)
  }
}

function agentFor(model: string): unknown {
  return {
    options: { provider: 'test-provider', model },
    session: { requestHeader: () => undefined, header: { cwd: undefined } },
  }
}

const INSPECT_CONFIG: InspectImageConfig = {
  mode: 'on',
  timeoutMs: 300_000,
  maxBytes: 20 * 1024 * 1024,
  visionProvider: '',
  visionModel: '',
}

let dir: string

beforeEach(async () => {
  dir = await tempDir('image-tool-test')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('imageMediaTypeForPath / sniffImageMediaType', () => {
  it('maps extensions to media types', () => {
    expect(imageMediaTypeForPath('a.png')).toBe('image/png')
    expect(imageMediaTypeForPath('a.JPG')).toBe('image/jpeg')
    expect(imageMediaTypeForPath('a.webp')).toBe('image/webp')
    expect(imageMediaTypeForPath('a.gif')).toBe('image/gif')
    expect(imageMediaTypeForPath('a.txt')).toBeUndefined()
  })

  it('sniffs PNG/JPEG/GIF/WebP magic bytes and rejects others', () => {
    expect(sniffImageMediaType(PNG_1X1)).toBe('image/png')
    expect(sniffImageMediaType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4))).toBe('image/jpeg')
    const gif = new TextEncoder().encode('GIF89a....')
    expect(sniffImageMediaType(gif)).toBe('image/gif')
    const webp = new TextEncoder().encode('RIFF1234WEBP')
    expect(sniffImageMediaType(webp)).toBe('image/webp')
    expect(sniffImageMediaType(Uint8Array.of(1, 2, 3, 4))).toBeUndefined()
  })
})

describe('resolveVisionRoute / collectVisionText', () => {
  it('falls back to the calling agent route when no vision config is set', () => {
    const exec = makeExec({ agent: agentFor('main-model') as never })
    expect(resolveVisionRoute(exec, '', '')).toEqual({ provider: 'test-provider', model: 'main-model' })
    expect(resolveVisionRoute(exec, 'vision-p', 'vision-m')).toEqual({ provider: 'vision-p', model: 'vision-m' })
  })

  it('requires both vision config fields together', () => {
    const exec = makeExec({ agent: agentFor('main-model') as never })
    expect(() => resolveVisionRoute(exec, 'vision-p', '')).toThrow(/configured together/)
  })

  it('assembles text deltas and throws on error finishes', async () => {
    const ok = (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'The image shows ' }
      yield { type: 'text-delta', index: 0, text: 'a cat.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
    expect(await collectVisionText(ok)).toBe('The image shows a cat.')

    const bad = (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }
    })()
    await expect(collectVisionText(bad)).rejects.toThrow(/vision model call failed/)
  })
})

describe('read_image tool', () => {
  it('registers only when attachments is mounted and reads an image through the attachment store', async () => {
    const ctx = new HarnessCtx(new HarnessFs(dir))
    const attachments = new FakeAttachments()
    ctx.services.set('attachments', attachments)
    ctx.services.set('llm', new FakeLlm())
    applyReadImageTool(ctx as never)

    const definition = ctx.registered[0]
    expect(definition).toBeDefined()
    await writeFile(join(dir, 'photo.png'), PNG_1X1)

    const exec = makeExec({ agent: agentFor('vision-model') as never })
    ;(ctx.services.get('llm') as FakeLlm).modelInfo.set('vision-model', { provider: 'test-provider', id: 'vision-model', name: 'vision-model', inputModalities: ['text', 'image'] })

    const value = await definition!.execute({ file_path: 'photo.png' }, exec)
    expect(value.path).toContain('photo.png')
    expect(value.image.mediaType).toBe('image/png')
    expect(value.image.bytes).toBe(PNG_1X1.length)
    expect(attachments.saved).toHaveLength(1)
    expect(ctx.observed).toHaveLength(1)
    expect(ctx.observed[0]).toBeDefined()
  })

  it('refuses when the routed model does not declare image input', async () => {
    const ctx = new HarnessCtx(new HarnessFs(dir))
    ctx.services.set('attachments', new FakeAttachments())
    const llm = new FakeLlm()
    llm.modelInfo.set('text-model', { provider: 'test-provider', id: 'text-model', name: 'text-model', inputModalities: ['text'] })
    ctx.services.set('llm', llm)
    applyReadImageTool(ctx as never)
    await writeFile(join(dir, 'photo.png'), PNG_1X1)
    const exec = makeExec({ agent: agentFor('text-model') as never })
    await expect(ctx.registered[0]!.execute({ file_path: 'photo.png' }, exec))
      .rejects.toThrow(/does not declare image input/)
  })

  it('refuses non-image extensions before any filesystem I/O', async () => {
    const ctx = new HarnessCtx(new HarnessFs(dir))
    ctx.services.set('attachments', new FakeAttachments())
    ctx.services.set('llm', new FakeLlm())
    applyReadImageTool(ctx as never)
    await expect(ctx.registered[0]!.execute({ file_path: 'notes.txt' }, makeExec()))
      .rejects.toThrow(/only accepts PNG\/JPEG\/WebP\/GIF/)
  })

  it('records fs/observed after the read', async () => {
    const ctx = new HarnessCtx(new HarnessFs(dir))
    ctx.services.set('attachments', new FakeAttachments())
    const llm = new FakeLlm()
    llm.modelInfo.set('vision-model', { provider: 'p', id: 'vision-model', name: 'vision-model', inputModalities: ['text', 'image'] })
    ctx.services.set('llm', llm)
    applyReadImageTool(ctx as never)
    await writeFile(join(dir, 'photo.png'), PNG_1X1)
    await ctx.registered[0]!.execute({ file_path: 'photo.png' }, makeExec({ agent: agentFor('vision-model') as never }))
    const [target, obs] = ctx.observed[0] as [unknown, { kind: string }]
    expect(obs.kind).toBe('present')
    expect((target as { displayPath: string }).displayPath).toContain('photo.png')
  })
})

describe('inspect_image tool', () => {
  it('does not register in off mode', () => {
    const ctx = new HarnessCtx(new HarnessFs(dir))
    ctx.services.set('attachments', new FakeAttachments())
    ctx.services.set('llm', new FakeLlm())
    applyInspectImageTool(ctx as never, { ...INSPECT_CONFIG, mode: 'off' })
    expect(ctx.registered).toHaveLength(0)
  })

  it('calls the vision route with an image block + question and returns text, model, mimeType', async () => {
    const ctx = new HarnessCtx(new HarnessFs(dir))
    const attachments = new FakeAttachments()
    ctx.services.set('attachments', attachments)
    const llm = new FakeLlm()
    llm.modelInfo.set('vision-model', { provider: 'vision-p', id: 'vision-model', name: 'vision-model', inputModalities: ['text', 'image'] })
    llm.chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'A cat sits on a mat.' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    ctx.services.set('llm', llm)
    applyInspectImageTool(ctx as never, { ...INSPECT_CONFIG, visionProvider: 'vision-p', visionModel: 'vision-model' })
    await writeFile(join(dir, 'cat.png'), PNG_1X1)

    const value = await ctx.registered[0]!.execute({ path: 'cat.png', question: 'What is in this image?' }, makeExec())
    expect(value).toMatchObject({ text: 'A cat sits on a mat.', model: 'vision-model', mimeType: 'image/png' })
    expect(llm.calls).toHaveLength(1)
    const call = llm.calls[0]!
    expect(call.options.provider).toBe('vision-p')
    expect(call.options.model).toBe('vision-model')
    expect(call.options.messages[0]!.content[0]!.type).toBe('image')
    expect(call.options.messages[0]!.content[1]).toEqual({ type: 'text', text: 'What is in this image?' })
    expect(attachments.saved).toHaveLength(1)
    expect(ctx.observed).toHaveLength(1)
  })

  it('refuses when the resolved vision model lacks image input', async () => {
    const ctx = new HarnessCtx(new HarnessFs(dir))
    ctx.services.set('attachments', new FakeAttachments())
    const llm = new FakeLlm()
    llm.modelInfo.set('text-model', { provider: 'p', id: 'text-model', name: 'text-model', inputModalities: ['text'] })
    ctx.services.set('llm', llm)
    applyInspectImageTool(ctx as never, { ...INSPECT_CONFIG, mode: 'auto', visionProvider: 'p', visionModel: 'text-model' })
    await writeFile(join(dir, 'cat.png'), PNG_1X1)
    await expect(ctx.registered[0]!.execute({ path: 'cat.png', question: '?' }, makeExec()))
      .rejects.toThrow(/does not declare image input/)
  })

  it('auto mode refuses when the main route already accepts images', async () => {
    const ctx = new HarnessCtx(new HarnessFs(dir))
    ctx.services.set('attachments', new FakeAttachments())
    const llm = new FakeLlm()
    llm.modelInfo.set('main-vision', { provider: 'p', id: 'main-vision', name: 'main-vision', inputModalities: ['text', 'image'] })
    ctx.services.set('llm', llm)
    applyInspectImageTool(ctx as never, { ...INSPECT_CONFIG, mode: 'auto' })
    await writeFile(join(dir, 'cat.png'), PNG_1X1)
    const exec = makeExec({ agent: agentFor('main-vision') as never })
    await expect(ctx.registered[0]!.execute({ path: 'cat.png', question: '?' }, exec))
      .rejects.toThrow(/already accepts image input/)
  })

  it('auto mode proceeds for a text-only main route with a configured vision route', async () => {
    const ctx = new HarnessCtx(new HarnessFs(dir))
    ctx.services.set('attachments', new FakeAttachments())
    const llm = new FakeLlm()
    llm.modelInfo.set('main-text', { provider: 'p', id: 'main-text', name: 'main-text', inputModalities: ['text'] })
    llm.modelInfo.set('vision-model', { provider: 'vision-p', id: 'vision-model', name: 'vision-model', inputModalities: ['text', 'image'] })
    llm.chunks = [{ type: 'text-delta', index: 0, text: 'it is a picture' }, { type: 'finish', reason: { kind: 'stop' } }]
    ctx.services.set('llm', llm)
    applyInspectImageTool(ctx as never, { ...INSPECT_CONFIG, mode: 'auto', visionProvider: 'vision-p', visionModel: 'vision-model' })
    await writeFile(join(dir, 'cat.png'), PNG_1X1)
    const exec = makeExec({ agent: agentFor('main-text') as never })
    const value = await ctx.registered[0]!.execute({ path: 'cat.png', question: '?' }, exec)
    expect(value.text).toBe('it is a picture')
    expect(value.model).toBe('vision-model')
  })

  it('rejects non-image bytes and missing files', async () => {
    const ctx = new HarnessCtx(new HarnessFs(dir))
    ctx.services.set('attachments', new FakeAttachments())
    const llm = new FakeLlm()
    llm.modelInfo.set('vision-model', { provider: 'p', id: 'vision-model', name: 'vision-model', inputModalities: ['text', 'image'] })
    ctx.services.set('llm', llm)
    applyInspectImageTool(ctx as never, { ...INSPECT_CONFIG, visionProvider: 'p', visionModel: 'vision-model' })
    await writeFile(join(dir, 'not.png'), 'just text')
    await expect(ctx.registered[0]!.execute({ path: 'not.png', question: '?' }, makeExec()))
      .rejects.toThrow(/not a PNG\/JPEG\/GIF\/WebP/)
    await expect(ctx.registered[0]!.execute({ path: 'missing.png', question: '?' }, makeExec()))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

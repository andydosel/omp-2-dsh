import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ILinkClient } from '../src/ilink/client.ts'
import { aes128EcbDecrypt, aesKeyForApi } from '../src/ilink/crypto.ts'
import {
  buildMediaItem,
  extractLocalFiles,
  extractMedia,
  mediaKindForPath,
  sendFile,
} from '../src/ilink/media.ts'
import { randomBytes } from 'node:crypto'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wechat-media-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('extractMedia', () => {
  it('extracts MEDIA: tags and strips them from the text', () => {
    const { media, cleaned } = extractMedia('MEDIA:/tmp/a.png\nsee this')
    expect(media).toEqual([{ path: '/tmp/a.png', isVoice: false }])
    expect(cleaned).toBe('see this')
  })

  it('honors quotes/backticks and the [[audio_as_voice]] directive', () => {
    const { media, cleaned } = extractMedia('[[audio_as_voice]]\nMEDIA:`/tmp/note.ogg`')
    expect(media).toEqual([{ path: '/tmp/note.ogg', isVoice: true }])
    expect(cleaned).toBe('')
  })

  it('extracts multiple tags', () => {
    const { media } = extractMedia('MEDIA:/a.png\nMEDIA:/b.png')
    expect(media).toHaveLength(2)
  })
})

describe('extractLocalFiles', () => {
  it('detects existing absolute paths and removes them from text', () => {
    const file = join(dir, 'chart.pdf')
    writeFileSync(file, 'pdf')
    const { files, cleaned } = extractLocalFiles(`here: ${file} thanks`)
    expect(files).toEqual([file])
    expect(cleaned).not.toContain(file)
  })

  it('ignores paths inside code spans and missing files', () => {
    const { files } = extractLocalFiles('```\n/usr/local/example.png\n``` and `/nope/x.png`')
    expect(files).toEqual([])
  })

  it('accepts tilde-home paths', () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const file = join(home, 'pic.jpg')
    if (home) writeFileSync(file, 'jpg')
    const { files } = extractLocalFiles(`~/pic.jpg`)
    expect(files).toContain(file)
  })
})

describe('mediaKindForPath', () => {
  it('classifies by extension', () => {
    expect(mediaKindForPath('/x/a.png', false)).toBe('image')
    expect(mediaKindForPath('/x/a.mp4', false)).toBe('video')
    expect(mediaKindForPath('/x/a.silk', false)).toBe('voice')
    expect(mediaKindForPath('/x/a.ogg', false)).toBe('file') // audio → file fallback
    expect(mediaKindForPath('/x/a.pdf', false)).toBe('file')
    expect(mediaKindForPath('/x/a.png', true)).toBe('file') // forced attachment
  })
})

describe('buildMediaItem', () => {
  it('builds the image item with encrypt_type 1 and the base64(hex) key', () => {
    const item = buildMediaItem('image', '/x/a.png', 'ENC', 'a2V5', 100, 50, 'md5')
    expect(item).toEqual({
      type: 2,
      image_item: {
        media: { encrypt_query_param: 'ENC', aes_key: 'a2V5', encrypt_type: 1 },
        mid_size: 100,
      },
    })
  })

  it('builds the file item with the plaintext len as a string', () => {
    const item = buildMediaItem('file', '/x/a.pdf', 'ENC', 'k', 200, 150, 'md5')
    expect(item).toMatchObject({ type: 4, file_item: { file_name: 'a.pdf', len: '150' } })
  })

  it('builds the voice item with silk encode params', () => {
    const item = buildMediaItem('voice', '/x/a.silk', 'ENC', 'k', 300, 250, 'md5')
    expect(item).toMatchObject({
      type: 3,
      voice_item: { encode_type: 6, sample_rate: 24000, bits_per_sample: 16 },
    })
  })
})

describe('sendFile end-to-end (mock CDN)', () => {
  function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch
  }

  it('uploads encrypted bytes via POST and sends the media message', async () => {
    const plaintext = 'attachment-content'
    const file = join(dir, 'photo.png')
    writeFileSync(file, plaintext, 'utf-8')

    const calls: { url: string; method: string; body?: string | Uint8Array }[] = []
    let sentMediaItem: Record<string, unknown> | undefined
    let sentAesKey: string | undefined
    let uploadedCiphertext: Uint8Array | undefined

    const client = new ILinkClient({
      baseUrl: 'https://ilink.test',
      token: 't',
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(async (url, init) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | Uint8Array })
        if (url.endsWith('/ilink/bot/getuploadurl')) {
          return new Response(JSON.stringify({ upload_param: 'UP', upload_full_url: 'https://cdn.test/full' }), { status: 200 })
        }
        if (url.startsWith('https://cdn.test')) {
          uploadedCiphertext = init?.body as Uint8Array
          return new Response('', { status: 200, headers: { 'x-encrypted-param': 'ENC-1' } })
        }
        if (url.endsWith('/ilink/bot/sendmessage')) {
          const msg = JSON.parse(String(init?.body))['msg']
          sentMediaItem = msg['item_list'][0]
          sentAesKey = sentMediaItem?.['image_item']?.['media']?.['aes_key']
          return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      }),
    })

    const result = await sendFile(client, { to: 'peer@im.wechat', path: file, contextToken: 'CT-9' })

    // POST to CDN (not PUT), with the ciphertext body
    const uploadCall = calls.find((c) => c.url.startsWith('https://cdn.test'))
    expect(uploadCall?.method).toBe('POST')
    expect(uploadedCiphertext).toBeDefined()

    // the receiver can decrypt with the key encoded base64(hex)
    const keyBytes = randomBytes(16)
    void keyBytes
    // verify decryptability: the media item's aes_key (base64 of hex string)
    // must reconstruct the encryption key for uploadedCiphertext
    const itemAesKey = sentMediaItem?.['image_item']?.['media']?.['aes_key'] as string
    expect(sentAesKey).toBe(itemAesKey)
    // encrypt side used a random key; decode item key and decrypt the upload
    const { parseAesKey } = await import('../src/ilink/crypto.ts')
    const raw = aes128EcbDecrypt(uploadedCiphertext!, parseAesKey(itemAesKey))
    expect(Buffer.from(raw).toString('utf-8')).toBe(plaintext)

    // item shape
    expect(sentMediaItem?.['type']).toBe(2)
    expect((sentMediaItem?.['image_item'] as Record<string, unknown>)?.['media']).toMatchObject({
      encrypt_query_param: 'ENC-1',
      encrypt_type: 1,
    })
    expect(result.clientId).toMatch(/^dsh-wechat-/)
  })

  it('aes_key on the wire is base64(hex-string), the documented gotcha', () => {
    const key = randomBytes(16)
    const wireKey = aesKeyForApi(key)
    // base64(raw bytes) would be a DIFFERENT string — asserting the wire
    // value decodes to the 32-char hex representation.
    expect(Buffer.from(wireKey, 'base64').toString('ascii')).toBe(Buffer.from(key).toString('hex'))
    expect(wireKey).not.toBe(Buffer.from(key).toString('base64'))
  })
})

describe('media fixtures regression', () => {
  it('cacheMediaBytes writes atomic decrypted files', async () => {
    const { cacheMediaBytes } = await import('../src/ilink/media.ts')
    const cacheDir = join(dir, 'cache')
    const path = cacheMediaBytes(cacheDir, 'voice.silk', new TextEncoder().encode('silk-bytes'))
    expect(readFileSync(path, 'utf-8')).toBe('silk-bytes')
  })
})

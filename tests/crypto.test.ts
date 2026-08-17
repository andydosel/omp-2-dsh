import { describe, expect, it } from 'vitest'
import {
  aes128EcbDecrypt,
  aes128EcbEncrypt,
  aesKeyForApi,
  aesPaddedSize,
  parseAesKey,
  pkcs7Pad,
  pkcs7Unpad,
} from '../src/ilink/crypto.ts'
import { randomBytes } from 'node:crypto'

describe('AES-128-ECB media crypto', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const key = randomBytes(16)
    const plaintext = new TextEncoder().encode('hello iLink media payload')
    const ciphertext = aes128EcbEncrypt(plaintext, key)
    expect(ciphertext).not.toEqual(plaintext)
    expect(aes128EcbDecrypt(ciphertext, key)).toEqual(plaintext)
  })

  it('round-trips payloads of every block-aligned length', () => {
    const key = randomBytes(16)
    for (const size of [0, 1, 15, 16, 17, 31, 32, 33, 1000]) {
      const plaintext = new Uint8Array(size).fill(0x41)
      const ciphertext = aes128EcbEncrypt(plaintext, key)
      expect(ciphertext.length % 16).toBe(0)
      expect(aes128EcbDecrypt(ciphertext, key)).toEqual(plaintext)
    }
  })

  it('pkcs7 pads to the block size and unpads symmetrically', () => {
    expect(pkcs7Pad(new Uint8Array(10))).toHaveLength(16)
    expect(pkcs7Pad(new Uint8Array(16))).toHaveLength(32)
    const padded = pkcs7Pad(new Uint8Array(3))
    expect(padded[15]).toBe(13)
    expect(pkcs7Unpad(padded)).toEqual(new Uint8Array(3))
  })

  it('pkcs7Unpad leaves invalid padding untouched (hermes behavior)', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 9])
    expect(pkcs7Unpad(data)).toEqual(data)
    expect(pkcs7Unpad(new Uint8Array(0))).toEqual(new Uint8Array(0))
  })

  it('aesPaddedSize matches hermes formula', () => {
    expect(aesPaddedSize(0)).toBe(16)
    expect(aesPaddedSize(15)).toBe(32)
    expect(aesPaddedSize(16)).toBe(32)
    expect(aesPaddedSize(17)).toBe(48)
    expect(aesPaddedSize(100)).toBe(128)
  })
})

describe('aes_key base64(hex) gotcha', () => {
  it('aesKeyForApi produces base64 of the HEX STRING, not raw bytes', () => {
    const key = Uint8Array.from([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
      0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    ])
    const hexString = '000102030405060708090a0b0c0d0e0f'
    const expected = Buffer.from(hexString, 'ascii').toString('base64')
    // base64(raw bytes) differs — this is the documented grey-box gotcha.
    const rawBytesB64 = Buffer.from(key).toString('base64')
    expect(aesKeyForApi(key)).toBe(expected)
    expect(aesKeyForApi(key)).not.toBe(rawBytesB64)
  })

  it('parseAesKey accepts base64(hex string) (32 decoded chars)', () => {
    const key = randomBytes(16)
    const b64Hex = Buffer.from(Buffer.from(key).toString('hex'), 'ascii').toString('base64')
    expect(parseAesKey(b64Hex)).toEqual(new Uint8Array(key))
  })

  it('parseAesKey accepts base64(raw 16 bytes) for leniency', () => {
    const key = randomBytes(16)
    expect(parseAesKey(Buffer.from(key).toString('base64'))).toEqual(new Uint8Array(key))
  })

  it('parseAesKey rejects unexpected decoded lengths', () => {
    expect(() => parseAesKey(Buffer.from('abc').toString('base64'))).toThrow(/unexpected aes_key format/)
    expect(() => parseAesKey(Buffer.from('not-hex-string-here').toString('base64'))).toThrow(/unexpected aes_key format/)
  })

  it('the full send-side key path decrypts on the receiver side', () => {
    const key = randomBytes(16)
    const plaintext = new TextEncoder().encode('attachment bytes')
    const ciphertext = aes128EcbEncrypt(plaintext, key)
    // Simulate the receiver: it gets base64(hex) from the API and must derive
    // the same raw key used for encryption.
    const receiverKey = parseAesKey(aesKeyForApi(key))
    expect(aes128EcbDecrypt(ciphertext, receiverKey)).toEqual(plaintext)
  })
})

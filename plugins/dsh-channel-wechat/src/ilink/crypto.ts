/**
 * AES-128-ECB media encryption for the iLink Bot API, mirroring hermes
 * `gateway/platforms/weixin.py` (`_pkcs7_pad`, `_aes128_ecb_encrypt`,
 * `_aes128_ecb_decrypt`, `_parse_aes_key`, `_aes_padded_size`).
 *
 * The documented gotcha: the `aes_key` passed to the API is
 * **base64(hex-string-of-bytes)**, NOT base64(raw bytes) — sending
 * base64(raw_bytes) decrypts on the receiver as a grey-box mismatch
 * (`weixin.py:2037-2042`). Inbound media items carry the same encoding, so
 * `parseAesKey` accepts both base64(16 raw bytes) (len 16) and
 * base64(32-char hex string) (len 32) to be lenient, exactly like hermes.
 * @module @dsh-plugin/dsh-channel-wechat/ilink/crypto
 */

import { createDecipheriv, createCipheriv } from 'node:crypto'

/** AES block size in bytes. */
export const AES_BLOCK_SIZE = 16

/** PKCS#7 pad (hermes `_pkcs7_pad`). */
export function pkcs7Pad(data: Uint8Array, blockSize: number = AES_BLOCK_SIZE): Uint8Array {
  const padLen = blockSize - (data.length % blockSize)
  const out = new Uint8Array(data.length + padLen)
  out.set(data)
  out.fill(padLen, data.length)
  return out
}

/** PKCS#7 unpad; returns the input unchanged when the padding is invalid (hermes behavior). */
export function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data
  const padLen = data[data.length - 1]!
  if (padLen >= 1 && padLen <= AES_BLOCK_SIZE && data.length >= padLen) {
    let valid = true
    for (let i = data.length - padLen; i < data.length; i++) {
      if (data[i] !== padLen) {
        valid = false
        break
      }
    }
    if (valid) return data.subarray(0, data.length - padLen)
  }
  return data
}

/** AES-128-ECB encrypt with PKCS#7 padding (hermes `_aes128_ecb_encrypt`). */
export function aes128EcbEncrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const padded = pkcs7Pad(plaintext)
  return new Uint8Array(Buffer.concat([cipher.update(padded), cipher.final()]))
}

/** AES-128-ECB decrypt and best-effort unpad (hermes `_aes128_ecb_decrypt`). */
export function aes128EcbDecrypt(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return pkcs7Unpad(new Uint8Array(padded))
}

/**
 * Parse an API/network `aes_key`: base64 of either 16 raw bytes or the
 * 32-char hex string of those bytes (hermes `_parse_aes_key`).
 * @param aesKeyB64 - base64-encoded key as delivered by iLink.
 * @returns the 16 raw key bytes.
 * @throws on unexpected decoded lengths.
 */
export function parseAesKey(aesKeyB64: string): Uint8Array {
  const decoded = Buffer.from(aesKeyB64, 'base64')
  if (decoded.length === 16) return new Uint8Array(decoded)
  if (decoded.length === 32) {
    const text = decoded.toString('ascii')
    if (/^[0-9a-fA-F]{32}$/.test(text)) return new Uint8Array(Buffer.from(text, 'hex'))
  }
  throw new Error(`unexpected aes_key format (${decoded.length} decoded bytes)`)
}

/** AES-padded size for `getuploadurl` (`filesize`, hermes `_aes_padded_size`). */
export function aesPaddedSize(size: number): number {
  return Math.ceil((size + 1 + 15) / 16) * 16
}

/**
 * Encode a raw 16-byte key the way the iLink API expects it:
 * base64(hex-string). This is the send-side gotcha — base64 of the raw
 * bytes shows grey boxes on the receiver.
 */
export function aesKeyForApi(key: Uint8Array): string {
  return Buffer.from(Buffer.from(key).toString('hex'), 'ascii').toString('base64')
}

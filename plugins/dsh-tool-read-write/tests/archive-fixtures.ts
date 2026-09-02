/**
 * In-memory zip/tar fixture builders for the archive tests (writer-side only —
 * the parser under test is the plugin's own).
 */

import { deflateRawSync, gzipSync } from 'node:zlib'

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff]!) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const encoder = new TextEncoder()

/** Build a zip container with store (0) and/or deflate (8) entries. */
export function buildZip(entries: Array<{ name: string; data: Uint8Array; method?: 0 | 8 }>): Uint8Array {
  const chunks: Uint8Array[] = []
  const cd: Uint8Array[] = []
  let offset = 0
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  for (const entry of entries) {
    const isDir = entry.name.endsWith('/')
    const method = entry.method ?? 0
    const comp = method === 8 ? deflateRawSync(entry.data) : entry.data
    const crc = crc32(entry.data)
    const nameBytes = encoder.encode(entry.name)
    const local = new Uint8Array(30 + nameBytes.length)
    writeU32(local, 0, 0x04034b50)
    writeU16(local, 4, 20)
    writeU16(local, 6, 0x0800)
    writeU16(local, 8, method)
    writeU16(local, 10, dosTime)
    writeU16(local, 12, dosDate)
    writeU32(local, 14, crc)
    writeU32(local, 18, comp.length)
    writeU32(local, 22, entry.data.length)
    writeU16(local, 26, nameBytes.length)
    writeU16(local, 28, 0)
    local.set(nameBytes, 30)
    chunks.push(local, comp)

    const record = new Uint8Array(46 + nameBytes.length)
    writeU32(record, 0, 0x02014b50)
    writeU16(record, 4, 20)
    writeU16(record, 6, 20)
    writeU16(record, 8, 0x0800)
    writeU16(record, 10, method)
    writeU16(record, 12, dosTime)
    writeU16(record, 14, dosDate)
    writeU32(record, 16, crc)
    writeU32(record, 20, comp.length)
    writeU32(record, 24, entry.data.length)
    writeU16(record, 28, nameBytes.length)
    writeU16(record, 30, 0)
    writeU16(record, 32, 0)
    writeU16(record, 34, 0)
    writeU16(record, 36, 0)
    writeU32(record, 38, 0)
    writeU32(record, 42, offset)
    record.set(nameBytes, 46)
    cd.push(record)
    offset += local.length + comp.length
  }
  const cdBytes = concat(cd)
  const eocd = new Uint8Array(22)
  writeU32(eocd, 0, 0x06054b50)
  writeU16(eocd, 4, 0)
  writeU16(eocd, 6, 0)
  writeU16(eocd, 8, entries.length)
  writeU16(eocd, 10, entries.length)
  writeU32(eocd, 12, cdBytes.length)
  writeU32(eocd, 16, offset)
  writeU16(eocd, 20, 0)
  return concat([...chunks, cdBytes, eocd])
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i)
}

export function tarHeader(name: string, size: number, typeflag: string): Uint8Array {
  const header = new Uint8Array(512)
  const nameBytes = encoder.encode(name)
  header.set(nameBytes, 0)
  writeAscii(header, 100, '0000644\0')
  writeAscii(header, 108, '0000000\0')
  writeAscii(header, 116, '0000000\0')
  writeAscii(header, 124, `${size.toString(8).padStart(11, '0')}\0`)
  writeAscii(header, 136, '00000000000\0')
  writeAscii(header, 148, '        \0')
  header[156] = typeflag.charCodeAt(0)
  writeAscii(header, 257, 'ustar\0')
  writeAscii(header, 263, '00')
  let sum = 0
  for (const byte of header) sum += byte
  writeAscii(header, 148, `${sum.toString(8).padStart(6, '0')}\0 `)
  return header
}

/** Build a tar container; gzip it when `gzip` is set. */
export function buildTar(entries: Array<{ name: string; data?: Uint8Array; dir?: boolean }>, gzip = false): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    const size = entry.dir ? 0 : entry.data!.length
    chunks.push(tarHeader(entry.name, size, entry.dir ? '5' : '0'))
    if (!entry.dir) {
      chunks.push(entry.data!)
      const padding = size % 512 === 0 ? 0 : 512 - (size % 512)
      if (padding > 0) chunks.push(new Uint8Array(padding))
    }
  }
  chunks.push(new Uint8Array(1024))
  const tar = concat(chunks)
  return gzip ? gzipSync(tar) : tar
}

export const text = (value: string): Uint8Array => encoder.encode(value)

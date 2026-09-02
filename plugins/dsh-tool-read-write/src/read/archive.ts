/**
 * Archive reading: tar (plain and gzip-compressed) and zip-family containers
 * parsed from raw bytes via `node:zlib` plus self-written tar/zip parsing.
 * Pure over byte arrays so the format layer is testable without a filesystem.
 * @module dsh-tool-read-write/read/archive
 */

import { gunzipSync, inflateRawSync } from 'node:zlib'
import { TextDecoder } from 'node:util'

/** Byte cap on an archive container read (guards memory on hostile files). */
export const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024

/** One entry parsed from a tar container. */
export interface TarEntry {
  name: string
  type: 'file' | 'dir' | 'other'
  /** Uncompressed size in bytes. */
  size: number
  /** Offset of the entry's 512-byte header block. */
  headerOffset: number
  /** Offset of the entry's data. */
  dataOffset: number
}

/** One entry parsed from a zip central directory. */
export interface ZipEntry {
  name: string
  isDir: boolean
  /** 0 = stored, 8 = deflate. */
  method: number
  compSize: number
  uncompSize: number
  crc: number
  /** Offset of the entry's local header. */
  localOffset: number
  /** Offset of the entry's (compressed) data. */
  dataOffset: number
  /** Original DOS date/time and general-purpose flags, preserved on rewrite. */
  modTime: number
  modDate: number
  flags: number
}

/** Whether a path claims an archive by extension. */
export function archiveKindForPath(path: string): 'tar' | 'tar-gz' | 'zip' | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar-gz'
  if (lower.endsWith('.tar')) return 'tar'
  if (lower.endsWith('.zip') || lower.endsWith('.jar') || lower.endsWith('.war')
    || lower.endsWith('.ear') || lower.endsWith('.apk')) return 'zip'
  return undefined
}

/** Normalize a tar-style 100-byte name field: strip NULs and trailing spaces. */
function readAsciiField(data: Uint8Array, offset: number, length: number): string {
  const bytes = data.subarray(offset, offset + length)
  let end = bytes.length
  while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end -= 1
  return new TextDecoder('latin1').decode(bytes.subarray(0, end))
}

/** Parse a tar numeric field: octal, or GNU base-256 when the high bit is set. */
function readTarNumber(data: Uint8Array, offset: number, length: number): number | undefined {
  const raw = data.subarray(offset, offset + length)
  if (raw.length === 0) return undefined
  if ((raw[0]! & 0x80) !== 0) {
    // GNU base-256 (rare; files > 8 GiB). Sign bit is bit 6 of the first byte.
    let value = raw[0]! & 0x7f
    for (let i = 1; i < raw.length; i++) value = value * 256 + raw[i]!
    if ((raw[0]! & 0x40) !== 0) value -= 2 ** (raw.length * 8 - 1)
    return value
  }
  const text = readAsciiField(data, offset, length)
  if (text === '') return undefined
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : undefined
}

function isZeroBlock(header: Uint8Array): boolean {
  for (const byte of header) {
    if (byte !== 0) return false
  }
  return true
}

function paddedSize(size: number): number {
  return Math.ceil(size / 512) * 512
}

/**
 * Parse a (possibly gzip-wrapped) tar container into its entries.
 * @param data - the raw container bytes.
 * @returns the entries in archive order, and the container bytes actually parsed.
 */
export function parseTarContainer(data: Uint8Array): { entries: TarEntry[]; bytes: Uint8Array } {
  const bytes = data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data
  const entries: TarEntry[] = []
  let offset = 0
  let pendingLongName: string | undefined
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    const name = readAsciiField(header, 0, 100)
    if (name === '' && isZeroBlock(header)) break
    const size = readTarNumber(header, 124, 12) ?? 0
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + 512
    const dataLen = paddedSize(size)
    if (dataStart + dataLen > bytes.length) break

    if (typeflag === 'L') {
      pendingLongName = new TextDecoder('utf-8').decode(bytes.subarray(dataStart, dataStart + size))
      offset = dataStart + dataLen
      continue
    }
    // 'K' (GNU long link), 'x' (pax per-file), 'g' (pax global) carry data to skip.
    if (typeflag === 'K' || typeflag === 'x' || typeflag === 'g') {
      offset = dataStart + dataLen
      continue
    }
    let entryName = name
    if (pendingLongName !== undefined) {
      entryName = pendingLongName
      pendingLongName = undefined
    }
    const prefix = readAsciiField(header, 345, 155)
    if (prefix !== '') entryName = `${prefix}/${entryName}`
    if (typeflag === '5') {
      entries.push({ name: entryName, type: 'dir', size: 0, headerOffset: offset, dataOffset: dataStart })
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === ' ' || typeflag === '7') {
      entries.push({ name: entryName, type: 'file', size, headerOffset: offset, dataOffset: dataStart })
    } else {
      entries.push({ name: entryName, type: 'other', size, headerOffset: offset, dataOffset: dataStart })
    }
    offset = dataStart + dataLen
  }
  return { entries, bytes }
}

/** Read the data of one tar entry. */
export function readTarEntryData(bytes: Uint8Array, entry: TarEntry): Uint8Array {
  return bytes.subarray(entry.dataOffset, entry.dataOffset + entry.size)
}

function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
}

function readU32(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16) | ((data[offset + 3] ?? 0) << 24)) >>> 0
}

/** Decode a zip entry name: UTF-8 when the flag is set, else a Latin-1 fallback. */
function decodeZipName(bytes: Uint8Array, flags: number): string {
  if ((flags & 0x0800) !== 0) return new TextDecoder('utf-8').decode(bytes)
  // cp437 is the zip default; latin1 is a lossy but readable approximation.
  return new TextDecoder('latin1').decode(bytes)
}

function findEocd(data: Uint8Array): { offset: number; record: Uint8Array } | undefined {
  const min = Math.max(0, data.length - 22 - 65535)
  for (let i = data.length - 22; i >= min; i--) {
    if (readU32(data, i) === 0x06054b50) return { offset: i, record: data.subarray(i, i + 22) }
  }
  return undefined
}

/**
 * Parse a zip-family container into its central-directory entries.
 * @param data - the raw container bytes.
 * @returns the entries in central-directory order.
 */
export function parseZipContainer(data: Uint8Array): { entries: ZipEntry[] } {
  const eocd = findEocd(data)
  if (eocd === undefined) {
    throw new Error('not a zip archive: missing end-of-central-directory record')
  }
  const total = readU16(eocd.record, 10)
  const cdSize = readU32(eocd.record, 12)
  const cdOffset = readU32(eocd.record, 16)
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || eocd.offset < cdOffset + cdSize) {
    throw new Error('zip64 archives are not supported')
  }
  const entries: ZipEntry[] = []
  let pos = cdOffset
  const cdEnd = cdOffset + cdSize
  while (pos + 46 <= cdEnd && entries.length < total) {
    if (readU32(data, pos) !== 0x02014b50) break
    const flags = readU16(data, pos + 8)
    const method = readU16(data, pos + 10)
    const modTime = readU16(data, pos + 12)
    const modDate = readU16(data, pos + 14)
    const crc = readU32(data, pos + 16)
    const compSize = readU32(data, pos + 20)
    const uncompSize = readU32(data, pos + 24)
    const nameLen = readU16(data, pos + 28)
    const extraLen = readU16(data, pos + 30)
    const commentLen = readU16(data, pos + 32)
    const localOffset = readU32(data, pos + 42)
    if (pos + 46 + nameLen > data.length) break
    const name = decodeZipName(data.subarray(pos + 46, pos + 46 + nameLen), flags)
    const isDir = name.endsWith('/')
    let dataOffset = 0
    if (!isDir || compSize > 0) {
      if (readU32(data, localOffset) !== 0x04034b50) {
        throw new Error(`zip entry "${name}" has an invalid local header`)
      }
      const lNameLen = readU16(data, localOffset + 26)
      const lExtraLen = readU16(data, localOffset + 28)
      dataOffset = localOffset + 30 + lNameLen + lExtraLen
    }
    entries.push({
      name, isDir, method, compSize, uncompSize, crc, localOffset, dataOffset, modTime, modDate, flags,
    })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return { entries }
}

/**
 * Read and decompress one zip entry's data.
 * @param data - the raw container bytes.
 * @param entry - the parsed entry.
 * @returns the uncompressed entry bytes.
 */
export function readZipEntryData(data: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.isDir) return new Uint8Array(0)
  const comp = data.subarray(entry.dataOffset, entry.dataOffset + entry.compSize)
  if (entry.method === 0) return comp
  if (entry.method === 8) return inflateRawSync(comp)
  throw new Error(`unsupported zip compression method ${entry.method} for entry "${entry.name}"`)
}

/**
 * Sniff whether bytes look binary: a NUL byte within the first 8 KiB.
 * @param bytes - the entry bytes.
 * @returns whether the entry is treated as binary.
 */
export function sniffBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192)
  return sample.includes(0)
}

/**
 * Decode entry bytes as UTF-8 (lossy for invalid sequences).
 * @param bytes - the entry bytes.
 * @returns the decoded text.
 */
export function decodeEntryText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/**
 * Normalize a `:inner/path` archive selector: reject absolute paths, drive
 * letters, and `..` segments; collapse `.` and duplicate slashes.
 * @param inner - the raw inner path.
 * @returns the normalized forward-slash path.
 */
export function normalizeArchiveEntryPath(inner: string): string {
  let value = inner.replace(/\\/g, '/')
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new Error(`archive entry path must be relative, got "${inner}"`)
  }
  const segments = value.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new Error(`archive entry path must not contain "..", got "${inner}"`)
    out.push(segment)
  }
  if (out.length === 0) throw new Error(`archive entry path must not be empty`)
  return out.join('/')
}

/**
 * Render a list of archive entries as one text block body: one name per line,
 * directories suffixed with `/`, capped by `limit` with a `+N more entries`
 * marker.
 * @param entries - the entry names in display order.
 * @param limit - the maximum number of entries to render.
 * @returns the rendered listing and whether it was truncated.
 */
export function formatArchiveListing(entries: readonly string[], limit: number): { text: string; truncated: boolean } {
  const shown = entries.slice(0, limit)
  const truncated = entries.length > shown.length
  const lines = shown.map(name => name.endsWith('/') ? name : name)
  if (truncated) lines.push(`+${entries.length - shown.length} more entries`)
  return { text: lines.join('\n'), truncated }
}

/** Find a normalized inner path among parsed entries (exact name match). */
export function findArchiveEntry<E extends { name: string }>(entries: readonly E[], normalized: string): E | undefined {
  return entries.find(entry => entry.name === normalized)
}

/** List the immediate children of an archive directory prefix. */
export function listArchiveChildren(
  entries: ReadonlyArray<{ name: string; isDir?: boolean; type?: string }>,
  prefix: string,
): string[] {
  const children = new Set<string>()
  const base = prefix === '' ? '' : `${prefix}/`
  for (const entry of entries) {
    if (!entry.name.startsWith(base)) continue
    const rest = entry.name.slice(base.length)
    if (rest === '') continue // the directory entry itself
    const slash = rest.indexOf('/')
    const isDir = entry.isDir === true || entry.type === 'dir'
    if (slash === -1) {
      children.add(isDir && rest !== '' ? `${rest}/` : rest)
    } else {
      children.add(`${rest.slice(0, slash)}/`)
    }
  }
  return [...children].sort((a, b) => a.localeCompare(b, 'en'))
}

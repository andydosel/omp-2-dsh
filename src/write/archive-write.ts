/**
 * Archive entry writing: replace or add one entry inside a tar/tar.gz/zip
 * container by rewriting the container atomically. The mutation gates
 * (`fs/write-intent` waterfall + `fs/observed`) run through `ctx.fs`; the
 * binary container rewrite itself must touch the process path directly because
 * the `ctx.fs` seam offers no binary write (writeText is UTF-8 only) — a
 * documented, unavoidable deviation for this capability. Staging uses the OS
 * temp directory and an atomic rename into place.
 * @module dsh-tool-read-write/write/archive-write
 */

import { randomUUID } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  ARCHIVE_MAX_BYTES,
  archiveKindForPath,
  normalizeArchiveEntryPath,
  parseTarContainer,
  parseZipContainer,
  readTarEntryData,
  readZipEntryData,
} from '../read/archive.ts'
import type { TarEntry, ZipEntry } from '../read/archive.ts'

/** The written archive entry result the write tool folds into its canonical value. */
export interface ArchiveWriteResult {
  path: string
  kind: 'archive'
  operation: 'create' | 'update'
  before: string | null
  after: string
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i)
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

/** Build one ustar header (name ≤ 100 bytes; longer names throw for v1). */
function buildTarHeader(name: string, size: number, typeflag: '0' | '5'): Uint8Array {
  const header = new Uint8Array(512)
  const nameBytes = Buffer.from(name, 'utf8')
  if (nameBytes.length > 100) {
    throw new Error(`archive entry name too long for tar (max 100 bytes): "${name}"`)
  }
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

/** Missing ancestor directories of an entry name, in archive order. */
function missingParentDirs(entries: ReadonlyArray<{ name: string; type: string }>, target: string): string[] {
  const dirs = new Set(entries.filter(entry => entry.type === 'dir').map(entry => entry.name))
  const missing: string[] = []
  const parts = target.split('/')
  let acc = ''
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc === '' ? parts[i]! : `${acc}/${parts[i]}`
    if (!dirs.has(acc)) {
      missing.push(acc)
      dirs.add(acc)
    }
  }
  return missing
}

function tarRewrite(
  bytes: Uint8Array,
  entries: TarEntry[],
  targetName: string,
  content: Uint8Array,
): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    if (entry.name === targetName && entry.type === 'file') continue
    const dataLen = Math.ceil(entry.size / 512) * 512
    chunks.push(bytes.subarray(entry.headerOffset, entry.headerOffset + 512 + dataLen))
  }
  for (const dir of missingParentDirs(entries, targetName)) {
    chunks.push(buildTarHeader(dir, 0, '5'))
  }
  chunks.push(buildTarHeader(targetName, content.length, '0'))
  chunks.push(content)
  const padding = content.length % 512 === 0 ? 0 : 512 - (content.length % 512)
  if (padding > 0) chunks.push(new Uint8Array(padding))
  chunks.push(new Uint8Array(1024)) // two end-of-archive zero blocks
  return concat(chunks)
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

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff]!) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** One central-directory record. */
function buildZipCentralDir(
  name: string,
  method: number,
  modTime: number,
  modDate: number,
  crc: number,
  compSize: number,
  uncompSize: number,
  localOffset: number,
  flags: number,
): Uint8Array {
  const nameBytes = Buffer.from(name, 'utf8')
  const record = new Uint8Array(46 + nameBytes.length)
  writeU32(record, 0, 0x02014b50)
  writeU16(record, 4, 20)
  writeU16(record, 6, 20)
  writeU16(record, 8, flags)
  writeU16(record, 10, method)
  writeU16(record, 12, modTime)
  writeU16(record, 14, modDate)
  writeU32(record, 16, crc)
  writeU32(record, 20, compSize)
  writeU32(record, 24, uncompSize)
  writeU16(record, 28, nameBytes.length)
  writeU16(record, 30, 0)
  writeU16(record, 32, 0)
  writeU16(record, 34, 0)
  writeU16(record, 36, 0)
  writeU32(record, 38, 0)
  writeU32(record, 42, localOffset)
  record.set(nameBytes, 46)
  return record
}

function zipRewrite(
  bytes: Uint8Array,
  entries: ZipEntry[],
  targetName: string,
  content: Uint8Array,
): Uint8Array {
  const existing = entries.find(entry => entry.name === targetName && !entry.isDir)
  const comp = deflateRawSync(content)
  const crc = crc32(content)
  const now = new Date()
  const modTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)
  const modDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()

  // New entry: local header + compressed data appended at the end.
  const nameBytes = Buffer.from(targetName, 'utf8')
  const local = new Uint8Array(30 + nameBytes.length)
  writeU32(local, 0, 0x04034b50)
  writeU16(local, 4, 20)
  writeU16(local, 6, 0x0800)
  writeU16(local, 8, 8)
  writeU16(local, 10, modTime)
  writeU16(local, 12, modDate)
  writeU32(local, 14, crc)
  writeU32(local, 18, comp.length)
  writeU32(local, 22, content.length)
  writeU16(local, 26, nameBytes.length)
  writeU16(local, 28, 0)
  local.set(nameBytes, 30)
  const newEntry = concat([local, comp])
  const newLocalOffset = bytes.length

  // Central directory: keep every entry except the replaced target, then the
  // new entry, then missing parent directory entries.
  const kept = entries.filter(entry => entry.name !== targetName || entry.isDir)
  const cdChunks: Uint8Array[] = []
  for (const entry of kept) {
    cdChunks.push(buildZipCentralDir(
      entry.name, entry.method, entry.modTime, entry.modDate, entry.crc,
      entry.compSize, entry.uncompSize, entry.localOffset, entry.flags,
    ))
  }
  const dirNames = new Set(kept.filter(entry => entry.isDir).map(entry => entry.name))
  const parts = targetName.split('/')
  let acc = ''
  let addedDirs = 0
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc === '' ? parts[i]! : `${acc}/${parts[i]}`
    const dirName = `${acc}/`
    if (!dirNames.has(dirName)) {
      cdChunks.push(buildZipCentralDir(dirName, 0, modTime, modDate, 0, 0, 0, newLocalOffset, 0x0800))
      dirNames.add(dirName)
      addedDirs += 1
    }
  }
  cdChunks.push(buildZipCentralDir(
    targetName, 8, modTime, modDate, crc, comp.length, content.length, newLocalOffset, 0x0800,
  ))
  const cd = concat(cdChunks)
  const cdOffset = newLocalOffset + newEntry.length
  const total = kept.length + addedDirs + 1

  const eocd = new Uint8Array(22)
  writeU32(eocd, 0, 0x06054b50)
  writeU16(eocd, 4, 0)
  writeU16(eocd, 6, 0)
  writeU16(eocd, 8, total)
  writeU16(eocd, 10, total)
  writeU32(eocd, 12, cd.length)
  writeU32(eocd, 16, cdOffset)
  writeU16(eocd, 20, 0)

  return concat([bytes, newEntry, cd, eocd])
}

/** Whether the resolved sandbox policy refuses the mutation outright. */
function refuseReadOnly(policy: SandboxExecutionPolicy | undefined, path: string): void {
  if (policy !== undefined && policy.mode === 'read-only') {
    throw new FsError(
      `${sandboxDenialMarker('read-only')}\narchive writes are not permitted under read-only sandbox mode for "${path}"`,
      'FS_SANDBOX_DENIED',
    )
  }
}

/**
 * Write one archive entry. Returns `undefined` when the path is not an archive
 * selector target (the caller falls through to SQLite/file writes).
 */
export async function writeArchiveEntry(
  ctx: Context,
  exec: ToolExecution,
  rawPath: string,
  content: string,
  policy: SandboxExecutionPolicy | undefined,
  config: { archiveWriteEnabled: boolean; maxBytes: number },
): Promise<ArchiveWriteResult | undefined> {
  if (!config.archiveWriteEnabled) {
    throw new Error('archive writes are disabled by configuration')
  }
  // Split container/inner at the first non-drive separator colon.
  const start = /^[A-Za-z]:[\\/]/.test(rawPath) ? 2 : 0
  let sep = -1
  for (let i = start; i < rawPath.length; i++) {
    if (rawPath[i] === ':') {
      sep = i
      break
    }
  }
  if (sep === -1) return undefined
  const containerPath = rawPath.slice(0, sep)
  const inner = rawPath.slice(sep + 1)
  if (containerPath === '' || inner === '') return undefined

  const target = await ctx.fs.resolve(containerPath, { ...policy !== undefined ? { cwd: policy.workspaceRoot } : {}, signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined || info.type !== 'file') return undefined
  const kind = archiveKindForPath(target.displayPath)
  if (kind === undefined) return undefined
  refuseReadOnly(policy, target.displayPath)

  const targetName = normalizeArchiveEntryPath(inner)
  const bytes = await ctx.fs.readBytes(target, exec.signal, ARCHIVE_MAX_BYTES)

  // Resolve the previous entry text for the diff (capped; binary → null).
  let before: string | null = null
  let newBytes: Uint8Array
  if (kind === 'tar' || kind === 'tar-gz') {
    const { entries, bytes: tarBytes } = parseTarContainer(bytes)
    const old = entries.find(entry => entry.name === targetName && entry.type === 'file')
    if (old !== undefined && old.size <= config.maxBytes) {
      const oldData = readTarEntryData(tarBytes, old)
      if (!oldData.subarray(0, 8192).includes(0)) before = Buffer.from(oldData).toString('utf8')
    }
    newBytes = tarRewrite(tarBytes, entries, targetName, Buffer.from(content, 'utf8'))
  } else {
    const { entries } = parseZipContainer(bytes)
    const old = entries.find(entry => entry.name === targetName && !entry.isDir)
    if (old !== undefined && old.uncompSize <= config.maxBytes) {
      const oldData = readZipEntryData(bytes, old)
      if (!oldData.subarray(0, 8192).includes(0)) before = Buffer.from(oldData).toString('utf8')
    }
    newBytes = zipRewrite(bytes, entries, targetName, Buffer.from(content, 'utf8'))
  }

  // The mutation gate runs through ctx.fs; the binary container write stages a
  // temp file and atomically renames it over the process path.
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
  if (intent !== undefined) {
    if (intent.kind === 'createIfAbsent') {
      throw new FsError('cannot write archive: the container already exists', 'FS_STALE_VERSION')
    }
    if (intent.version !== info.version) {
      throw new FsError('cannot write archive: the container changed since it was last observed — re-read, then retry', 'FS_STALE_VERSION')
    }
  }
  const tempPath = join(tmpdir(), `dsh-tool-read-write-${randomUUID()}`)
  try {
    await writeFile(tempPath, newBytes, { mode: 0o600 })
    await rename(tempPath, ctx.fs.processPath(target))
  } catch (error: unknown) {
    throw new FsError(`cannot rewrite archive "${target.displayPath}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR', { cause: error })
  }
  const afterInfo = await ctx.fs.stat(target, exec.signal)
  ctx.emit('fs/observed', target, { kind: 'present', version: afterInfo?.version ?? info.version }, exec)
  return {
    path: `${target.displayPath}:${targetName}`,
    kind: 'archive',
    operation: before === null ? 'create' : 'update',
    before,
    after: content,
  }
}

import { describe, expect, it } from 'vitest'
import {
  archiveKindForPath,
  decodeEntryText,
  findArchiveEntry,
  formatArchiveListing,
  listArchiveChildren,
  normalizeArchiveEntryPath,
  parseTarContainer,
  parseZipContainer,
  readTarEntryData,
  readZipEntryData,
  sniffBinary,
} from '../src/read/archive.ts'
import { buildTar, buildZip, concat, tarHeader, text } from './archive-fixtures.ts'

describe('archiveKindForPath', () => {
  it('recognizes the supported extensions', () => {
    expect(archiveKindForPath('a.tar')).toBe('tar')
    expect(archiveKindForPath('a.tar.gz')).toBe('tar-gz')
    expect(archiveKindForPath('a.tgz')).toBe('tar-gz')
    expect(archiveKindForPath('a.zip')).toBe('zip')
    expect(archiveKindForPath('app.jar')).toBe('zip')
    expect(archiveKindForPath('app.war')).toBe('zip')
    expect(archiveKindForPath('app.ear')).toBe('zip')
    expect(archiveKindForPath('app.apk')).toBe('zip')
    expect(archiveKindForPath('a.txt')).toBeUndefined()
  })
})

describe('normalizeArchiveEntryPath', () => {
  it('normalizes separators and dot segments', () => {
    expect(normalizeArchiveEntryPath('src/./main.ts')).toBe('src/main.ts')
    expect(normalizeArchiveEntryPath('src\\main.ts')).toBe('src/main.ts')
    expect(normalizeArchiveEntryPath('a//b/')).toBe('a/b')
  })

  it('rejects parent traversal, absolute paths, and empty paths', () => {
    expect(() => normalizeArchiveEntryPath('src/../etc/passwd')).toThrow(/\.\./)
    expect(() => normalizeArchiveEntryPath('../x')).toThrow(/\.\./)
    expect(() => normalizeArchiveEntryPath('/etc/passwd')).toThrow(/relative/)
    expect(() => normalizeArchiveEntryPath('C:\\x')).toThrow(/relative/)
    expect(() => normalizeArchiveEntryPath('')).toThrow(/empty/)
  })
})

describe('zip parsing', () => {
  const zip = buildZip([
    { name: 'dir/', data: new Uint8Array(0) },
    { name: 'dir/hello.txt', data: text('hello world'), method: 8 },
    { name: 'dir/sub/', data: new Uint8Array(0) },
    { name: 'dir/sub/nested.bin', data: Uint8Array.of(0, 1, 2, 0, 255), method: 0 },
  ])

  it('parses the central directory with names and directory flags', () => {
    const { entries } = parseZipContainer(zip)
    expect(entries.map(entry => entry.name)).toEqual(['dir/', 'dir/hello.txt', 'dir/sub/', 'dir/sub/nested.bin'])
    expect(entries[0]!.isDir).toBe(true)
    expect(entries[1]!.isDir).toBe(false)
    expect(entries[1]!.method).toBe(8)
  })

  it('reads and decompresses store and deflate entries', () => {
    const { entries } = parseZipContainer(zip)
    const hello = findArchiveEntry(entries, 'dir/hello.txt')!
    expect(decodeEntryText(readZipEntryData(zip, hello))).toBe('hello world')
    const nested = findArchiveEntry(entries, 'dir/sub/nested.bin')!
    expect(readZipEntryData(zip, nested)).toEqual(Uint8Array.of(0, 1, 2, 0, 255))
  })

  it('rejects a non-zip byte stream', () => {
    expect(() => parseZipContainer(text('this is not a zip'))).toThrow(/not a zip/)
  })

  it('lists immediate children of a directory prefix', () => {
    const { entries } = parseZipContainer(zip)
    expect(listArchiveChildren(entries, 'dir')).toEqual(['hello.txt', 'sub/'])
    expect(listArchiveChildren(entries, 'dir/sub')).toEqual(['nested.bin'])
  })
})

describe('tar parsing', () => {
  const tar = buildTar([
    { name: 'dir', dir: true },
    { name: 'dir/hello.txt', data: text('tar hello') },
    { name: 'dir/big.bin', data: new Uint8Array(700) }, // spans two data blocks
  ])

  it('parses plain tar entries with dirs and sizes', () => {
    const { entries, bytes } = parseTarContainer(tar)
    expect(entries.map(entry => entry.name)).toEqual(['dir', 'dir/hello.txt', 'dir/big.bin'])
    expect(entries[0]!.type).toBe('dir')
    expect(entries[1]!.size).toBe(9) // "tar hello"
    expect(decodeEntryText(readTarEntryData(bytes, entries[1]!))).toBe('tar hello')
    expect(readTarEntryData(bytes, entries[2]!).length).toBe(700)
  })

  it('parses gzip-compressed tar containers', () => {
    const gz = buildTar([{ name: 'a.txt', data: text('gzipped') }], true)
    const { entries, bytes } = parseTarContainer(gz)
    expect(entries.map(entry => entry.name)).toEqual(['a.txt'])
    expect(decodeEntryText(readTarEntryData(bytes, entries[0]!))).toBe('gzipped')
  })

  it('handles GNU long names (typeflag L)', () => {
    const realName = `very/long/${'n'.repeat(120)}.txt`
    const longData = text(realName)
    const longHeader = tarHeader('L', longData.length, 'L')
    const longPadding = longData.length % 512 === 0 ? 0 : 512 - (longData.length % 512)
    const fileHeader = tarHeader('placeholder-name', 4, '0')
    const content = text('long')
    const container = concat([longHeader, longData, new Uint8Array(longPadding), fileHeader, content, new Uint8Array(508)])
    const { entries, bytes } = parseTarContainer(container)
    expect(entries.map(entry => entry.name)).toEqual([realName])
    expect(decodeEntryText(readTarEntryData(bytes, entries[0]!))).toBe('long')
  })

  it('lists children for tar entries without trailing slashes', () => {
    const { entries } = parseTarContainer(tar)
    expect(listArchiveChildren(entries, 'dir')).toEqual(['big.bin', 'hello.txt'])
  })
})

describe('sniffBinary / decodeEntryText / formatArchiveListing', () => {
  it('sniffs NUL bytes in the first 8 KiB', () => {
    expect(sniffBinary(Uint8Array.of(1, 2, 0, 4))).toBe(true)
    expect(sniffBinary(text('plain text'))).toBe(false)
  })

  it('decodes UTF-8 text lossily', () => {
    expect(decodeEntryText(text('héllo'))).toBe('héllo')
  })

  it('formats listings with a truncation marker', () => {
    expect(formatArchiveListing(['a/', 'b.txt'], 10)).toEqual({ text: 'a/\nb.txt', truncated: false })
    expect(formatArchiveListing(['a', 'b', 'c'], 2)).toEqual({ text: 'a\nb\n+1 more entries', truncated: true })
  })
})

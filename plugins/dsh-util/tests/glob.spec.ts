import { describe, expect, it } from 'vitest'
import { firstPathMatch, globToRegExp, normalizeGlobPath } from '../src/glob.ts'

describe('normalizeGlobPath', () => {
  it('uses posix separators and collapses duplicate/trailing separators', () => {
    expect(normalizeGlobPath('.\\src\\\\a.ts')).toBe('src/a.ts')
    expect(normalizeGlobPath('./src/')).toBe('src')
    expect(normalizeGlobPath('/')).toBe('/')
    expect(normalizeGlobPath('C:\\proj\\src\\a.ts')).toBe('C:/proj/src/a.ts')
  })
})

describe('globToRegExp', () => {
  it('matches `**/` across zero or more directories', () => {
    const pattern = globToRegExp('**/src/**')
    expect(pattern.test('src/a.ts')).toBe(true)
    expect(pattern.test('pkg/src/a.ts')).toBe(true)
    expect(pattern.test('C:/proj/src/deep/a.ts')).toBe(true)
    expect(pattern.test('srcx/a.ts')).toBe(false)
    expect(pattern.test('docs/a.ts')).toBe(false)
  })

  it('keeps `*` inside one segment and `?` single-character', () => {
    expect(globToRegExp('*.md').test('a.md')).toBe(true)
    expect(globToRegExp('*.md').test('docs/a.md')).toBe(false)
    expect(globToRegExp('docs/?.md').test('docs/a.md')).toBe(true)
    expect(globToRegExp('docs/?.md').test('docs/ab.md')).toBe(false)
  })

  it('treats regex metacharacters as literals', () => {
    expect(globToRegExp('a+b(1).ts').test('a+b(1).ts')).toBe(true)
    expect(globToRegExp('a+b(1).ts').test('aab(1).ts')).toBe(false)
  })

  it('honors the case-sensitivity knob in both directions', () => {
    expect(globToRegExp('**/*.ts', { caseInsensitive: true }).test('SRC/A.TS')).toBe(true)
    expect(globToRegExp('**/*.ts', { caseInsensitive: false }).test('SRC/A.TS')).toBe(false)
    expect(globToRegExp('**/*.ts', { caseInsensitive: false }).test('src/a.ts')).toBe(true)
  })

  it('compiles backslash patterns for cross-platform config', () => {
    expect(globToRegExp('**\\src\\**').test('C:/proj/src/a.ts')).toBe(true)
  })
})

describe('firstPathMatch', () => {
  it('reports the winning original pattern and candidate', () => {
    const hit = firstPathMatch(['**/src/**', '**/*.ts'], ['docs/notes.md', 'src/a.ts'])
    expect(hit).toEqual({ pattern: '**/src/**', path: 'src/a.ts' })
    expect(firstPathMatch(['**/src/**'], ['docs/a.md'])).toBeUndefined()
  })

  it('normalizes patterns and candidates when asked', () => {
    expect(firstPathMatch(['.\\src\\**'], ['src//a.ts'], { normalize: true }))
      .toEqual({ pattern: '.\\src\\**', path: 'src/a.ts' })
  })

  it('optionally matches a directory target with a trailing slash', () => {
    expect(firstPathMatch(['**/src/**'], ['src'], { directorySuffix: true })).toEqual({ pattern: '**/src/**', path: 'src' })
    expect(firstPathMatch(['**/src/**'], ['src'])).toBeUndefined()
  })
})

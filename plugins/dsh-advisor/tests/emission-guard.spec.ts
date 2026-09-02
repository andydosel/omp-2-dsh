/**
 * Emission-guard unit tests: normalization, empty-phrase filter, FIFO dedupe,
 * the per-reviewer update rate limit, and reset semantics.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_DEDUPE_LIMIT, EmissionGuard, isEmptyPhrase, normalizeNote } from '../src/emission-guard.ts'

describe('normalizeNote', () => {
  it('applies NFKC + lowercase + non-alphanumeric collapse', () => {
    expect(normalizeNote('  Check the SCHEMA!  ')).toBe('check the schema')
    expect(normalizeNote('ＦＵＬＬＷＩＤＴＨ')).toBe('fullwidth')
    expect(normalizeNote('a.b/c-d_e')).toBe('a b c d e')
    expect(normalizeNote('…ellipsis…')).toBe('ellipsis')
  })

  it('collapses punctuation-only runs and trims', () => {
    expect(normalizeNote('!!!')).toBe('')
    expect(normalizeNote('--- okay ---')).toBe('okay')
  })
})

describe('isEmptyPhrase', () => {
  it('rejects the canonical empty phrases', () => {
    for (const phrase of ['stop', 'done', 'lgtm', 'ok', 'okay', 'thanks', 'got it', 'will do']) {
      expect(isEmptyPhrase(normalizeNote(phrase))).toBe(true)
    }
  })

  it('accepts substantive notes', () => {
    expect(isEmptyPhrase(normalizeNote('the retry loop never terminates'))).toBe(false)
  })
})

describe('EmissionGuard', () => {
  it('accepts a first note and reports the normalized form', () => {
    const guard = new EmissionGuard()
    const result = guard.accept('The schema is missing required fields', 'reviewer-1')
    expect(result.accepted).toBe(true)
    expect(result.normalized).toBe('the schema is missing required fields')
    expect(guard.size).toBe(1)
  })

  it('rejects empty phrases with reason empty', () => {
    const guard = new EmissionGuard()
    const result = guard.accept('lgtm', 'reviewer-1')
    expect(result).toMatchObject({ accepted: false, reason: 'empty' })
  })

  it('dedupes identical notes after normalization', () => {
    const guard = new EmissionGuard()
    expect(guard.accept('Fix the schema!', 'r1').accepted).toBe(true)
    expect(guard.accept('fix the schema', 'r1')).toMatchObject({ accepted: false, reason: 'duplicate' })
    expect(guard.accept('FIX THE SCHEMA!!', 'r2')).toMatchObject({ accepted: false, reason: 'duplicate' })
    expect(guard.size).toBe(1)
  })

  it('enforces one accepted note per reviewer per update window', () => {
    const guard = new EmissionGuard()
    guard.beginUpdate('r1')
    expect(guard.accept('note one', 'r1').accepted).toBe(true)
    expect(guard.accept('note two', 'r1')).toMatchObject({ accepted: false, reason: 'rate-limited' })
    // A second reviewer is not rate-limited by the first.
    expect(guard.accept('note three', 'r2').accepted).toBe(true)
    // Closing the window reopens it.
    guard.endUpdate('r1')
    expect(guard.accept('note four', 'r1').accepted).toBe(true)
  })

  it('evicts the oldest entry past the FIFO limit', () => {
    const guard = new EmissionGuard({ dedupeLimit: 3 })
    expect(guard.accept('one', 'r1').accepted).toBe(true)
    expect(guard.accept('two', 'r2').accepted).toBe(true)
    expect(guard.accept('three', 'r3').accepted).toBe(true)
    expect(guard.accept('one', 'r4')).toMatchObject({ accepted: false, reason: 'duplicate' })
    expect(guard.accept('four', 'r4').accepted).toBe(true)
    expect(guard.size).toBe(3)
    // 'one' was evicted, so it is accepted again.
    expect(guard.accept('one', 'r5').accepted).toBe(true)
  })

  it('uses a default FIFO capacity of 4096', () => {
    expect(new EmissionGuard().normalize('x')).toBe('x')
    expect(DEFAULT_DEDUPE_LIMIT).toBe(4096)
  })

  it('rejects invalid dedupe limits', () => {
    expect(() => new EmissionGuard({ dedupeLimit: 0 })).toThrow()
    expect(() => new EmissionGuard({ dedupeLimit: 1.5 })).toThrow()
  })

  it('reset clears dedupe history and open update windows', () => {
    const guard = new EmissionGuard()
    guard.beginUpdate('r1')
    expect(guard.accept('same note', 'r1').accepted).toBe(true)
    expect(guard.accept('same note', 'r1').accepted).toBe(false)
    guard.reset()
    expect(guard.size).toBe(0)
    expect(guard.accept('same note', 'r1').accepted).toBe(true)
  })
})

/**
 * Path-gate tests: the read/write whitelist behaviour of both role envelopes,
 * including the absent-`path` glob/grep hole and the absolute-outside denial.
 */

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveOrgConfig } from '../src/config.ts'
import { decidePathGate, matchesAnyPath, normalizeCandidate, normalizePattern } from '../src/paths.ts'

const cwd = process.cwd()
const config = resolveOrgConfig()
const secretary = { readPaths: config.secretaryReadPaths, writePaths: config.secretaryWritePaths }
const lead = { readPaths: config.leadReadPaths, writePaths: config.leadWritePaths }

describe('path gate', () => {
  it('denies a secretary a source-code read', () => {
    const decision = decidePathGate({ toolName: 'read', args: { file_path: 'src/index.ts' }, cwd, ...secretary })
    expect(decision.kind).toBe('deny')
  })

  it('denies a secretary a source-code write', () => {
    const decision = decidePathGate({ toolName: 'write', args: { file_path: 'src/index.ts' }, cwd, ...secretary })
    expect(decision.kind).toBe('deny')
  })

  it('allows a secretary to read a document', () => {
    const decision = decidePathGate({ toolName: 'read', args: { file_path: 'docs/a.md' }, cwd, ...secretary })
    expect(decision.kind).toBe('allow')
  })

  it('allows a secretary to write in the handoff area', () => {
    const decision = decidePathGate({ toolName: 'write', args: { file_path: '.dsh-handoff/brief.md' }, cwd, ...secretary })
    expect(decision.kind).toBe('allow')
  })

  it('denies an absolute path outside the whitelist', () => {
    const outside = path.resolve(cwd, '..', 'outside', 'secret.txt')
    const decision = decidePathGate({ toolName: 'read', args: { file_path: outside }, cwd, ...secretary })
    expect(decision.kind).toBe('deny')
  })

  it('denies glob/grep with an absent path (workspace root is not a document root)', () => {
    expect(decidePathGate({ toolName: 'glob', args: { pattern: '**/*.ts' }, cwd, ...secretary }).kind).toBe('deny')
    expect(decidePathGate({ toolName: 'grep', args: { pattern: 'secret' }, cwd, ...secretary }).kind).toBe('deny')
  })

  it('denies unverifiable path arguments (fail closed)', () => {
    expect(decidePathGate({ toolName: 'read', args: {}, cwd, ...secretary }).kind).toBe('deny')
    expect(decidePathGate({ toolName: 'write', args: { file_path: '   ' }, cwd, ...secretary }).kind).toBe('deny')
    expect(decidePathGate({ toolName: 'read', args: 'not-an-object', cwd, ...secretary }).kind).toBe('deny')
  })

  it('maps str_replace_editor view→read and other commands→write', () => {
    expect(decidePathGate({ toolName: 'str_replace_editor', args: { command: 'view', path: 'docs/a.md' }, cwd, ...secretary }).kind).toBe('allow')
    expect(decidePathGate({ toolName: 'str_replace_editor', args: { command: 'create', path: 'docs/a.md' }, cwd, ...secretary }).kind).toBe('deny')
  })

  it('allows a lead a src read but denies a src write', () => {
    expect(decidePathGate({ toolName: 'read', args: { file_path: 'src/index.ts' }, cwd, ...lead }).kind).toBe('allow')
    expect(decidePathGate({ toolName: 'write', args: { file_path: 'src/index.ts' }, cwd, ...lead }).kind).toBe('deny')
    expect(decidePathGate({ toolName: 'write', args: { file_path: 'docs/a.md' }, cwd, ...lead }).kind).toBe('allow')
  })

  it('allows unnamed tools through (name masking is the allow-list’s job)', () => {
    expect(decidePathGate({ toolName: 'peer_send', args: { targetId: 'x' }, cwd, ...secretary }).kind).toBe('allow')
  })

  it('normalizes and matches globs', () => {
    const normalized = normalizeCandidate('docs/a.md', cwd)
    expect(matchesAnyPath(normalized, [normalizePattern('docs/**', cwd)])).toBe(true)
    expect(matchesAnyPath(normalized, [normalizePattern('**/*.md', cwd)])).toBe(true)
    expect(matchesAnyPath(normalizeCandidate('src/index.ts', cwd), [normalizePattern('docs/**', cwd)])).toBe(false)
  })
})

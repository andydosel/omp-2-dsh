import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { composeAdvisoryText, resolveAdvisoryPath } from '../src/advisory.ts'
import { resolveConfig } from '../src/config.ts'
import { matchGateRule, RulesGate } from '../src/gate.ts'
import { firstPathMatch, globToRegExp, normalizePath } from '../src/glob.ts'

/** A ToolExecution stand-in: the gate reads only name, arguments, and the session cwd. */
function call(name: string, callArguments: unknown, cwd: string | undefined = 'C:/proj'): ToolExecution {
  return {
    name,
    arguments: callArguments,
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
  } as unknown as ToolExecution
}

describe('glob matching', () => {
  it('matches a `**/src/**` pattern in both relative and absolute spellings', () => {
    const pattern = globToRegExp('**/src/**')
    expect(pattern.test('src/a.ts')).toBe(true)
    expect(pattern.test('pkg/src/a.ts')).toBe(true)
    expect(pattern.test('C:/proj/src/deep/a.ts')).toBe(true)
    expect(pattern.test('srcx/a.ts')).toBe(false)
    expect(pattern.test('docs/a.ts')).toBe(false)
  })

  it('keeps `*` inside one path segment and `?` single-character', () => {
    expect(globToRegExp('*.md').test('a.md')).toBe(true)
    expect(globToRegExp('*.md').test('docs/a.md')).toBe(false)
    expect(globToRegExp('docs/?.md').test('docs/a.md')).toBe(true)
    expect(globToRegExp('docs/?.md').test('docs/ab.md')).toBe(false)
  })

  it('normalizes separators and duplicated prefixes before comparing', () => {
    expect(normalizePath('.\\src\\\\a.ts')).toBe('src/a.ts')
    expect(globToRegExp('**\\src\\**').test('C:/proj/src/a.ts')).toBe(true)
  })

  it('reports the winning pattern and path', () => {
    const hit = firstPathMatch(['**/src/**', '**/*.ts'], ['docs/notes.md', 'src/a.ts'])
    expect(hit).toEqual({ pattern: '**/src/**', path: 'src/a.ts' })
    expect(firstPathMatch(['**/src/**'], ['docs/a.md'])).toBeUndefined()
  })
})

describe('gate rules', () => {
  it('gates a matching write and lets a non-matching path through', () => {
    const rule = { tool: 'write', paths: ['**/src/**'] }
    const match = matchGateRule(rule, call('write', { file_path: 'C:/proj/src/a.ts' }))
    expect(match?.reason).toContain('**/src/**')
    expect(matchGateRule(rule, call('write', { file_path: 'C:/proj/docs/a.ts' }))).toBeUndefined()
  })

  it('gates every call of a tool whose rule carries no paths', () => {
    const match = matchGateRule({ tool: 'bash' }, call('bash', { command: 'ls' }))
    expect(match?.rule.tool).toBe('bash')
  })

  it('fails closed when a path-scoped rule names a tool with no path argument', () => {
    const match = matchGateRule({ tool: 'bash', paths: ['**/src/**'] }, call('bash', { command: 'cat src/a.ts' }))
    expect(match?.reason).toContain('failing closed')
  })

  it('fails closed when a required path argument is missing or not a string', () => {
    const rule = { tool: 'write', paths: ['**/src/**'] }
    expect(matchGateRule(rule, call('write', {}))?.reason).toContain('failing closed')
    expect(matchGateRule(rule, call('write', { file_path: '   ' }))?.reason).toContain('failing closed')
    expect(matchGateRule(rule, call('write', { file_path: 42 }))?.reason).toContain('failing closed')
  })

  it('fails closed on an unscoped search and scopes an explicit one', () => {
    const rule = { tool: 'glob', paths: ['**/proj/src/**'] }
    expect(matchGateRule(rule, call('glob', { pattern: '**/*.ts' }))?.reason).toContain('failing closed')
    expect(matchGateRule(rule, call('glob', { pattern: '**/*.ts', path: 'src' }))).toBeDefined()
    expect(matchGateRule(rule, call('glob', { pattern: '**/*.ts', path: 'docs' }))).toBeUndefined()
  })

  it('matches a relative pattern against an absolute call path', () => {
    const match = matchGateRule({ tool: 'edit', paths: ['src/**'] }, call('edit', { file_path: 'C:/proj/src/a.ts' }))
    expect(match?.reason).toContain('src/a.ts')
  })
})

describe('RulesGate service', () => {
  it('filters by tool name and turns a match into an approval ask', () => {
    const gate = new RulesGate(new Context(), [{ tool: 'write', paths: ['**/src/**'] }, { tool: 'bash' }])
    expect(gate.match(call('read', { file_path: 'C:/proj/src/a.ts' }))).toBeUndefined()
    expect(gate.evaluate(call('write', { file_path: 'C:/proj/docs/a.ts' }))).toEqual({ kind: 'allow' })
    const decision = gate.evaluate(call('write', { file_path: 'C:/proj/src/a.ts' }))
    if (decision.kind !== 'ask') throw new Error(`expected an ask decision, got ${decision.kind}`)
    expect(decision.displayReason?.en).toContain('Approve')
    expect(gate.evaluate(call('bash', { command: 'ls' })).kind).toBe('ask')
  })
})

describe('advisory resolution', () => {
  const home = 'C:/home/.dsh'

  it('expands $DSH_HOME, ${DSH_HOME}, and bare tokens', () => {
    expect(normalizePath(resolveAdvisoryPath('$DSH_HOME/AGENTS.md', home))).toBe(`${home}/AGENTS.md`)
    expect(normalizePath(resolveAdvisoryPath('${DSH_HOME}/AGENTS.md', home))).toBe(`${home}/AGENTS.md`)
    expect(normalizePath(resolveAdvisoryPath('persona', home))).toBe(`${home}/persona.md`)
    expect(normalizePath(resolveAdvisoryPath('rules/extra.md', home))).toBe(`${home}/rules/extra.md`)
    expect(normalizePath(resolveAdvisoryPath('D:/rules/r.md', home))).toBe('D:/rules/r.md')
  })

  it('leaves ~ expansion to the shared home helper', () => {
    expect(normalizePath(resolveAdvisoryPath('~/r.md', home)).endsWith('/r.md')).toBe(true)
  })

  it('renders nothing for no sources and labels loaded sources by path', () => {
    expect(composeAdvisoryText([])).toBe('')
    const text = composeAdvisoryText([{ path: 'C:/home/.dsh/AGENTS.md', text: 'Be terse.' }])
    expect(text).toContain('not mechanically enforced')
    expect(text).toContain('### C:/home/.dsh/AGENTS.md')
    expect(text).toContain('Be terse.')
  })
})

describe('config resolution', () => {
  it('trims entries and collapses empty path lists to "every call"', () => {
    const resolved = resolveConfig({
      advisoryFiles: [' $DSH_HOME/AGENTS.md '],
      gateRules: [{ tool: ' write ', paths: [' ', '**/src/**'] }, { tool: 'bash', paths: [] }],
      advisoryOrder: 0,
    })
    expect(resolved.advisoryFiles).toEqual(['$DSH_HOME/AGENTS.md'])
    expect(resolved.gateRules).toEqual([
      { tool: 'write', paths: ['**/src/**'] },
      { tool: 'bash' },
    ])
  })

  it('fails loud on a blank tool name', () => {
    expect(() => resolveConfig({ advisoryFiles: [], gateRules: [{ tool: '  ' }], advisoryOrder: 0 })).toThrow()
  })
})

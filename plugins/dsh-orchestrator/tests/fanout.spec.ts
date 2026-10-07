import { describe, expect, it } from 'vitest'
import { planFanOut, type FanOutBounds, type FanOutContext, type FanOutPlan, type FanOutRequest } from '../src/fanout.ts'

const BOUNDS: FanOutBounds = { maxDepth: 3, maxTotalAgents: 20, minSubtasks: 2, minEffortTokens: 2000 }

/** Two briefs big enough to clear the effort gate. */
function bigTasks(count = 2): FanOutRequest['tasks'] {
  return Array.from({ length: count }, (_unused, index) => ({ brief: `task ${index} ${'x'.repeat(5000)}` }))
}

function context(overrides: Partial<FanOutContext> = {}): FanOutContext {
  return { bounds: BOUNDS, depth: 0, spent: 0, ...overrides }
}

/** Assert a plan is a refusal and return its code. */
function refusalCode(plan: FanOutPlan): string {
  if (plan.kind !== 'do-it-yourself') throw new Error(`expected a refusal, got ${plan.kind}`)
  return plan.refusal.code
}

describe('fan-out gates', () => {
  it('dispatches a worth-it batch and normalizes each task', () => {
    const plan = planFanOut(context(), { tasks: [{ brief: '  do a thing  ' }, { brief: 'x'.repeat(9000), model: 'fast', role: 'reviewer' }] })
    expect(plan.kind).toBe('fan-out')
    if (plan.kind !== 'fan-out') return
    expect(plan.tasks).toEqual([
      { brief: 'do a thing', tier: 'good', role: 'worker' },
      { brief: 'x'.repeat(9000), tier: 'fast', role: 'reviewer' },
    ])
    expect(plan.maxDepth).toBe(3)
    expect(plan.maxTotalAgents).toBe(20)
    expect(plan.effortTokens).toBeGreaterThanOrEqual(2000)
  })

  it('gate 1 (maxDepth): refuses at the cap and lets a shallower agent delegate', () => {
    expect(refusalCode(planFanOut(context({ depth: 3 }), { tasks: bigTasks() }))).toBe('depth-exhausted')
    expect(refusalCode(planFanOut(context({ depth: 9 }), { tasks: bigTasks() }))).toBe('depth-exhausted')
    expect(planFanOut(context({ depth: 2 }), { tasks: bigTasks() }).kind).toBe('fan-out')
  })

  it('gate 2 (maxTotalAgents): refuses over budget, counts what is already spent, and never partially dispatches', () => {
    expect(refusalCode(planFanOut(context({ spent: 19 }), { tasks: bigTasks() }))).toBe('budget-exhausted')
    expect(planFanOut(context({ spent: 18 }), { tasks: bigTasks() }).kind).toBe('fan-out')
    expect(planFanOut(context({ spent: 19 }), { tasks: bigTasks(1), maxTotalAgents: 20 }).kind)
      .toBe('do-it-yourself')
  })

  it('gate 3 (fanOut heuristics): refuses a one-task split and a below-effort split', () => {
    expect(refusalCode(planFanOut(context(), { tasks: bigTasks(1) }))).toBe('too-few-subtasks')
    expect(refusalCode(planFanOut(context(), { tasks: [{ brief: 'tiny one' }, { brief: 'tiny two' }] }))).toBe('effort-too-small')
  })

  it('honours a disabled heuristic (minSubtasks 1 / minEffortTokens 0)', () => {
    const bounds: FanOutBounds = { ...BOUNDS, minSubtasks: 1, minEffortTokens: 0 }
    const plan = planFanOut({ bounds, depth: 0, spent: 0 }, { tasks: [{ brief: 'one tiny task' }] })
    expect(plan.kind).toBe('fan-out')
  })

  it('lets a call TIGHTEN a bound but never raise it', () => {
    // Tightening: 20 -> 1 refuses a two-task batch; 3 -> 0 refuses at depth 0.
    expect(refusalCode(planFanOut(context(), { tasks: bigTasks(), maxTotalAgents: 1 }))).toBe('budget-exhausted')
    expect(refusalCode(planFanOut(context(), { tasks: bigTasks(), maxDepth: 0 }))).toBe('depth-exhausted')
    // Raising: a call asking for 99 still hits the deployment's depth cap of 3.
    const raised = planFanOut(context({ depth: 3 }), { tasks: bigTasks(), maxDepth: 99, maxTotalAgents: 99 })
    expect(refusalCode(raised)).toBe('depth-exhausted')
    const plan = planFanOut(context(), { tasks: bigTasks(), maxDepth: 99, maxTotalAgents: 99 })
    expect(plan.kind === 'fan-out' && plan.maxDepth).toBe(3)
    expect(plan.kind === 'fan-out' && plan.maxTotalAgents).toBe(20)
  })

  it('refuses malformed requests without dispatching anything', () => {
    expect(refusalCode(planFanOut(context(), { tasks: [] }))).toBe('no-tasks')
    expect(refusalCode(planFanOut(context(), { tasks: [{ brief: '   ' }, { brief: 'ok' }] }))).toBe('invalid-task')
    expect(refusalCode(planFanOut(context(), { tasks: [{ brief: 'ok', model: 'turbo' as never }] }))).toBe('invalid-task')
    expect(refusalCode(planFanOut(context(), { tasks: [{ brief: 'ok', role: 'boss' as never }] }))).toBe('invalid-task')
    expect(refusalCode(planFanOut(context(), { tasks: bigTasks(), maxDepth: -1 }))).toBe('invalid-bounds')
    expect(refusalCode(planFanOut(context(), { tasks: bigTasks(), maxTotalAgents: 2.5 }))).toBe('invalid-bounds')
  })

  it('explains every refusal in model-facing terms', () => {
    const plan = planFanOut(context({ depth: 3 }), { tasks: bigTasks() })
    expect(plan.kind === 'do-it-yourself' && plan.refusal.reason).toMatch(/do the work here/)
    const small = planFanOut(context(), { tasks: [{ brief: 'small' }, { brief: 'small' }] })
    expect(small.kind === 'do-it-yourself' && small.refusal.reason).toMatch(/inline/)
  })
})

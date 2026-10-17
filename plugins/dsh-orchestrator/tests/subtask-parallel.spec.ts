import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineSubtaskParallelTool } from '../src/tools.ts'
import { makeAgent, makeHarness, type Harness } from './harness.ts'

/** A tool execution context for one fake caller. */
function execFor(agent: Agent): ToolRunContext {
  return { agent, signal: new AbortController().signal } as unknown as ToolRunContext
}

/** Two briefs big enough to clear the effort gate. */
function bigTasks(count = 2): Array<{ brief: string }> {
  return Array.from({ length: count }, (_unused, index) => ({ brief: `task ${index} ${'x'.repeat(5000)}` }))
}

/** Run the tool and return its canonical value (the declared output shape). */
async function run(harness: Harness, agent: Agent, args: unknown): Promise<Record<string, never>> {
  const tool = defineSubtaskParallelTool(harness.runtime)
  return await tool.execute(args, execFor(agent)) as Record<string, never>
}

describe('subtask_parallel', () => {
  it('gates, dispatches concurrently, and returns one result per task in request order', async () => {
    const harness = makeHarness()
    const lead = harness.addAgent(makeAgent('lead'))
    const value = await run(harness, lead, {
      tasks: [{ brief: 'first ' + 'x'.repeat(5000), model: 'fast' }, { brief: 'second ' + 'x'.repeat(5000), role: 'reviewer' }],
    }) as unknown as { results: Array<{ taskIndex: number; value: { role: string; status: string; output?: string } }> }
    expect(value.results.map(row => row.taskIndex)).toEqual([0, 1])
    expect(value.results.map(row => row.value.role)).toEqual(['worker', 'reviewer'])
    expect(value.results.every(row => row.value.status === 'completed')).toBe(true)
    expect(harness.dispatcher.requests.map(request => request.tier)).toEqual(['fast', 'good'])
    expect(harness.dispatcher.requests.map(request => request.label)).toEqual(['subtask-1', 'subtask-2'])
  })

  it('isolates a failed task instead of failing the batch', async () => {
    const harness = makeHarness()
    const lead = harness.addAgent(makeAgent('lead'))
    harness.dispatcher.script.push({ status: 'timeout', error: 'reviewer budget expired' }, { status: 'completed', output: 'ok' })
    const value = await run(harness, lead, { tasks: bigTasks() }) as unknown as {
      results: Array<{ value: { status: string; error?: string; output?: string } }>
    }
    expect(value.results[0]!.value).toMatchObject({ status: 'timeout', error: 'reviewer budget expired' })
    expect(value.results[1]!.value).toMatchObject({ status: 'completed', output: 'ok' })
  })

  it('contains a throwing dispatcher into that task\'s outcome', async () => {
    const harness = makeHarness()
    const lead = harness.addAgent(makeAgent('lead'))
    harness.dispatcher.throws = new Error('provider exploded')
    const value = await run(harness, lead, { tasks: bigTasks() }) as unknown as {
      results: Array<{ value: { status: string; error?: string } }>
    }
    expect(value.results.map(row => row.value)).toEqual([
      { role: 'worker', status: 'error', error: 'provider exploded' },
      { role: 'worker', status: 'error', error: 'provider exploded' },
    ])
  })

  it('refuses through the depth gate before dispatching anything', async () => {
    const harness = makeHarness({ fanOut: { maxDepth: 1 } })
    const lead = harness.addAgent(makeAgent('lead'))
    const child = harness.addAgent(makeAgent('child', lead))
    await expect(run(harness, child, { tasks: bigTasks() })).rejects.toThrow(/depth-exhausted/)
    expect(harness.dispatcher.requests).toHaveLength(0)
    // The top-level lead is still below the cap.
    await expect(run(harness, lead, { tasks: bigTasks() })).resolves.toBeDefined()
  })

  it('refuses through the budget gate and counts what it already spent', async () => {
    const harness = makeHarness({ fanOut: { maxTotalAgents: 3, maxDepth: 5 } })
    const lead = harness.addAgent(makeAgent('lead'))
    await expect(run(harness, lead, { tasks: bigTasks(2) })).resolves.toBeDefined()
    await expect(run(harness, lead, { tasks: bigTasks(2) })).rejects.toThrow(/budget-exhausted/)
    expect(harness.dispatcher.requests).toHaveLength(2)
  })

  it('refuses through the fan-out heuristics before spending anything', async () => {
    const harness = makeHarness()
    const lead = harness.addAgent(makeAgent('lead'))
    await expect(run(harness, lead, { tasks: [{ brief: 'x'.repeat(5000) }] })).rejects.toThrow(/too-few-subtasks/)
    await expect(run(harness, lead, { tasks: [{ brief: 'a' }, { brief: 'b' }] })).rejects.toThrow(/effort-too-small/)
    expect(harness.dispatcher.requests).toHaveLength(0)
  })

  it('charges the budget by the calling lineage, not by the individual agent', async () => {
    const harness = makeHarness({ fanOut: { maxTotalAgents: 4, maxDepth: 5 } })
    const lead = harness.addAgent(makeAgent('lead'))
    const child = harness.addAgent(makeAgent('child', lead))
    await expect(run(harness, child, { tasks: bigTasks(2) })).resolves.toBeDefined()
    // Two more from the SAME flow tree: the first agent already spent 2 of 4.
    await expect(run(harness, lead, { tasks: bigTasks(2) })).resolves.toBeDefined()
    await expect(run(harness, lead, { tasks: bigTasks(1) })).rejects.toThrow(/budget-exhausted/)
  })

  it('propagates a per-call maxDepth to the children\'s own fan-outs', async () => {
    const harness = makeHarness({ fanOut: { maxDepth: 5 } })
    const lead = harness.addAgent(makeAgent('lead'))
    const child = harness.addAgent(makeAgent('child', lead))
    await expect(run(harness, lead, { tasks: bigTasks(2), maxDepth: 1 })).resolves.toBeDefined()
    // The child is at depth 1: the parent's call cap (1) now refuses it, even
    // though the deployment cap is 5.
    await expect(run(harness, child, { tasks: bigTasks(2) })).rejects.toThrow(/depth-exhausted/)
  })

  it('propagates a per-call maxTotalAgents budget to the children\'s own fan-outs', async () => {
    const harness = makeHarness({ fanOut: { maxTotalAgents: 10, maxDepth: 5 } })
    const lead = harness.addAgent(makeAgent('lead'))
    const child = harness.addAgent(makeAgent('child', lead))
    await expect(run(harness, lead, { tasks: bigTasks(2), maxTotalAgents: 3 })).resolves.toBeDefined()
    // The flow already spent 2 of the parent's tighter 3-agent budget.
    await expect(run(harness, child, { tasks: bigTasks(2) })).rejects.toThrow(/budget-exhausted/)
  })

  it('passes the brief toolFilter through to the dispatch request', async () => {
    const harness = makeHarness()
    const lead = harness.addAgent(makeAgent('lead'))
    await run(harness, lead, {
      tasks: [
        { brief: 'read only ' + 'x'.repeat(5000), toolFilter: ['read', 'grep'] },
        { brief: 'write ' + 'x'.repeat(5000) },
      ],
    })
    expect(harness.dispatcher.requests[0]!.toolFilter).toEqual(['read', 'grep'])
    expect(harness.dispatcher.requests[1]!.toolFilter).toBeUndefined()
  })

  it('surfaces reviewer findings and their parse state', async () => {
    const harness = makeHarness()
    const lead = harness.addAgent(makeAgent('lead'))
    harness.dispatcher.queueFindings([{ severity: 'P0', summary: 'the lock leaks' }])
    harness.dispatcher.script.push({ role: 'reviewer', status: 'completed', output: 'not json', findings: undefined })
    const value = await run(harness, lead, { tasks: bigTasks() }) as unknown as {
      results: Array<{ value: { findings?: Array<{ severity: string; summary: string }>; error?: string } }>
    }
    expect(value.results[0]!.value.findings).toEqual([{ severity: 'P0', summary: 'the lock leaks' }])
    expect(value.results[1]!.value.findings).toBeUndefined()
  })
})

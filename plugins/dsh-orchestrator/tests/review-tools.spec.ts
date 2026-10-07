import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { OrchestratorService } from '../src/index.ts'
import { defineOrchestratorTools } from '../src/tools.ts'
import { makeAgent, makeHarness, type Harness } from './harness.ts'

/** A tool execution context for one fake caller. */
function execFor(agent: Agent): ToolRunContext {
  return { agent, signal: new AbortController().signal } as unknown as ToolRunContext
}

/** Two briefs big enough to clear the effort gate. */
function bigTasks(count = 2): Array<{ brief: string }> {
  return Array.from({ length: count }, (_unused, index) => ({ brief: `task ${index} ${'x'.repeat(5000)}` }))
}

/** Start a loop through the `review_loop` tool and return the carriers. */
async function startThroughTool(harness: Harness) {
  const lead = harness.addAgent(makeAgent('lead'))
  const carrier = harness.addAgent(makeAgent('carrier-1', lead))
  const tools = defineOrchestratorTools(harness.runtime)
  const start = tools.find(tool => tool.name === 'review_loop')!
  const value = await start.execute({ objective: 'harden the parser', files: ['src/parser.ts'] }, execFor(lead)) as {
    loopId: string
    carrierId: string
    goalId: string
    objective: string
    reviewersPerRound: number
  }
  return { lead, carrier, tools, value }
}

/** Look up one tool by name. */
function toolOf(tools: ReturnType<typeof defineOrchestratorTools>, name: string) {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool
}

describe('orchestrator tool surface', () => {
  it('registers exactly the documented tool names', async () => {
    const harness = makeHarness()
    const tools = defineOrchestratorTools(harness.runtime)
    expect(tools.map(tool => tool.name)).toEqual([
      'subtask_parallel',
      'review_loop',
      'review_round',
      'review_filter',
      'review_finish',
      'review_complete',
      'review_block',
      'review_resume',
    ])
  })

  it('applies as a cordis service: registers every tool on ctx.tools', () => {
    const harness = makeHarness()
    const registered: string[] = []
    harness.ctx.provide('tools', {
      register: (tool: { name: string }) => {
        registered.push(tool.name)
        return () => {}
      },
    } as never)
    const service = new OrchestratorService(harness.ctx, { reviewersPerRound: 2 })
    expect(registered).toEqual([
      'subtask_parallel',
      'review_loop',
      'review_round',
      'review_filter',
      'review_finish',
      'review_complete',
      'review_block',
      'review_resume',
    ])
    expect(service.resolved.reviewersPerRound).toBe(2)
    expect(service.status().loops).toEqual([])
    service.runtime.dispose()
  })
})

describe('review tools end to end', () => {
  it('starts a loop and reports its ids without waiting for the review', async () => {
    const harness = makeHarness({ reviewersPerRound: 3 })
    const { value } = await startThroughTool(harness)
    expect(value).toEqual({
      loopId: 'loop-carrier-1',
      carrierId: 'carrier-1',
      goalId: 'goal-carrier-1',
      objective: 'harden the parser',
      reviewersPerRound: 3,
    })
    expect(harness.starts[0]!.prompt).toMatch(/review_round/)
  })

  it('drives a round, removes a resolved P0, clears the review phase, and completes the goal', async () => {
    const harness = makeHarness({ reviewersPerRound: 2 })
    const { lead, carrier, tools } = await startThroughTool(harness)

    // Round 1: one P0 and one P1 from the two reviewers.
    harness.dispatcher.queueFindings([{ severity: 'P0', summary: 'the lock leaks' }])
    harness.dispatcher.queueFindings([{ severity: 'P1', summary: 'slow query' }])
    const round = toolOf(tools, 'review_round')
    const roundValue = await round.execute({ plan: 'split the lexer' }, execFor(carrier)) as {
      round: number
      dispatched: number
      completed: number
      failures: number
      zeroP0: boolean
      counts: { P0: number; P1: number }
      findings: Array<{ severity: string; summary: string; sourceRound: number }>
    }
    expect(roundValue).toMatchObject({
      round: 1,
      dispatched: 2,
      completed: 2,
      failures: 0,
      zeroP0: false,
      counts: { P0: 1, P1: 1 },
    })
    expect(roundValue.findings).toEqual([
      { severity: 'P0', summary: 'the lock leaks', sourceRound: 1 },
      { severity: 'P1', summary: 'slow query', sourceRound: 1 },
    ])

    // The completion gate refuses while the P0 stands.
    const finish = toolOf(tools, 'review_finish')
    await expect(finish.execute({}, execFor(carrier))).rejects.toThrow(/1 P0 finding\(s\) remain/)
    const complete = toolOf(tools, 'review_complete')
    await expect(complete.execute({}, execFor(carrier))).rejects.toThrow(/close the review phase/)

    // Remove the P0 as resolved, then clear and complete.
    const filter = toolOf(tools, 'review_filter')
    const filterValue = await filter.execute({
      reject: [{ severity: 'P0', summary: 'the lock leaks', reason: 'resolved' }],
      note: 'the lexer split removes the shared lock',
    }, execFor(carrier)) as { removed: unknown[]; counts: { P0: number }; zeroP0: boolean }
    expect(filterValue.removed).toEqual([{ severity: 'P0', summary: 'the lock leaks', sourceRound: 1 }])
    expect(filterValue).toMatchObject({ counts: { P0: 0 }, zeroP0: true })

    const finishValue = await finish.execute({}, execFor(carrier)) as { rounds: number; reviewers: number; findings: number }
    expect(finishValue).toEqual({ counts: { P0: 0, P1: 1, P2: 0, P3: 0 }, rounds: 1, reviewers: 2, failures: 0, findings: 1 })

    const completeValue = await complete.execute({ summary: 'shipped the split' }, execFor(carrier)) as {
      goalId: string
      phase: string
      reported: boolean
    }
    expect(completeValue).toMatchObject({ goalId: 'goal-carrier-1', phase: 'complete', reported: true })
    expect(harness.sent[0]).toMatchObject({ senderId: 'carrier-1', targetId: lead.id })
    expect(harness.sent[0]!.text).toMatch(/Outcome: shipped the split/)
  })

  it('blocks for a human decision and resumes on the answer', async () => {
    const harness = makeHarness({ reviewersPerRound: 1 })
    const { carrier, tools } = await startThroughTool(harness)
    const blocked = await toolOf(tools, 'review_block').execute(
      { code: 'scope-tradeoff', message: 'drop feature X?' },
      execFor(carrier),
    ) as { goalId: string; phase: string; code: string; message: string }
    expect(blocked).toEqual({
      goalId: 'goal-carrier-1',
      phase: 'blocked',
      code: 'scope-tradeoff',
      message: 'drop feature X?',
    })

    // A blocked loop refuses rounds and cannot be blocked twice.
    await expect(toolOf(tools, 'review_round').execute({ plan: 'p' }, execFor(carrier))).rejects.toThrow(/blocked/)
    await expect(toolOf(tools, 'review_block').execute({ code: 'again', message: 'x' }, execFor(carrier)))
      .rejects.toThrow(/already blocked/)

    const resumed = await toolOf(tools, 'review_resume').execute({}, execFor(carrier)) as { goalId: string; phase: string; status: string }
    expect(resumed).toEqual({ goalId: 'goal-carrier-1', phase: 'active', status: 'reviewing' })
    harness.dispatcher.queueFindings([])
    await expect(toolOf(tools, 'review_round').execute({ plan: 'p' }, execFor(carrier))).resolves.toBeDefined()
  })

  it('refuses loop tools for an agent that carries no loop, and requires a calling agent', async () => {
    const harness = makeHarness()
    const { lead, tools } = await startThroughTool(harness)
    await expect(toolOf(tools, 'review_round').execute({ plan: 'p' }, execFor(lead))).rejects.toThrow(/not carrying a review loop/)
    await expect(toolOf(tools, 'review_finish').execute({}, execFor(lead))).rejects.toThrow(/not carrying a review loop/)
    await expect(toolOf(tools, 'review_round').execute({ plan: 'p' }, {} as ToolRunContext))
      .rejects.toThrow(/require a calling agent/)
  })

  it('fans out through the subtask_parallel tool with the three gates', async () => {
    const harness = makeHarness({ fanOut: { minSubtasks: 2, minEffortTokens: 1000, maxDepth: 2, maxTotalAgents: 3 } })
    const lead = harness.addAgent(makeAgent('lead'))
    const tool = toolOf(defineOrchestratorTools(harness.runtime), 'subtask_parallel')
    // The two refusals that happen BEFORE any spend leave the budget intact.
    await expect(tool.execute({ tasks: [{ brief: 'a' }, { brief: 'b' }] }, execFor(lead))).rejects.toThrow(/effort-too-small/)
    await expect(tool.execute({ tasks: bigTasks(1) }, execFor(lead))).rejects.toThrow(/too-few-subtasks/)
    expect(harness.dispatcher.requests).toHaveLength(0)
    // A worth-it batch spends the flow's budget...
    const value = await tool.execute({ tasks: bigTasks(2) }, execFor(lead)) as { results: unknown[] }
    expect(value.results).toHaveLength(2)
    // ...and two more would exceed the remaining budget.
    await expect(tool.execute({ tasks: bigTasks(2) }, execFor(lead))).rejects.toThrow(/budget-exhausted/)
  })
})

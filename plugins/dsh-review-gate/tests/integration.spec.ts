/**
 * Review-gate integration probe: the real cordis wiring — session store,
 * projection registry, sandbox policy, tool runtime and the plugin — driven
 * through the `agent/pre-step` and `tools/pre-execute` waterfalls with LIVE
 * sessions, so the flag strip, the induced notices, the durable
 * `review-gate/state` append, the approval audit bookkeeping, the sandbox
 * transition and the folded state are all exercised together.
 *
 * @module @dsh-plugin/dsh-review-gate/tests/integration
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { setSandboxMode, SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { beforeAll, describe, expect, it } from 'vitest'
import ReviewGateController, { type ReviewGateConfig } from '../src/index.ts'

let ctx: Context

beforeAll(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, {})
  await ctx.plugin(ReviewGateController, {} satisfies ReviewGateConfig)
})

/** A live (entered + announced) session rooted at `/workspace`. */
function liveSession(id: string): Session {
  return ctx.sessions.create(SessionId(id), { meta: { cwd: '/workspace' } })
}

/** A minimal stepping agent over one live session. */
function agentFor(session: Session): Agent {
  // Test seam: the real Agent owner is the agent-loop plugin, which this
  // integration probe deliberately does not compose.
  return { id: session.id, session } as unknown as Agent
}

/** One direct user message with a single text block. */
function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Drive one claimed step through the `agent/pre-step` waterfall. */
async function preStep(agent: Agent, claimed: readonly UserMessage[], turn: number): Promise<PreStepDecision> {
  return ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [...claimed], turn, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter' as const, messages: [...claimed] }),
  )
}

/** One fabricated pre-execute call for the fence (only the read fields matter). */
function writeCall(agent: Agent, callId: string, target: string): ToolExecution {
  // Test seam: the registry mints real ToolExecutions; this probe builds the
  // fields the fence reads so the WIRED listener can be driven directly.
  return { name: 'write', arguments: { path: target }, callId: ToolCallId(callId), agent } as unknown as ToolExecution
}

/** The delegate a pre-execute listener receives when nothing blocks the call. */
async function delegate(): Promise<PreToolDecision> {
  return { kind: 'allow' }
}

describe('review-gate wiring', () => {
  it('strips the flags, injects the gate notice and logs the durable state', async () => {
    const session = liveSession('session-1')
    const agent = agentFor(session)
    const decision = await preStep(agent, [userMessage('implement the widget --review --workers 3')], 1)
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return

    const [stripped, ...notices] = decision.messages
    expect(stripped?.content).toEqual([{ type: 'text', text: 'implement the widget' }])
    expect(notices).toHaveLength(1)
    expect(notices[0]?.source.kind).toBe('dsh-review-gate')

    const armed = { taskId: 'task-1', enabled: true, awaitingApproval: true, reviewers: 3 }
    expect(session.snapshotEvents().filter(event => event.type === 'review-gate/state').at(-1)?.data).toEqual(armed)
    expect(ctx.reviewGate.stateOf(session)).toEqual(armed)

    // --no-review cancels the same task and logs the cancellation.
    const cancelled = await preStep(agent, [userMessage('actually go ahead --no-review')], 2)
    expect(cancelled.kind).toBe('enter')
    expect(ctx.reviewGate.stateOf(session)).toEqual({
      taskId: 'task-2',
      enabled: false,
      awaitingApproval: false,
      reviewers: 3,
    })
  })

  it('hands the armed task to the task board for --review and --plan', async () => {
    const session = liveSession('session-7')
    const marked: string[] = []
    ctx.provide('taskBoard', {
      markAwaitingApproval: (target: Session) => { marked.push(String(target.id)) },
    } as never)

    await preStep(agentFor(session), [userMessage('draft the migration --plan')], 1)
    await preStep(agentFor(session), [userMessage('implement it --review')], 2)
    expect(marked).toEqual(['session-7', 'session-7'])

    // --no-review does not hand anything to the board.
    await preStep(agentFor(session), [userMessage('go ahead --no-review')], 3)
    expect(marked).toHaveLength(2)
  })

  it('leaves unflagged input untouched', async () => {
    const session = liveSession('session-2')
    const decision = await preStep(agentFor(session), [userMessage('just do it')], 1)
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0]?.content).toEqual([{ type: 'text', text: 'just do it' }])
    expect(session.snapshotEvents().some(event => event.type === 'review-gate/state')).toBe(false)
  })

  it('fences protected writes, spares the scratch dir, and opens on approval', async () => {
    const session = liveSession('session-3')
    const agent = agentFor(session)
    await preStep(agent, [userMessage('plan it --review')], 1)

    // `<cwd>/src/app.ts` is protected by the default globs while the gate is
    // closed; the scratch dir stays writable; approving opens the gate.
    expect((await ctx.waterfall('tools/pre-execute', writeCall(agent, 'call-3', 'src/app.ts'), delegate)).kind).toBe('ask')
    expect((await ctx.waterfall('tools/pre-execute', writeCall(agent, 'call-3b', '.dsh-plans/plan.md'), delegate)).kind).toBe('allow')

    ctx.reviewGate.approve(session)
    expect((await ctx.waterfall('tools/pre-execute', writeCall(agent, 'call-3c', 'src/app.ts'), delegate)).kind).toBe('allow')
    await preStep(agent, [], 1)
    expect(ctx.reviewGate.stateOf(session).awaitingApproval).toBe(false)
  })

  it('opens from the approval audit pair and feeds a refusal back to the model', async () => {
    const session = liveSession('session-4')
    const agent = agentFor(session)
    await preStep(agent, [userMessage('plan it --review')], 1)

    // A refused ask leaves the fence closed and comes back as feedback at the
    // next step.
    const callId = ToolCallId('call-refused')
    expect((await ctx.waterfall('tools/pre-execute', writeCall(agent, 'call-refused', 'src/app.ts'), delegate)).kind).toBe('ask')
    session.append('approval/asked', { id: ApprovalRequestId('approval-refused'), toolName: 'write', callId })
    session.append('approval/decided', { id: ApprovalRequestId('approval-refused'), outcome: 'rejected' })
    const refused = await preStep(agent, [], 1)
    expect(refused.kind).toBe('enter')
    expect(ctx.reviewGate.stateOf(session).awaitingApproval).toBe(true)
    if (refused.kind !== 'enter') return
    expect(refused.messages.some(message => message.content.some(
      block => block.type === 'text' && block.text.includes('did not approve'),
    ))).toBe(true)

    // A granted ask unlocks the fence immediately; the next step logs it.
    expect((await ctx.waterfall('tools/pre-execute', writeCall(agent, 'call-refused', 'src/app.ts'), delegate)).kind).toBe('ask')
    session.append('approval/asked', { id: ApprovalRequestId('approval-granted'), toolName: 'write', callId })
    session.append('approval/decided', { id: ApprovalRequestId('approval-granted'), outcome: 'allowed-once' })
    expect((await ctx.waterfall('tools/pre-execute', writeCall(agent, 'call-refused', 'src/app.ts'), delegate)).kind).toBe('allow')
    await preStep(agent, [], 1)
    expect(ctx.reviewGate.stateOf(session).awaitingApproval).toBe(false)
  })

  it('tightens the session sandbox while gated and restores it on approval', async () => {
    const session = liveSession('session-5')
    const agent = agentFor(session)
    setSandboxMode(session, 'danger-full-access')
    await preStep(agent, [userMessage('plan it --review')], 1)
    expect(ctx.sandboxPolicy.overrideOf(session)).toBe('workspace-write')

    ctx.reviewGate.approve(session)
    await preStep(agent, [], 1)
    expect(ctx.sandboxPolicy.overrideOf(session)).toBe('danger-full-access')
  })

  it('never loosens a stricter session sandbox', async () => {
    const session = liveSession('session-6')
    setSandboxMode(session, 'read-only')
    await preStep(agentFor(session), [userMessage('plan it --review')], 1)
    expect(ctx.sandboxPolicy.overrideOf(session)).toBe('read-only')
  })
})

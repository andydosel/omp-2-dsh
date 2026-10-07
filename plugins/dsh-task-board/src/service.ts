/**
 * The task-board service (`ctx.taskBoard`, §13.3): durable state operations
 * over the session's `task/*` events plus everything that is bound to the
 * plugin's life cycle — the `taskBoard` projection unit, the five coordinator
 * tools, the per-agent work-set prompt section, and the conservative
 * auto-close observer.
 *
 * Every mutation appends one whole-value durable event (the projection seam's
 * whole-value rule) and bumps the task revision; mutations go through the
 * session the caller supplies, so one board per session and replay from the
 * log are both free.
 *
 * @module @dsh-plugin/dsh-task-board/service
 */

import { Service, type Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { registerTaskCommands } from './commands.ts'
import {
  EMPTY_TASK_BOARD,
  TASK_BOARD_KEY,
  findTask,
  isTerminalStatus,
  nextTaskId,
  taskBoardProjection,
  visibleTasks,
} from './projection.ts'
import { defineTaskTools } from './tools.ts'
import { WORK_SET_ORDER, WORK_SET_SECTION, renderWorkSet } from './workset.ts'
import type { TaskBoardState, TaskId, TaskPatch, TaskSnapshot } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted task board (`@dsh-plugin/dsh-task-board`). */
    taskBoard: TaskBoardService
  }
}

/** Configuration accepted from `cordis.patch.yml` (design §6). */
export interface TaskBoardConfig {
  /** Hard UTF-8 byte budget of the work-set prompt section (default {@link DEFAULT_MAX_CONTEXT_BYTES}). */
  maxContextBytes?: number
  /** Successful tool-result substrings that complete in-progress tasks (default `['test-passed']`). */
  autoCloseSignals?: readonly string[]
}

/** Config with every default materialized. */
export interface ResolvedTaskBoardConfig {
  readonly maxContextBytes: number
  readonly autoCloseSignals: readonly string[]
}

/** Default work-set budget: a few dozen task lines, never a context sink. */
export const DEFAULT_MAX_CONTEXT_BYTES = 2000

/** Default auto-close signal: only an unmistakable "the tests pass" result closes a task. */
export const DEFAULT_AUTO_CLOSE_SIGNALS: readonly string[] = ['test-passed']

/** Arguments of {@link TaskBoardHost.create} / the one-object overload. */
export interface CreateTaskInput {
  /** Requirement-level description; required, non-empty. */
  subject: string
  /** Session accountable for the task. */
  owner?: SessionId | string
  /** Work-set membership (new tasks default to `true`). */
  inContext?: boolean
}

/**
 * The board surface the tools and sibling plugins program against
 * (`ctx.get('taskBoard')` structurally satisfies it).
 */
export interface TaskBoardHost {
  /** Create a task (revision 1, status `pending`). */
  create(session: Session, input: CreateTaskInput): TaskSnapshot
  /** Compare-and-set update; `revision` mismatches throw {@link TaskRevisionConflictError}. */
  update(session: Session, id: TaskId, patch: TaskPatch, revision?: number): TaskSnapshot
  /** Close a task: status `closed`, out of the work set, tombstone kept. */
  close(session: Session, id: TaskId, reason?: string): TaskSnapshot
  /** Reopen a terminal task: status `pending`, back in the work set. */
  reopen(session: Session, id: TaskId): TaskSnapshot
  /** Every task except `deleted` tombstones, in creation order. */
  list(session: Session): readonly TaskSnapshot[]
}

/** No task with that id on the session's board. */
export class TaskNotFoundError extends Error {
  constructor(readonly taskId: TaskId) {
    super(`task board: task ${JSON.stringify(taskId)} is not on this session's board`)
    this.name = 'TaskNotFoundError'
  }
}

/** A compare-and-set update named a revision that is no longer current. */
export class TaskRevisionConflictError extends Error {
  constructor(
    readonly taskId: TaskId,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`task board: task ${JSON.stringify(taskId)} is at revision ${actual}, not ${expected} — re-read with task_list and retry`)
    this.name = 'TaskRevisionConflictError'
  }
}

/**
 * Whether one rendered tool result carries an auto-close signal. Case-insensitive
 * substring match; an empty signal list disables auto-close entirely.
 */
export function matchesAutoCloseSignal(text: string, signals: readonly string[]): boolean {
  const haystack = text.toLowerCase()
  return signals.some(signal => signal.length > 0 && haystack.includes(signal.toLowerCase()))
}

/** Materialize and validate the plugin config (fail loud on a bad knob). */
export function resolveTaskBoardConfig(config: TaskBoardConfig = {}): ResolvedTaskBoardConfig {
  const maxContextBytes = config.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES
  if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes < 0) {
    throw new TypeError(`dsh-task-board: maxContextBytes must be a non-negative integer, got ${String(config.maxContextBytes)}`)
  }
  const autoCloseSignals = config.autoCloseSignals ?? DEFAULT_AUTO_CLOSE_SIGNALS
  for (const signal of autoCloseSignals) {
    if (typeof signal !== 'string' || signal.trim() === '') {
      throw new TypeError(`dsh-task-board: autoCloseSignals entries must be non-empty strings, got ${JSON.stringify(signal)}`)
    }
  }
  return { maxContextBytes, autoCloseSignals: [...autoCloseSignals] }
}

/**
 * Apply one patch to a task: bump the revision, and force a terminal status
 * out of the work set unless the patch states otherwise.
 */
function patchedTask(current: TaskSnapshot, patch: TaskPatch): TaskSnapshot {
  const status = patch.status ?? current.status
  const owner = patch.owner === undefined ? current.owner : SessionId(String(patch.owner))
  return {
    id: current.id,
    revision: current.revision + 1,
    subject: patch.subject ?? current.subject,
    status,
    ...owner === undefined ? {} : { owner },
    reviewRound: patch.reviewRound ?? current.reviewRound,
    findings: patch.findings ?? current.findings,
    filteredFindings: patch.filteredFindings ?? current.filteredFindings,
    inContext: patch.inContext ?? (isTerminalStatus(status) ? false : current.inContext),
  }
}

/**
 * The task board: durable ledger, work set, and the lifecycle-bound arms.
 * Mounted as `ctx.taskBoard`.
 */
export class TaskBoardService extends Service implements TaskBoardHost {
  static inject = ['agents', 'sessionProjections', 'tools'] as const

  /** Effective config (defaults materialized). */
  readonly config: ResolvedTaskBoardConfig

  private readonly workSetFibers = new Map<Agent, Fiber>()

  constructor(ctx: Context, config: TaskBoardConfig = {}) {
    super(ctx, 'taskBoard')
    this.config = resolveTaskBoardConfig(config)

    // The projection unit is owned by this plugin's fiber (register() attaches
    // its effect to the calling context), so unloading the plugin drops the key.
    ctx.sessionProjections.register(taskBoardProjection)
    for (const tool of defineTaskTools(this)) ctx.tools.register(tool)
    // The user-facing action channel the Web task-board panel drives.
    registerTaskCommands(ctx, this)

    // Conservative auto-close: a successful tool result, and only then.
    ctx.on('tools/result', (exec, result) => {
      this.onToolResult(exec, result)
    })

    for (const agent of ctx.agents.list()) this.installWorkSet(agent)
    ctx.on('agent/created', async ({ agent }) => {
      this.installWorkSet(agent)
    })
    ctx.on('agent/disposed', async ({ agent }) => {
      this.uninstallWorkSet(agent)
    })
    ctx.effect(() => () => this.disposeWorkSets(), 'dsh-task-board: work-set sections')
  }

  /** The session's folded board (empty before the first `task/new`). */
  boardOf(session: Session): TaskBoardState {
    return this.ctx.sessionProjections.stateOf(session, TASK_BOARD_KEY) ?? EMPTY_TASK_BOARD
  }

  /** Create a task from `(session, input)`. */
  create(session: Session, input: CreateTaskInput): TaskSnapshot
  /** Create a task from a single `{ session, subject, … }` object (sibling-plugin form). */
  create(input: CreateTaskInput & { session: Session }): TaskSnapshot
  create(sessionOrInput: Session | (CreateTaskInput & { session: Session }), input?: CreateTaskInput): TaskSnapshot {
    const call = input === undefined
      ? oneObjectCreate(sessionOrInput as CreateTaskInput & { session: Session })
      : { session: sessionOrInput as Session, input }
    return this.addTask(call.session, call.input)
  }

  update(session: Session, id: TaskId, patch: TaskPatch, revision?: number): TaskSnapshot {
    if (Object.keys(patch).length === 0) {
      throw new TypeError('task board: a non-empty patch is required — nothing would change')
    }
    const current = this.requireTask(session, id)
    if (revision !== undefined && revision !== current.revision) {
      throw new TaskRevisionConflictError(id, revision, current.revision)
    }
    const next = patchedTask(current, patch)
    session.append('task/update', { task: next })
    return next
  }

  close(session: Session, id: TaskId, reason?: string): TaskSnapshot {
    const current = this.requireTask(session, id)
    const next: TaskSnapshot = { ...current, revision: current.revision + 1, status: 'closed', inContext: false }
    session.append('task/closed', { task: next, ...reason === undefined ? {} : { reason } })
    return next
  }

  reopen(session: Session, id: TaskId): TaskSnapshot {
    const current = this.requireTask(session, id)
    const next: TaskSnapshot = { ...current, revision: current.revision + 1, status: 'pending', inContext: true }
    session.append('task/reopened', { task: next })
    return next
  }

  list(session: Session): readonly TaskSnapshot[] {
    return visibleTasks(this.boardOf(session))
  }

  /** One task by id, tombstones included. */
  get(session: Session, id: TaskId): TaskSnapshot | undefined {
    return findTask(this.boardOf(session), id)
  }

  /** Mark one task completed and out of the work set (the auto-close target). */
  complete(session: Session, id: TaskId): TaskSnapshot {
    const current = this.requireTask(session, id)
    const next: TaskSnapshot = { ...current, revision: current.revision + 1, status: 'completed', inContext: false }
    session.append('task/update', { task: next })
    return next
  }

  /** The work-set section text for one session (also the prompt provider's body). */
  renderWorkSet(session: Session): string {
    return renderWorkSet(this.boardOf(session), this.config.maxContextBytes)
  }

  private addTask(session: Session, input: CreateTaskInput): TaskSnapshot {
    const subject = input.subject.trim()
    if (subject === '') throw new TypeError('task board: a task subject must be a non-empty string')
    const task: TaskSnapshot = {
      id: nextTaskId(this.boardOf(session)),
      revision: 1,
      subject,
      status: 'pending',
      ...input.owner === undefined ? {} : { owner: SessionId(String(input.owner)) },
      reviewRound: 0,
      findings: [],
      filteredFindings: [],
      inContext: input.inContext ?? true,
    }
    session.append('task/new', { task })
    return task
  }

  private requireTask(session: Session, id: TaskId): TaskSnapshot {
    const task = findTask(this.boardOf(session), id)
    if (task === undefined) throw new TaskNotFoundError(id)
    return task
  }

  /**
   * Auto-close: only a successful result carrying a configured completion
   * signal closes anything, and only tasks already `in_progress` (a task the
   * coordinator never started is left for a human).
   */
  private onToolResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    const signals = this.config.autoCloseSignals
    const session = exec.agent?.session
    if (result.isError || signals.length === 0 || session === undefined) return
    const matched = result.content.some(block => block.type === 'text' && matchesAutoCloseSignal(block.text, signals))
    if (!matched) return
    for (const task of this.boardOf(session)) {
      if (task.status !== 'in_progress') continue
      this.complete(session, task.id)
    }
  }

  /** Install the bounded work-set section for one agent (per-agent scope). */
  private installWorkSet(agent: Agent): void {
    if (this.workSetFibers.has(agent)) return
    const fiber = agent.ctx.inject(['systemPrompt', 'sessionProjections'], scope => {
      scope.systemPrompt.section({
        name: WORK_SET_SECTION,
        order: WORK_SET_ORDER,
        // A task subject may contain `{{…}}`; the section is literal text.
        interpolate: false,
        text: () => this.renderWorkSet(agent.session),
      })
    })
    this.workSetFibers.set(agent, fiber)
  }

  private uninstallWorkSet(agent: Agent): void {
    const fiber = this.workSetFibers.get(agent)
    if (fiber === undefined) return
    this.workSetFibers.delete(agent)
    this.disposeWorkSetFiber(fiber)
  }

  private disposeWorkSets(): void {
    const fibers = [...this.workSetFibers.values()]
    this.workSetFibers.clear()
    for (const fiber of fibers) this.disposeWorkSetFiber(fiber)
  }

  /**
   * Retire one per-agent section fiber. Disposal is fire-and-forget with a
   * logged failure: it runs on agent disposal and on plugin unload, when the
   * agent's own context is already unwinding and nothing awaits the result.
   */
  private disposeWorkSetFiber(fiber: Fiber): void {
    void fiber.dispose().catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-task-board: work-set section cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

/** Normalize the one-object `create` overload (a `Session` never carries a `subject`). */
function oneObjectCreate(value: CreateTaskInput & { session: Session }): { session: Session; input: CreateTaskInput } {
  return { session: value.session, input: value }
}

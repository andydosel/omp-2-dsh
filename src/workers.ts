/**
 * Per-director worker bookkeeping for vibe mode: childId → tier/turn counters,
 * the live roster state the `vibe/workers` projection folds, and the turn-end
 * promise table `vibe_wait` resolves against.
 *
 * A continuable child produces NO jobs; `agent/status` idle is not a
 * turn-end signal and `subagent/end` is epoch-granular. The only turn-precise
 * signal is the child session's own `turn/end` log event, paired with the
 * turn counter this registry maintains per dispatch (spawn = one turn, each
 * followup = the next FIFO turn).
 *
 * The registry is also the completion self-delivery owner: when a watched
 * worker's turn/end settles and NO `vibe_wait` consumed it inline, the
 * director session is STEERED with a `subagent-settled` notice (completion
 * self-delivery). The steer is gated on the consecutive-settle wake budget —
 * the same budget `vibe_spawn` refuses on — so the self-exciting wake chain
 * stays bounded. A wait that returned the result inline acked the turn; the
 * waiter-table check in {@link WorkerRegistry.onTurnEnd} is the ack protocol
 * (no double delivery).
 *
 * @module @dsh-plugin/dsh-vibe-mode/workers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type { VibeTier, VibeWorkerState, VibeWorkerView } from './types.ts'

/** Cap on the completion preview carried by the self-delivery steer text. */
const COMPLETION_PREVIEW_MAX_CHARS = 2000

/** One live worker's bookkeeping under its director. */
export interface WorkerRecord {
  /** Durable child session id, stable across activations. */
  readonly childId: SessionId
  /** The tier the director spawned it under. */
  readonly tier: VibeTier
  /** Durable creation label from the spawn call. */
  readonly label: string
  /**
   * The expected absolute turn number of the most recently dispatched
   * message (spawn = `completed + 1`, each send increments).
   */
  lastTurn: number
  /** Messages dispatched so far (spawn counts 1, each send +1). */
  dispatched: number
  /** Live roster state (starting → running ↔ idle, parked, dead). */
  state: VibeWorkerState
  /** ISO timestamp of the last state transition. */
  lastActivity?: string
}

/** One pending `vibe_wait` outcome. */
export interface TurnEndResult {
  readonly session: SessionId
  /** The turn number that ended. */
  readonly turn: number
  /**
   * The child's final assistant output text. ABSENT (not `undefined`) when
   * the child logged none: the canonical value must be lossless JSON, and an
   * `undefined` field value is not representable.
   */
  readonly output?: string
  readonly status: 'completed' | 'timeout' | 'aborted' | 'disposed'
}

/**
 * Build one canonical `vibe_wait` result, omitting the `output` key entirely
 * when the worker produced no final text. The tool's canonical output must be
 * plain lossless JSON (the tools service snapshots it), and an `undefined`
 * field value would fail that boundary.
 */
function turnEndResult(
  session: SessionId,
  turn: number,
  status: TurnEndResult['status'],
  output: string | undefined,
): TurnEndResult {
  return output === undefined
    ? { session, turn, status }
    : { session, turn, status, output }
}

/** Options for one `waitForTurn` call. */
export interface WaitForTurnOptions {
  /** Per-wait timeout in milliseconds; resolves `timeout` on expiry. */
  readonly timeoutMs: number
  /** Caller cancellation; rejects `aborted` when it fires before resolution. */
  readonly signal: AbortSignal
  /** Called once on resolution to release the wake budget. */
  readonly onSettled?: () => void
}

/** Whether the child log holds an open turn (turn/start without its closing turn/end). */
function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/**
 * The roster state a worker should carry the moment the registry first
 * registers it (the `vibe_spawn`/`vibe_send` race: the child begins its turn
 * BEFORE the tool handler registers the record, so the `turn/start` firehose
 * event is already past and the firehose listener misses it). Seed from the
 * child's live log: an open turn means it is already running; a closed turn
 * means it is idle; nothing logged means it is still starting.
 */
function seedState(events: readonly SessionEvent[] | undefined): VibeWorkerState {
  if (events === undefined || events.length === 0) return 'starting'
  if (hasOpenTurn(events)) return 'running'
  return completedTurnsOf(events) > 0 ? 'idle' : 'starting'
}
/** Count completed turns in a child's session log (turn/end events). */
export function completedTurnsOf(events: readonly SessionEvent[]): number {
  let completed = 0
  for (const event of events) {
    if (event.type === 'turn/end') completed += 1
  }
  return completed
}

/**
 * One director's worker registry. Created at mode entry, disposed at mode
 * exit (or with the agent scope). Owns the root-ctx `session/event` listener
 * that routes `turn/end` to waiting `vibe_wait` calls (and `turn/start` to
 * the roster state), the consecutive settle-wake budget that mirrors
 * `tool-jobs`' `maxConsecutiveWakes`, and the completion self-delivery steer.
 */
export class WorkerRegistry {
  /** Workers by child id, in spawn order. */
  private readonly workers = new Map<SessionId, WorkerRecord>()
  /** Turn-end waiters keyed by child id, then by target turn. */
  private readonly waiters = new Map<SessionId, Map<number, Array<() => void>>>()
  /**
   * Turns a `vibe_wait` already delivered INLINE (from the log, or through a
   * registered waiter). A later `turn/end` replay for such a turn must not
   * also steer — the inline return was the ack. Keyed `childId\0turn`.
   */
  private readonly deliveredTurns = new Set<string>()
  /**
   * Consecutive `subagent-settled` claims by the director since the last
   * user-authored claim. Bounds the self-exciting wake chain.
   */
  private consecutiveSettles = 0
  /** Whether the registry has been disposed. */
  private disposed = false

  /** Disposes the root listeners (the tools' `agent.ctx` registrations unwind separately). */
  private readonly disposeListeners: () => void

  constructor(
    private readonly ctx: Context,
    private readonly director: Agent,
    private readonly wakeBudget: number,
  ) {
    // The session/event firehose on the ROOT ctx sees every session's events,
    // including the children's. Scope-filtered dispatch would miss them.
    const offEvents = ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') {
        const record = this.workers.get(session.id)
        if (record === undefined) return
        record.state = 'running'
        record.lastActivity = new Date().toISOString()
        this.emitRoster()
        return
      }
      if (event.type === 'turn/end') {
        this.onTurnEnd(session.id, event.data.turn)
      }
    })
    // Hard destroy (drain/--terminate) marks the worker dead in the roster;
    // the per-wait disposed listener rejects waits separately.
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      const record = this.workers.get(agent.id)
      if (record === undefined) return
      record.state = 'dead'
      record.lastActivity = new Date().toISOString()
      this.emitRoster()
    })
    // User input resets the wake budget; a settle notice spends it. The
    // continuation manager's settle notice is the only wake we cannot block
    // from a plugin, so we bound what the woken director may DO next — and
    // the self-delivery steer spends the same budget through the same claim.
    const offClaims = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (agent !== this.director) return
      if (message.source.kind === 'user') {
        this.consecutiveSettles = 0
      } else if (message.source.kind === 'subagent-settled') {
        this.consecutiveSettles += 1
      }
    })
    this.disposeListeners = () => {
      offEvents()
      offDisposed()
      offClaims()
    }
  }

  /** All workers, in spawn order. */
  list(): WorkerRecord[] {
    return [...this.workers.values()]
  }

  /** Look up one worker. */
  get(childId: SessionId): WorkerRecord | undefined {
    return this.workers.get(childId)
  }

  /** Whether the wake budget is exhausted (spawn refusal / steer suppression gate). */
  wakeBudgetExhausted(): boolean {
    return this.consecutiveSettles >= this.wakeBudget
  }

  /** Current consecutive settle count (exposed by `vibe_list`). */
  get consecutiveSettleCount(): number {
    return this.consecutiveSettles
  }

  /**
   * Register a freshly spawned worker. The initial prompt completes as
   * `completed + 1`, read from the child's live log when readable (a fresh
   * child has none → turn 1), else assumed fresh.
   */
  spawn(childId: SessionId, tier: VibeTier, label: string, initialEvents: readonly SessionEvent[] | undefined): WorkerRecord {
    const record: WorkerRecord = {
      childId,
      tier,
      label,
      lastTurn: initialEvents === undefined ? 1 : completedTurnsOf(initialEvents) + 1,
      dispatched: 1,
      state: seedState(initialEvents),
      lastActivity: new Date().toISOString(),
    }
    this.workers.set(childId, record)
    this.emitRoster()
    return record
  }

  /**
   * Register one followup dispatch. The next FIFO turn completes after the
   * previous one; for a worker the registry does not know (cold-resumed),
   * seed from its live log.
   */
  send(childId: SessionId, liveEvents: readonly SessionEvent[] | undefined): WorkerRecord {
    const existing = this.workers.get(childId)
    if (existing !== undefined) {
      existing.lastTurn += 1
      existing.dispatched += 1
      this.emitRoster()
      return existing
    }
    const record: WorkerRecord = {
      childId,
      tier: 'good',
      label: 'vibe worker',
      lastTurn: liveEvents === undefined ? 1 : completedTurnsOf(liveEvents) + 1,
      dispatched: 1,
      state: seedState(liveEvents),
      lastActivity: new Date().toISOString(),
    }
    this.workers.set(childId, record)
    this.emitRoster()
    return record
  }

  /** Mark one worker parked (vibe_kill interrupt). */
  park(childId: SessionId): void {
    const record = this.workers.get(childId)
    if (record === undefined) return
    record.state = 'parked'
    record.lastActivity = new Date().toISOString()
    this.emitRoster()
  }

  /** Mark every live worker parked (`/vibe off`), leaving dead rows untouched. */
  parkAll(): void {
    let changed = false
    for (const record of this.workers.values()) {
      if (record.state === 'dead') continue
      record.state = 'parked'
      record.lastActivity = new Date().toISOString()
      changed = true
    }
    if (changed) this.emitRoster()
  }

  /** Remove a worker's bookkeeping (used on kill/terminate). */
  forget(childId: SessionId): void {
    this.workers.delete(childId)
    this.waiters.delete(childId)
  }

  /**
   * Wait until the child logs `turn/end` for the given turn. Races the
   * turn/end event against the timeout and the caller's abort signal, and
   * rejects `disposed` if the worker's agent leaves the registry first.
   *
   * @param readEvents - reads the child's CURRENT log on settlement, so the
   *   output reflects everything logged up to (and including) the matched
   *   `turn/end`, not a stale pre-wait snapshot.
   */
  waitForTurn(
    childId: SessionId,
    turn: number,
    readEvents: () => readonly SessionEvent[] | undefined,
    options: WaitForTurnOptions,
  ): Promise<TurnEndResult> {
    return new Promise<TurnEndResult>((resolve, reject) => {
      // Already completed before the wait registered: resolve from the log.
      if (completedTurnsOf(readEvents() ?? []) >= turn) {
        options.onSettled?.()
        this.deliveredTurns.add(`${childId}\u0000${turn}`)
        resolve(turnEndResult(childId, turn, 'completed', this.outputText(readEvents() ?? [])))
        return
      }
      let offTimeout: () => void = () => {}
      let offSignal: () => void = () => {}
      let offDisposed: () => void = () => {}
      let finished = false
      const finish = (result: TurnEndResult | undefined, error?: Error): void => {
        if (finished) return
        finished = true
        this.removeWaiter(childId, turn, settle)
        offTimeout()
        offSignal()
        offDisposed()
        options.onSettled?.()
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve(result!)
      }
      const settle = (): void => finish(turnEndResult(childId, turn, 'completed', this.outputText(readEvents() ?? [])))
      this.addWaiter(childId, turn, settle)
      const timer = setTimeout(() => {
        finish(turnEndResult(childId, turn, 'timeout', undefined))
      }, options.timeoutMs)
      offTimeout = () => { clearTimeout(timer) }
      // Exec signal: the director's turn was cancelled or the tool call aborted.
      offSignal = () => {
        if (options.signal.aborted) {
          finish(undefined, new Error(`vibe_wait aborted: ${String(options.signal.reason ?? 'signal')}`))
        }
      }
      options.signal.addEventListener('abort', offSignal)
      // Worker destroyed while waiting (park-interrupt does not dispose, so
      // this fires only on hard destroy / drain).
      offDisposed = this.ctx.on('agent/disposed', ({ agent }) => {
        if (agent.id === childId) {
          finish(undefined, new Error(`vibe_wait: worker ${childId} was disposed before turn ${turn} ended`))
        }
      })
      if (options.signal.aborted) offSignal()
    })
  }

  /**
   * One worker turn ended. Resolve any waiters for exactly this turn — that
   * is the inline ack that CONSUMES the completion (no steer). When nobody
   * waited (or the wait already timed out/aborted/interrupted), self-deliver
   * the completion to the director by steering it, unless the wake budget is
   * exhausted (no new self-excitation).
   */
  private onTurnEnd(childId: SessionId, turn: number): void {
    if (this.disposed) return
    const record = this.workers.get(childId)
    if (record === undefined) return
    if (record.state !== 'parked') record.state = 'idle'
    record.lastActivity = new Date().toISOString()
    this.emitRoster()
    const byTurn = this.waiters.get(childId)
    const waiters = byTurn?.get(turn)
    if (waiters !== undefined && waiters.length > 0) {
      const snapshot = [...waiters]
      byTurn!.delete(turn)
      if (byTurn?.size === 0) this.waiters.delete(childId)
      this.deliveredTurns.add(`${childId}\u0000${turn}`)
      for (const settle of snapshot) settle()
      return
    }
    // A wait already returned this turn inline (from the log): that return
    // was the ack, so a replayed turn/end must not also steer.
    if (this.deliveredTurns.delete(`${childId}\u0000${turn}`)) return
    // No inline ack: the completion was NOT consumed by a vibe_wait.
    const events = childSessionEvents(this.ctx, childId)
    this.steerCompletion(childId, turn, this.outputText(events ?? []))
  }

  /**
   * Steer the director with the worker's completion. Gated on the wake
   * budget: a woken director whose budget is spent must not be woken again —
   * the completion stays reachable through `vibe_wait` (which resolves from
   * the child's log) and later settles steer again once a user message
   * resets the budget.
   */
  private steerCompletion(childId: SessionId, turn: number, output: string | undefined): void {
    if (this.wakeBudgetExhausted()) return
    const record = this.workers.get(childId)
    const label = record?.label ?? childId
    const preview = output === undefined
      ? '(no final output)'
      : output.slice(0, COMPLETION_PREVIEW_MAX_CHARS)
    const text = `worker ${label} completed: ${preview}\nFull output: read agent://${childId}`
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: `worker ${label} completed (turn ${turn})`,
        senderSessionId: childId,
      },
    })
    this.director.steer(message)
  }

  /** Resolve every waiter for one completed turn. */
  private addWaiter(childId: SessionId, turn: number, settle: () => void): void {
    let byTurn = this.waiters.get(childId)
    if (byTurn === undefined) {
      byTurn = new Map()
      this.waiters.set(childId, byTurn)
    }
    let list = byTurn.get(turn)
    if (list === undefined) {
      list = []
      byTurn.set(turn, list)
    }
    list.push(settle)
  }

  private removeWaiter(childId: SessionId, turn: number, settle: () => void): void {
    const byTurn = this.waiters.get(childId)
    const list = byTurn?.get(turn)
    if (list === undefined) return
    const index = list.indexOf(settle)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) {
      byTurn!.delete(turn)
      if (byTurn?.size === 0) this.waiters.delete(childId)
    }
  }

  /** Join a child's final assistant output to text. */
  outputText(events: readonly SessionEvent[]): string | undefined {
    const blocks = finalAssistantOutput(events)
    if (blocks === undefined || blocks.length === 0) return undefined
    const text = blocks.map(block => (block.type === 'text' ? block.text : '')).join('').trim()
    return text.length === 0 ? undefined : text
  }

  /**
   * Append the current roster as a `vibe/workers` whole-value event — on the
   * DIRECTOR session (the projection's home) and on every live worker session
   * (mirror), so the client dock can show the roster (and its
   * "返回主会话" affordance) while a worker session is current.
   */
  private emitRoster(): void {
    if (this.disposed) return
    const payload = { workers: this.workersView() }
    try {
      this.director.session.append('vibe/workers', payload)
    } catch (error) {
      this.ctx.logger.warn('dsh-vibe-mode: failed to append vibe/workers to the director session: %o', error)
    }
    for (const record of this.workers.values()) {
      const session = childSession(this.ctx, record.childId)
      if (session === undefined) continue
      try {
        session.append('vibe/workers', payload)
      } catch (error) {
        this.ctx.logger.warn('dsh-vibe-mode: failed to append vibe/workers to worker session %s: %o', record.childId, error)
      }
    }
  }

  /** The wire rows of the current roster, in spawn order. */
  private workersView(): VibeWorkerView[] {
    return [...this.workers.values()].map(record => ({
      id: record.childId,
      name: record.label,
      tier: record.tier,
      state: record.state,
      turn: record.lastTurn,
      ...record.lastActivity === undefined ? {} : { lastActivity: record.lastActivity },
    }))
  }

  /** Dispose the registry: emit the final roster (mode exit), then reject nothing further (no waits can arrive). */
  dispose(): void {
    if (this.disposed) return
    this.emitRoster()
    this.disposed = true
    this.disposeListeners()
    this.workers.clear()
    this.waiters.clear()
    this.deliveredTurns.clear()
  }
}

/**
 * Read the child's live session events for output extraction. Prefers the
 * live agent's session; falls back to the session store when mounted.
 */
export function childSessionEvents(ctx: Context, childId: SessionId): readonly SessionEvent[] | undefined {
  const agent = ctx.get('agents')?.get(childId)
  if (agent !== undefined) return agent.session.events
  const sessions = ctx.get('sessions')
  const session = sessions?.get(childId)
  return session?.events
}

/** Read the child's live Session for roster mirror appends. */
function childSession(ctx: Context, childId: SessionId): Session | undefined {
  const agent = ctx.get('agents')?.get(childId)
  if (agent !== undefined) return agent.session
  const sessions = ctx.get('sessions')
  return sessions?.get(childId)
}

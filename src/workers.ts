/**
 * Per-director worker bookkeeping for vibe mode: childId → tier/turn counters
 * and the turn-end promise table `vibe_wait` resolves against.
 *
 * A continuable child produces NO jobs; `agent/status` idle is not a
 * turn-end signal and `subagent/end` is epoch-granular. The only turn-precise
 * signal is the child session's own `turn/end` log event, paired with the
 * turn counter this registry maintains per dispatch (spawn = one turn, each
 * followup = the next FIFO turn).
 *
 * @module @dsh-plugin/dsh-vibe-mode/workers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type { VibeTier } from './types.ts'

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
}

/** One pending `vibe_wait` outcome. */
export interface TurnEndResult {
  readonly session: SessionId
  /** The turn number that ended. */
  readonly turn: number
  /** The child's final assistant output text, or undefined when it logged none. */
  readonly output: string | undefined
  readonly status: 'completed' | 'timeout' | 'aborted' | 'disposed'
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
 * that routes `turn/end` to waiting `vibe_wait` calls, and the consecutive
 * settle-wake budget that mirrors `tool-jobs`' `maxConsecutiveWakes`.
 */
export class WorkerRegistry {
  /** Workers by child id, in spawn order. */
  private readonly workers = new Map<SessionId, WorkerRecord>()
  /** Turn-end waiters keyed by child id, then by target turn. */
  private readonly waiters = new Map<SessionId, Map<number, Array<() => void>>>()
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
      if (event.type !== 'turn/end') return
      this.onTurnEnd(session.id, event.data.turn)
    })
    // User input resets the wake budget; a settle notice spends it. The
    // continuation manager's settle notice is the only wake we cannot block
    // from a plugin, so we bound what the woken director may DO next.
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

  /** Whether the wake budget is exhausted (spawn refusal gate). */
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
    }
    this.workers.set(childId, record)
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
      return existing
    }
    const record: WorkerRecord = {
      childId,
      tier: 'good',
      label: 'vibe worker',
      lastTurn: liveEvents === undefined ? 1 : completedTurnsOf(liveEvents) + 1,
      dispatched: 1,
    }
    this.workers.set(childId, record)
    return record
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
        resolve({ session: childId, turn, output: this.outputText(readEvents() ?? []), status: 'completed' })
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
      const settle = (): void => finish({
        session: childId,
        turn,
        output: this.outputText(readEvents() ?? []),
        status: 'completed',
      })
      this.addWaiter(childId, turn, settle)
      const timer = setTimeout(() => {
        finish({ session: childId, turn, output: undefined, status: 'timeout' })
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

  /** Resolve every waiter for one completed turn. */
  private onTurnEnd(childId: SessionId, turn: number): void {
    if (this.disposed) return
    const byTurn = this.waiters.get(childId)
    const waiters = byTurn?.get(turn)
    if (waiters === undefined || waiters.length === 0) return
    const snapshot = [...waiters]
    byTurn!.delete(turn)
    if (byTurn?.size === 0) this.waiters.delete(childId)
    for (const settle of snapshot) settle()
  }

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

  /** Dispose the registry and reject nothing further (no waits can arrive). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeListeners()
    this.workers.clear()
    this.waiters.clear()
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

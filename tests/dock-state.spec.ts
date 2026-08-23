/**
 * Worker dock presentational rules (react-free derivation): the "waiting for
 * worker" cue fact and the "隐藏已完成" filter — the pieces the user asked to
 * fold into the dock so the main session reads as NOT blocked while a worker
 * runs.
 */

import { describe, expect, it } from 'vitest'
import { hasRunningWorker, visibleWorkers } from '../client/src/dock/dock-state.ts'
import type { VibeWorkerView } from '../src/types.ts'

function worker(over: Partial<VibeWorkerView>): VibeWorkerView {
  return { id: 'w', name: 'w', tier: 'fast', state: 'idle', turn: 1, ...over }
}

describe('dock state', () => {
  it('hasRunningWorker is true only while at least one worker runs (the waiting cue)', () => {
    expect(hasRunningWorker([worker({ state: 'idle' }), worker({ state: 'parked' })])).toBe(false)
    expect(hasRunningWorker([worker({ state: 'starting' }), worker({ state: 'running' })])).toBe(true)
    expect(hasRunningWorker([worker({ state: 'running', turn: 2 })])).toBe(true)
    expect(hasRunningWorker([])).toBe(false)
  })

  it('visibleWorkers hides dead rows under the default 隐藏已完成 filter and keeps every other state', () => {
    const roster = [
      worker({ id: 'a', state: 'starting' }),
      worker({ id: 'b', state: 'running' }),
      worker({ id: 'c', state: 'idle' }),
      worker({ id: 'd', state: 'parked' }),
      worker({ id: 'e', state: 'dead' }),
    ]
    expect(visibleWorkers(roster, true).map(w => w.id)).toEqual(['a', 'b', 'c', 'd'])
    // Toggled off: everything shows.
    expect(visibleWorkers(roster, false).map(w => w.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    // Empty roster renders nothing either way.
    expect(visibleWorkers([], true)).toEqual([])
  })
})

/**
 * Worker dock presentational rules (react-free derivation): the "waiting for
 * worker" cue fact and the "隐藏已完成" filter — the pieces the user asked to
 * fold into the dock so the main session reads as NOT blocked while a worker
 * runs.
 */

import { dockPresentation, hasRunningWorker, visibleWorkers } from '../client/src/dock/dock-state.ts'
import { describe, expect, it } from 'vitest'
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

  it('dockPresentation: no roster renders nothing; the default collapse is a header-only slim bar', () => {
    const roster = [
      worker({ id: 'a', state: 'starting' }),
      worker({ id: 'b', state: 'running' }),
      worker({ id: 'e', state: 'dead' }),
    ]
    // No workers -> render nothing (no vertical space).
    expect(dockPresentation([], true, true)).toEqual({ render: false, headerOnly: false, rows: [] })
    // Default collapse: header-only, rows hidden.
    const collapsed = dockPresentation(roster, true, true)
    expect(collapsed).toEqual({ render: true, headerOnly: true, rows: [] })
    // Expanded: rows under the 隐藏已完成 filter (dead row hidden behind the header-only state).
    const expanded = dockPresentation(roster, true, false)
    expect(expanded).toEqual({ render: true, headerOnly: false, rows: [worker({ id: 'a', state: 'starting' }), worker({ id: 'b', state: 'running' })] })
  })
})

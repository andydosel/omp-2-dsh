/**
 * DIRECTOR (vibe) mode for dsh: the main agent becomes a director with a
 * narrowed read-only toolset plus five worker-control tools (`vibe_spawn`,
 * `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`); workers are real
 * persisted continuable subagent sessions. `/vibe` toggles the mode;
 * `/vibe off` parks workers (interrupt), `/vibe off --terminate` hard-destroys
 * the worker forest (drain).
 *
 * The mode state is logged as `vibe/mode` (fold-recoverable, plan-mode
 * pattern). The DIRECTOR narrowing is scoped to the director's `agent.ctx`
 * and applied at mode entry, so only that agent sees the narrowed catalog.
 *
 * @module @dsh-plugin/dsh-vibe-mode
 */

import VibeModeController from './mode.ts'
import { foldVibeMode } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whether DIRECTOR mode is in force from this point on: log-only,
     * non-surface, whole-value replace. The last `vibe/mode` wins; a log with
     * none folds to inactive through {@link foldVibeMode}.
     */
    'vibe/mode': { active: boolean }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    vibeMode: VibeModeController
  }
}

export { VibeModeController, VibeModeConflictError } from './mode.ts'
export { applyDirectorScope, DIRECTOR_SECTION_NAME, DIRECTOR_SECTION_ORDER } from './director.ts'
export { WorkerRegistry, type TurnEndResult, type WorkerRecord } from './workers.ts'
export * from './types.ts'

export default VibeModeController

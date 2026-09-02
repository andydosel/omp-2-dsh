/**
 * DIRECTOR (vibe) mode for dsh: the main agent becomes a director with a
 * narrowed read-only toolset plus five worker-control tools (`vibe_spawn`,
 * `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`); workers are real
 * persisted continuable subagent sessions. `/vibe` toggles the mode;
 * `/vibe off` parks workers (interrupt), `/vibe off --terminate` hard-destroys
 * the worker forest (drain), `/vibe restore` re-applies a saved runtime scope.
 *
 * The mode state is plugin-owned (a persisted JSON snapshot) rather than a
 * session event: the active flag and worker roster live in the store, the
 * DIRECTOR narrowing is scoped to the director's `agent.ctx` and applied at
 * mode entry, so only that agent sees the narrowed catalog.
 *
 * @module @dsh-plugin/dsh-vibe-mode
 */

import VibeModeController from './mode.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    vibeMode: VibeModeController
  }
}

export { VibeModeController, VibeModeConflictError } from './mode.ts'
export {
  applyDirectorScope,
  DIRECTOR_SECTION_NAME,
  DIRECTOR_SECTION_ORDER,
  DIRECTOR_TOOL_GUIDANCE_NAME,
  DIRECTOR_TOOL_GUIDANCE_ORDER,
} from './director.ts'
export { WorkerRegistry, type TurnEndResult, type WorkerRecord } from './workers.ts'
export { VibeModeStore, type VibeSessionState } from './state-store.ts'
export * from './types.ts'
export default VibeModeController

/**
 * Review-gate plugin configuration: load-time schema (schemastery), validation,
 * and the detached resolved shape the runtime consumes.
 *
 * @module @dsh-plugin/dsh-review-gate/config
 */

import z from '@deepseek-ai/schemastery'

/** Default protected globs — the real source tree of a typical JS/TS project. */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = ['**/src/**', '**/*.ts', '**/*.tsx']

/** Default planning scratch area (relative to the session workspace). */
export const DEFAULT_SCRATCH_DIR = '.dsh-plans'

/** Whether an unflagged task starts behind the write fence. */
export type GatePolicy = 'off' | 'on'

/** Sandbox mode forced on a gated session, or `''` to leave the session policy alone. */
export type DraftSandboxMode = '' | 'read-only' | 'workspace-write' | 'danger-full-access'

/** Raw (user-written) review-gate configuration. All fields optional. */
export interface ReviewGateConfig {
  /**
   * Globs of "real source" — `write`/`edit` targeting a match is fenced while a
   * task awaits plan approval. Defaults to {@link DEFAULT_PROTECTED_PATHS}.
   */
  protectedPaths?: string[]
  /**
   * Planning scratch area. Writes under it always pass the fence, so the plan
   * itself can be drafted on disk. Defaults to {@link DEFAULT_SCRATCH_DIR}.
   */
  scratchDir?: string
  /**
   * Gate state for a task that carried no flag: `'off'` (default) executes
   * freely, `'on'` starts every task behind the fence until the user approves
   * or sends `--no-review`.
   */
  defaultPolicy?: GatePolicy
  /**
   * Sandbox mode forced on the session while the fence is closed (the `bash`
   * surface has no path-level fence — see the module docs of `src/index.ts`).
   * The gate only ever TIGHTENS: a session already at or below this mode keeps
   * its own mode. `''` disables the transition entirely.
   *
   * @default 'workspace-write'
   */
  draftSandboxMode?: DraftSandboxMode
}

/** Detached, validated configuration consumed by the runtime. */
export interface ResolvedReviewGateConfig {
  readonly protectedPaths: readonly string[]
  readonly scratchDir: string
  readonly defaultPolicy: GatePolicy
  readonly draftSandboxMode: DraftSandboxMode
}

/** Every accepted top-level key; anything else fails plugin load. */
const CONFIG_KEYS: readonly string[] = [
  'protectedPaths',
  'scratchDir',
  'defaultPolicy',
  'draftSandboxMode',
]

/** Schema of the review-gate plugin configuration. */
export const Config = z.object({
  protectedPaths: z.array(z.string()).default([...DEFAULT_PROTECTED_PATHS]),
  scratchDir: z.string().default(DEFAULT_SCRATCH_DIR),
  defaultPolicy: z.union(['off', 'on'] as const).default('off'),
  draftSandboxMode: z
    .union(['', 'read-only', 'workspace-write', 'danger-full-access'] as const)
    .default('workspace-write'),
})

/**
 * Validate raw configuration and return a detached resolved copy. Unknown keys
 * and invalid values fail at plugin load rather than silently degrading the
 * fence.
 * @param config - raw plugin config.
 * @returns the validated configuration with defaults applied.
 */
export function resolveConfig(config: ReviewGateConfig = {}): ResolvedReviewGateConfig {
  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `ReviewGateConfig has unknown key(s) ${unknown.join(', ')} — config is { protectedPaths, scratchDir, defaultPolicy, draftSandboxMode }`,
    )
  }
  const raw = Config(config)
  const protectedPaths = raw.protectedPaths ?? [...DEFAULT_PROTECTED_PATHS]
  const scratchDir = raw.scratchDir ?? DEFAULT_SCRATCH_DIR
  const defaultPolicy = raw.defaultPolicy ?? 'off'
  const draftSandboxMode = raw.draftSandboxMode ?? 'workspace-write'
  if (defaultPolicy !== 'off' && defaultPolicy !== 'on') {
    throw new Error(`ReviewGateConfig.defaultPolicy must be 'off' or 'on', got ${String(defaultPolicy)}`)
  }
  if (protectedPaths.length === 0) {
    throw new Error('ReviewGateConfig.protectedPaths must name at least one glob')
  }
  for (const pattern of protectedPaths) {
    if (pattern.trim() === '') {
      throw new Error('ReviewGateConfig.protectedPaths entries must be non-empty globs')
    }
  }
  if (scratchDir.trim() === '') {
    throw new Error('ReviewGateConfig.scratchDir must be a non-empty path')
  }
  return Object.freeze({
    protectedPaths: Object.freeze([...protectedPaths]),
    scratchDir,
    defaultPolicy,
    draftSandboxMode,
  })
}

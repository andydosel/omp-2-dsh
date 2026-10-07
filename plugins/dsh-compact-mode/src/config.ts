/**
 * Load-time validation for the compact-mode plugin configuration.
 *
 * Mirrors compaction-basic's strict key validation: unknown keys are rejected
 * before defaults can hide them, and every field from the design (§2.9) is
 * validated to its documented domain.
 *
 * @module @dsh-plugin/dsh-compact-mode/config
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'

/** Default request-pressure fraction that prompts entering compact mode. */
const DEFAULT_THRESHOLD_RATIO = 0.6

/** Default recent-context tail protected verbatim during shake. */
const DEFAULT_KEEP_RECENT_TOKENS = 20000

/** Default minimum savings fraction before shake lands replacements. */
const DEFAULT_MIN_SHAKE_SAVINGS_RATIO = 0.05

/** Default provider generation cap for revision calls. */
const DEFAULT_MAX_TOKENS = 8192

/** Default review-tree storage route. */
const DEFAULT_REVIEW_TREE: CompactModeConfig['reviewTree'] = 'domain'

/** Every accepted top-level key; anything else fails plugin load. */
const COMPACT_MODE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thresholdRatio',
  'keepRecentTokens',
  'minShakeSavingsRatio',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'promptOnThreshold',
  'promptCooldown',
  'promptOnHardOverflow',
  'reviewTimeoutMs',
  'auto',
  'reviewTree',
  'readOnlyTools',
])

/**
 * Plugin configuration for the compact-mode backend. All fields carry the
 * documented defaults from IMPLEMENTATION-COMPACT-VIBE.md §2.9.
 */
export interface CompactModeConfig {
  /** Shake-then-prompt threshold: after shake, above this fraction prompts entering compact mode. Defaults to `0.6`. */
  thresholdRatio: number
  /** Recent-context tail (tokens) protected verbatim during shake. Defaults to `20000`. */
  keepRecentTokens: number
  /** Minimum savings fraction before shake lands replacements (anti-thrash). Defaults to `0.05`. */
  minShakeSavingsRatio: number
  /** Revision-call provider; empty inherits the latest routed request. */
  summarizationProvider: string
  /** Revision-call model; set together with the provider. */
  summarizationModel: string
  /** Provider generation cap for revision calls. Defaults to `8192`. */
  maxTokens: number
  /** Emit the 60% notice prompt after shake exceeds the threshold. Defaults to `true`. */
  promptOnThreshold: boolean
  /** Notice cooldown in ms; `0` = once per session per threshold kind. Defaults to `0`. */
  promptCooldown: number
  /** Emit the hard-overflow notice prompt. Defaults to `true`. */
  promptOnHardOverflow: boolean
  /** Review timeout in ms; `0` = the review never times out. Defaults to `0`. */
  reviewTimeoutMs: number
  /** Register automatic pressure/overflow listeners. Defaults to `true`. */
  auto: boolean
  /** Review-tree persistence route: `'domain'` (preferred) or `'file'` (plugin-owned JSON). Defaults to `'domain'`. */
  reviewTree: 'domain' | 'file'
  /**
   * Accepted for profile compatibility only; compact-mode does not use it.
   * Released profile overlays (and profile configs already installed under
   * `~/.dsh/dsh-suite/`) carry this key, and unknown keys are rejected at
   * load, so the field must stay accepted even though it is inert.
   */
  readOnlyTools: string[]
}

/** Detached immutable validated configuration. */
export type ResolvedConfig = Readonly<CompactModeConfig>

const thresholdRatioSchema = z.number()
const keepRecentTokensSchema = z.number().step(1).min(0)
const minShakeSavingsRatioSchema = z.number()
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const promptOnThresholdSchema = z.boolean()
const promptCooldownSchema = z.number().step(1).min(0)
const promptOnHardOverflowSchema = z.boolean()
const reviewTimeoutMsSchema = z.number().step(1).min(0)
const autoSchema = z.boolean()
const reviewTreeSchema = z.union([z.const('domain'), z.const('file')])
const readOnlyToolsSchema = z.array(z.string())

/**
 * Plugin Config schema (schemastery). The loader validates untrusted config
 * against this before the engine constructor runs.
 */
export const CompactModeConfigSchema: z<CompactModeConfig> = z.object({
  thresholdRatio: thresholdRatioSchema,
  keepRecentTokens: keepRecentTokensSchema,
  minShakeSavingsRatio: minShakeSavingsRatioSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  promptOnThreshold: promptOnThresholdSchema,
  promptCooldown: promptCooldownSchema,
  promptOnHardOverflow: promptOnHardOverflowSchema,
  reviewTimeoutMs: reviewTimeoutMsSchema,
  auto: autoSchema,
  reviewTree: reviewTreeSchema,
  readOnlyTools: readOnlyToolsSchema,
})

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`CompactModeConfig: ${name} must be a finite number`)
  }
}

function assertNonNegativeInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`CompactModeConfig: ${name} must be a non-negative integer`)
  }
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`CompactModeConfig: ${name} must be a positive integer`)
  }
}

function assertString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error(`CompactModeConfig: ${name} must be a string`)
}

function assertBoolean(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`CompactModeConfig: ${name} must be a boolean`)
}

function assertStringArray(name: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`CompactModeConfig: ${name} must be an array of strings`)
  }
}

function validateKeys(config: object, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) {
      throw new Error(`${name}: unknown key "${key}" (supported: ${[...keys].join(', ')})`)
    }
  }
}

/**
 * Resolve and validate untrusted plugin configuration after loader
 * normalization. Unknown keys are rejected; documented defaults fill the rest.
 *
 * @param config - raw plugin config (all fields optional; defaults apply).
 * @returns detached immutable resolved config.
 */
export function resolveConfig(config: Partial<CompactModeConfig> = {}): ResolvedConfig {
  if (!isUnknownRecord(config)) {
    throw new Error('CompactModeConfig must be a plain object')
  }
  validateKeys(config, COMPACT_MODE_CONFIG_KEYS, 'CompactModeConfig')

  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  assertRatio('thresholdRatio', thresholdRatio)
  const keepRecentTokens = config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS
  assertNonNegativeInteger('keepRecentTokens', keepRecentTokens)
  const minShakeSavingsRatio = config.minShakeSavingsRatio ?? DEFAULT_MIN_SHAKE_SAVINGS_RATIO
  assertRatio('minShakeSavingsRatio', minShakeSavingsRatio)
  const summarizationProvider = config.summarizationProvider ?? ''
  assertString('summarizationProvider', summarizationProvider)
  const summarizationModel = config.summarizationModel ?? ''
  assertString('summarizationModel', summarizationModel)
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  assertPositiveInteger('maxTokens', maxTokens)
  const promptOnThreshold = config.promptOnThreshold ?? true
  assertBoolean('promptOnThreshold', promptOnThreshold)
  const promptCooldown = config.promptCooldown ?? 0
  assertNonNegativeInteger('promptCooldown', promptCooldown)
  const promptOnHardOverflow = config.promptOnHardOverflow ?? true
  assertBoolean('promptOnHardOverflow', promptOnHardOverflow)
  const reviewTimeoutMs = config.reviewTimeoutMs ?? 0
  assertNonNegativeInteger('reviewTimeoutMs', reviewTimeoutMs)
  const auto = config.auto ?? true
  assertBoolean('auto', auto)
  const reviewTree = config.reviewTree ?? DEFAULT_REVIEW_TREE
  if (reviewTree !== 'domain' && reviewTree !== 'file') {
    throw new Error(`CompactModeConfig: reviewTree must be 'domain' or 'file'`)
  }
  const readOnlyTools = config.readOnlyTools ?? []
  assertStringArray('readOnlyTools', readOnlyTools)

  return deepFreeze({
    thresholdRatio,
    keepRecentTokens,
    minShakeSavingsRatio,
    summarizationProvider,
    summarizationModel,
    maxTokens,
    promptOnThreshold,
    promptCooldown,
    promptOnHardOverflow,
    reviewTimeoutMs,
    auto,
    reviewTree,
    readOnlyTools,
  } satisfies CompactModeConfig) as ResolvedConfig
}

/** Export a structural placeholder so the reserved field stays typed. */
export type { ToolSchema }

/**
 * WATCHDOG discovery and parsing: user-level + project-level upward walk for
 * `WATCHDOG.md` / `WATCHDOG.yml` (omp naming), roster schema validation, and
 * rendering of guidance into reviewer-prompt `<attention>` blocks.
 *
 * Discovery copies the walk of `@deepseek-ai/dsh-agent-instructions` — the
 * nearest project-level file wins per kind, falling back to the user-level
 * file — but nothing is ever injected into the primary transcript: loaded
 * content reaches only the reviewer's prompt.
 *
 * @module @dsh-plugin/dsh-advisor/watchdog
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'

/** WATCHDOG markdown guidance file name (omp naming). */
export const WATCHDOG_MD = 'WATCHDOG.md'
/** WATCHDOG roster file name (omp naming). */
export const WATCHDOG_YML = 'WATCHDOG.yml'
/** Bound on a single WATCHDOG file read (256 KiB). */
export const MAX_WATCHDOG_BYTES = 256 * 1024

/** File-system surface the discovery uses; defaults to node:fs. */
export interface WatchdogFileSystem {
  /** Whether a path exists at all (file, directory, or link). */
  exists(path: string): Promise<boolean>
  /**
   * Read a UTF-8 text file, or `undefined` when the path is absent, not a
   * regular file, or larger than `maxBytes`.
   */
  readTextFile(path: string, maxBytes?: number): Promise<string | undefined>
}

/** Node:fs implementation of {@link WatchdogFileSystem}. */
export const nodeWatchdogFileSystem: WatchdogFileSystem = {
  async exists(path) {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
  async readTextFile(path, maxBytes = MAX_WATCHDOG_BYTES) {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > maxBytes) return undefined
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  },
}

/** One validated WATCHDOG.yml roster entry. */
export interface WatchdogRosterEntry {
  readonly name: string
  readonly enabled: boolean
  /** Model override; undefined = follow the primary agent's route. */
  readonly model?: string
  /** Tool allow-list; undefined = the plugin default tool set. */
  readonly tools?: readonly string[]
  /** Reviewer-specific instructions appended to the role section. */
  readonly instructions?: string
}

/** A parsed and validated WATCHDOG.yml roster. */
export interface WatchdogRoster {
  readonly entries: readonly WatchdogRosterEntry[]
  /** Shared top-level instructions, prepended to every entry's instructions. */
  readonly sharedInstructions?: string
}

/** A loaded WATCHDOG.md guidance file. */
export interface WatchdogMdFile {
  readonly path: string
  readonly content: string
}

/** Everything discovery found for one session workspace. */
export interface WatchdogSource {
  /** The winning markdown guidance file (nearest project-level, else user-level). */
  readonly md?: WatchdogMdFile
  /** The winning roster file (nearest project-level, else user-level). */
  readonly roster?: { path: string } & WatchdogRoster
}

/** Discovery inputs. */
export interface WatchdogDiscoveryOptions {
  /** Absolute session working directory where the walk begins. */
  readonly cwd: string
  /** User-level directory; empty = `$DSH_HOME`, then the home directory. */
  readonly userDir?: string
  /** Directory child names that identify a project root (default `['.git']`). */
  readonly projectMarkers?: readonly string[]
  /** Optional file-system provider (defaults to node:fs). */
  readonly fileSystem?: WatchdogFileSystem
}

/** Resolve the user-level directory. */
function resolveUserDir(userDir: string | undefined): string {
  if (userDir !== undefined && userDir !== '') return resolve(userDir)
  const dshHome = process.env.DSH_HOME
  return dshHome !== undefined && dshHome !== '' ? resolve(dshHome) : homedir()
}

/** Whether a path has a project root marker. */
async function hasMarker(dir: string, markers: readonly string[], fs: WatchdogFileSystem): Promise<boolean> {
  for (const marker of markers) {
    if (marker === '') continue
    if (await fs.exists(join(dir, marker))) return true
  }
  return false
}

/** Walk from `cwd` upward, nearest directory first, until a project root marker stops the walk. */
async function walkProjectLevels(
  cwd: string,
  markers: readonly string[],
  fs: WatchdogFileSystem,
): Promise<readonly string[]> {
  const dirs: string[] = []
  let current = resolve(cwd)
  for (;;) {
    dirs.push(current)
    if (await hasMarker(current, markers, fs)) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

/** Load one file kind from a directory list, nearest directory first. */
async function loadFirst(
  dirs: readonly string[],
  fileName: string,
  fs: WatchdogFileSystem,
): Promise<WatchdogMdFile | undefined> {
  for (const dir of dirs) {
    const path = join(dir, fileName)
    const content = await fs.readTextFile(path)
    if (content !== undefined) return { path, content }
  }
  return undefined
}

/** Schema of one roster entry. Unknown keys are ignored; required fields fail. */
const RosterEntrySchema = z.object({
  name: z.string().required(),
  enabled: z.boolean().default(true),
  model: z.string(),
  tools: z.array(z.string()),
  instructions: z.string(),
})

/** Schema of the object form (`{ instructions?, roster: [...] }`). */
const RosterObjectSchema = z.object({
  roster: z.array(RosterEntrySchema).required(),
  instructions: z.string(),
})

function normalizeEntry(raw: unknown, index: number): WatchdogRosterEntry {
  const entry = RosterEntrySchema(raw as never)
  if (entry.name.trim() === '') {
    throw new Error(`WATCHDOG.yml roster entry ${index}: name must be non-empty`)
  }
  return {
    name: entry.name,
    enabled: entry.enabled,
    ...entry.model !== undefined ? { model: entry.model } : {},
    ...entry.tools !== undefined && entry.tools.length > 0 ? { tools: [...entry.tools] } : {},
    ...entry.instructions !== undefined ? { instructions: entry.instructions } : {},
  }
}

/**
 * Parse and schema-validate WATCHDOG.yml content. Accepts either a bare list
 * of entries or `{ instructions?, roster: [...] }` with shared instructions
 * prepended to every entry.
 * @param content - raw YAML text.
 * @param sourcePath - the file path, used in error messages.
 * @returns the validated roster.
 * @throws when the YAML is malformed or an entry violates the schema.
 */
export function parseWatchdogYml(content: string, sourcePath: string): WatchdogRoster {
  let parsed: unknown
  try {
    parsed = yaml.load(content)
  } catch (error) {
    throw new Error(`WATCHDOG.yml ${sourcePath}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (Array.isArray(parsed)) {
    return { entries: parsed.map((entry, index) => normalizeEntry(entry, index)) }
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const object = RosterObjectSchema(parsed as never)
    return {
      entries: object.roster.map((entry, index) => normalizeEntry(entry, index)),
      ...object.instructions !== undefined ? { sharedInstructions: object.instructions } : {},
    }
  }
  throw new Error(`WATCHDOG.yml ${sourcePath}: expected a roster list or an object with a "roster" list`)
}

/**
 * Discover WATCHDOG files for one session workspace. The project-level walk
 * runs from `cwd` upward to the nearest directory containing a project
 * marker; without any marker it walks to the filesystem root. Per kind
 * (`WATCHDOG.md` / `WATCHDOG.yml`) the nearest project-level file wins,
 * falling back to the user-level file.
 * @param options - discovery inputs.
 * @returns the loaded sources (undefined per kind when nothing was found).
 */
export async function discoverWatchdog(options: WatchdogDiscoveryOptions): Promise<WatchdogSource> {
  const fs = options.fileSystem ?? nodeWatchdogFileSystem
  const markers = options.projectMarkers !== undefined && options.projectMarkers.length > 0
    ? options.projectMarkers
    : ['.git']
  const userDir = resolveUserDir(options.userDir)
  const dirs = await walkProjectLevels(options.cwd, markers, fs)

  const projectMd = await loadFirst(dirs, WATCHDOG_MD, fs)
  const projectYml = await loadFirst(dirs, WATCHDOG_YML, fs)
  const userMd = await loadFirst([userDir], WATCHDOG_MD, fs)
  const userYml = await loadFirst([userDir], WATCHDOG_YML, fs)

  const md = projectMd ?? userMd
  const ymlFile = projectYml ?? userYml
  return {
    ...md !== undefined ? { md } : {},
    ...ymlFile !== undefined
      ? { roster: { path: ymlFile.path, ...parseWatchdogYml(ymlFile.content, ymlFile.path) } }
      : {},
  }
}

/**
 * Render discovered markdown guidance into `<attention>` blocks for the
 * reviewer's system prompt.
 * @param source - the discovery result.
 * @returns the attention-block text, or `''` with no markdown guidance.
 */
export function renderWatchdogGuidance(source: WatchdogSource): string {
  if (source.md === undefined) return ''
  const display = isAbsolute(source.md.path) ? source.md.path : resolve(source.md.path)
  return `<attention source="${display.replace(/</g, '&lt;')}">\n${source.md.content}\n</attention>`
}

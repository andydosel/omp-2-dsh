/**
 * Test harness: a fake `ctx.fs` over a temp directory plus a minimal plugin
 * `Context` (waterfall/emit spies, tool-definition capture, stub services) and
 * a minimal `ToolRunContext`. Also a tiny fs-observation policy mirroring
 * `fs-observation-policy`, so the fs/* event linkage is tested end to end
 * without a Cordis host or API keys.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsEditOutcome, FsInfo, FsObservation, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** A fake ctx.fs provider backed by a temp directory (with a CAS writeText/editText). */
export class HarnessFs {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  get sandboxMode(): undefined {
    return undefined
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const abs = resolve(opts?.cwd ?? this.root, path)
    return { targetKey: FsTargetKey(abs), displayPath: abs }
  }

  async stat(target: FsTarget): Promise<FsInfo | undefined> {
    try {
      const s = await stat(target.displayPath)
      return {
        version: FsVersion(`v${s.size}:${s.mtimeMs}`),
        type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other',
        size: s.size,
      }
    } catch {
      return undefined
    }
  }

  async readText(target: FsTarget): Promise<string> {
    return readFile(target.displayPath, 'utf8')
  }

  async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    return [await this.readText(target)]
  }

  async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const data = await readFile(target.displayPath)
    if (data.length > maxBytes) throw new FsError('read exceeds the byte cap', 'FS_TOO_LARGE')
    return new Uint8Array(data)
  }

  async listDir(target: FsTarget): Promise<Array<{ name: string; type: 'file' | 'directory' | 'other'; target: FsTarget; size?: number }>> {
    const entries = await readdir(target.displayPath, { withFileTypes: true })
    return entries
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))
      .map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: { targetKey: FsTargetKey(join(target.displayPath, entry.name)), displayPath: join(target.displayPath, entry.name) },
      }))
  }

  async writeText(target: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    if (expected !== undefined) {
      const current = await this.stat(target)
      if (expected.kind === 'createIfAbsent' && current !== undefined) {
        throw new FsError('target already exists', 'FS_NOT_OBSERVED')
      }
      if (expected.kind === 'replaceIfVersion' && (current === undefined || current.version !== expected.version)) {
        throw new FsError('target changed since it was observed', 'FS_STALE_VERSION')
      }
    }
    const before = (await this.stat(target)) !== undefined ? await this.readText(target) : null
    await mkdir(dirname(target.displayPath), { recursive: true })
    await writeFile(target.displayPath, content, 'utf8')
    const after = await this.stat(target)
    return { operation: before === null ? 'create' : 'update', version: after!.version, before, after: content }
  }

  async editText(target: FsTarget, edit: { oldString: string; newString: string; replaceAll: boolean }, expected?: { version: unknown }): Promise<FsEditOutcome> {
    if (expected !== undefined) {
      const current = await this.stat(target)
      if (current === undefined || current.version !== expected.version) {
        throw new FsError('target changed since it was observed', 'FS_STALE_VERSION')
      }
    }
    const before = await this.readText(target)
    const matches = before.split(edit.oldString).length - 1
    if (matches === 0) throw new FsError('old_string not found', 'FS_EDIT_NOT_FOUND')
    if (!edit.replaceAll && matches > 1) throw new FsError('old_string is ambiguous', 'FS_AMBIGUOUS_EDIT')
    const after = edit.replaceAll
      ? before.split(edit.oldString).join(edit.newString)
      : before.replace(edit.oldString, edit.newString)
    await writeFile(target.displayPath, after, 'utf8')
    const info = await this.stat(target)
    return { version: info!.version, before, after }
  }

  processPath(target: FsTarget): string {
    return target.displayPath
  }

  fileUrl(target: FsTarget): string {
    return `file://${target.displayPath}`
  }

  contains(_parent: FsTarget, _child: FsTarget): boolean {
    return false
  }

  async lstat(_path: string): Promise<undefined> {
    return undefined
  }
}

/** A tiny fs-observation policy: read → present/absent record → guarded write/edit intents. */
export class ObservationPolicy {
  readonly observed = new Map<string, { kind: 'present' | 'absent'; version?: string }>()

  record(target: FsTarget, observation: FsObservation): void {
    this.observed.set(target.targetKey, {
      kind: observation.kind,
      ...'version' in observation ? { version: observation.version } : {},
    })
  }

  writeIntent(target: FsTarget, next: () => unknown): unknown {
    const obs = this.observed.get(target.targetKey)
    if (obs === undefined) throw new FsError('not observed', 'FS_NOT_OBSERVED')
    if (obs.kind === 'absent') return { kind: 'createIfAbsent' }
    return { kind: 'replaceIfVersion', version: obs.version }
  }

  editIntent(target: FsTarget, next: () => unknown): unknown {
    const obs = this.observed.get(target.targetKey)
    if (obs === undefined || obs.kind !== 'present') throw new FsError('not observed', 'FS_NOT_OBSERVED')
    return { version: obs.version }
  }
}

/** A fake plugin Context: fs + waterfall/emit spies + captured tool definitions. */
export class HarnessCtx {
  readonly fs: HarnessFs
  readonly observed: unknown[] = []
  readonly waterfallCalls: Array<{ event: string; args: unknown[] }> = []
  readonly registered: ToolDefinition[] = []
  readonly services = new Map<string, unknown>()
  private readonly waterfallHandlers = new Map<string, (...args: unknown[]) => unknown>()
  private readonly policy: ObservationPolicy | undefined

  constructor(fs: HarnessFs, policy?: ObservationPolicy) {
    this.fs = fs
    this.policy = policy
    if (policy !== undefined) {
      this.onWaterfall('fs/write-intent', (target, _exec, next) => policy.writeIntent(target as FsTarget, next as () => unknown))
      this.onWaterfall('fs/edit-intent', (target, _exec, next) => policy.editIntent(target as FsTarget, next as () => unknown))
    }
  }

  /** Register a single-slot waterfall handler (like fs-observation-policy would). */
  onWaterfall(event: string, handler: (...args: unknown[]) => unknown): void {
    this.waterfallHandlers.set(event, handler)
  }

  async waterfall(event: string, ...args: unknown[]): Promise<unknown> {
    this.waterfallCalls.push({ event, args })
    const handler = this.waterfallHandlers.get(event)
    if (handler !== undefined) return handler(...args)
    const next = args.at(-1) as () => unknown
    return next()
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === 'fs/observed') {
      this.observed.push(args)
      this.policy?.record(args[0] as FsTarget, args[1] as FsObservation)
    }
  }

  get(key: string): unknown {
    return this.services.get(key)
  }

  systemPrompt = {
    section: (): void => {},
    context: (): void => {},
  }

  tools = {
    register: (definition: ToolDefinition): (() => void) => {
      this.registered.push(definition)
      return () => {}
    },
  }

  inject = (): (() => void) => () => {}
}

/** A minimal ToolRunContext for direct definition.execute calls. */
export function makeExec(overrides?: Partial<ToolRunContext>): ToolRunContext {
  const controller = new AbortController()
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'tool',
    arguments: {},
    signal: controller.signal,
    token: Symbol('token'),
    deferContext: () => {},
    concludeTurn: () => {},
    ...overrides,
  } as unknown as ToolRunContext
}

/** Create a temp directory and return its absolute path. */
export async function tempDir(prefix = 'dsh-rw-test'): Promise<string> {
  return mkdir(join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`), { recursive: true })
}

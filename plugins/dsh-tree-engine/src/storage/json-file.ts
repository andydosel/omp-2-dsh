import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InvalidTreeError } from '../errors.js';
import type { SerializedTree, TreeStorage } from '../types/index.js';
import { parseSerialized } from '../validate.js';

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * JSON file {@link TreeStorage} with atomic writes: state is written to a
 * temporary file in the same directory and renamed over the target, so a
 * crashed/failed save never leaves a truncated file behind.
 *
 * - `load()` on a missing file returns an empty tree.
 * - `load()` on a corrupt file (invalid JSON or malformed shape) rejects
 *   with {@link InvalidTreeError}.
 */
export class JsonFileStorage<M = unknown> implements TreeStorage<M> {
  readonly filePath: string;

  constructor(filePath: string) {
    if (filePath.length === 0) throw new Error('JsonFileStorage: filePath must not be empty');
    this.filePath = filePath;
  }

  async load(): Promise<SerializedTree<M>> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (isENOENT(err)) return { nodes: [], labels: [], leafId: null, seq: 0 };
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new InvalidTreeError(`invalid JSON in ${this.filePath}: ${(err as Error).message}`, { cause: err });
    }
    return parseSerialized(parsed) as SerializedTree<M>;
  }

  async save(tree: SerializedTree<M>): Promise<void> {
    parseSerialized(tree as unknown); // never write malformed state
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(tree, null, 2), 'utf8');
    try {
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

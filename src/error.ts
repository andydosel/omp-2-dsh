/**
 * Model-facing remediation for guarded-mutation failures: append the correct
 * recovery instruction to `FS_STALE_VERSION` / `FS_NOT_OBSERVED` failures.
 * Faithful port of the upstream tool-fs helper.
 * @module dsh-tool-read-write/error
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'

/** The remedy appended to each remediable failure code's message. */
const REMEDIES: Partial<Record<FsErrorCode, string>> = {
  FS_STALE_VERSION: 're-read the file, then retry',
  FS_NOT_OBSERVED: 'read the file, then retry',
}

/**
 * Append the correct recovery instruction to a guarded-mutation failure's
 * message, preserving the `FsError` code and chaining the original as `cause`.
 * @param error - the caught value from a write/edit execution.
 * @returns a remediated `FsError` for the two guarded-mutation codes, else the original value.
 */
export function remediateFsError(error: unknown): unknown {
  if (!(error instanceof FsError)) return error
  const remedy = REMEDIES[error.code]
  if (!remedy) return error
  return new FsError(`${error.message} — ${remedy}`, error.code, { cause: error })
}

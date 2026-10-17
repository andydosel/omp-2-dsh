/**
 * One rendering of a thrown value for tool results and log lines.
 *
 * @module @dsh-plugin/dsh-util/error
 */

/**
 * Render one thrown value for a tool result or a log line.
 * @param error - anything a `catch` bound.
 * @returns the error message, or the value's string form.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The suite's one session-id normalizer: one place to brand the plain strings
 * that arrive from tool arguments, JSON configuration, and map keys.
 *
 * @module @dsh-plugin/dsh-util/session
 */

import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Brand a plain string, or pass an already-branded id through.
 * @param value - a branded `SessionId` or the raw wire string.
 * @returns the branded id.
 */
export function toSessionId(value: SessionId | string): SessionId {
  return SessionId(String(value))
}

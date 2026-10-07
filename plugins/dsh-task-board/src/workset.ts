/**
 * Work-set rendering: the bounded, extremely short task list injected into the
 * system prompt (§5.2). Only `inContext === true` tasks appear — the work set
 * is the coordinator's attention, not the board — and the byte budget keeps a
 * runaway board from eating the context (design §3.8).
 *
 * @module @dsh-plugin/dsh-task-board/workset
 */

import { isWorkSetMember } from './projection.ts'
import type { TaskSnapshot } from './types.ts'

/** Unique prompt-section name owned by this plugin. */
export const WORK_SET_SECTION = 'task-board/work-set'

/**
 * Section order: right after the deployment persona (0) and before the plan
 * policy (500), because the work set is identity-level attention, not tool
 * guidance.
 */
export const WORK_SET_ORDER = 400

/** Header line; states the section's job so the model does not treat it as a to-do organ. */
export const WORK_SET_HEADER = 'Work set (active requirements — execute these; do not reorganize this list):'

const encoder = new TextEncoder()

/** UTF-8 byte length of one rendered section. */
function byteLength(text: string): number {
  return encoder.encode(text).length
}

/**
 * Trailer announcing the tasks the budget pushed out of the section. One
 * helper (not an inline template) because the reserve computed for a
 * would-be break and the trailer appended later MUST agree byte for byte.
 */
function overflowNote(omitted: number): string {
  return `\n…(+${omitted} more)`
}

/**
 * Render the work set under a hard UTF-8 byte budget. Line-granular and
 * deterministic: whole task lines are added while they fit beside the
 * overflow trailer, then a trailer counts the omitted tasks. An empty string
 * means "contribute nothing" (no active tasks, or not even the header fits).
 * @param tasks - the folded board (any order; only `inContext` members render).
 * @param maxBytes - hard budget in UTF-8 bytes.
 * @returns the section text, or `''` when nothing fits.
 */
export function renderWorkSet(tasks: readonly TaskSnapshot[], maxBytes: number): string {
  const active = tasks.filter(isWorkSetMember)
  if (active.length === 0 || maxBytes <= 0 || byteLength(WORK_SET_HEADER) > maxBytes) return ''
  let text = WORK_SET_HEADER
  let included = 0
  for (const [index, task] of active.entries()) {
    // One line per task (collapsed whitespace) so the byte accounting is exact.
    const line = `\n- ${task.id} [${task.status}] ${task.subject.replace(/\s+/gu, ' ').trim()}`
    // Reserve the trailer this break would need, so the result never exceeds the budget.
    const omittedAfterIncluding = active.length - index - 1
    const reserve = omittedAfterIncluding === 0 ? 0 : byteLength(overflowNote(omittedAfterIncluding))
    if (byteLength(text + line) + reserve > maxBytes) break
    text += line
    included = index + 1
  }
  if (included === 0) return ''
  if (included < active.length) text += overflowNote(active.length - included)
  return text
}

/**
 * The `question-board` keyed Chat renderer: one asker's pending questions.
 *
 * Data comes from the host-folded `questionBoard` session projection through
 * the standard-kit `useProjection` (zero client-side folding, so a replayed
 * window, a second tab, and the live inbox agree). Grouping and question text
 * reuse the plugin's own pure `board.ts` helpers — the same functions the host
 * fold runs — so the panel and the delivery path cannot disagree about what a
 * question says or which asker owns it.
 *
 * Actions are injected, not imported: the browser bundle cannot reach
 * `ctx.questionBoard`, so the injected face dispatches the plugin's
 * `/answer_question` and `/dismiss_question` commands (see the client index).
 *
 * An asker with no pending questions renders nothing. The seat's wrapper
 * collapses to zero height for an empty slot, so a settled inbox costs no
 * vertical space in the transcript.
 *
 * @module @dsh-plugin/dsh-question-board/client/panel
 */

import { useMemo, useState, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ChatNode seat declaration this renderer occupies.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the session-scope standard props (sessionId + useProjection).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { groupQuestionsByAsker, pendingQuestions, plainQuestionText } from '../../src/board.ts'
// Type-only: pulls the questionBoard SessionProjectionMap merge read below.
import type {} from '../../src/types.ts'
import { QUESTION_BOARD_NODE_KIND } from './question-board-node.ts'
import css from './QuestionBoardPanel.module.css'

/** No question selected: a stable reference the empty projections reuse. */
const NO_SELECTION: ReadonlySet<string> = new Set()

/** Injected business face of the panel: the command-backed inbox actions. */
export interface QuestionBoardInjected {
  /**
   * Answer one pending question.
   * @param id - question id.
   * @param answer - the answer text (an offered option label or free text).
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  answer: (id: string, answer: string) => Promise<string | null>
  /**
   * Dismiss one pending question without answering it.
   * @param id - question id.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  dismiss: (id: string) => Promise<string | null>
}

/** Full props of the question panel: the keyed seat plus the injected actions. */
export type QuestionBoardPanelProps =
  PropsRuntime<'conversation.chat.node', typeof QUESTION_BOARD_NODE_KIND>
  & InjectFace<QuestionBoardInjected>

/** Which inbox transition one panel button drives. */
type PanelAction = 'answer' | 'dismiss'

export function QuestionBoardPanel({ node, useProjection, answer, dismiss }: QuestionBoardPanelProps): ReactNode {
  const board = useProjection('questionBoard')
  const [checked, setChecked] = useState<ReadonlySet<string>>(NO_SELECTION)
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const asker = node.data.asker
  // One keyed node per asker: this row renders that asker's group, its
  // questions as keyed children so an out-of-order answer batch stays
  // addressable by question id.
  const group = useMemo(
    () => groupQuestionsByAsker(pendingQuestions(board ?? [])).find(candidate => candidate.asker === asker),
    [board, asker],
  )
  const questions = group?.questions ?? []
  const selected = questions.filter(question => checked.has(question.id))

  const toggle = (id: string): void => {
    setChecked((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  // Choosing an option or typing free text selects the question: a question the
  // human has attended to is one the batch should submit.
  const writeDraft = (id: string, value: string): void => {
    setDrafts(current => ({ ...current, [id]: value }))
    setChecked(current => current.has(id) ? current : new Set(current).add(id))
  }

  const run = (action: PanelAction): void => {
    setBusy(true)
    setFailure(null)
    void (async () => {
      const failures: string[] = []
      // Sequential: each command appends durable events to the same session,
      // and the human should see one settled answer at a time.
      for (const question of selected) {
        const text = (drafts[question.id] ?? '').trim()
        if (action === 'answer' && text === '') {
          failures.push(`${question.id}: no answer yet`)
          continue
        }
        // Failure copy stays English (error-surface policy: not localized).
        const line = action === 'answer' ? await answer(question.id, text) : await dismiss(question.id)
        if (line !== null) failures.push(line)
      }
      setBusy(false)
      setChecked(NO_SELECTION)
      setFailure(failures.length === 0 ? null : failures.join('; '))
    })()
  }

  const submitLabel = selected.length === 0 ? 'Answer selected' : `Answer ${String(selected.length)} selected`
  if (questions.length === 0) return null
  return (
    <section className={css.panel} aria-label={`Questions from ${asker}`} data-question-asker={asker}>
      <header className={css.header}>
        <span className={css.title}>Questions from {asker}</span>
        <span className={css.count}>{questions.length} pending</span>
      </header>
      {questions.map(question => (
        <article key={question.id} className={css.question} data-question-id={question.id}>
          <label className={css.pick}>
            <input
              type="checkbox"
              className={css.check}
              checked={checked.has(question.id)}
              onChange={() => { toggle(question.id) }}
            />
            <span className={css.body}>{plainQuestionText(question.content)}</span>
          </label>
          <p className={css.meta}>
            <span className={css.ident}>{question.id}</span>
            {question.blocking === 'blocking' && <span className={css.blocking}>blocking</span>}
          </p>
          {question.options !== undefined && question.options.length > 0 && (
            <div className={css.options}>
              {question.options.map(option => (
                <button
                  key={option.label}
                  type="button"
                  className={drafts[question.id] === option.label ? css.optionOn : css.option}
                  aria-pressed={drafts[question.id] === option.label}
                  title={option.description}
                  onClick={() => { writeDraft(question.id, option.label) }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <input
            type="text"
            className={css.answer}
            value={drafts[question.id] ?? ''}
            placeholder="answer"
            aria-label={`Answer to ${question.id}`}
            onChange={(event) => { writeDraft(question.id, event.target.value) }}
          />
        </article>
      ))}
      <footer className={css.actions}>
        <button
          type="button"
          className={css.submit}
          disabled={busy || selected.length === 0}
          onClick={() => { run('answer') }}
        >
          {submitLabel}
        </button>
        <button
          type="button"
          className={css.dismiss}
          disabled={busy || selected.length === 0}
          onClick={() => { run('dismiss') }}
        >
          Dismiss selected
        </button>
        {failure !== null && <span className={css.error} role="status" title={failure}>failed</span>}
      </footer>
    </section>
  )
}

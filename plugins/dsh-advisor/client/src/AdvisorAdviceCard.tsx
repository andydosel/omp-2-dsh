/**
 * The `advisor-advice` keyed Chat renderer: one advisory as a severity-graded
 * card in the transcript flow.
 *
 * The card reads only the durable node payload (the host-appended
 * `advisor/advice` event), so it needs no projection and no client-side fold:
 * a replayed window, a second tab, and the live transcript render the same
 * advice. Severity drives the border/pill treatment; the note is the card
 * body.
 *
 * @module @dsh-plugin/dsh-advisor/client/card
 */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `conversation.chat.node` keyed seat + ChatNodeDataMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { ADVISOR_ADVICE_NODE_KIND, type AdvisorAdviceChatData } from './advisor-advice-node.ts'
import css from './AdvisorAdviceCard.module.css'

/** Full props of the advisor card: the keyed seat carrying the durable advice. */
export type AdvisorAdviceCardProps = PropsRuntime<'conversation.chat.node', typeof ADVISOR_ADVICE_NODE_KIND>

/** Human-readable severity label. */
const SEVERITY_LABEL: Record<AdvisorAdviceChatData['severity'], string> = {
  nit: 'nit',
  concern: 'concern',
  blocker: 'blocker',
}

/** Class map of one severity (CSS modules may resolve to undefined under noUncheckedIndexedAccess). */
const SEVERITY_CLASS: Record<AdvisorAdviceChatData['severity'], string | undefined> = {
  nit: css.nit,
  concern: css.concern,
  blocker: css.blocker,
}

/**
 * Render one advisor advisory.
 * @param props - the keyed seat with the durable advice payload.
 * @returns the severity-graded card.
 */
export function AdvisorAdviceCard({ node }: AdvisorAdviceCardProps): ReactNode {
  const { severity, note, reviewer } = node.data
  return (
    <div className={`${css.card} ${SEVERITY_CLASS[severity] ?? ''}`} data-advisor-advice={severity}>
      <div className={css.header}>
        <span className={css.badge} data-advisor-severity>{SEVERITY_LABEL[severity]}</span>
        <span className={css.source}>advisor · {reviewer}</span>
      </div>
      <p className={css.note}>{note}</p>
    </div>
  )
}

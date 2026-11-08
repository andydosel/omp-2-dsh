/**
 * Advisor header badge: renders the host-computed `advisorStatus` projection
 * (enabled + reviewer count) and runs /advisor on click.
 *
 * @module @dsh-plugin/dsh-advisor/client/badge/AdvisorBadge
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header.utilities seat)
// and the advisorStatus SessionProjectionMap key.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ModeBadge, type ModeBadgeInjected } from './ModeBadge.tsx'

/** Full props of the advisor badge: standard kit + injected command runner. */
export type AdvisorBadgeProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<ModeBadgeInjected>

/**
 * Render the advisor status badge.
 * @param props - the header seat props plus the injected command runner.
 * @returns the always-visible advisor badge.
 */
export function AdvisorBadge({ useProjection, ...rest }: AdvisorBadgeProps) {
  const projection = useProjection('advisorStatus')
  const active = projection?.enabled ?? false
  const label = active
    ? `ADVISOR · ${projection?.reviewers ?? 0}`
    : 'ADVISOR off'
  return (
    <ModeBadge
      {...rest}
      id="advisor"
      label={label}
      title={active
        ? `Advisor enabled with ${projection?.reviewers ?? 0} reviewer(s) — click to run /advisor off`
        : 'Advisor disabled — click to run /advisor on'}
      command={active ? '/advisor off' : '/advisor on'}
      active={active}
    />
  )
}

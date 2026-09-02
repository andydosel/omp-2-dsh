/**
 * Compact-mode header badge: renders the host-computed `compactMode`
 * projection and executes /compact on click.
 *
 * @module @dsh-plugin/dsh-mode-ui/client/badges/CompactBadge
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header.utilities
// list seat) and the compactMode SessionProjectionMap key.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ModeBadge, type ModeBadgeInjected } from './ModeBadge.tsx'

/** Full props of the compact badge: standard kit + injected command runner. */
export type CompactBadgeProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<ModeBadgeInjected>

export function CompactBadge({ useProjection, ...rest }: CompactBadgeProps) {
  const projection = useProjection('compactMode')
  const active = projection?.active ?? false
  return (
    <ModeBadge
      {...rest}
      id="compact"
      label={active ? 'COMPACT ON' : 'COMPACT off'}
      title={active
        ? 'Compact mode on — click to run /compact'
        : 'Compact mode off — click to run /compact'}
      command="/compact"
      active={active}
    />
  )
}

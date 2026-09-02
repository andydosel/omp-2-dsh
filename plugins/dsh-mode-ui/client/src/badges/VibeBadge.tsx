/**
 * Vibe-mode header badge: renders the host-computed `vibeMode` projection
 * and executes /vibe on click.
 *
 * @module @dsh-plugin/dsh-mode-ui/client/badges/VibeBadge
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge and the vibeMode
// SessionProjectionMap key.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ModeBadge, type ModeBadgeInjected } from './ModeBadge.tsx'

/** Full props of the vibe badge: standard kit + injected command runner. */
export type VibeBadgeProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<ModeBadgeInjected>

export function VibeBadge({ useProjection, ...rest }: VibeBadgeProps) {
  const projection = useProjection('vibeMode')
  const active = projection?.active ?? false
  return (
    <ModeBadge
      {...rest}
      id="vibe"
      label={active ? 'VIBE ON' : 'VIBE off'}
      title={active
        ? 'DIRECTOR (vibe) mode on — click to run /vibe'
        : 'DIRECTOR (vibe) mode off — click to run /vibe'}
      command="/vibe"
      active={active}
    />
  )
}

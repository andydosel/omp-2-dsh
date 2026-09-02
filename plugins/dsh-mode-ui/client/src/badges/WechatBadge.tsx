/**
 * WeChat channel header badge: renders the host-computed `wechatChannel`
 * projection (connected + account) and executes `/wechat status` on click.
 * The channel is deliberately DISABLED in profile-main, so the projection
 * stays absent and the badge renders the offline state.
 *
 * @module @dsh-plugin/dsh-mode-ui/client/badges/WechatBadge
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge and the wechatChannel
// SessionProjectionMap key.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ModeBadge, type ModeBadgeInjected } from './ModeBadge.tsx'

/** Full props of the wechat badge: standard kit + injected command runner. */
export type WechatBadgeProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<ModeBadgeInjected>

export function WechatBadge({ useProjection, ...rest }: WechatBadgeProps) {
  const projection = useProjection('wechatChannel')
  const connected = projection?.connected ?? false
  return (
    <ModeBadge
      {...rest}
      id="wechat"
      label={connected ? 'WECHAT on' : 'WECHAT off'}
      title={connected
        ? `WeChat channel connected (${projection?.account ?? 'unknown account'}) — click to run /wechat status`
        : 'WeChat channel offline — click to run /wechat status'}
      command="/wechat status"
      active={connected}
    />
  )
}

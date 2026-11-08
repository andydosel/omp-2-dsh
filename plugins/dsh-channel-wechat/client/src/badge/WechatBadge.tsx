/**
 * WeChat channel header badge: renders the host-computed `wechatChannel`
 * projection (connected + account) and executes `/wechat status` on click.
 *
 * The badge ships with the channel package, so installing the channel is all
 * it takes to get the header indicator; an absent projection (channel not yet
 * connected) folds to the offline state.
 *
 * @module @dsh-plugin/dsh-channel-wechat/client/badge/WechatBadge
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge for the header seat.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ModeBadge, type ModeBadgeInjected } from './ModeBadge.tsx'

/** Full props of the wechat badge: standard kit + injected command runner. */
export type WechatBadgeProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<ModeBadgeInjected>

/**
 * The WECHAT header badge.
 * @param props - standard kit (incl. `useProjection`) plus the injected runner.
 * @returns the badge, lit while the channel is connected.
 */
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

/**
 * tsdown config for the client face: the shared preset lives in
 * ./tsdown.client.ts (copied from dsh-mode-ui / dsh-org, MIT). The build runs
 * with --env.DSH_BUILD_FACE client so only lib/client.js is emitted from the
 * tsc-emitted lib/client/src/ tree.
 */
import { clientBundle } from './tsdown.client.ts'

export default clientBundle()

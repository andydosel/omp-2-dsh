/**
 * dsh-org: the secretary/lead organisation layer (DESIGN-COORDINATOR-SUITE.md
 * §5.1 / §5.6 / §5.9 / §5.10 / §13.6).
 *
 * - durable events: `org/claim`, `org/relinquish`, `org/forbid`, `org/role`,
 *   `org/assign`, `org/notice`
 * - service: `ctx.org` — `claim` / `relinquish` / `forbid` / `spawnLead` /
 *   `assign` / `setRole` / `notices`, plus the `managerOf` / `managesOf` /
 *   `isForbidden` / `roleOf` readers
 * - projections: `org` (per-session role, manager edge, manages, forbidden,
 *   notices) with a client wire view
 * - commands: `/org on|off|claim <id>|relinquish <id>|forbid <id>|list`
 * - tools: nine secretary-scoped tools and the lead-scoped `report`, registered
 *   per ROLE APPLICATION (never globally) together with the mechanism-enforced
 *   capability envelope on the agent scope
 * - peers/task-board are reached by GLOBAL NAME only (`ctx.get('peers')`,
 *   `ctx.get('taskBoard')`); this package imports no sibling plugin package
 *
 * The controller extends the service with the framework wiring and re-applies a
 * role envelope when an agent is announced carrying a folded role (resume path).
 *
 * Client face: the `org` projection's wire view (role, manager edge, manages,
 * forbidden, notices) is the whole client contract for the session panel. The
 * browser half (`client/src/index.ts`, shipped as `lib/client.js` behind this
 * package's `dsh.client` + `exports["./client"]` declaration) registers:
 * - one `conversation.input.dock` entry: it lists the sessions this secretary
 *   manages, one row per session, each offering release (`/org relinquish <id>`)
 *   and forbid (`/org forbid <id>`);
 * - two `ui-workspace` global session-list seats: a leading dot and the hover
 *   relation line, both reading the same `org` projection and labelling a row
 *   "归 X 管" (managed) or "孤儿" (a lead whose manager edge is gone).
 *
 * The panel reads this package's own projection through the standard-kit
 * `useProjection('org')` (zero client-side folding) and mutates through those
 * slash commands, so the host half needs no client-specific API surface.
 *
 * @module @dsh-plugin/dsh-org
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { registerOrgCommands } from './commands.ts'
import type { OrgConfig } from './config.ts'
import { applyLeadEnvelope, applySecretaryEnvelope } from './envelope.ts'
import { registerOrgProjection } from './projection.ts'
import { OrgService } from './service.ts'

export const name = 'dsh-org'

// The domain vocabulary (session-event + projection + message-source merges,
// probes, OrgApi/OrgDeps) lives in ./types.ts; this re-export keeps the module
// edge in the emitted declaration so aggregate programs receive the merges.
export type * from './types.ts'

export { OrgService } from './service.ts'
export { applyLeadEnvelope, applySecretaryEnvelope, disposeEnvelope, isEnvelopeApplied, LEAD_INHERITED_TOOLS, SECRETARY_INHERITED_TOOLS } from './envelope.ts'
export { orgCommandHandler, registerOrgCommands, ORG_USAGE } from './commands.ts'
export type { OrgCommandInvocation } from './commands.ts'
export {
  emptyOrgView,
  isOrgProjectionView,
  orgProjection,
  orgViewSchema,
  registerOrgProjection,
  viewOrg,
  applyOrgView,
} from './projection.ts'
export {
  addForbidden,
  applyOrgEvent,
  emptyOrgState,
  forbiddenOf,
  grantClaim,
  isForbidden,
  managerOf,
  managesOf,
  orgStateFromEvents,
  relinquishEdge,
  roleOf,
  setRole,
  toSessionId,
} from './state.ts'
export {
  decidePathGate,
  matchesAnyPath,
  normalizeCandidate,
  normalizePattern,
} from './paths.ts'
export type { PathGateDecision, PathGateInput } from './paths.ts'
export {
  Config,
  defaultLeadWritePaths,
  defaultSecretaryReadPaths,
  defaultSecretaryWritePaths,
  KNOWN_CONFIG_KEYS,
  ORG_CONFIG_KEYS,
  resolveOrgConfig,
} from './config.ts'
export type { OrgConfig, ResolvedOrgConfig } from './config.ts'
export {
  defineAssignTaskTool,
  defineNotifyUserTool,
  defineOrgClaimTool,
  defineOrgForbidTool,
  defineOrgRelinquishTool,
  defineOrgSpawnLeadTool,
  defineProjectStructureTool,
  defineReadProjectDocsTool,
  defineReportTool,
  defineSecretaryTools,
  defineSummarizeReportsTool,
  LEAD_TOOL_NAMES,
  SECRETARY_TOOL_NAMES,
} from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    org: OrgController
  }
}

/**
 * The plugin entry: builds the organisation service, wires commands and the
 * `org` projection, and re-applies a role envelope whenever an agent is
 * announced with a folded `secretary`/`lead` role (resume and late load).
 */
export class OrgController extends OrgService {
  static override inject = ['agents', 'sessions'] as const

  /**
   * @param ctx - the plugin context (`agents` and `sessions` are injected).
   * @param config - raw plugin configuration (validated by the service).
   */
  constructor(ctx: Context, config: OrgConfig = {}) {
    super(ctx, config)
    registerOrgCommands(ctx, this, this.deps)
    registerOrgProjection(ctx)
    // Late load: sessions already live and already carrying a folded role.
    for (const agent of ctx.agents.list()) this.syncEnvelope(agent)
    ctx.on('agent/created', ({ agent }) => {
      this.syncEnvelope(agent)
      return undefined
    })
  }

  /**
   * Re-apply the envelope an agent's folded role calls for. Envelope
   * application is idempotent per agent object, so the creation paths that
   * already composed it (`spawnLead` setup, `/org on`) are not doubled.
   */
  private syncEnvelope(agent: Agent): void {
    const role = this.roleOf(agent.id)
    if (role !== 'secretary' && role !== 'lead') return
    try {
      if (role === 'secretary') applySecretaryEnvelope(agent.ctx, agent, this.deps)
      else applyLeadEnvelope(agent.ctx, agent, this.deps)
    } catch (error) {
      this.ctx.logger.warn('dsh-org: failed to re-apply the %s envelope for %s: %o', role, agent.id, error)
    }
  }
}

export default OrgController

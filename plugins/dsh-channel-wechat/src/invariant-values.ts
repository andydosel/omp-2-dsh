/** Policy value sets shared between config schema and invariant checks. */

export const DM_POLICIES: ReadonlySet<string> = new Set(['open', 'allowlist', 'pairing', 'disabled'])

export const GROUP_POLICIES: ReadonlySet<string> = new Set(['disabled', 'open', 'allowlist'])

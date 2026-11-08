/**
 * Advisor popover: the header badge's click panel. It owns the two settings
 * the badge itself cannot express — an enable switch (the same
 * `/advisor on|off` command the badge used to run directly) and the reviewer
 * model route, picked from the session's model directory. Both travel as
 * slash commands so the host stays the single writer of persisted state.
 *
 * The model catalog is optional: when the web app's `modelDirectories`
 * service is absent or has no binding for this session, the picker disables
 * itself and says so instead of failing the badge.
 *
 * @module @dsh-plugin/dsh-advisor/client/badge/AdvisorPanel
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { ModelDirectoryFace, ModelDirectorySnapshot } from './model-directory.ts'
import { EMPTY_DIRECTORY_SNAPSHOT } from './model-directory.ts'
import css from './AdvisorPanel.module.css'

/** Copy for the "no route chosen" option; also the follow-primary sentinel. */
export const FOLLOW_PRIMARY_LABEL = '跟随主会话模型'

/** One rendered option: the wire value is `provider/model`. */
interface RouteOption {
  readonly value: string
  readonly label: string
}

/** Props of the panel: projection state in, commands out. */
export interface AdvisorPanelProps {
  /** `advisorStatus.enabled` — the host's switch state, not local state. */
  readonly active: boolean
  /** `advisorStatus.reviewers` — shown next to the switch when enabled. */
  readonly reviewers: number
  /** `advisorStatus.model` — the effective route, empty for follow-primary. */
  readonly model: string
  /** A command is in flight; both controls stay disabled. */
  readonly busy: boolean
  /** User-facing failure line from the last command, if any. */
  readonly error: string | null
  /** The session's model directory, or undefined when unavailable. */
  readonly directory: ModelDirectoryFace | undefined
  onToggle(): void
  /** `''` restores follow-primary; anything else is `provider/model`. */
  onSelectModel(route: string): void
  onClose(): void
}

function noSubscribe(): () => void {
  return () => {}
}

function emptySnapshot(): ModelDirectorySnapshot {
  return EMPTY_DIRECTORY_SNAPSHOT
}

function routeOptions(snapshot: ModelDirectorySnapshot): readonly RouteOption[] {
  const options: RouteOption[] = []
  for (const group of snapshot.groups) {
    for (const model of group.models) {
      options.push({
        value: `${group.id}/${model.id}`,
        label: group.name === model.name ? model.name : `${group.name} · ${model.name}`,
      })
    }
  }
  return options
}

/**
 * Match a stored route against the catalog. A bare model id is legal on the
 * wire (the host falls back to the primary provider), so an exact id match
 * still selects its row rather than showing "unavailable".
 */
function canonicalRoute(model: string, options: readonly RouteOption[]): string {
  if (model === '') return ''
  const exact = options.find((option) => option.value === model)
  if (exact !== undefined) return exact.value
  const bare = options.find((option) => option.value.slice(option.value.lastIndexOf('/') + 1) === model)
  return bare?.value ?? model
}

function catalogHint(directory: ModelDirectoryFace | undefined, snapshot: ModelDirectorySnapshot): string | null {
  if (directory === undefined) return '模型目录不可用,审查模型沿用主会话的选择。'
  if (snapshot.groups.length > 0 && snapshot.status !== 'loading') return null
  if (snapshot.status === 'loading') return '正在加载模型列表…'
  if (snapshot.error !== null) return `模型目录加载失败:${snapshot.error}`
  return '暂无可用模型,审查模型沿用主会话的选择。'
}

/**
 * Render the advisor settings panel.
 * @param props - projection state plus the command callbacks.
 * @returns the popover card.
 */
export function AdvisorPanel({
  active,
  reviewers,
  model,
  busy,
  error,
  directory,
  onToggle,
  onSelectModel,
  onClose,
}: AdvisorPanelProps) {
  const snapshot = useSyncExternalStore(directory?.subscribe ?? noSubscribe, directory?.getSnapshot ?? emptySnapshot)

  useEffect(() => {
    // The catalog loads lazily; the panel opening is exactly the moment the
    // user needs it, and a closed panel should not warm the store.
    directory?.load()
  }, [directory])

  const options = routeOptions(snapshot)
  const selected = canonicalRoute(model, options)
  const known = selected === '' || options.some((option) => option.value === selected)
  const hint = catalogHint(directory, snapshot)

  return (
    <div className={css.panel} role="dialog" aria-label="Advisor 设置">
      <div className={css.head}>
        <span className={css.title}>ADVISOR</span>
        <button type="button" className={css.close} aria-label="关闭" onClick={onClose}>×</button>
      </div>
      <div className={css.row}>
        <span className={css.label}>状态</span>
        <button
          type="button"
          role="switch"
          aria-checked={active}
          aria-label="启用 Advisor"
          className={active ? css.switchOn : css.switch}
          disabled={busy}
          onClick={onToggle}
        >
          {active ? `已开启 · ${reviewers} 个审查者` : '已关闭'}
        </button>
      </div>
      <div className={css.row}>
        <span className={css.label}>审查模型</span>
        <select
          className={css.select}
          aria-label="审查模型"
          value={selected}
          disabled={busy || directory === undefined}
          onChange={(event) => { onSelectModel(event.target.value) }}
        >
          <option value="">{FOLLOW_PRIMARY_LABEL}</option>
          {known ? null : <option value={selected}>{selected}(不在当前目录)</option>}
          {snapshot.groups.map((group) => (
            <optgroup key={group.id} label={group.name}>
              {group.models.map((entry) => (
                <option key={`${group.id}/${entry.id}`} value={`${group.id}/${entry.id}`}>{entry.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {hint === null ? null : <div className={css.hint}>{hint}</div>}
      {error === null ? null : <div className={css.error} role="status">失败: {error}</div>}
    </div>
  )
}

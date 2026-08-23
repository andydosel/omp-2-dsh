/**
 * DIRECTOR-instructions settings page (settings.section, id `vibe-director`,
 * label "Vibe 指令"). Binds the `dsh-vibe-mode` namespace through
 * `ctx.settingsScope`; a textarea stages the `section` text and the 保存
 * button writes it with `scope.set('section', draft)`. Handles the
 * writable / unavailable / conflict states: an unavailable namespace
 * (not exposed by the api-proxy whitelist) renders a notice instead of a
 * form; a save that did not land (conflict recovery) shows a failure line.
 *
 * @module @dsh-plugin/dsh-vibe-mode/client/settings
 */

import { useSyncExternalStore, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import styles from './DirectorSection.module.css'

/** Extra props the settings entry injects: the bound namespace scope. */
export interface DirectorSectionInjected {
  scope: SettingsScope<unknown>
}

/** Full props of the settings page. */
export type DirectorSectionProps = PropsRuntime<'settings.section'> & DirectorSectionInjected

/** The section shape the panel edits. */
interface VibeSection {
  section?: string
}

/** Snapshot value narrowed to the editable section shape. */
function sectionOf(snapshot: SettingsScopeSnapshot<unknown>): VibeSection | undefined {
  if (snapshot.value === undefined) return undefined
  return snapshot.value as VibeSection
}

/**
 * Settings page: textarea + save button. Staged text is written only on 保存;
 * the seeded draft follows the last accepted snapshot (conflict recovery
 * reloads Host state, so a failed save re-seeds from what the Host holds).
 */
export function DirectorSection({ scope }: DirectorSectionProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(scope.subscribe, scope.getSnapshot)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  if (snapshot.status === 'unavailable') {
    return <div className={styles.notice}>设置不可用:dsh-vibe-mode 命名空间未对客户端开放。</div>
  }

  const section = sectionOf(snapshot)
  const text = draft ?? section?.section ?? ''
  const dirty = draft !== null && draft !== (section?.section ?? '')
  const editable = snapshot.writable

  const save = async (): Promise<void> => {
    if (!editable || !dirty || saving) return
    setSaving(true)
    setFailed(false)
    try {
      await scope.set('section', text)
      setDraft(null)
    } catch {
      // The scope reloads Host state on a rejected/failed write; the draft
      // re-seeds from the accepted snapshot on the next render.
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.label}>DIRECTOR 指令</div>
      <textarea
        className={styles.textarea}
        value={text}
        rows={10}
        spellCheck={false}
        disabled={!editable}
        placeholder="输入 DIRECTOR 指令文本,保存后下个请求生效…"
        onChange={(event) => {
          setDraft(event.target.value)
          setFailed(false)
        }}
      />
      {!editable && <div className={styles.notice}>当前会话只读,无法保存设置。</div>}
      {failed && <div className={styles.failed}>保存冲突:设置已被其他会话修改,已重新加载。</div>}
      <button type="button" className={styles.save} disabled={!editable || !dirty || saving} onClick={() => void save()}>
        {saving ? '保存中…' : '保存'}
      </button>
    </div>
  )
}

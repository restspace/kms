import { useEffect, useState } from 'react'
import { getFileCollectionDefaults, updateFileCollectionDefaults, type FileCollectionDefaults } from '../api'

/**
 * #18 (eval defect): file collection was only ever configurable per-task, via
 * "Action type = File upload" on the New task form — there was no
 * event-level default an organiser could set once. This is deliberately
 * small: a toggle (pre-fill new tasks' Action type to File upload,
 * TaskCreateForm.tsx) plus one default allowed-types list (applied to the
 * task's file request at creation, adminApi.ts's POST /tasks) — a default,
 * not a new subsystem alongside the existing per-task file-request settings.
 */
export function FileCollectionDefaultsCard() {
  const [defaults, setDefaults] = useState<FileCollectionDefaults | null>(null)
  const [typesInput, setTypesInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const reload = () => {
    setError(null)
    return getFileCollectionDefaults()
      .then((r) => {
        setDefaults(r)
        setTypesInput(r.allowed_types.join(', '))
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load file-collection defaults'))
  }

  useEffect(() => {
    void reload()
  }, [])

  const save = async (next: Partial<FileCollectionDefaults>) => {
    if (!defaults) return
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      const merged: FileCollectionDefaults = { ...defaults, ...next }
      const r = await updateFileCollectionDefaults(merged)
      setDefaults(r)
      setTypesInput(r.allowed_types.join(', '))
      setNote('Saved — new tasks will pick this up.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save file-collection defaults.')
    } finally {
      setSaving(false)
    }
  }

  const saveTypes = () => {
    const allowed_types = typesInput
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '')
    void save({ allowed_types })
  }

  return (
    <section className="settings-card">
      <h2>File collection default</h2>
      <p className="settings-hint">
        When on, a new task on the Tasks tab starts with <strong>Action type = File upload</strong> already picked.
        The allowed types below apply to any file-upload task created without its own file request — set once
        instead of on every task.
      </p>

      {error && (
        <div className="settings-error">
          {error}{' '}
          <button type="button" className="settings-ghost" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      )}

      {defaults === null && !error ? (
        <div className="settings-hint">Loading…</div>
      ) : defaults ? (
        <>
          <label className="settings-chase-mode">
            <input
              type="checkbox"
              checked={defaults.enabled}
              disabled={saving}
              onChange={(e) => void save({ enabled: (e.target as HTMLInputElement).checked })}
            />
            <span>Default new tasks to File upload</span>
          </label>

          <label className="settings-chase-mode">
            <span>Default allowed types (comma-separated MIME types)</span>
            <input
              type="text"
              value={typesInput}
              disabled={saving}
              placeholder="application/pdf, image/png"
              onChange={(e) => setTypesInput((e.target as HTMLInputElement).value)}
              onBlur={saveTypes}
            />
          </label>
        </>
      ) : null}

      {note && <div className="settings-hint" role="status">{note}</div>}
    </section>
  )
}

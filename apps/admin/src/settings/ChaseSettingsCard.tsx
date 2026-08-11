import { useEffect, useState } from 'react'
import { getChaseSettings, updateChaseSettings, type ChaseSettings } from '../api'

/**
 * Workplan 13 W4d: the kill switch. `chase_mode` defaults to 'auto' for every
 * event (D5 — Brief.md #3 / FR-COMM-5 is a hard contract), so reminders keep
 * auto-sending out of the box. Switching to 'assisted' routes every staged
 * nudge through the Speaker Tracking board's chase inbox instead, where a
 * human reviews, edits and clicks Send — never the default, always a choice.
 */
export function ChaseSettingsCard() {
  const [mode, setMode] = useState<ChaseSettings['chase_mode'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const reload = () => {
    setError(null)
    return getChaseSettings()
      .then((r) => setMode(r.chase_mode))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load chase settings'))
  }

  useEffect(() => {
    void reload()
  }, [])

  const handleChange = async (next: ChaseSettings['chase_mode']) => {
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      const r = await updateChaseSettings(next)
      setMode(r.chase_mode)
      setNote(
        r.chase_mode === 'auto'
          ? 'Reminders auto-send again — nobody reviews them first.'
          : 'Reminders now stage as drafts on the Speaker Tracking board until a human clicks Send.',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the chase mode.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-card">
      <h2>Chase inbox</h2>
      <p className="settings-hint">
        How task reminders and other speaker nudges leave this event. <strong>Auto</strong> is the default and
        spec-compliant: reminders send themselves on schedule, with no review step. <strong>Assisted</strong> stages
        every nudge as an editable draft on the Speaker Tracking board instead, and sends nothing until a human
        clicks Send.
      </p>

      {error && (
        <div className="settings-error">
          {error}{' '}
          <button type="button" className="settings-ghost" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      )}

      {mode === null && !error ? (
        <div className="settings-hint">Loading…</div>
      ) : (
        <label className="settings-chase-mode">
          <span>Chase mode</span>
          <select
            value={mode ?? 'auto'}
            disabled={saving}
            onChange={(e) => void handleChange((e.target as HTMLSelectElement).value as ChaseSettings['chase_mode'])}
          >
            <option value="auto">Auto (default, spec-compliant) — reminders send themselves</option>
            <option value="assisted">Assisted — drafts wait for review</option>
          </select>
        </label>
      )}

      {note && <div className="settings-hint" role="status">{note}</div>}
    </section>
  )
}

import { useEffect, useState } from 'react'
import {
  createSpeakerStatus,
  deleteSpeakerStatus,
  listSpeakerStatuses,
  updateSpeakerStatus,
  type SpeakerStatusOption,
} from '../api'
import { appConfirm } from '../components/dialogs'
import '../components/RoomsTracksFields.css'

/**
 * Speaker statuses (SPK-04): the settings-side editor for this event's
 * extensions to the built-in speaker_status vocabulary (Prospect / Invited /
 * Awaiting reply / Confirmed / Declined, always available and not rows here).
 * Follows ContactFieldsCard's pattern — each edit is an immediate API call,
 * not a draft with a Save button, so a freshly added status is selectable on
 * the Speakers tab the moment the organiser switches tabs there.
 *
 * `key` is server-derived from the label at creation time and never exposed
 * for editing — renaming only changes the `label`; contacts already carrying
 * the key keep it.
 */

interface StatusDraft {
  id: string
  key: string
  label: string
}

const asDraft = (o: SpeakerStatusOption): StatusDraft => ({ id: o.id, key: o.key, label: o.label })

export function SpeakerStatusesCard() {
  const [options, setOptions] = useState<StatusDraft[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const reload = () => {
    setError(null)
    return listSpeakerStatuses()
      .then((r) => setOptions(r.items.map(asDraft)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load speaker statuses'))
  }

  useEffect(() => {
    reload()
    // Intentionally once on mount — every subsequent change already updates local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAdd = async () => {
    try {
      const n = (options?.length ?? 0) + 1
      const created = await createSpeakerStatus({ label: `New status ${n}` })
      setOptions((cur) => [...(cur ?? []), asDraft(created)])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add the status.')
    }
  }

  const handleLabelBlur = async (row: StatusDraft) => {
    const label = row.label.trim()
    if (!label) {
      // Empty labels are rejected server-side; reload discards the edit
      // rather than leaving the row in a state the server never accepted.
      reload()
      return
    }
    setSaving(row.id)
    try {
      await updateSpeakerStatus(row.id, { label })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename the status.')
    } finally {
      setSaving(null)
    }
  }

  const handleRemove = async (row: StatusDraft) => {
    const confirmed = await appConfirm(
      `Delete "${row.label || 'this status'}"? Speakers currently carrying it keep the value, but it drops off the pick-list.`,
      { title: 'Delete speaker status', confirmLabel: 'Delete', danger: true },
    )
    if (!confirmed) return
    try {
      await deleteSpeakerStatus(row.id)
      setOptions((cur) => (cur ?? []).filter((o) => o.id !== row.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete the status.')
    }
  }

  return (
    <section className="settings-card">
      <h2>Speaker statuses</h2>
      <p className="settings-hint">
        Prospect, Invited, Awaiting reply, Confirmed and Declined are always available. Add more here for
        this event&rsquo;s own workflow (e.g. &ldquo;On the fence&rdquo;) — they show up in the Speakers tab&rsquo;s
        status filter and edit control immediately.
      </p>
      {error && options === null ? (
        <div className="settings-error">
          {error}{' '}
          <button type="button" className="settings-ghost" onClick={() => reload()}>
            Retry
          </button>
        </div>
      ) : options === null ? (
        <div className="settings-hint">Loading…</div>
      ) : (
        <div className="rt-field">
          {error && <div className="settings-error">{error}</div>}
          {options.length === 0 && <div className="settings-hint">No custom statuses yet.</div>}
          {options.map((row) => (
            <div key={row.id} className={saving === row.id ? 'rt-row-saving' : undefined}>
              <div className="rt-row">
                <input
                  type="text"
                  className="rt-row-name"
                  placeholder="Status label"
                  aria-label="Status label"
                  value={row.label}
                  onChange={(e) =>
                    setOptions((cur) =>
                      (cur ?? []).map((o) => (o.id === row.id ? { ...o, label: (e.target as HTMLInputElement).value } : o)),
                    )
                  }
                  onBlur={() => void handleLabelBlur(row)}
                />
                <button type="button" className="rt-row-remove" aria-label={`Delete "${row.label}"`} onClick={() => void handleRemove(row)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="rt-add" onClick={() => void handleAdd()}>
            + Add status
          </button>
        </div>
      )}
    </section>
  )
}

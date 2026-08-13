import { useEffect, useState } from 'react'
import { getEventRevisions, patchEvent, type EntityRevision } from '../api'
import { appConfirm } from '../components/dialogs'

/**
 * Settings history for the current event — the Settings hub's own rendering of
 * the 'settings' content_revisions rows (Wave E mechanism, workplan 14 D8).
 *
 * Previously this card mounted workspace/entityHistory's EventSettingsHistory,
 * which drew a FIXED field list (the nine events-PATCH fields) on every row.
 * Room/track edits now record history too (eval defect: they never appeared
 * here at all), and their snapshots carry `rooms`/`tracks` fields instead —
 * under the fixed list those rows rendered as nine "(empty)" event fields,
 * which reads as "the event had no name". This panel therefore shows only the
 * fields each snapshot actually contains, and offers Restore only when the
 * snapshot holds fields the events PATCH can write back (a rooms/tracks list
 * has no write-back surface; its restore path is the delete-toast Undo).
 */

/** Display order + labels; superset of every settings snapshot flavour. */
const FIELD_LABELS: Array<[string, string]> = [
  ['name', 'Name'],
  ['slug', 'Slug'],
  ['type', 'Type'],
  ['website_url', 'Website'],
  ['location', 'Location'],
  ['timezone', 'Timezone'],
  ['description', 'Description'],
  ['starts_at', 'Starts'],
  ['ends_at', 'Ends'],
  ['rooms', 'Rooms'],
  ['tracks', 'Tracks'],
]

/** The keys PATCH /app/api/events/:id accepts — the restorable subset. */
const RESTORABLE_KEYS = new Set([
  'name', 'slug', 'type', 'website_url', 'location', 'timezone', 'description', 'starts_at', 'ends_at',
])

/** Same shape as the workspace panels' local fmtDateTime. */
const fmtDateTime = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function SettingsHistory({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<EntityRevision[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = () =>
    getEventRevisions(eventId)
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load history'))

  useEffect(() => {
    setItems(null)
    setError(null)
    setNote(null)
    setOpenId(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId])

  const restore = async (rev: EntityRevision) => {
    const fields = Object.fromEntries(
      Object.entries(rev.fields).filter(([k]) => RESTORABLE_KEYS.has(k)),
    )
    const ok = await appConfirm(
      `Restore the event settings as they were before the edit on ${fmtDateTime(rev.edited_at)}? The current content is kept in the history.`,
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      // The snapshot's keys are the PATCH surface's own field names, so a
      // restore is literally "send them back" — and the PATCH snapshots the
      // replaced values itself, keeping restores reversible.
      await patchEvent(eventId, fields)
      setNote('Restored. The replaced content was added to the history.')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {note && <p className="settings-hint" role="status">{note}</p>}
      {!items && !error && <p className="settings-hint">Loading…</p>}
      {items && items.length === 0 && (
        <p className="settings-hint">No settings edits recorded — the event settings are as first configured.</p>
      )}
      {items?.map((rev) => {
        const shown = FIELD_LABELS.filter(([key]) => key in rev.fields)
        const restorable = shown.some(([key]) => RESTORABLE_KEYS.has(key))
        return (
          <div className="settings-history-row" key={rev.id}>
            <div className="settings-history-head">
              <span className="settings-history-when">
                {fmtDateTime(rev.edited_at)} · edited by {rev.edited_by_name ?? 'Unknown'} ·{' '}
                {rev.source === 'portal' ? 'Speaker portal' : 'Admin'}
              </span>
              <button
                type="button"
                className="settings-ghost"
                onClick={() => setOpenId((prev) => (prev === rev.id ? null : rev.id))}
              >
                {openId === rev.id ? 'Hide' : 'Before this edit'}
              </button>
              {restorable ? (
                <button
                  type="button"
                  className="settings-ghost"
                  disabled={busy}
                  onClick={() => void restore(rev)}
                  title="Put the event settings back to how they were before this edit"
                >
                  Restore
                </button>
              ) : (
                // A rooms/tracks snapshot has no PATCH to write it back; the
                // way back from a room delete is the delete toast's Undo.
                <span
                  className="settings-history-norestore"
                  title="Room and track lists are restored through the delete confirmation's Undo, not from here"
                >
                  Recorded
                </span>
              )}
            </div>
            {openId === rev.id && (
              <dl className="settings-history-fields">
                {shown.map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>
                      {rev.fields[key] ? (
                        <span style={{ whiteSpace: 'pre-line' }}>{rev.fields[key]}</span>
                      ) : (
                        '(empty)'
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )
      })}
    </>
  )
}

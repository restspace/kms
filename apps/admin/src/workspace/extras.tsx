import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { DataListFilterProps } from '../components/DataList'
import type { CreateFormProps } from '../components/DataTabManager'
import { appConfirm } from '../components/dialogs'
import {
  addSubmissionParticipant,
  getSubmissionDetail,
  listRooms,
  listTracks,
  PARTICIPANT_ROLES,
  queryResource,
  removeSubmissionParticipant,
  updateSubmissionNotes,
  updateSubmissionParticipantRole,
  type ContactRow,
  type RoomRow,
  type SubmissionDetail,
  type TrackRow,
} from '../api'
import { SubmissionFilesPanel } from './FilePanels'
import './review.css'

/**
 * M3 workspace pieces: the status filter chips (docs/06 §1 status tabs as
 * chips), the bulk-action bar and the submission detail tab.
 */

export const SUBMISSION_STATUSES = [
  'pending',
  'accept_queue',
  'accepted',
  'decline_queue',
  'declined',
  'withdrawn',
  'draft',
] as const

export const statusLabel = (s: string): string =>
  s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

/** Single-select status chips; the tab count tracks the active chip. */
export function StatusChipsFilter({ filters, setFilters }: DataListFilterProps<Record<string, string>>) {
  const active = filters.status ?? ''
  const choose = (value: string) => setFilters((prev) => ({ ...prev, status: value }))
  return (
    <div className="chip-filter" role="group" aria-label="Status filter">
      <button className={active === '' ? 'active' : ''} aria-pressed={active === ''} onClick={() => choose('')}>
        All
      </button>
      {SUBMISSION_STATUSES.map((s) => (
        <button key={s} className={active === s ? 'active' : ''} aria-pressed={active === s} onClick={() => choose(s)}>
          {statusLabel(s)}
        </button>
      ))}
    </div>
  )
}

export interface BulkBarProps {
  count: number
  busy: boolean
  onAction: (action: 'accept_queue' | 'decline_queue' | 'pending' | 'send_decisions') => void
  onClear: () => void
  note: string | null
}

/** Floating bar shown while submissions are checked (docs/06 §5). */
export function BulkBar({ count, busy, onAction, onClear, note }: BulkBarProps) {
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      {count > 0 ? (
        <>
          <span className="bulk-count">{count} selected</span>
          <button disabled={busy} onClick={() => onAction('accept_queue')}>→ Accept Queue</button>
          <button disabled={busy} onClick={() => onAction('decline_queue')}>→ Decline Queue</button>
          <button disabled={busy} onClick={() => onAction('pending')}>→ Pending</button>
          <button className="primary" disabled={busy} onClick={() => onAction('send_decisions')}>
            Send decision emails
          </button>
        </>
      ) : null}
      {note && <span className="bulk-note">{note}</span>}
      <button disabled={busy} onClick={onClear}>{count > 0 ? 'Clear' : '✕'}</button>
    </div>
  )
}

const fmtDate = (iso: unknown): string => {
  if (typeof iso !== 'string' || !iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const answerText = (json: string | null): string => {
  if (!json) return '—'
  try {
    const v = JSON.parse(json) as unknown
    // A stored JSON value of `null` (an unused/skipped custom field) parses
    // to the JS value `null`, which isn't falsy at the string level above —
    // `json` here is the literal text "null", not an empty string — so it
    // fell through to `String(v)` and rendered the literal word "null".
    // Same for `undefined`-ish array holes; catch both explicitly.
    if (v === null || v === undefined) return '—'
    if (Array.isArray(v)) return v.filter((item) => item !== null && item !== undefined).join(', ') || '—'
    if (typeof v === 'boolean') return v ? 'Yes' : 'No'
    return String(v).replace(/<[^>]*>/g, '') || '—'
  } catch {
    return json
  }
}

/**
 * One `<dt>`/`<dd>` pair. A `<dl>`'s valid children are `dt`/`dd` (optionally
 * grouped) *or* one or more `<div>` each holding `dt`s followed by `dd`s — the
 * previous `<span style="display:contents">` wrapper wasn't valid `<dl>`
 * content at all. A `<div>` is, and `display: contents` keeps it out of the
 * render tree so `dt`/`dd` still land as direct grid items under the parent
 * `.detail-panel dl` grid (shell.css) without new layout CSS.
 */
function DetailPair({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div style={{ display: 'contents' }}>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * Participant headshot thumbnail (manual-QA follow-up: the participants row
 * rendered "headshot ✓" text but never the image). Mirrors the contact
 * detail's `ContactHeadshot` in App.tsx — same `/files/<id>` src (already
 * reachable from an authenticated admin session via fileAuth) and the same
 * `.contact-headshot`/`.contact-headshot-fallback` classes from shell.css —
 * just smaller, and with an initials fallback when there's no asset on file.
 */
function ParticipantHeadshot({ p }: {
  p: { first_name: string | null; last_name: string | null; email: string; headshot_asset_id: string | null }
}) {
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email
  if (p.headshot_asset_id) {
    return (
      <img
        className="contact-headshot part-headshot"
        src={`/files/${p.headshot_asset_id}`}
        alt={`${name} headshot`}
        width={28}
        height={28}
      />
    )
  }
  const parts = [p.first_name, p.last_name].filter(Boolean) as string[]
  const initials = parts.length > 0
    ? parts.map((s) => s[0]?.toUpperCase() ?? '').join('')
    : (p.email[0] ?? '?').toUpperCase()
  return (
    <div className="contact-headshot contact-headshot-fallback part-headshot" aria-hidden="true">
      {initials}
    </div>
  )
}

/** Submission detail tab: answers, participants with roles, review summary. */
export function SubmissionDetailPanel({ id }: { id: string }) {
  const [detail, setDetail] = useState<SubmissionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [savedNotes, setSavedNotes] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesError, setNotesError] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    setNotesError(null)
    getSubmissionDetail(id)
      .then((d) => {
        setDetail(d)
        const initialNotes = typeof d.submission.notes === 'string' ? d.submission.notes : ''
        setNotes(initialNotes)
        setSavedNotes(initialNotes)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  const saveNotes = async () => {
    setNotesSaving(true)
    setNotesError(null)
    try {
      await updateSubmissionNotes(id, notes.trim() || null)
      setSavedNotes(notes)
    } catch (e) {
      setNotesError(e instanceof Error ? e.message : 'Failed to save notes')
    } finally {
      setNotesSaving(false)
    }
  }

  if (error) return <div className="detail-panel"><p>{error}</p></div>
  if (!detail) return <div className="detail-panel"><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  const s = detail.submission
  const rating = detail.reviews.filter((r) => r.weighted_total !== null)
  const mean =
    rating.length > 0
      ? Math.round((rating.reduce((sum, r) => sum + (r.weighted_total ?? 0), 0) / rating.length) * 100) / 100
      : null

  return (
    <div className="detail-panel">
      <h2>
        {String(s.title)}{' '}
        <span className={`status-chip status-${String(s.status)}`}>{statusLabel(String(s.status))}</span>
        {mean !== null && <span className="rating-badge">★ {mean}</span>}
      </h2>
      <div className="detail-sub">
        {String(s.code)} · {String(s.form_name ?? 'Manual')} · Submitted {fmtDate(s.created_at)}
        {s.notified_at ? ` · Notified ${fmtDate(s.notified_at)}` : ' · Not notified'}
      </div>
      <dl>
        {s.format ? <DetailPair term="Format">{String(s.format)}</DetailPair> : null}
        {s.track_name ? <DetailPair term="Track">{String(s.track_name)}</DetailPair> : null}
        {s.plan_name ? <DetailPair term="Evaluation plan">{String(s.plan_name)}</DetailPair> : null}
        {detail.tags.length > 0 && <DetailPair term="Tags">{detail.tags.join(', ')}</DetailPair>}
        {detail.answers
          // The submission form's own "Track" question (field_key `track`,
          // manual-QA item) duplicates the built-in Track pair above, which
          // already shows the resolved, canonical track name from the
          // `tracks` relation (`s.track_name`) — the raw form answer is an
          // unresolved id/label list for the same field. Show it once, from
          // the relation.
          .filter((a) => a.label.trim().toLowerCase() !== 'track')
          .map((a, i) => (
            <DetailPair key={i} term={a.label}>{answerText(a.value_json)}</DetailPair>
          ))}
      </dl>

      <h2 style={{ fontSize: 14 }}>Internal notes</h2>
      <textarea
        className="internal-notes-field"
        rows={4}
        value={notes}
        onChange={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
        aria-label="Internal notes"
        placeholder="Notes visible to organisers only — never shown in the portal."
      />
      <div className="internal-notes-actions">
        <button
          type="button"
          disabled={notes === savedNotes || notesSaving}
          onClick={() => void saveNotes()}
        >
          {notesSaving ? 'Saving…' : 'Save notes'}
        </button>
        {notesError && <span className="internal-notes-error" role="alert">{notesError}</span>}
      </div>

      <h2 style={{ fontSize: 14 }}>Participants</h2>
      {detail.participants.map((p) => (
        <div className="part-row" key={p.contact_id}>
          <ParticipantHeadshot p={p} />
          <strong>{[p.first_name, p.last_name].filter(Boolean).join(' ') || p.email}</strong>
          <span style={{ color: 'var(--text-muted)' }}>
            {p.role}{p.is_primary_contact === 1 ? ' · primary' : ''}
          </span>
          <span className="part-flags">
            {p.has_bio === 1 ? 'bio ✓' : 'bio –'}
          </span>
        </div>
      ))}

      {/* Submission-scoped uploads (slides and the like) with download links —
          manual-QA item (b): these were invisible to organisers. */}
      <SubmissionFilesPanel submissionId={id} />

      <h2 style={{ fontSize: 14, marginTop: 16 }}>
        Reviews {detail.reviews.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({detail.reviews.length})</span>}
      </h2>
      {detail.reviews.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No reviews yet.</p>}
      {detail.reviews.map((r, i) => (
        <div className="review-row" key={i}>
          <div className="rev-head">
            <span>{r.reviewer_name ?? 'Reviewer'}</span>
            <span>{r.conflict_of_interest === 1 ? 'Conflict of interest' : r.weighted_total ?? '—'}</span>
          </div>
          {r.comment && <div className="rev-comment">{r.comment}</div>}
        </div>
      ))}
    </div>
  )
}

const readableRole = (role: string): string =>
  role.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('-')

/**
 * Submission edit form (F14/ABS-11): the previous edit surface only reached
 * title/description/format via side-channels (notes textarea, status
 * dropdown) — this is the real edit tab, opened on row double-click via
 * `TabConfig.editComponent`. Track/room are dynamic per-event lists the
 * generic RecordForm's static JSON-Schema enum can't express, and adding a
 * participant needs a contact-search picker RecordForm has no field type
 * for — so this is a bespoke form rather than a `schema` render, styled with
 * the same `record-form*` classes RecordForm uses for a consistent look.
 *
 * Participant add/role-change/remove are immediate API calls (like the
 * "Save notes" button on the read-only detail panel above), not staged into
 * the form's own Save — the submission has to exist first, and there is no
 * reason to make a role change wait on unrelated title/description edits.
 */
export function SubmissionEditForm({ initialValues, onSubmit, onCancel, onDelete, title, onDirtyChange }: CreateFormProps) {
  const id = typeof initialValues?.id === 'string' ? initialValues.id : undefined

  const [detail, setDetail] = useState<SubmissionDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tracks, setTracks] = useState<TrackRow[]>([])
  const [rooms, setRooms] = useState<RoomRow[]>([])

  const [fields, setFields] = useState({
    title: typeof initialValues?.title === 'string' ? initialValues.title : '',
    description: typeof initialValues?.description === 'string' ? initialValues.description : '',
    format: typeof initialValues?.format === 'string' ? initialValues.format : '',
    level: typeof initialValues?.level === 'string' ? initialValues.level : '',
    language: typeof initialValues?.language === 'string' ? initialValues.language : '',
    track_id: typeof initialValues?.track_id === 'string' ? initialValues.track_id : '',
    room_id: '',
  })
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    Promise.all([getSubmissionDetail(id), listTracks(), listRooms()])
      .then(([d, t, r]) => {
        if (cancelled) return
        setDetail(d)
        setTracks(t.items)
        setRooms(r.items)
        const roomId = typeof d.submission.room_id === 'string' ? d.submission.room_id : ''
        setFields((prev) => ({ ...prev, room_id: roomId }))
      })
      .catch((e: unknown) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load') })
    return () => { cancelled = true }
  }, [id])

  const setField = (key: keyof typeof fields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }))
    onDirtyChange?.(true)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitError(null)
    if (!fields.title.trim()) {
      setSubmitError('Title is required.')
      return
    }
    setIsSubmitting(true)
    try {
      const ok = await onSubmit({
        title: fields.title.trim(),
        description: fields.description.trim() || null,
        format: fields.format.trim() || null,
        level: fields.level.trim() || null,
        language: fields.language.trim() || null,
        track_id: fields.track_id || null,
        room_id: fields.room_id || null,
      })
      if (!ok) setSubmitError('The submission could not be saved.')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unexpected error.')
    } finally {
      setIsSubmitting(false)
    }
  }

  // --- Participants -------------------------------------------------------
  const [participantError, setParticipantError] = useState<string | null>(null)
  const [addingRole, setAddingRole] = useState<string>('co-speaker')
  const [contactQuery, setContactQuery] = useState('')
  const [contactResults, setContactResults] = useState<ContactRow[]>([])
  const [busyParticipantId, setBusyParticipantId] = useState<string | null>(null)

  const refreshDetail = async () => {
    if (!id) return
    setDetail(await getSubmissionDetail(id))
  }

  const searchContacts = async (q: string) => {
    setContactQuery(q)
    if (!q.trim()) {
      setContactResults([])
      return
    }
    const result = await queryResource<ContactRow>('contacts')({ from: 0, size: 8, filters: { q } })
    setContactResults(result.items)
  }

  const addParticipant = async (contact: ContactRow) => {
    if (!id) return
    setParticipantError(null)
    try {
      await addSubmissionParticipant(id, { contact_id: contact.id, role: addingRole })
      await refreshDetail()
      setContactQuery('')
      setContactResults([])
    } catch (err) {
      setParticipantError(err instanceof Error ? err.message : 'Could not add participant.')
    }
  }

  const changeRole = async (participantId: string, role: string) => {
    if (!id) return
    setBusyParticipantId(participantId)
    setParticipantError(null)
    try {
      await updateSubmissionParticipantRole(id, participantId, role)
      await refreshDetail()
    } catch (err) {
      setParticipantError(err instanceof Error ? err.message : 'Could not change role.')
    } finally {
      setBusyParticipantId(null)
    }
  }

  const removeParticipant = async (participantId: string, name: string) => {
    if (!id) return
    const confirmed = await appConfirm(`Remove ${name} from this submission?`, {
      title: 'Remove participant',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!confirmed) return
    setBusyParticipantId(participantId)
    setParticipantError(null)
    try {
      await removeSubmissionParticipant(id, participantId)
      await refreshDetail()
    } catch (err) {
      setParticipantError(err instanceof Error ? err.message : 'Could not remove participant.')
    } finally {
      setBusyParticipantId(null)
    }
  }

  return (
    <form className="record-form" onSubmit={handleSubmit} noValidate>
      <div className="record-form-header">
        <h2>{title}</h2>
      </div>
      {submitError && <div className="record-form-submit-error" role="alert"><span>{submitError}</span></div>}
      <div className="record-form-fields">
        <div className="record-form-field">
          <label htmlFor="sub-edit-title">Title<span className="record-form-required" aria-hidden="true"> *</span></label>
          <input id="sub-edit-title" value={fields.title} disabled={isSubmitting} onChange={(e) => setField('title', e.target.value)} />
        </div>
        <div className="record-form-field">
          <label htmlFor="sub-edit-desc">Description</label>
          <textarea id="sub-edit-desc" rows={4} value={fields.description} disabled={isSubmitting} onChange={(e) => setField('description', e.target.value)} />
        </div>
        <div className="record-form-field">
          <label htmlFor="sub-edit-format">Format</label>
          <input id="sub-edit-format" value={fields.format} disabled={isSubmitting} onChange={(e) => setField('format', e.target.value)} />
        </div>
        <div className="record-form-field">
          <label htmlFor="sub-edit-level">Level</label>
          <input id="sub-edit-level" value={fields.level} disabled={isSubmitting} onChange={(e) => setField('level', e.target.value)} />
        </div>
        <div className="record-form-field">
          <label htmlFor="sub-edit-language">Language</label>
          <input id="sub-edit-language" value={fields.language} disabled={isSubmitting} onChange={(e) => setField('language', e.target.value)} />
        </div>
        <div className="record-form-field">
          <label htmlFor="sub-edit-track">Track</label>
          <select id="sub-edit-track" value={fields.track_id} disabled={isSubmitting} onChange={(e) => setField('track_id', e.target.value)}>
            <option value="">— No track —</option>
            {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="record-form-field">
          <label htmlFor="sub-edit-room">Room</label>
          <select id="sub-edit-room" value={fields.room_id} disabled={isSubmitting} onChange={(e) => setField('room_id', e.target.value)}>
            <option value="">— No room —</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      </div>

      <h2 style={{ fontSize: 14 }}>Participants</h2>
      {loadError && <p className="record-form-error" role="alert">{loadError}</p>}
      {participantError && <p className="record-form-error" role="alert">{participantError}</p>}
      {detail?.participants.map((p) => {
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email
        return (
          <div className="part-row" key={p.participant_id}>
            <ParticipantHeadshot p={p} />
            <strong>{name}</strong>
            <select
              aria-label={`Role for ${name}`}
              value={p.role}
              disabled={busyParticipantId === p.participant_id}
              onChange={(e) => void changeRole(p.participant_id, e.target.value)}
            >
              {PARTICIPANT_ROLES.map((role) => <option key={role} value={role}>{readableRole(role)}</option>)}
            </select>
            {p.is_primary_contact === 1 && <span style={{ color: 'var(--text-muted)' }}>primary</span>}
            <button
              type="button"
              className="record-form-delete"
              disabled={busyParticipantId === p.participant_id}
              onClick={() => void removeParticipant(p.participant_id, name)}
            >
              Remove
            </button>
          </div>
        )
      })}
      {(!detail || detail.participants.length === 0) && !loadError && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No participants yet.</p>
      )}

      <div className="record-form-field" style={{ marginTop: 8 }}>
        <label htmlFor="sub-edit-add-participant">Add participant</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="sub-edit-add-participant"
            placeholder="Search speakers by name or email…"
            value={contactQuery}
            onChange={(e) => void searchContacts(e.target.value)}
            autoComplete="off"
          />
          <select aria-label="Role to add" value={addingRole} onChange={(e) => setAddingRole(e.target.value)}>
            {PARTICIPANT_ROLES.map((role) => <option key={role} value={role}>{readableRole(role)}</option>)}
          </select>
        </div>
        {contactResults.length > 0 && (
          <ul className="contact-picker-results">
            {contactResults.map((c) => {
              const already = detail?.participants.some((p) => p.contact_id === c.id)
              const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email
              return (
                <li key={c.id}>
                  <button type="button" disabled={already} onClick={() => void addParticipant(c)}>
                    {name} — {c.email}{already ? ' (already added)' : ''}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Submission-scoped uploads and reviews, same as the read-only detail
          panel — the edit form doesn't need its own copy of that logic. */}
      {id && <SubmissionFilesPanel submissionId={id} />}

      <div className="record-form-actions">
        {onDelete && (
          <button type="button" className="record-form-delete" onClick={onDelete} disabled={isSubmitting}>
            Delete
          </button>
        )}
        <span className="record-form-actions-spacer" />
        <button type="button" className="record-form-cancel" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </button>
        <button type="submit" className="record-form-submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

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
  setSubmissionParticipantConfirmed,
  updateSubmission,
  updateSubmissionNotes,
  updateSubmissionParticipantRole,
  updateSubmissionStatus,
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

/**
 * Tasks tab status filter (baseline defect: "the organizer Tasks list has no
 * complete/incomplete status filter ... Only column sorting is available").
 * `open` has no single matching value in adminApi.ts's tasks `status` filter
 * (which only takes the raw assignment statuses `not_started`/`in_progress`/
 * `complete`) — App.tsx's `tasksDataSourceWithStatusFilter` is what turns
 * this chip's `open`/`complete`/`overdue` value into the actual query.
 */
export function TaskStatusFilter({ filters, setFilters }: DataListFilterProps<Record<string, string>>) {
  const active = filters.taskState ?? ''
  const choose = (value: string) => setFilters((prev) => ({ ...prev, taskState: value }))
  return (
    <div className="chip-filter" role="group" aria-label="Task status filter">
      <button className={active === '' ? 'active' : ''} aria-pressed={active === ''} onClick={() => choose('')}>
        All
      </button>
      <button className={active === 'open' ? 'active' : ''} aria-pressed={active === 'open'} onClick={() => choose('open')}>
        Open
      </button>
      <button className={active === 'complete' ? 'active' : ''} aria-pressed={active === 'complete'} onClick={() => choose('complete')}>
        Complete
      </button>
      <button className={active === 'overdue' ? 'active' : ''} aria-pressed={active === 'overdue'} onClick={() => choose('overdue')}>
        Overdue
      </button>
    </div>
  )
}

/** Roster filter for the Speakers tab's derived `confirmation` column (SPK-04):
 * confirmed / awaiting a submission_participants.confirmed_at row, or "All"
 * (no filter — includes non-participants, whose column reads "—"). */
export function ConfirmationChipsFilter({ filters, setFilters }: DataListFilterProps<Record<string, string>>) {
  const active = filters.confirmation ?? ''
  const choose = (value: string) => setFilters((prev) => ({ ...prev, confirmation: value }))
  return (
    <div className="chip-filter" role="group" aria-label="Confirmation filter">
      <button className={active === '' ? 'active' : ''} aria-pressed={active === ''} onClick={() => choose('')}>
        All
      </button>
      <button className={active === 'confirmed' ? 'active' : ''} aria-pressed={active === 'confirmed'} onClick={() => choose('confirmed')}>
        Confirmed
      </button>
      <button className={active === 'awaiting' ? 'active' : ''} aria-pressed={active === 'awaiting'} onClick={() => choose('awaiting')}>
        Awaiting
      </button>
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

/**
 * Add / change-role / confirm / remove participants for one submission.
 *
 * Extracted from `SubmissionEditForm` so the read-only-looking detail tab can
 * render it too (eval defect AIA-04: "No UI exists anywhere to link a
 * speaker/participant to a submission" — the controls did exist, but only
 * behind a row *double*-click, while a single click opens the detail tab; the
 * detail tab's Participants section was a bare list with no add control, so an
 * exhaustive search concluded the feature was missing).
 *
 * Every action here is an immediate API call rather than staged form state:
 * the submission already exists, and a role change has no reason to wait on
 * unrelated title/abstract edits.
 */
export function ParticipantsEditor({
  submissionId,
  participants,
  onChanged,
  idPrefix = 'sub-edit',
}: {
  submissionId: string
  participants: SubmissionDetail['participants']
  onChanged: () => void | Promise<void>
  /** Distinguishes the label/input ids when both surfaces are mounted. */
  idPrefix?: string
}) {
  const [participantError, setParticipantError] = useState<string | null>(null)
  const [addingRole, setAddingRole] = useState<string>('co-speaker')
  const [contactQuery, setContactQuery] = useState('')
  const [contactResults, setContactResults] = useState<ContactRow[]>([])
  const [busyParticipantId, setBusyParticipantId] = useState<string | null>(null)

  const searchContacts = async (q: string) => {
    setContactQuery(q)
    if (!q.trim()) {
      setContactResults([])
      return
    }
    try {
      const result = await queryResource<ContactRow>('contacts')({ from: 0, size: 8, filters: { q } })
      setContactResults(result.items)
    } catch (err) {
      setParticipantError(err instanceof Error ? err.message : 'Could not search speakers.')
    }
  }

  const addParticipant = async (contact: ContactRow) => {
    setParticipantError(null)
    try {
      await addSubmissionParticipant(submissionId, { contact_id: contact.id, role: addingRole })
      await onChanged()
      setContactQuery('')
      setContactResults([])
    } catch (err) {
      setParticipantError(err instanceof Error ? err.message : 'Could not add participant.')
    }
  }

  const changeRole = async (participantId: string, role: string) => {
    setBusyParticipantId(participantId)
    setParticipantError(null)
    try {
      await updateSubmissionParticipantRole(submissionId, participantId, role)
      await onChanged()
    } catch (err) {
      setParticipantError(err instanceof Error ? err.message : 'Could not change role.')
    } finally {
      setBusyParticipantId(null)
    }
  }

  // SPK-04/w2: the only place an organiser can set a speaker's confirmed
  // status — see setSubmissionParticipantConfirmed in api.ts for why this
  // control didn't exist before.
  const toggleConfirmed = async (participantId: string, next: boolean) => {
    setBusyParticipantId(participantId)
    setParticipantError(null)
    try {
      await setSubmissionParticipantConfirmed(submissionId, participantId, next)
      await onChanged()
    } catch (err) {
      setParticipantError(err instanceof Error ? err.message : 'Could not update confirmation.')
    } finally {
      setBusyParticipantId(null)
    }
  }

  const removeParticipant = async (participantId: string, name: string) => {
    const confirmed = await appConfirm(`Remove ${name} from this submission?`, {
      title: 'Remove participant',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!confirmed) return
    setBusyParticipantId(participantId)
    setParticipantError(null)
    try {
      await removeSubmissionParticipant(submissionId, participantId)
      await onChanged()
    } catch (err) {
      setParticipantError(err instanceof Error ? err.message : 'Could not remove participant.')
    } finally {
      setBusyParticipantId(null)
    }
  }

  const addInputId = `${idPrefix}-add-participant`

  return (
    <div className="participants-editor">
      {participantError && <p className="record-form-error" role="alert">{participantError}</p>}
      {participants.map((p) => {
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email
        return (
          <div className="part-row" key={p.participant_id}>
            <ParticipantHeadshot p={p} />
            <strong>{name}</strong>
            <select
              aria-label={`Role for ${name}`}
              value={p.role}
              disabled={busyParticipantId === p.participant_id}
              onChange={(e) => void changeRole(p.participant_id, (e.target as HTMLSelectElement).value)}
            >
              {PARTICIPANT_ROLES.map((role) => <option key={role} value={role}>{readableRole(role)}</option>)}
            </select>
            {p.is_primary_contact === 1 && <span style={{ color: 'var(--text-muted)' }}>primary</span>}
            <button
              type="button"
              aria-pressed={p.confirmed_at !== null}
              disabled={busyParticipantId === p.participant_id}
              onClick={() => void toggleConfirmed(p.participant_id, p.confirmed_at === null)}
              title={p.confirmed_at ? `Confirmed ${fmtDate(p.confirmed_at)}` : 'Not yet confirmed'}
            >
              {p.confirmed_at ? 'Confirmed ✓' : 'Mark confirmed'}
            </button>
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
      {participants.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No participants yet.</p>
      )}

      <div className="record-form-field" style={{ marginTop: 8 }}>
        <label htmlFor={addInputId}>Add participant</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id={addInputId}
            placeholder="Search speakers by name or email…"
            value={contactQuery}
            onChange={(e) => void searchContacts((e.target as HTMLInputElement).value)}
            autoComplete="off"
          />
          <select
            aria-label="Role to add"
            value={addingRole}
            onChange={(e) => setAddingRole((e.target as HTMLSelectElement).value)}
          >
            {PARTICIPANT_ROLES.map((role) => <option key={role} value={role}>{readableRole(role)}</option>)}
          </select>
        </div>
        {contactResults.length > 0 && (
          <ul className="contact-picker-results">
            {contactResults.map((c) => {
              const already = participants.some((p) => p.contact_id === c.id)
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
    </div>
  )
}

/**
 * Submission detail tab: answers, participants with roles, review summary —
 * plus the controls an organiser reaches for straight after opening a record.
 *
 * This panel is what a single row click opens, so it can't be read-only: an
 * "Edit" button (DataTabManager hands `onEdit` to every detail component whose
 * tab config has `onUpsert` + `schema` — the submissions tab has both) opens
 * the full SubmissionEditForm for title/abstract editing (CNT-09), the
 * participants section is directly actionable (AIA-04), and the public-agenda
 * gate and status are editable in place (CNT-12).
 */
export function SubmissionDetailPanel({ id, onEdit, onItemSaved }: {
  id: string
  /** Opens the edit tab; omitted in read-only hosts. */
  onEdit?: () => void
  /** Lets the tab manager refresh the parent list after an in-panel save. */
  onItemSaved?: (item: Record<string, unknown>) => void
}) {
  const [detail, setDetail] = useState<SubmissionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [savedNotes, setSavedNotes] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesError, setNotesError] = useState<string | null>(null)
  /** Inline save feedback for the status / visibility controls. */
  const [fieldSaving, setFieldSaving] = useState(false)
  const [fieldSaved, setFieldSaved] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)

  const load = async () => {
    const d = await getSubmissionDetail(id)
    setDetail(d)
    return d
  }

  useEffect(() => {
    setDetail(null)
    setNotesError(null)
    setFieldError(null)
    setFieldSaved(false)
    getSubmissionDetail(id)
      .then((d) => {
        setDetail(d)
        const initialNotes = typeof d.submission.notes === 'string' ? d.submission.notes : ''
        setNotes(initialNotes)
        setSavedNotes(initialNotes)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  /**
   * Run one field write, refresh the panel from the server (so the header
   * chip/checkbox reflect what was actually stored) and tell the tab manager
   * so the parent grid row updates too.
   */
  const saveField = async (write: () => Promise<unknown>) => {
    setFieldSaving(true)
    setFieldSaved(false)
    setFieldError(null)
    try {
      await write()
      const fresh = await load()
      onItemSaved?.(fresh.submission)
      setFieldSaved(true)
    } catch (e) {
      setFieldError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setFieldSaving(false)
    }
  }

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

      {/* CNT-09/CNT-12: the actions an organiser wants the moment the record
          opens. "Edit" is first and unmissable — everything the bespoke form
          offers (title, abstract, track, room) was otherwise reachable only by
          a row double-click nobody discovers. */}
      <div className="detail-actions submission-detail-actions">
        {onEdit && (
          <button type="button" className="primary" onClick={onEdit}>
            Edit submission
          </button>
        )}
        <label htmlFor="sub-detail-status">Status</label>
        <select
          id="sub-detail-status"
          className={`status-edit status-chip status-${String(s.status)}`}
          value={String(s.status)}
          disabled={fieldSaving}
          onChange={(e) => {
            const next = (e.target as HTMLSelectElement).value
            void saveField(() => updateSubmissionStatus(id, next))
          }}
        >
          {SUBMISSION_STATUSES.map((st) => (
            <option key={st} value={st}>{statusLabel(st)}</option>
          ))}
        </select>
        <label htmlFor="sub-detail-content-approved" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            id="sub-detail-content-approved"
            type="checkbox"
            checked={s.content_approved !== 0}
            disabled={fieldSaving}
            onChange={(e) => {
              const next = (e.target as HTMLInputElement).checked
              void saveField(() => updateSubmission(id, { content_approved: next }))
            }}
          />
          Visible in public agenda
        </label>
        {fieldSaving && <span className="detail-save-note" role="status">Saving…</span>}
        {!fieldSaving && fieldSaved && <span className="detail-save-note" role="status">Saved</span>}
        {fieldError && <span className="internal-notes-error" role="alert">{fieldError}</span>}
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
      {/* AIA-04: previously a bare list with no add/remove control at all. */}
      <ParticipantsEditor
        submissionId={id}
        participants={detail.participants}
        onChanged={async () => { await load() }}
        idPrefix="sub-detail"
      />

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
 * Submission edit/create form (F14/ABS-11; theme-E create-form gap: the "+
 * New" submission form had no track/status field, and a manually-created
 * record could never be linked to a track or given a non-default status).
 * Opened on row double-click via `TabConfig.editComponent` AND on "+ New"
 * via `TabConfig.createComponent` — `id` (from `initialValues.id`) tells the
 * two modes apart. Track/room are dynamic per-event lists the generic
 * RecordForm's static JSON-Schema enum can't express (no id→label mapping),
 * and adding a participant needs a contact-search picker RecordForm has no
 * field type for — so this is a bespoke form rather than a `schema` render,
 * styled with the same `record-form*` classes RecordForm uses for a
 * consistent look.
 *
 * Participant add/role-change/remove are immediate API calls (like the
 * "Save notes" button on the detail panel above), not staged into the form's
 * own Save — the submission has to exist first, and there is no reason to
 * make a role change wait on unrelated title/description edits (and hence
 * never apply in create mode, before the record exists). The controls
 * themselves now live in the shared `ParticipantsEditor`, which the detail
 * panel renders too.
 */
export function SubmissionEditForm({ initialValues, onSubmit, onCancel, onDelete, title, onDirtyChange }: CreateFormProps) {
  const id = typeof initialValues?.id === 'string' ? initialValues.id : undefined
  const isCreate = !id

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
    // Theme-E: only meaningful (and only shown) on create — an existing
    // submission's status is changed via the Submissions grid's inline
    // dropdown (App.tsx's `status` column), which also fires decision-queue
    // side effects the plain field PUT below doesn't. See the App.tsx
    // `onUpsert` doc comment for how a non-default create-time status is
    // applied as a second call.
    status: typeof initialValues?.status === 'string' ? initialValues.status : 'pending',
  })
  // CNT-12/w3: content_approved (0010 migration) gates the public feeds
  // independently of acceptance status — default-on so existing/imported
  // rows stay visible; see the migration comment for full semantics.
  const [contentApproved, setContentApproved] = useState(initialValues?.content_approved !== 0)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Track/room pickers need the event's lists whether creating or editing;
  // only the existing-record detail (participants, reviews, files, the
  // room already on the record) is conditional on an id existing yet.
  useEffect(() => {
    let cancelled = false
    listTracks()
      .then((t) => { if (!cancelled) setTracks(t.items) })
      .catch(() => {})
    listRooms()
      .then((r) => { if (!cancelled) setRooms(r.items) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    getSubmissionDetail(id)
      .then((d) => {
        if (cancelled) return
        setDetail(d)
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
        content_approved: contentApproved,
        // Only sent on create — see `fields.status`'s doc comment. Reading
        // App.tsx's submissions `onUpsert`, an edit ignores this key.
        ...(isCreate ? { status: fields.status } : {}),
      })
      if (!ok) setSubmitError('The submission could not be saved.')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unexpected error.')
    } finally {
      setIsSubmitting(false)
    }
  }

  // --- Participants -------------------------------------------------------
  // The controls themselves live in `ParticipantsEditor` above, shared with
  // the detail tab; the form only owns refreshing its own copy of the detail.
  const refreshDetail = async () => {
    if (!id) return
    setDetail(await getSubmissionDetail(id))
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
        {isCreate && (
          <div className="record-form-field">
            <label htmlFor="sub-edit-status">Status</label>
            <select id="sub-edit-status" value={fields.status} disabled={isSubmitting} onChange={(e) => setField('status', e.target.value)}>
              {SUBMISSION_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </div>
        )}
        <div className="record-form-field">
          <label htmlFor="sub-edit-room">Room</label>
          <select id="sub-edit-room" value={fields.room_id} disabled={isSubmitting} onChange={(e) => setField('room_id', e.target.value)}>
            <option value="">— No room —</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="record-form-field">
          <label htmlFor="sub-edit-content-approved" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              id="sub-edit-content-approved"
              type="checkbox"
              checked={contentApproved}
              disabled={isSubmitting}
              onChange={(e) => { setContentApproved(e.target.checked); onDirtyChange?.(true) }}
            />
            Visible in public agenda
          </label>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '2px 0 0' }}>
            Independent of acceptance status — uncheck to hold an accepted, scheduled
            session back from the public feeds without rejecting it.
          </p>
        </div>
      </div>

      {/* Add/remove-participant controls (SPK-11, CFP-13/15): the record has
          to exist first — an unsaved create tab has no submission id yet for
          `addSubmissionParticipant` to attach to — so this whole section
          only renders once editing an existing submission. */}
      {!isCreate && (
      <>
      <h2 style={{ fontSize: 14 }}>Participants</h2>
      {loadError && <p className="record-form-error" role="alert">{loadError}</p>}
      <ParticipantsEditor
        submissionId={id!}
        participants={detail?.participants ?? []}
        onChanged={refreshDetail}
        idPrefix="sub-edit"
      />
      </>
      )}

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

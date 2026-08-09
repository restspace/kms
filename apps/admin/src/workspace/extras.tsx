import { useEffect, useState, type ReactNode } from 'react'
import type { DataListFilterProps } from '../components/DataList'
import { getSubmissionDetail, updateSubmissionNotes, type SubmissionDetail } from '../api'
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
    if (Array.isArray(v)) return v.join(', ')
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
        {detail.answers.map((a, i) => (
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
          <strong>{[p.first_name, p.last_name].filter(Boolean).join(' ') || p.email}</strong>
          <span style={{ color: 'var(--text-muted)' }}>
            {p.role}{p.is_primary_contact === 1 ? ' · primary' : ''}
          </span>
          <span className="part-flags">
            {p.has_bio === 1 ? 'bio ✓' : 'bio –'} · {p.has_headshot === 1 ? 'headshot ✓' : 'headshot –'}
          </span>
        </div>
      ))}

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

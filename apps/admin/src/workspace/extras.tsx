import { useEffect, useState } from 'react'
import type { DataListFilterProps } from '../components/DataList'
import { getSubmissionDetail, type SubmissionDetail } from '../api'
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
      <button className={active === '' ? 'active' : ''} onClick={() => choose('')}>
        All
      </button>
      {SUBMISSION_STATUSES.map((s) => (
        <button key={s} className={active === s ? 'active' : ''} onClick={() => choose(s)}>
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

/** Submission detail tab: answers, participants with roles, review summary. */
export function SubmissionDetailPanel({ id }: { id: string }) {
  const [detail, setDetail] = useState<SubmissionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    getSubmissionDetail(id)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

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
        {s.format ? <><dt>Format</dt><dd>{String(s.format)}</dd></> : null}
        {s.track_name ? <><dt>Track</dt><dd>{String(s.track_name)}</dd></> : null}
        {s.plan_name ? <><dt>Evaluation plan</dt><dd>{String(s.plan_name)}</dd></> : null}
        {detail.tags.length > 0 && <><dt>Tags</dt><dd>{detail.tags.join(', ')}</dd></>}
        {detail.answers.map((a, i) => (
          <span key={i} style={{ display: 'contents' }}>
            <dt>{a.label}</dt>
            <dd>{answerText(a.value_json)}</dd>
          </span>
        ))}
      </dl>

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

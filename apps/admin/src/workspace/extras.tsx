import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { DataListFilterProps } from '../components/DataList'
import type { CreateFormProps } from '../components/DataTabManager'
import { appConfirm } from '../components/dialogs'
import {
  addSubmissionComment,
  addSubmissionParticipant,
  getMaterialsOwners,
  getSubmissionDetail,
  getSubmissionFileComments,
  getSubmissionRevisions,
  listFormats,
  listRooms,
  listTracks,
  PARTICIPANT_ROLES,
  queryResource,
  removeSubmissionParticipant,
  setSubmissionParticipantConfirmed,
  updateSubmission,
  updateSubmissionApproval,
  updateSubmissionCondition,
  updateSubmissionDecision,
  updateSubmissionIntroScript,
  updateSubmissionMaterials,
  updateSubmissionNotes,
  updateSubmissionParticipantRole,
  updateSubmissionStatus,
  type ContactRow,
  type RoomRow,
  type SubmissionComment,
  type SubmissionDetail,
  type SubmissionFileComment,
  type TrackRow,
} from '../api'
import { LobbyRail } from '../review/LobbyQueue'
import { SubmissionFilesPanel } from './FilePanels'
import './files.css'
import './review.css'

/**
 * M3 workspace pieces: the status filter chips (docs/06 §1 status tabs as
 * chips), the bulk-action bar and the submission detail tab.
 */

/**
 * Rich-text answers (wysiwyg description fields) reach the detail as an HTML
 * string; rendering it as a React child shows literal '<p>…</p>' tags
 * (CNT eval, SESS-1). Reduce to plain text with paragraph/line breaks kept as
 * newlines — same approach as App.tsx's stripHtml, plus break preservation.
 */
const htmlToText = (html: string): string => {
  if (!/[<>]/.test(html)) return html
  const el = document.createElement('div')
  el.innerHTML = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
  return (el.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

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

/** Workplan 13 W3 (D4) vocabulary — must track routes/evaluation.ts's
 * APPROVAL_STATES, duplicated client-side like SUBMISSION_STATUSES above. */
export const APPROVAL_STATES = ['pending', 'granted', 'refused'] as const

const APPROVAL_CHIP: Record<string, { className: string; label: string }> = {
  pending: { className: 'status-pending', label: 'Approval pending' },
  granted: { className: 'status-accepted', label: 'Approval granted' },
  refused: { className: 'status-declined', label: 'Approval refused' },
}

/** Workplan 15 W5a (D9) vocabulary — tracks routes/adminApi.ts's
 *  MATERIALS_STATES, duplicated client-side like APPROVAL_STATES above.
 *  'received' is listed because it must be *displayable*; it is set by an
 *  upload, never by a person, so the editor below offers it read-only. */
export const MATERIALS_STATES = ['received', 'reviewed', 'revision_requested', 'final'] as const

const MATERIALS_CHIP: Record<string, { className: string; label: string }> = {
  received: { className: 'status-pending', label: 'Deck received' },
  reviewed: { className: 'status-pending', label: 'Deck reviewed' },
  revision_requested: { className: 'status-declined', label: 'Revision requested' },
  final: { className: 'status-accepted', label: 'Deck final' },
}

/** Single-select status chips; the tab count tracks the active chip. */
export function StatusChipsFilter({ filters, setFilters }: DataListFilterProps<Record<string, string>>) {
  const active = filters.status ?? ''
  const choose = (value: string) => setFilters((prev) => ({ ...prev, status: value }))
  const reviseOn = filters.decision_outcome === 'revise'
  const conditionOn = filters.condition_outstanding === 'true'
  const toggle = (key: string, value: string) =>
    setFilters((prev) => ({ ...prev, [key]: prev[key] === value ? '' : value }))
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
      {/* Workplan 15 W2/W3: two flags that no status value can express (D4/D5)
        * — a revise row reads 'Declined' in the status column, and a condition
        * is orthogonal to the accept it hangs off. Independent toggles, so
        * they compose with whichever status chip is active. */}
      <button
        className={reviseOn ? 'active' : ''}
        aria-pressed={reviseOn}
        title="Declines flagged revise-and-resubmit — the status column still reads Declined (D5)"
        onClick={() => toggle('decision_outcome', 'revise')}
      >
        Revise &amp; resubmit
      </button>
      <button
        className={conditionOn ? 'active' : ''}
        aria-pressed={conditionOn}
        title="Accepts carrying a condition nobody has marked met yet"
        onClick={() => toggle('condition_outstanding', 'true')}
      >
        Condition outstanding
      </button>
    </div>
  )
}

/** Workplan 13 W2: the coverage bar's "read enough" threshold — two reads. */
const COVERAGE_MIN_READS = 2

/**
 * Review-coverage bar for the Submissions tab header (workplan 13 W2):
 * `n of m have ≥2 reads`. Both numbers come from the same query endpoint and
 * the same `min_reviews` filter the grid uses, so the bar and the list cannot
 * disagree; the "Under-reviewed" chip below applies the matching
 * `max_reviews` filter — the actual worklist.
 */
function SubmissionCoverageBar({
  filters,
  eventFilterId,
}: {
  filters: Record<string, unknown>
  eventFilterId?: string | null
}) {
  const [coverage, setCoverage] = useState<{ covered: number; total: number } | null>(null)
  const base: Record<string, unknown> = { ...filters }
  delete base.min_reviews
  delete base.max_reviews
  if (eventFilterId) base.event_id = eventFilterId
  const signature = JSON.stringify(base)

  useEffect(() => {
    let cancelled = false
    const parsed = JSON.parse(signature) as Record<string, unknown>
    const query = queryResource<Record<string, unknown>>('submissions')
    Promise.all([
      query({ from: 0, size: 1, filters: parsed }),
      query({ from: 0, size: 1, filters: { ...parsed, min_reviews: COVERAGE_MIN_READS } }),
    ])
      .then(([all, covered]) => {
        if (!cancelled) setCoverage({ total: all.total, covered: covered.total })
      })
      .catch(() => {
        if (!cancelled) setCoverage(null)
      })
    return () => {
      cancelled = true
    }
  }, [signature])

  if (!coverage || coverage.total === 0) return null
  const pct = Math.round((coverage.covered / coverage.total) * 100)
  return (
    <div
      className="coverage-bar"
      role="status"
      title={`Review coverage: ${coverage.covered} of ${coverage.total} submissions have at least ${COVERAGE_MIN_READS} reviews`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 12, fontSize: 12, color: 'var(--text-muted)' }}
    >
      <span>
        {coverage.covered} of {coverage.total} have ≥{COVERAGE_MIN_READS} reads
      </span>
      <span
        aria-hidden="true"
        style={{ display: 'inline-block', width: 96, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}
      >
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
      </span>
    </div>
  )
}

/**
 * Slot counter strip (workplan 15 W1a): one chip per track carrying a target
 * — `Agents 12/15` — plus the total accepted on everything untracked.
 *
 * Counts are `status IN ('accepted','accept_queue')` (D2, the resource's
 * `decision_accepted` filter): the strip exists to run *during* the decision
 * meeting, where the last ten minutes of accepts are still queued and unsent,
 * and counting only 'accepted' would make it read zero on the one screen it
 * is for. Every count goes through the same query endpoint and the same
 * filters as the grid, so the strip and the list cannot disagree — the rule
 * the coverage bar above follows.
 *
 * D1: a target, never a cap. Over target renders in the error tone and blocks
 * nothing — no modal, no refused save, anywhere.
 */
function SlotCounterStrip({
  filters,
  eventFilterId,
}: {
  filters: Record<string, unknown>
  eventFilterId?: string | null
}) {
  const [tracks, setTracks] = useState<TrackRow[] | null>(null)
  const [counts, setCounts] = useState<{ byTrack: Record<string, number>; total: number } | null>(null)

  // The strip sets its own status and track scope; everything else the grid is
  // filtered by (search text, tag, event) is carried through unchanged.
  const base: Record<string, unknown> = { ...filters }
  delete base.status
  delete base.track_id
  delete base.decision_accepted
  if (eventFilterId) base.event_id = eventFilterId
  const signature = JSON.stringify(base)

  // Tracks belong to the session's event — the decision meeting is a
  // one-event act, so this is deliberately not re-fetched per event filter.
  useEffect(() => {
    let cancelled = false
    listTracks()
      .then((r) => !cancelled && setTracks(r.items))
      .catch(() => !cancelled && setTracks([]))
    return () => {
      cancelled = true
    }
  }, [])

  const targeted = (tracks ?? []).filter((t) => t.target_slots !== null)
  const trackIds = targeted.map((t) => t.id).join(',')

  useEffect(() => {
    if (tracks === null) return
    let cancelled = false
    const parsed = JSON.parse(signature) as Record<string, unknown>
    const query = queryResource<Record<string, unknown>>('submissions')
    const ids = trackIds === '' ? [] : trackIds.split(',')
    Promise.all([
      query({ from: 0, size: 1, filters: { ...parsed, decision_accepted: true } }),
      ...ids.map((id) => query({ from: 0, size: 1, filters: { ...parsed, decision_accepted: true, track_id: id } })),
    ])
      .then(([all, ...perTrack]) => {
        if (cancelled) return
        const byTrack: Record<string, number> = {}
        ids.forEach((id, i) => {
          byTrack[id] = perTrack[i]?.total ?? 0
        })
        setCounts({ byTrack, total: all.total })
      })
      .catch(() => {
        if (!cancelled) setCounts(null)
      })
    return () => {
      cancelled = true
    }
  }, [signature, trackIds, tracks])

  if (targeted.length === 0 || !counts) return null
  // Whatever the targeted tracks do not account for: no track at all, or a
  // track nobody set a target on. Both are "not being counted down", which is
  // the one number this strip owes the room beyond its chips.
  const untracked = counts.total - targeted.reduce((sum, t) => sum + (counts.byTrack[t.id] ?? 0), 0)
  return (
    <div
      className="slot-counter"
      role="status"
      aria-label="Accepted slots by track"
      title="Accepted or queued, counted against each track's target — a target, not a cap"
    >
      {targeted.map((t) => {
        const filled = counts.byTrack[t.id] ?? 0
        const target = t.target_slots as number
        const tone = filled > target ? 'status-declined' : filled === target ? 'status-accepted' : 'status-pending'
        return (
          <span key={t.id} className={`status-chip ${tone}`}>
            {t.name} {filled}/{target}
          </span>
        )
      })}
      {untracked > 0 && <span className="status-chip status-draft">Untracked {untracked}</span>}
    </div>
  )
}

/**
 * The Submissions tab's filter row: the status chips plus the coverage
 * worklist chip ("everything with fewer than two reads" as a filter, not just
 * a sort — workplan 13 W2) and the coverage bar reading the same filters.
 * `eventFilterId` arrives via filterConfig.filterProps so the bar's counts
 * are scoped exactly like the grid's own dataSource.
 */
export function SubmissionsFilter({
  filters,
  setFilters,
  eventFilterId,
}: DataListFilterProps<Record<string, unknown>> & { eventFilterId?: string | null }) {
  const underReviewed = filters.max_reviews === COVERAGE_MIN_READS - 1
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
      <StatusChipsFilter
        filters={filters as Record<string, string>}
        setFilters={setFilters as DataListFilterProps<Record<string, string>>['setFilters']}
        resetFilters={() =>
          setFilters((prev) => {
            const next: Record<string, unknown> = { ...prev, status: '' }
            delete next.max_reviews
            return next
          })
        }
      />
      <div className="chip-filter" role="group" aria-label="Review coverage filter">
        <button
          className={underReviewed ? 'active' : ''}
          aria-pressed={underReviewed}
          title={`Only submissions with fewer than ${COVERAGE_MIN_READS} reviews — the coverage worklist`}
          onClick={() =>
            setFilters((prev) => {
              const next = { ...prev }
              if (underReviewed) delete next.max_reviews
              else next.max_reviews = COVERAGE_MIN_READS - 1
              return next
            })
          }
        >
          Under-reviewed
        </button>
      </div>
      <SubmissionCoverageBar filters={filters} eventFilterId={eventFilterId} />
      <SlotCounterStrip filters={filters} eventFilterId={eventFilterId} />
      <LobbyRail />
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

/** SPK-04 built-in speaker_status vocabulary, in chip display order. */
const SPEAKER_STATUS_BUILTIN_CHIPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'prospect', label: 'Prospect' },
  { key: 'invited', label: 'Invited' },
  { key: 'awaiting_reply', label: 'Awaiting reply' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'declined', label: 'Declined' },
]

/**
 * Roster filter for the Speakers tab's settable `speaker_status` column
 * (SPK-04): the five built-in statuses plus this event's custom options
 * (`filterProps={{ options }}`, fetched once alongside contactFields — see
 * buildWorkspaceConfig), or "All" (no filter). Supersedes ConfirmationChipsFilter
 * on the Speakers tab; that component stays exported for anywhere still
 * reading the older `confirmation` column.
 */
export function SpeakerStatusChipsFilter({
  filters,
  setFilters,
  options = [],
}: DataListFilterProps<Record<string, string>> & { options?: Array<{ key: string; label: string }> }) {
  const active = filters.speaker_status ?? ''
  const choose = (value: string) => setFilters((prev) => ({ ...prev, speaker_status: value }))
  const chips = [...SPEAKER_STATUS_BUILTIN_CHIPS, ...options]
  return (
    <div className="chip-filter" role="group" aria-label="Speaker status filter">
      <button className={active === '' ? 'active' : ''} aria-pressed={active === ''} onClick={() => choose('')}>
        All
      </button>
      {chips.map((chip) => (
        <button
          key={chip.key}
          className={active === chip.key ? 'active' : ''}
          aria-pressed={active === chip.key}
          onClick={() => choose(chip.key)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  )
}

/**
 * CRM-02: a debounced text box for one server-side substring filter
 * (`company` / `job_title`). Typing must not fire a query per keystroke, and
 * the committed value has to survive DataList handing back a fresh `filters`
 * object — so the input holds its own draft and only syncs down from
 * `filters` when the committed value changes underneath it (a Clear Filters
 * press, or a URL-restored seed).
 */
function TextFilterInput({
  label,
  filterKey,
  filters,
  setFilters,
}: {
  label: string
  filterKey: string
  filters: Record<string, unknown>
  setFilters: DataListFilterProps<Record<string, unknown>>['setFilters']
}) {
  const committed = typeof filters[filterKey] === 'string' ? (filters[filterKey] as string) : ''
  const [draft, setDraft] = useState(committed)
  const lastCommitted = useRef(committed)
  useEffect(() => {
    if (committed !== lastCommitted.current) {
      lastCommitted.current = committed
      setDraft(committed)
    }
  }, [committed])
  const commit = (value: string) => {
    if (value === lastCommitted.current) return
    lastCommitted.current = value
    setFilters((prev) => ({ ...prev, [filterKey]: value }))
  }
  useEffect(() => {
    if (draft === lastCommitted.current) return
    const handle = window.setTimeout(() => commit(draft), 400)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])
  return (
    <input
      className="contact-attr-filter"
      type="search"
      value={draft}
      aria-label={`${label} filter`}
      placeholder={label}
      title={`Substring match on ${label.toLowerCase()}`}
      onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit(draft)
        }
      }}
      style={{ width: 130 }}
    />
  )
}

/**
 * The Speakers tab's filter row, in both of that tab's modes (CRM-01/02).
 *
 * Event mode is the roster: the confirmation chips as before, plus the two
 * attribute boxes. Org mode ("All events" in the sidebar) is the organisation's
 * contact directory — one row per person, people on no event included — where
 * `confirmation` is a per-event concept with no answer, so its chips are hidden
 * and the membership select takes their place. All three extra filters are
 * plain server filter keys ANDed with the header search box server-side.
 */
export function ContactsFilter({
  filters,
  setFilters,
  orgMode = false,
  events = [],
  statusOptions = [],
}: DataListFilterProps<Record<string, unknown>> & {
  orgMode?: boolean
  events?: Array<{ id: string; name: string }>
  /** SPK-04: this event's custom speaker_status options for the chips row. */
  statusOptions?: Array<{ key: string; label: string }>
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
      {!orgMode && (
        <SpeakerStatusChipsFilter
          filters={filters as Record<string, string>}
          setFilters={setFilters as DataListFilterProps<Record<string, string>>['setFilters']}
          resetFilters={() => setFilters((prev) => ({ ...prev, speaker_status: '' }))}
          options={statusOptions}
        />
      )}
      <TextFilterInput label="Company" filterKey="company" filters={filters} setFilters={setFilters} />
      <TextFilterInput label="Job title" filterKey="job_title" filters={filters} setFilters={setFilters} />
      {orgMode && (
        <select
          aria-label="Events filter"
          title="Narrow the directory by event membership"
          value={typeof filters.events === 'string' ? filters.events : ''}
          onChange={(e) => {
            const value = (e.target as HTMLSelectElement).value
            setFilters((prev) => ({ ...prev, events: value }))
          }}
        >
          <option value="">Any events</option>
          <option value="any">On some event</option>
          <option value="none">On no event</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
      )}
    </div>
  )
}

export interface BulkBarProps {
  count: number
  busy: boolean
  onAction: (
    action: 'accept_queue' | 'decline_queue' | 'pending' | 'send_decisions' | 'enroll_pipeline' | 'revise',
  ) => void
  onClear: () => void
  note: string | null
  /** Workplan 13 W3: per-send opt-in — accept emails carry the employer-approval
   * ask and the covered submissions are flagged approval_state='pending'. */
  approvalAsk?: boolean
  onApprovalAskChange?: (next: boolean) => void
  /** Workplan 15 W2: the meeting's proviso, typed in the accept action itself
   * — the note is produced here and has nowhere else to land. */
  acceptCondition?: string
  onAcceptConditionChange?: (next: string) => void
  /** W3: the speaker-facing "what to change", opened by "Ask to revise". */
  reviseGuidance?: string
  onReviseGuidanceChange?: (next: string) => void
}

/** Floating bar shown while submissions are checked (docs/06 §5). */
export function BulkBar({
  count,
  busy,
  onAction,
  onClear,
  note,
  approvalAsk,
  onApprovalAskChange,
  acceptCondition,
  onAcceptConditionChange,
  reviseGuidance,
  onReviseGuidanceChange,
}: BulkBarProps) {
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      {count > 0 ? (
        <>
          <span className="bulk-count">{count} selected</span>
          <button disabled={busy} onClick={() => onAction('accept_queue')}>→ Accept Queue</button>
          {/* W2: the condition rides the accept action rather than waiting for
            * a later per-row edit — the document's whole complaint is that this
            * note is the meeting's work product and lands nowhere. Blank means
            * "no condition", never "clear the one that is there". */}
          {onAcceptConditionChange && (
            <input
              type="text"
              aria-label="Accept condition"
              placeholder="Condition (e.g. needs a business co-presenter)"
              value={acceptCondition ?? ''}
              disabled={busy}
              style={{ minWidth: 220, fontSize: 12 }}
              title="Applied to the selected talks when you queue them as accepts; the speaker is told it in the acceptance letter"
              onChange={(e) => onAcceptConditionChange((e.target as HTMLInputElement).value)}
            />
          )}
          <button disabled={busy} onClick={() => onAction('decline_queue')}>→ Decline Queue</button>
          {/* W3: a flag, not a status (D5) — the rows stay in the decline queue
            * and every downstream state machine is untouched; only the letter
            * and the exported outcome differ. */}
          {onReviseGuidanceChange && (
            <>
              <button
                disabled={busy}
                title="Flag the selected declines as revise-and-resubmit — they keep their decline status and get the revise letter instead"
                onClick={() => onAction('revise')}
              >
                Ask to revise
              </button>
              <input
                type="text"
                aria-label="Revise guidance"
                placeholder="What to change — sent to the speaker"
                value={reviseGuidance ?? ''}
                disabled={busy}
                style={{ minWidth: 220, fontSize: 12 }}
                onChange={(e) => onReviseGuidanceChange((e.target as HTMLInputElement).value)}
              />
            </>
          )}
          <button disabled={busy} onClick={() => onAction('pending')}>→ Pending</button>
          <button className="primary" disabled={busy} onClick={() => onAction('send_decisions')}>
            Send decision emails
          </button>
          {/* Workplan 15 W4: the gesture is sort by rating, filter to declined,
            * select the top of the tail, enrol — so it belongs on the same bar
            * as the decision actions, not on a screen the organiser has to
            * remember to visit later. */}
          <button
            disabled={busy}
            title="Add each selected talk's speaker to the org-wide speaker pipeline at Identified"
            onClick={() => onAction('enroll_pipeline')}
          >
            Add to speaker pipeline
          </button>
          {onApprovalAskChange && (
            <label
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
              title="Accept emails ask the speaker to confirm employer sign-off, and their talks are marked Approval pending on the tracking board"
            >
              <input
                type="checkbox"
                checked={approvalAsk === true}
                disabled={busy}
                onChange={(e) => onApprovalAskChange((e.target as HTMLInputElement).checked)}
              />
              Ask for employer approval
            </label>
          )}
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

/** Same shape as FilePanels' fmtDateTime — the discussion thread needs the
 *  time too, not just the day, since replies can stack up within an hour. */
const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
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
 * Workplan 11 (G7/§5.4): `extra` is a nullable JSON-text column
 * (`{original header: value}`) holding whatever columns an import left
 * unmapped — "never discard data" without a queryable custom-fields system.
 * Pure so it's cheaply unit-testable without mounting the panel; exported for
 * that reason.
 */
export function parseExtraFields(extra: unknown): Array<[string, string]> {
  if (typeof extra !== 'string' || extra.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(extra)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, String(v)])
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
 * Content history (eval defect: revisions were recorded server-side —
 * content_revisions, migration 0023 — but no UI surfaced them, so edits to
 * titles/abstracts looked untraceable and irreversible). Each row is the
 * pre-edit snapshot the API stores; "Restore" writes it back through the
 * normal updateSubmission PUT, which itself snapshots the current content
 * first — so a restore is traceable and reversible too.
 */
/** A pre-edit snapshot, normalised to the field-map shape whatever the entity
 * (a submission revision's dedicated title/description columns become
 * `fields.title` / `fields.description`). */
export interface GenericRevision {
  id: string
  fields: Record<string, string | null>
  edited_by_name: string | null
  source: 'admin' | 'portal'
  edited_at: string
}

/** Wave E (workplan 14, D8): what makes one entity type's history different —
 * everything else (list, snapshot expansion, restore-with-confirm) is shared. */
export interface EntityHistoryConfig {
  /** Remount/reload identity — the effect keys on this, not on the (fresh
   * every render) config object itself. */
  cacheKey: string
  load: () => Promise<GenericRevision[]>
  /** Write the snapshot back through the entity's normal update surface —
   * which snapshots the replaced values itself, keeping restores reversible. */
  restore: (fields: Record<string, string | null>) => Promise<void>
  /** [field key, label] in display order. */
  fieldLabels: Array<[string, string]>
  /** For the confirm prompt: "Restore <noun> as they were…". */
  noun: string
  emptyText: string
}

const submissionHistoryConfig = (submissionId: string): EntityHistoryConfig => ({
  cacheKey: `submission:${submissionId}`,
  load: () =>
    getSubmissionRevisions(submissionId).then((r) =>
      r.items.map(({ title, description, ...rest }) => ({ ...rest, fields: { title, description } })),
    ),
  restore: (fields) =>
    updateSubmission(submissionId, { title: fields.title, description: fields.description }).then(() => undefined),
  fieldLabels: [
    ['title', 'Title'],
    ['description', 'Description'],
  ],
  noun: 'the title and description',
  emptyText: 'No content edits recorded — the title and description are as first submitted.',
})

export function ContentHistorySection({
  submissionId,
  entity,
  onRestored,
}: {
  /** The original submission flavour — mutually exclusive with `entity`. */
  submissionId?: string
  /** Any other entity type (contact profile, event settings — Wave E). */
  entity?: EntityHistoryConfig
  /** Refresh the host panel after a restore lands; receives the fields the
   * restore wrote back, for hosts that patch their row in place. */
  onRestored?: (fields: Record<string, string | null>) => void | Promise<void>
}) {
  const cfg = submissionId !== undefined ? submissionHistoryConfig(submissionId) : entity
  const [items, setItems] = useState<GenericRevision[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = () =>
    cfg
      ? cfg
          .load()
          .then((r) => setItems(r))
          .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load history'))
      : Promise.resolve()

  useEffect(() => {
    setItems(null)
    setError(null)
    setNote(null)
    setOpenId(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.cacheKey])

  if (!cfg) return null

  const restore = async (rev: GenericRevision) => {
    const ok = await appConfirm(
      `Restore ${cfg.noun} as they were before the edit on ${fmtDateTime(rev.edited_at)}? The current content is kept in the history.`,
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await cfg.restore(rev.fields)
      setNote('Restored. The replaced content was added to the history.')
      await load()
      await onRestored?.(rev.fields)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2 style={{ fontSize: 14, marginTop: 16 }}>
        Content history{items && items.length > 0 ? ` (${items.length})` : ''}
      </h2>
      {error && <p className="file-error" role="alert">{error}</p>}
      {note && <p className="file-empty" role="status">{note}</p>}
      {!items && !error && <p className="file-empty">Loading…</p>}
      {items && items.length === 0 && <p className="file-empty">{cfg.emptyText}</p>}
      {items?.map((rev) => (
        <div className="file-chain" key={rev.id}>
          <div className="file-chain-head">
            <span className="fname">
              {fmtDateTime(rev.edited_at)} · edited by {rev.edited_by_name ?? 'Unknown'} ·{' '}
              {rev.source === 'portal' ? 'Speaker portal' : 'Admin'}
            </span>
            <button type="button" onClick={() => setOpenId((prev) => (prev === rev.id ? null : rev.id))}>
              {openId === rev.id ? 'Hide' : 'Before this edit'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void restore(rev)}
              title={`Put ${cfg.noun} back to how they were before this edit`}
            >
              Restore
            </button>
          </div>
          {openId === rev.id && (
            <dl>
              {cfg.fieldLabels.map(([key, label]) => (
                <DetailPair term={label} key={key}>
                  {rev.fields[key] ? (
                    <span style={{ whiteSpace: 'pre-line' }}>{htmlToText(rev.fields[key] as string)}</span>
                  ) : (
                    '(empty)'
                  )}
                </DetailPair>
              ))}
            </dl>
          )}
        </div>
      ))}
    </>
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
  /** W6/D10: the host's read-out line — also editable from the green room
   * screen, which is where it usually gets filled in; this is the backstop. */
  const [introScript, setIntroScript] = useState('')
  const [savedIntroScript, setSavedIntroScript] = useState('')
  const [introScriptSaving, setIntroScriptSaving] = useState(false)
  const [introScriptError, setIntroScriptError] = useState<string | null>(null)
  /** Workplan 13 W3: the approval note draft (saved on blur/button). */
  const [approvalNote, setApprovalNote] = useState('')
  /** Workplan 15 W2/W3: the condition and the revise guidance drafts, saved on
   * blur like the approval note beside them. */
  const [acceptCondition, setAcceptCondition] = useState('')
  const [reviseGuidance, setReviseGuidance] = useState('')
  /** W5a: seats a deck review can be handed to — fetched once per panel, and
   * only used by the owner picker beside the materials state. */
  const [owners, setOwners] = useState<Array<{ id: string; email: string; name: string | null }>>([])
  /** W5d: the deck thread, rendered under the accept discussion as one history. */
  const [fileComments, setFileComments] = useState<SubmissionFileComment[]>([])
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
        setApprovalNote(typeof d.submission.approval_note === 'string' ? d.submission.approval_note : '')
        setAcceptCondition(typeof d.submission.accept_condition === 'string' ? d.submission.accept_condition : '')
        setReviseGuidance(typeof d.submission.revise_guidance === 'string' ? d.submission.revise_guidance : '')
        const initialIntroScript = typeof d.submission.intro_script === 'string' ? d.submission.intro_script : ''
        setIntroScript(initialIntroScript)
        setSavedIntroScript(initialIntroScript)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
    // W5a/W5d: the deck-reviewer options and the deck thread. Neither is load
    // bearing for the panel, so a failure leaves them empty rather than
    // blanking a record an organiser opened to read.
    setOwners([])
    setFileComments([])
    getMaterialsOwners().then((r) => setOwners(r.items)).catch(() => {})
    getSubmissionFileComments(id).then((r) => setFileComments(r.items)).catch(() => {})
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

  const saveIntroScript = async () => {
    setIntroScriptSaving(true)
    setIntroScriptError(null)
    try {
      await updateSubmissionIntroScript(id, introScript.trim() || null)
      setSavedIntroScript(introScript)
    } catch (e) {
      setIntroScriptError(e instanceof Error ? e.message : 'Failed to save the intro script')
    } finally {
      setIntroScriptSaving(false)
    }
  }

  if (error) return <div className="detail-panel"><p>{error}</p></div>
  if (!detail) return <div className="detail-panel"><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  const s = detail.submission
  // Workplan 11 (G7/§5.4): unmapped import columns, preserved read-only.
  const extraFields = parseExtraFields(s.extra)
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
        {typeof s.approval_state === 'string' && APPROVAL_CHIP[s.approval_state] && (
          <span className={`status-chip ${APPROVAL_CHIP[s.approval_state].className}`}>
            {APPROVAL_CHIP[s.approval_state].label}
          </span>
        )}
        {typeof s.materials_state === 'string' && MATERIALS_CHIP[s.materials_state] && (
          <span className={`status-chip ${MATERIALS_CHIP[s.materials_state].className}`}>
            {MATERIALS_CHIP[s.materials_state].label}
          </span>
        )}
        {/* W2: an accepted talk that still owes something reads differently
            from one that does not, so the chip sits with the other flags. */}
        {typeof s.accept_condition === 'string' && s.accept_condition !== '' && (
          <span
            className={`status-chip ${s.condition_met_at ? 'status-accepted' : 'status-pending'}`}
            title={s.accept_condition}
          >
            {s.condition_met_at ? 'Condition met' : 'Condition outstanding'}
          </span>
        )}
        {/* W3: the flag is the only thing that says this is not a plain
            decline — the status column cannot (D5). */}
        {s.decision_outcome === 'revise' && (
          <span className="status-chip status-pending">Revise &amp; resubmit</span>
        )}
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
            // W2: the condition rides the status write, so a proviso typed
            // here lands with the accept that produced it rather than needing
            // a second, separate save nobody makes. A blank field means "no
            // condition", never "clear the one already there" — so the status
            // call is left exactly as it was when there is nothing to add.
            const condition = acceptCondition.trim()
            void saveField(() =>
              condition ? updateSubmissionStatus(id, next, condition) : updateSubmissionStatus(id, next),
            )
          }}
        >
          {SUBMISSION_STATUSES.map((st) => (
            <option key={st} value={st}>{statusLabel(st)}</option>
          ))}
        </select>
        {/* Workplan 15 W2 (D4): the accept's proviso, one line, beside the
            status editor that produces it. Marking it met never changes
            status — the two axes are independent. */}
        <label htmlFor="sub-detail-condition">Condition</label>
        <input
          id="sub-detail-condition"
          type="text"
          placeholder="e.g. needs a business co-presenter — Ann to follow up"
          value={acceptCondition}
          disabled={fieldSaving}
          style={{ minWidth: 240 }}
          onChange={(e) => setAcceptCondition((e.target as HTMLInputElement).value)}
          onBlur={() => {
            const stored = typeof s.accept_condition === 'string' ? s.accept_condition : ''
            if (acceptCondition.trim() === stored.trim()) return
            void saveField(() => updateSubmissionCondition(id, { accept_condition: acceptCondition.trim() || null }))
          }}
        />
        {typeof s.accept_condition === 'string' && s.accept_condition !== '' && (
          <button
            type="button"
            disabled={fieldSaving}
            title="Record that this condition has been met — the talk's status is untouched"
            onClick={() => void saveField(() => updateSubmissionCondition(id, { condition_met: !s.condition_met_at }))}
          >
            {s.condition_met_at ? 'Reopen condition' : 'Mark condition met'}
          </button>
        )}
        {/* Workplan 15 W3 (D5): the third outcome, as a flag. The row keeps
            its decline status on purpose — only the letter and the exported
            `outcome` column differ. */}
        <label htmlFor="sub-detail-outcome">Outcome</label>
        <select
          id="sub-detail-outcome"
          value={s.decision_outcome === 'revise' ? 'revise' : ''}
          disabled={fieldSaving}
          onChange={(e) => {
            const next = (e.target as HTMLSelectElement).value
            void saveField(() => updateSubmissionDecision(id, { decision_outcome: next || null }))
          }}
        >
          <option value="">As decided</option>
          <option value="revise">Revise &amp; resubmit</option>
        </select>
        {s.decision_outcome === 'revise' && (
          <input
            type="text"
            aria-label="Revise guidance"
            placeholder="What to change — the speaker reads this"
            value={reviseGuidance}
            disabled={fieldSaving}
            style={{ minWidth: 240 }}
            onChange={(e) => setReviseGuidance((e.target as HTMLInputElement).value)}
            onBlur={() => {
              const stored = typeof s.revise_guidance === 'string' ? s.revise_guidance : ''
              if (reviseGuidance.trim() === stored.trim()) return
              void saveField(() => updateSubmissionDecision(id, { revise_guidance: reviseGuidance.trim() || null }))
            }}
          />
        )}
        {/* Workplan 13 W3: the employer-approval flag lives beside the status
            editor — accepted AND awaiting sign-off are independent axes (D4);
            picking Refused prompts a human, it never auto-withdraws (D7). */}
        <label htmlFor="sub-detail-approval">Approval</label>
        <select
          id="sub-detail-approval"
          value={typeof s.approval_state === 'string' ? s.approval_state : ''}
          disabled={fieldSaving}
          onChange={(e) => {
            const next = (e.target as HTMLSelectElement).value
            void saveField(() => updateSubmissionApproval(id, { approval_state: next || null }))
          }}
        >
          <option value="">Not asked</option>
          {APPROVAL_STATES.map((st) => (
            <option key={st} value={st}>{statusLabel(st)}</option>
          ))}
        </select>
        {typeof s.approval_state === 'string' && (
          <input
            type="text"
            aria-label="Approval note"
            placeholder="Approval note — who is chasing what"
            value={approvalNote}
            disabled={fieldSaving}
            style={{ minWidth: 200 }}
            onChange={(e) => setApprovalNote((e.target as HTMLInputElement).value)}
            onBlur={() => {
              const stored = typeof s.approval_note === 'string' ? s.approval_note : ''
              if (approvalNote.trim() === stored.trim()) return
              void saveField(() => updateSubmissionApproval(id, { approval_note: approvalNote.trim() || null }))
            }}
          />
        )}
        {/* Workplan 15 W5a (D9): the post-accept editorial state, alongside
            status for the same reason approval is — an accepted talk keeps
            accumulating. 'Received' is offered only as the current value: it
            is what an upload sets, and making a person confirm it would add a
            click to every deck. */}
        <label htmlFor="sub-detail-materials">Materials</label>
        <select
          id="sub-detail-materials"
          value={typeof s.materials_state === 'string' ? s.materials_state : ''}
          disabled={fieldSaving}
          onChange={(e) => {
            const next = (e.target as HTMLSelectElement).value
            void saveField(() => updateSubmissionMaterials(id, { materials_state: next || null }))
          }}
        >
          <option value="">Nothing on file</option>
          {MATERIALS_STATES.filter((st) => st !== 'received' || s.materials_state === 'received').map((st) => (
            <option key={st} value={st} disabled={st === 'received'}>{statusLabel(st)}</option>
          ))}
        </select>
        {/* The 2016 retro action item was "share the load"; a reviewer per
            deck is the smallest thing that makes that expressible. */}
        <label htmlFor="sub-detail-materials-owner">Deck reviewer</label>
        <select
          id="sub-detail-materials-owner"
          value={typeof s.materials_owner_id === 'string' ? s.materials_owner_id : ''}
          disabled={fieldSaving}
          onChange={(e) => {
            const next = (e.target as HTMLSelectElement).value
            void saveField(() => updateSubmissionMaterials(id, { materials_owner_id: next || null }))
          }}
        >
          <option value="">Unassigned</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>{o.name ?? o.email}</option>
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
        {s.description ? (
          <DetailPair term="Description">
            <span style={{ whiteSpace: 'pre-line' }}>{htmlToText(String(s.description))}</span>
          </DetailPair>
        ) : null}
        {s.format ? <DetailPair term="Format">{String(s.format)}</DetailPair> : null}
        {s.track_name ? <DetailPair term="Track">{String(s.track_name)}</DetailPair> : null}
        {s.plan_name ? <DetailPair term="Evaluation plan">{String(s.plan_name)}</DetailPair> : null}
        {detail.tags.length > 0 && <DetailPair term="Tags">{detail.tags.join(', ')}</DetailPair>}
        {detail.answers
          // The submission form's own "Title"/"Description"/"Track"/"Format"
          // questions duplicate canonical columns rendered above (heading,
          // Description pair, Format/Track pairs). Those answer rows are
          // frozen at submit time, so after an organiser edit they show stale
          // pre-edit content — the columns are the single source of truth.
          // Conservative exact match (trim + lowercase) so a differently-
          // labelled question (e.g. "Track / Theme") still shows through.
          // ...but only while the canonical column actually has a value to
          // show. CFP defect: a submission whose track_id/track_name is NULL
          // renders no Track pair above AND had its raw "Track" answer
          // suppressed here, so the track the submitter chose vanished from
          // the detail view entirely. Suppress a duplicate, never the only
          // copy.
          .filter((a) => {
            const label = a.label.trim().toLowerCase();
            if (label === 'track') return !s.track_name;
            if (label === 'format') return !s.format;
            if (label === 'title') return !s.title;
            if (label === 'description') return !s.description;
            return true;
          })
          .map((a, i) => (
            <DetailPair key={i} term={a.label}>{answerText(a.value_json)}</DetailPair>
          ))}
      </dl>

      {extraFields.length > 0 && (
        <>
          {/* Workplan 11 (G7/§5.4): columns left unmapped on import, kept
              read-only rather than silently discarded. */}
          <h2 style={{ fontSize: 14 }}>Imported fields</h2>
          <dl>
            {extraFields.map(([k, v]) => (
              <DetailPair key={k} term={k}>{v}</DetailPair>
            ))}
          </dl>
        </>
      )}

      {/* W6/D10: same field the green room screen edits — generated show-flow
          export reads it straight off the submission. */}
      <h2 style={{ fontSize: 14 }}>Intro script</h2>
      <textarea
        className="internal-notes-field"
        rows={3}
        value={introScript}
        onChange={(e) => setIntroScript((e.target as HTMLTextAreaElement).value)}
        aria-label="Intro script"
        placeholder="What the host reads out to introduce this session — usually filled in close to showtime, from the green room screen."
      />
      <div className="internal-notes-actions">
        <button
          type="button"
          disabled={introScript === savedIntroScript || introScriptSaving}
          onClick={() => void saveIntroScript()}
        >
          {introScriptSaving ? 'Saving…' : 'Save intro script'}
        </button>
        {introScriptError && <span className="internal-notes-error" role="alert">{introScriptError}</span>}
      </div>

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

      {/* Content edit history + restore (content_revisions, migration 0023). */}
      <ContentHistorySection
        submissionId={id}
        onRestored={async () => {
          const fresh = await load()
          onItemSaved?.(fresh.submission)
        }}
      />

      <h2 style={{ fontSize: 14, marginTop: 16 }}>
        Reviews {detail.reviews.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({detail.reviews.length})</span>}
      </h2>
      {detail.reviews.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No reviews yet.</p>}
      {/* Grouped by evaluation round (plan): the header ★ above pools every
          plan's reviews into one number on purpose (adminApi.ts's grid
          rating does the same, kept as-is — that pooling is what made
          reviews from a submission's earlier round visible again after it
          moved rounds). Pooled across independent scoring criteria/scales,
          though, that single number is unreadable at the review level — a
          3.9 might be a strong 4.5 in round 1 diluted by a rough 3.0 in
          round 2. Grouping by round with a per-round mean (server-computed
          in review_plan_means, mirroring rating_cache's own per-plan AVG)
          makes each round's result legible again without touching the
          pooled grid column other panes rely on. */}
      {reviewsByPlan(detail.reviews).map(([planId, planName, planReviews]) => {
        const planMean = detail.review_plan_means.find((m) => m.plan_id === planId)?.mean ?? null
        return (
          <div className="review-plan-group" key={planId}>
            <div className="review-plan-heading">
              <span>{planName ?? 'Evaluation round'}</span>
              {planMean !== null && <span className="rating-badge">★ {planMean}</span>}
            </div>
            {planReviews.map((r, i) => (
              <div className="review-row" key={i}>
                <div className="rev-head">
                  <span>{r.reviewer_name ?? 'Reviewer'}</span>
                  <span>{r.conflict_of_interest === 1 ? 'Conflict of interest' : r.weighted_total ?? '—'}</span>
                </div>
              </div>
            ))}
          </div>
        )
      })}

      {/* Workplan 7: the discussion thread. Rationale rows (posted at
          score-save time) and free-standing discussion rows share one
          append-only thread — labelled distinctly from Internal notes above,
          which stays a writer-only scratchpad. */}
      <h2 style={{ fontSize: 14, marginTop: 16 }}>
        Discussion {detail.comments.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({detail.comments.length})</span>}
      </h2>
      <SubmissionDiscussionThread
        submissionId={id}
        comments={detail.comments}
        onComments={(next) => setDetail((d) => (d ? { ...d, comments: next } : d))}
      />

      {/* Workplan 15 W5d: the deck feedback, inline directly beneath the
          accept discussion so "the review comments sit next to the review
          comments that got it accepted" — one history rather than two threads
          on two surfaces. Version-anchored (0007), so a v1 note keeps pointing
          at the deck it described after v2 lands; replying still happens in
          the Files section above, against the version being replied to. */}
      {fileComments.length > 0 && (
        <>
          <h2 style={{ fontSize: 14, marginTop: 16 }}>
            Materials feedback <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({fileComments.length})</span>
          </h2>
          <div className="file-thread">
            {fileComments.map((m) => (
              <div key={m.id} className={m.author_role === 'speaker' ? 'file-comment speaker' : 'file-comment'}>
                <div className="fc-head">
                  <strong>{m.author_name ?? 'Someone'}</strong>
                  {m.author_role === 'speaker' ? ' · Speaker' : ' · Organiser'}
                  {' · '}{m.filename} v{m.version}
                  {' · '}{fmtDateTime(m.created_at)}
                </div>
                <div className="fc-body">{m.body}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The submission discussion thread (workplan 7). Same markup/CSS as
 * FilePanels' FileThread — `.file-thread` / `.file-comment` / `.fc-head` /
 * `.fc-body` / `.file-reply` / `.file-empty` / `.file-error` — so the two
 * threads read as one visual language. Append-only: no edit/delete controls.
 */
function SubmissionDiscussionThread({
  submissionId,
  comments,
  onComments,
}: {
  submissionId: string
  comments: SubmissionComment[]
  onComments: (next: SubmissionComment[]) => void
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const post = async () => {
    if (draft.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const res = await addSubmissionComment(submissionId, draft.trim())
      onComments(res.comments)
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to post comment')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="file-thread">
      {comments.length === 0 && <p className="file-empty">No comments yet.</p>}
      {comments.map((m) => (
        <div key={m.id} className="file-comment">
          <div className="fc-head">
            <strong>{m.author_name ?? 'Someone'}</strong>
            {m.author_role === 'reviewer' ? ' · Reviewer' : ' · Organiser'}
            {m.kind === 'rationale' ? ' · Review comment' : ''}
            {' · '}{fmtDateTime(m.created_at)}
          </div>
          <div className="fc-body">{m.body}</div>
        </div>
      ))}
      <div className="file-reply">
        <textarea
          rows={2}
          value={draft}
          aria-label="Add to the discussion"
          placeholder="Add to the discussion…"
          disabled={busy}
          onChange={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
        />
        <div className="file-reply-actions">
          <button type="button" disabled={busy || draft.trim() === ''} onClick={() => void post()}>
            {busy ? 'Posting…' : 'Post'}
          </button>
          {error && <span className="file-error" role="alert">{error}</span>}
        </div>
      </div>
    </div>
  )
}

/** Groups the flat `reviews` list by plan_id, preserving the server's
 *  ordering (plan.created_at then review.created_at — see evaluation.ts's
 *  detail query) so rounds appear in the order they were run, oldest first. */
function reviewsByPlan(
  reviews: SubmissionDetail['reviews'],
): Array<[string, string | null, SubmissionDetail['reviews']]> {
  const order: string[] = []
  const groups = new Map<string, { name: string | null; rows: SubmissionDetail['reviews'] }>()
  for (const r of reviews) {
    let group = groups.get(r.plan_id)
    if (!group) {
      group = { name: r.plan_name, rows: [] }
      groups.set(r.plan_id, group)
      order.push(r.plan_id)
    }
    group.rows.push(r)
  }
  return order.map((planId) => {
    const group = groups.get(planId)!
    return [planId, group.name, group.rows]
  })
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
  // #29 (eval defect): the Track select initially showed "— No track —" for a
  // submission that plainly has a track (e.g. "Platform & Infra") — `fields.
  // track_id` is seeded synchronously from `initialValues` (below), but
  // `tracks` starts empty until `listTracks()` resolves, so the first paint
  // has no <option> whose value matches the already-correct `track_id` and
  // the browser falls back to the list's first option. `tracksLoaded` lets
  // the select render a neutral "Loading…" placeholder for that one option
  // instead of silently reading as "no track" — see the select's render
  // below. The underlying state was never wrong; only the display was.
  const [tracksLoaded, setTracksLoaded] = useState(false)
  const [rooms, setRooms] = useState<RoomRow[]>([])
  const [formatNames, setFormatNames] = useState<string[]>([])
  // The `track_id` the record actually holds, kept apart from the picker's
  // value so Save can tell "the organiser chose a different track" from "the
  // picker never had an option for what was stored". See `handleSubmit`.
  const [loadedTrackId, setLoadedTrackId] = useState(
    typeof initialValues?.track_id === 'string' ? initialValues.track_id : '',
  )

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
      .finally(() => { if (!cancelled) setTracksLoaded(true) })
    listRooms()
      .then((r) => { if (!cancelled) setRooms(r.items) })
      .catch(() => {})
    listFormats()
      .then((f) => { if (!cancelled) setFormatNames(f.items.map((x) => x.name)) })
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
        // Baseline the Track picker off the record itself, not just the grid
        // row that opened the form — the row is the only source `initialValues`
        // has, and any path that opens the form without one would otherwise
        // start from '' and look like a deliberate "no track".
        const storedTrackId = typeof d.submission.track_id === 'string' ? d.submission.track_id : ''
        setLoadedTrackId(storedTrackId)
        setFields((prev) => {
          // Manual-review item: "Level" is blank in this form for some
          // submitted records even though the submitter answered it on the
          // public form. Root cause — the answer is only mirrored onto the
          // first-class `submissions.level` column when the form's question
          // is wired to the canonical `level` field_key (systemColumns in
          // submit.tsx); a form question built via FormBuilder's "Create
          // Field" flow with its own label (e.g. "Level") gets a distinct
          // `custom_*` key, so its answer only ever lands in
          // submission_answers — which the read-only detail panel above
          // already surfaces (via `detail.answers`, matched by label, not by
          // field_key) but this edit form did not. Falling back to that same
          // answer here — only when the column itself came back empty — means
          // the field is populated instead of appearing to have lost data,
          // and saving now backfills the proper column going forward.
          const trackId = prev.track_id || storedTrackId
          if (prev.level) return { ...prev, room_id: roomId, track_id: trackId }
          const levelAnswer = d.answers.find((a) => a.label.trim().toLowerCase().includes('level'))
          const fallbackLevel = levelAnswer ? answerText(levelAnswer.value_json) : ''
          return { ...prev, room_id: roomId, track_id: trackId, level: fallbackLevel === '—' ? '' : fallbackLevel }
        })
      })
      .catch((e: unknown) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load') })
    return () => { cancelled = true }
  }, [id])

  // Same manual-review defect as the Level fallback above, for Track: a
  // "Create Field"-built Track question has a `custom_*` field_key, so its
  // answer only ever lands in `submission_answers`, not `submissions.track_id`
  // — the MAJOR eval item (organizer's list showed a blank Track cell, and
  // the auto-created agenda session inherited the empty track). The read
  // path here mirrors the write-side fix in submit.tsx's `trackAnswers()`
  // (label-based fallback, canonical field_key still wins), resolving the
  // raw answer text to a real track id via the event's track list so this
  // form's Track picker — and, on Save, the `track_id` column — get backfilled
  // instead of silently staying blank. Runs once the track list and the
  // detail answers are both in, and only when the column itself is empty.
  useEffect(() => {
    if (!detail || tracks.length === 0) return
    setFields((prev) => {
      if (prev.track_id) return prev
      const trackAnswer = detail.answers.find((a) => a.label.trim().toLowerCase().includes('track'))
      const trackText = trackAnswer ? answerText(trackAnswer.value_json) : ''
      if (!trackText || trackText === '—') return prev
      // Multi-select answers join as "First, Second" (answerText above); the
      // first selected value is the primary track, same as submit.tsx.
      const firstName = trackText.split(',')[0]!.trim().toLowerCase()
      const match = tracks.find((t) => t.name.trim().toLowerCase() === firstName)
      return match ? { ...prev, track_id: match.id } : prev
    })
  }, [detail, tracks])

  // The submitted Track answer when it matches none of the event's tracks, so
  // the picker has no option for it. Surfacing the text beats a bare "— No
  // track —", which reads as though the submitter chose nothing.
  const unmatchedTrackAnswer = (() => {
    if (fields.track_id || !detail || tracks.length === 0) return ''
    const answer = detail.answers.find((a) => a.label.trim().toLowerCase().includes('track'))
    const text = answer ? answerText(answer.value_json) : ''
    if (!text || text === '—') return ''
    const first = text.split(',')[0]!.trim().toLowerCase()
    return tracks.some((t) => t.name.trim().toLowerCase() === first) ? '' : text
  })()

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
        // Only send Track when it actually changed. The picker can only offer
        // the *event's* tracks, so a submission whose stored track isn't one
        // of them (e.g. a CFP form whose Track question lists names the event
        // has no matching track for) renders as "— No track —" through no
        // choice of the organiser's — and an unconditional `track_id` would
        // then silently overwrite the stored value with NULL on any unrelated
        // edit. PUT /submissions/:id updates per key present (`'track_id' in
        // body`), so omitting it leaves the column alone. A real change —
        // including the answer-backfill effect above — still writes.
        ...(fields.track_id !== loadedTrackId ? { track_id: fields.track_id || null } : {}),
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
          {/* Managed vocabulary (CFP-S1) — but a submission may carry a name
              that predates a rename/delete, so the stored value is appended
              rather than silently dropped (the track picker's unmatched-answer
              rule, applied to a name-keyed column). */}
          <select id="sub-edit-format" value={fields.format} disabled={isSubmitting} onChange={(e) => setField('format', e.target.value)}>
            <option value="">— No format —</option>
            {fields.format !== '' && !formatNames.includes(fields.format) && (
              <option value={fields.format}>{fields.format} (no longer offered)</option>
            )}
            {formatNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
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
            {/* #29: before `tracks` has loaded, a synthetic option keeps a
                stored track_id from rendering as the misleading "No track"
                fallback — see `tracksLoaded`'s doc comment above. Disappears
                the moment the real list arrives and either matches by id
                (the common case) or leaves the field genuinely unmatched
                (unmatchedTrackAnswer's note below explains that case). */}
            {!tracksLoaded && fields.track_id && (
              <option value={fields.track_id}>Loading…</option>
            )}
            {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {unmatchedTrackAnswer && (
            <p className="record-form-note">
              Submitted as “{unmatchedTrackAnswer}”, which is not one of this event’s tracks.
              Pick a track to map it, or leave this blank — saving will not clear the submitted answer.
            </p>
          )}
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

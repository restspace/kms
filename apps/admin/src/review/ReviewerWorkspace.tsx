import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  addAssignmentComment,
  getAssignmentComments,
  getReviewQueue,
  saveReview,
  type ReviewQueue,
  type SubmissionComment,
} from '../api'
import '../workspace/review.css'
import '../workspace/files.css'

/**
 * Reviewer workspace (docs/06 §4): queue with progress, one submission at a
 * time, per-criterion scoring on the plan's scale, comment, conflict flag,
 * Save & Next. Reviewers see only this; admins reach it from the sidebar.
 */

type Assignment = Record<string, unknown>

/** A plan's review window (ABS-01) is closed when the queue says so. */
const isWindowClosed = (a: Assignment): boolean => a.plan_open === 0

/** Human date for the window notice; falls back to nothing useful gracefully. */
function formatWindowDate(raw: unknown): string {
  if (typeof raw !== 'string') return 'at the configured time'
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? 'at the configured time' : d.toLocaleString()
}

export function ReviewerWorkspace() {
  const [queue, setQueue] = useState<ReviewQueue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const reload = useCallback(
    () =>
      getReviewQueue()
        .then((q) => {
          setQueue(q)
          setActiveId((current) => {
            if (current && q.assignments.some((a) => a.id === current)) return current
            const firstOpen = q.assignments.find((a) => a.status !== 'complete' && a.status !== 'skipped')
            return (firstOpen?.id as string) ?? (q.assignments[0]?.id as string) ?? null
          })
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load')),
    [],
  )
  useEffect(() => void reload(), [reload])

  if (error) return <div className="review-pane"><p>{error}</p></div>
  if (!queue) return <div className="review-pane"><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>

  const done = queue.assignments.filter((a) => a.status === 'complete' || a.status === 'skipped').length
  const active = queue.assignments.find((a) => a.id === activeId) ?? null

  return (
    <div className="review-shell">
      <aside className="review-queue">
        <div className="rq-head">
          My review queue — {done} of {queue.assignments.length} reviewed
        </div>
        {queue.assignments.length === 0 && (
          <p style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>
            Nothing assigned to you yet.
          </p>
        )}
        {queue.assignments.map((a) => (
          <button
            key={String(a.id)}
            className={`rq-item${a.id === activeId ? ' active' : ''}`}
            onClick={() => setActiveId(a.id as string)}
          >
            <span className="rq-code">{String(a.code)} · {String(a.plan_name)}</span>
            <br />
            {String(a.title)}{' '}
            <span className={`status-chip status-${String(a.status)}`}>{String(a.status).replace('_', ' ')}</span>
            {isWindowClosed(a) && <span className="status-chip status-withdrawn">closed</span>}
          </button>
        ))}
      </aside>
      <div className="review-pane">
        {active ? (
          <ScoringForm
            key={String(active.id)}
            assignment={active}
            criteria={queue.criteria[String(active.plan_id)] ?? []}
            participants={queue.participants[String(active.submission_id)] ?? null}
            savedNote={savedNote}
            onSaved={(next) => {
              setSavedNote(next)
              void reload()
            }}
            onNext={() => {
              const list = queue.assignments
              const index = list.findIndex((a) => a.id === active.id)
              const nextOpen =
                list.slice(index + 1).find((a) => a.status !== 'complete' && a.status !== 'skipped') ??
                list.find((a) => a.status !== 'complete' && a.status !== 'skipped' && a.id !== active.id)
              if (nextOpen) setActiveId(nextOpen.id as string)
            }}
          />
        ) : (
          <p style={{ color: 'var(--text-muted)' }}>Select a submission from the queue.</p>
        )}
      </div>
    </div>
  )
}

function ScoringForm({
  assignment,
  criteria,
  participants,
  savedNote,
  onSaved,
  onNext,
}: {
  assignment: Assignment
  criteria: Array<{ id: string; name: string; description: string | null; weight: number }>
  participants: Array<{ name: string | null; role: string }> | null
  savedNote: string | null
  onSaved: (note: string) => void
  onNext: () => void
}) {
  const scaleMin = Number(assignment.scoring_scale_min) || 1
  const scaleMax = Number(assignment.scoring_scale_max) || 5
  const scale = useMemo(
    () => Array.from({ length: scaleMax - scaleMin + 1 }, (_, i) => scaleMin + i),
    [scaleMin, scaleMax],
  )
  const [scores, setScores] = useState<Record<string, number>>(() => {
    try {
      return assignment.my_scores ? (JSON.parse(String(assignment.my_scores)) as Record<string, number>) : {}
    } catch {
      return {}
    }
  })
  const [comment, setComment] = useState(String(assignment.my_comment ?? ''))
  const [conflict, setConflict] = useState(assignment.my_conflict === 1)
  const [saving, setSaving] = useState(false)
  const windowClosed = isWindowClosed(assignment)
  const anonymised = assignment.anonymise_submitters === 1
  const [formError, setFormError] = useState<string | null>(null)

  const complete = conflict || criteria.every((c) => scores[c.id] !== undefined)

  const save = async (advance: boolean) => {
    setSaving(true)
    setFormError(null)
    try {
      const result = await saveReview(String(assignment.id), {
        scores,
        comment,
        conflict_of_interest: conflict,
      })
      onSaved(
        conflict
          ? 'Saved — flagged as conflict of interest.'
          : `Saved — your total ${result.weighted_total}, submission mean ${result.submission_rating}.`,
      )
      if (advance) onNext()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h2>{String(assignment.code)} — {String(assignment.title)}</h2>
      <div className="rp-meta">
        {String(assignment.plan_name)}
        {assignment.track_name ? ` · ${String(assignment.track_name)}` : ''}
        {assignment.format ? ` · ${String(assignment.format)}` : ''}
        {assignment.level ? ` · ${String(assignment.level)}` : ''}
        {/* ABS-07: an anonymised round never carries participants in the
            payload (the redaction is server-side, in GET /review/queue), and
            this second gate means a stale or hand-crafted payload cannot put
            a submitter's name on screen either. The state is stated rather
            than left blank, so a reviewer knows the omission is deliberate. */}
        {anonymised ? (
          <> · <span style={{ fontStyle: 'italic' }}>Submitter hidden (anonymous review)</span></>
        ) : (
          participants && participants.length > 0 && (
            <> · {participants.map((p) => `${p.name ?? '—'} (${p.role})`).join(', ')}</>
          )
        )}
      </div>
      {assignment.description ? (
        <div className="rp-desc">{String(assignment.description).replace(/<[^>]*>/g, '')}</div>
      ) : null}

      {/* ABS-01: the plan's optional review window. The server refuses the
          save regardless (POST /review/assignments → 403 review_closed); this
          is so the reviewer is told before they spend time scoring. */}
      {windowClosed && (
        <div className="builder-error" style={{ marginTop: 10 }} role="status">
          {assignment.plan_window_reason === 'not_yet_open'
            ? `Reviewing for this round opens ${formatWindowDate(assignment.plan_opens_at)}.`
            : `Reviewing for this round closed ${formatWindowDate(assignment.plan_closes_at)}. Scores can no longer be saved.`}
        </div>
      )}

      {criteria.map((c) => (
        <div className="score-row" key={c.id}>
          <div className="score-label">
            {c.name} <span className="score-weight">×{c.weight}</span>
          </div>
          {c.description && <div className="score-desc">{c.description}</div>}
          <div className="score-scale" role="radiogroup" aria-label={c.name}>
            {scale.map((n) => (
              <button
                key={n}
                className={scores[c.id] === n ? 'selected' : ''}
                disabled={conflict}
                onClick={() => setScores((prev) => ({ ...prev, [c.id]: n }))}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="score-row">
        <div className="score-label">Your rationale</div>
        <textarea
          rows={3}
          value={comment}
          aria-label="Your rationale"
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="score-desc">
          Shared with the other reviewers once they have submitted their own review — it becomes a
          comment in the discussion below.
        </div>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <input type="checkbox" checked={conflict} onChange={(e) => setConflict(e.target.checked)} />
        Flag conflict of interest (skips scoring)
      </label>

      {formError && <div className="builder-error" style={{ marginTop: 10 }}>{formError}</div>}
      <div className="review-actions">
        <button className="fbtn primary" disabled={saving || !complete || windowClosed} onClick={() => void save(true)}>
          {saving ? 'Saving…' : 'Save & Next'}
        </button>
        <button className="fbtn" disabled={saving || !complete || windowClosed} onClick={() => void save(false)}>
          Save
        </button>
        {!complete && !conflict && <span className="saved-note">Score every criterion to save.</span>}
        {savedNote && <span className="saved-note">{savedNote}</span>}
      </div>

      <DiscussionPanel assignment={assignment} />
    </section>
  )
}

/**
 * The submission's discussion thread (workplan 7 §7), in one of three states:
 *
 *  1. Round not yet open → nothing extra; the window notice above already says
 *     when reviewing starts, and there is nothing to discuss before it does.
 *  2. This reviewer hasn't submitted yet and the round is still open → the
 *     server refuses the read (403 review_not_submitted, gate D3), so all we
 *     can show is a locked placeholder. Deliberately no counts, authors or
 *     excerpts: the rows never reached the client.
 *  3. Submitted (or round closed) → the full thread plus an append-only
 *     composer (D4 — no edit, no delete).
 *
 * The fetch is keyed on the assignment's status as well as its id, so the
 * queue reload after a successful save — which flips status to complete and
 * thereby opens the gate — refetches without any extra plumbing.
 */
function DiscussionPanel({ assignment }: { assignment: Assignment }) {
  const assignmentId = String(assignment.id)
  const status = String(assignment.status)
  const notYetOpen = assignment.plan_window_reason === 'not_yet_open'
  const [comments, setComments] = useState<SubmissionComment[] | null>(null)
  const [locked, setLocked] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  useEffect(() => {
    if (notYetOpen) return
    let cancelled = false
    setLoadError(null)
    getAssignmentComments(assignmentId)
      .then((res) => {
        if (cancelled) return
        setLocked(false)
        setComments(res.comments)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 403 && e.details?.error === 'review_not_submitted') {
          setLocked(true)
          setComments(null)
        } else {
          setLoadError(e instanceof Error ? e.message : 'Failed to load the discussion')
        }
      })
    return () => {
      cancelled = true
    }
  }, [assignmentId, status, notYetOpen])

  if (notYetOpen) return null

  const post = async () => {
    if (draft.trim() === '') return
    setBusy(true)
    setPostError(null)
    try {
      const res = await addAssignmentComment(assignmentId, draft.trim())
      setComments(res.comments)
      setDraft('')
    } catch (e) {
      setPostError(e instanceof Error ? e.message : 'Failed to post comment')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="file-thread">
      <strong style={{ fontSize: 13 }}>Discussion</strong>
      {locked && <p className="file-empty">Post your review to join the discussion.</p>}
      {loadError && <span className="file-error" role="alert">{loadError}</span>}
      {comments && (
        <>
          {comments.length === 0 && <p className="file-empty">No comments yet.</p>}
          {comments.map((m) => (
            <div key={m.id} className="file-comment">
              <div className="fc-head">
                <strong>{m.author_name ?? 'Someone'}</strong>
                {m.author_role === 'reviewer' ? ' · Reviewer' : ' · Organiser'}
                {' · '}
                {formatWindowDate(m.created_at)}
                {m.kind === 'rationale' ? ' · Review rationale' : ''}
              </div>
              <div className="fc-body">{m.body}</div>
            </div>
          ))}
          <div className="file-reply">
            <textarea
              rows={2}
              value={draft}
              aria-label="Reply to the discussion"
              placeholder="Add to the discussion…"
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="file-reply-actions">
              <button type="button" disabled={busy || draft.trim() === ''} onClick={() => void post()}>
                {busy ? 'Posting…' : 'Post'}
              </button>
              {postError && <span className="file-error" role="alert">{postError}</span>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

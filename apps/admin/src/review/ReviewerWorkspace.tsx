import { useCallback, useEffect, useMemo, useState } from 'react'
import { getReviewQueue, saveReview, type ReviewQueue } from '../api'
import '../workspace/review.css'

/**
 * Reviewer workspace (docs/06 §4): queue with progress, one submission at a
 * time, per-criterion scoring on the plan's scale, comment, conflict flag,
 * Save & Next. Reviewers see only this; admins reach it from the sidebar.
 */

type Assignment = Record<string, unknown>

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
        {participants && participants.length > 0 && (
          <> · {participants.map((p) => `${p.name ?? '—'} (${p.role})`).join(', ')}</>
        )}
      </div>
      {assignment.description ? (
        <div className="rp-desc">{String(assignment.description).replace(/<[^>]*>/g, '')}</div>
      ) : null}

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
        <div className="score-label">Comment</div>
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <input type="checkbox" checked={conflict} onChange={(e) => setConflict(e.target.checked)} />
        Flag conflict of interest (skips scoring)
      </label>

      {formError && <div className="builder-error" style={{ marginTop: 10 }}>{formError}</div>}
      <div className="review-actions">
        <button className="fbtn primary" disabled={saving || !complete} onClick={() => void save(true)}>
          {saving ? 'Saving…' : 'Save & Next'}
        </button>
        <button className="fbtn" disabled={saving || !complete} onClick={() => void save(false)}>
          Save
        </button>
        {!complete && !conflict && <span className="saved-note">Score every criterion to save.</span>}
        {savedNote && <span className="saved-note">{savedNote}</span>}
      </div>
    </section>
  )
}

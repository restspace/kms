// Speaker sourcing pipeline (spec-gap CRM-07/08): the org-wide kanban board.
// Sits in its own sidebar section — the pipeline spans the organisation like
// the contact directory, so it ignores the workspace's event filter entirely.
//
// Two ways to move a card, one write path: HTML5 drag-and-drop onto a column
// and the per-card "Move to" select both call the same PATCH, and the stage
// history is recorded server-side, so the timelines cannot differ by input
// method. Everything on screen is server state — a reload always agrees.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addPipelineNote,
  ApiError,
  assignPipelineCard,
  deletePipelineCard,
  enrollPipelineCard,
  fetchPipeline,
  fetchPipelineCard,
  queryContactsOrg,
  updatePipelineCard,
  type Me,
  type PipelineActivityRow,
  type PipelineCard,
} from '../api'
import { ModalDialog, appConfirm } from '../components/dialogs'
import { navigate } from '../router'
import './crm.css'

/** Display labels for the server's fixed stage vocabulary. Terminal stages
 * get chip styling on the column header so won/lost read at a glance. */
const STAGE_LABELS: Record<string, string> = {
  identified: 'Identified',
  researching: 'Researching',
  contacted: 'Contacted',
  interested: 'Interested',
  confirmed: 'Confirmed',
  declined: 'Declined',
}

const TERMINAL_STAGES = new Set(['confirmed', 'declined'])

const stageLabel = (key: string): string =>
  STAGE_LABELS[key] ??
  key.split('_').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ')

const cardName = (c: PipelineCard): string =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email

/** Absolute timestamp — the activity log is evidence, so no "2h ago". */
const fmtWhen = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

interface OrgPickerRow {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  company: string | null
}

const queryOrgContacts = queryContactsOrg<OrgPickerRow>()

// ---------------------------------------------------------------------------
// Enroll dialog
// ---------------------------------------------------------------------------

function EnrollDialog({
  stages,
  enrolledContactIds,
  onEnrolled,
  onClose,
}: {
  stages: string[]
  enrolledContactIds: ReadonlySet<string>
  onEnrolled: (card: PipelineCard) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<OrgPickerRow[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<OrgPickerRow | null>(null)
  const [stage, setStage] = useState(stages.find((s) => !TERMINAL_STAGES.has(s)) ?? stages[0] ?? '')
  const [score, setScore] = useState('')
  const [rationale, setRationale] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      queryOrgContacts({ from: 0, size: 20, filters: q.trim() ? { q: q.trim() } : {} })
        .then((res) => {
          if (cancelled) return
          setResults(res.items)
          setSearching(false)
        })
        .catch(() => {
          if (cancelled) return
          setResults([])
          setSearching(false)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q])

  const submit = async () => {
    if (!selected) {
      setError('Choose a contact to enroll.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const card = await enrollPipelineCard({
        contact_id: selected.id,
        stage,
        score: score.trim() === '' ? null : Number(score),
        rationale: rationale.trim() || null,
      })
      onEnrolled(card)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <ModalDialog open title="Enroll a prospect" onClose={onClose} initialFocusRef={searchRef} width="md">
      <div className="pl-enroll">
        <label className="pl-field">
          <span className="pl-field-label">Contact</span>
          <input
            ref={searchRef}
            type="search"
            placeholder="Search the directory by name, email or company…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <div className="pl-enroll-results" role="listbox" aria-label="Directory contacts">
          {results.map((row) => {
            const already = enrolledContactIds.has(row.id)
            const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email
            return (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={selected?.id === row.id}
                className={`pl-enroll-row ${selected?.id === row.id ? 'selected' : ''}`}
                disabled={already}
                onClick={() => setSelected(row)}
              >
                <span className="pl-enroll-name">{name}</span>
                <span className="pl-enroll-meta">
                  {already ? 'already on the board' : [row.email, row.company].filter(Boolean).join(' · ')}
                </span>
              </button>
            )
          })}
          {results.length === 0 && (
            <div className="pl-enroll-empty">{searching ? 'Searching…' : 'No matching contacts.'}</div>
          )}
        </div>
        <div className="pl-enroll-grid">
          <label className="pl-field">
            <span className="pl-field-label">Starting stage</span>
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              {stages.map((s) => (
                <option key={s} value={s}>{stageLabel(s)}</option>
              ))}
            </select>
          </label>
          <label className="pl-field">
            <span className="pl-field-label">Score (0–100, optional)</span>
            <input
              type="number"
              min={0}
              max={100}
              value={score}
              onChange={(e) => setScore(e.target.value)}
              placeholder="e.g. 85"
            />
          </label>
        </div>
        <label className="pl-field">
          <span className="pl-field-label">Rationale (optional)</span>
          <textarea
            rows={3}
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Why this person is worth pursuing…"
          />
        </label>
        {error && <div className="pl-error" role="alert">{error}</div>}
        <div className="pl-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={busy || !selected} onClick={() => void submit()}>
            {busy ? 'Enrolling…' : 'Enroll'}
          </button>
        </div>
      </div>
    </ModalDialog>
  )
}

// ---------------------------------------------------------------------------
// Card detail drawer
// ---------------------------------------------------------------------------

function ActivityEntry({ entry }: { entry: PipelineActivityRow }) {
  return (
    <li className={`pl-activity-row pl-activity-${entry.kind}`}>
      <div className="pl-activity-head">
        <span className="pl-activity-when">{fmtWhen(entry.created_at)}</span>
        {entry.author_name && <span className="pl-activity-author">{entry.author_name}</span>}
      </div>
      {entry.kind === 'note' ? (
        <div className="pl-activity-note">{entry.body}</div>
      ) : entry.kind === 'stage_change' ? (
        <div className="pl-activity-move">
          Moved from <strong>{stageLabel(entry.from_stage ?? '')}</strong> to{' '}
          <strong>{stageLabel(entry.to_stage ?? '')}</strong>
        </div>
      ) : (
        <div className="pl-activity-move">
          Enrolled into <strong>{stageLabel(entry.to_stage ?? '')}</strong>
        </div>
      )}
    </li>
  )
}

function CardDetailDialog({
  cardId,
  stages,
  me,
  onChanged,
  onRemoved,
  onClose,
}: {
  cardId: string
  stages: string[]
  me: Me
  onChanged: () => void
  onRemoved: () => void
  onClose: () => void
}) {
  const [detail, setDetail] = useState<(PipelineCard & { activity: PipelineActivityRow[] }) | null>(null)
  const [note, setNote] = useState('')
  const [assignEventId, setAssignEventId] = useState(me.event.id)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    fetchPipelineCard(cardId)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [cardId])

  useEffect(() => reload(), [reload])

  const run = async (action: () => Promise<unknown>, doneNotice?: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      if (doneNotice) setNotice(doneNotice)
      reload()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveNote = () => {
    const text = note.trim()
    if (!text) return
    void run(async () => {
      await addPipelineNote(cardId, text)
      setNote('')
    })
  }

  const remove = async () => {
    if (!detail) return
    const ok = await appConfirm(
      `Remove ${cardName(detail)} from the pipeline? Their contact record is untouched.`,
      { title: 'Remove from pipeline', confirmLabel: 'Remove', danger: true },
    )
    if (!ok) return
    try {
      await deletePipelineCard(cardId)
      onRemoved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const assign = () =>
    void run(async () => {
      await assignPipelineCard(cardId, assignEventId)
    }, `Added to ${me.events.find((e) => e.id === assignEventId)?.name ?? 'the event'} — their profile carried over.`)

  return (
    <ModalDialog open title={detail ? cardName(detail) : 'Prospect'} onClose={onClose} width="lg">
      {!detail ? (
        <div className="pl-detail-loading">{error ?? 'Loading…'}</div>
      ) : (
        <div className="pl-detail">
          <div className="pl-detail-contact">
            <div className="pl-detail-line">{detail.email}</div>
            {(detail.company || detail.job_title) && (
              <div className="pl-detail-line muted">
                {[detail.job_title, detail.company].filter(Boolean).join(' · ')}
              </div>
            )}
            {detail.score !== null && (
              <div className="pl-detail-line">
                Score <span className="pl-score">{detail.score}</span>
              </div>
            )}
            {detail.rationale && <div className="pl-detail-rationale">{detail.rationale}</div>}
            <button
              type="button"
              className="pl-linklike"
              onClick={() => {
                onClose()
                navigate({ v: 'workspace', tab: 'speakers', ev: 'all', rec: detail.contact_id })
              }}
            >
              Open in directory
            </button>
          </div>

          <div className="pl-detail-controls">
            <label className="pl-field">
              <span className="pl-field-label">Stage</span>
              <select
                value={detail.stage}
                disabled={busy}
                onChange={(e) => void run(() => updatePipelineCard(cardId, { stage: e.target.value }))}
              >
                {stages.map((s) => (
                  <option key={s} value={s}>{stageLabel(s)}</option>
                ))}
              </select>
            </label>
            <label className="pl-field">
              <span className="pl-field-label">Add to event</span>
              <span className="pl-assign">
                <select value={assignEventId} disabled={busy} onChange={(e) => setAssignEventId(e.target.value)}>
                  {me.events.map((ev) => (
                    <option key={ev.id} value={ev.id}>{ev.name}</option>
                  ))}
                </select>
                <button type="button" disabled={busy} onClick={assign}>Add</button>
              </span>
            </label>
          </div>

          {notice && <div className="pl-notice" role="status">{notice}</div>}
          {error && <div className="pl-error" role="alert">{error}</div>}

          <div className="pl-notes-compose">
            <textarea
              rows={2}
              placeholder="Add an internal note…"
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
            <button type="button" disabled={busy || !note.trim()} onClick={saveNote}>
              Add note
            </button>
          </div>

          <h4 className="pl-activity-title">Activity</h4>
          <ul className="pl-activity">
            {detail.activity.map((entry) => (
              <ActivityEntry key={entry.id} entry={entry} />
            ))}
            {detail.activity.length === 0 && <li className="pl-activity-empty">No activity yet.</li>}
          </ul>

          <div className="pl-detail-footer">
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              Remove from pipeline
            </button>
          </div>
        </div>
      )}
    </ModalDialog>
  )
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export function PipelineSection({ me }: { me: Me }) {
  const [stages, setStages] = useState<string[]>([])
  const [cards, setCards] = useState<PipelineCard[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const dragCardId = useRef<string | null>(null)

  const reload = useCallback(() => {
    fetchPipeline()
      .then((res) => {
        setStages(res.stages)
        setCards(res.cards)
        setLoaded(true)
        setError(null)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
        setLoaded(true)
      })
  }, [])

  useEffect(() => reload(), [reload])

  const move = useCallback(
    (cardId: string, stage: string) => {
      const card = cards.find((c) => c.id === cardId)
      if (!card || card.stage === stage) return
      // Optimistic column swap; the PATCH response (or a failure reload)
      // settles the truth.
      setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, stage } : c)))
      updatePipelineCard(cardId, { stage })
        .then((updated) => setCards((prev) => prev.map((c) => (c.id === cardId ? updated : c))))
        .catch((e) => {
          setError(e instanceof ApiError ? e.message : 'The move could not be saved — reloading the board.')
          reload()
        })
    },
    [cards, reload],
  )

  const enrolledContactIds = new Set(cards.map((c) => c.contact_id))

  return (
    <div className="pl-shell">
      <div className="pl-header">
        <div className="pl-header-main">
          <h2>Sourcing pipeline</h2>
          <div className="pl-header-sub">
            Prospects across the whole organisation — drag a card between stages, or open it for notes and history.
          </div>
        </div>
        <button type="button" className="primary" onClick={() => setEnrolling(true)}>
          + Enroll
        </button>
      </div>

      {error && <div className="pl-error" role="alert">{error}</div>}

      {!loaded ? (
        <div className="pl-loading">Loading the board…</div>
      ) : (
        <div className="pl-board" role="list" aria-label="Pipeline stages">
          {stages.map((stage) => {
            const columnCards = cards.filter((c) => c.stage === stage)
            return (
              <section
                key={stage}
                role="listitem"
                aria-label={`${stageLabel(stage)} column`}
                className={`pl-column ${TERMINAL_STAGES.has(stage) ? 'terminal' : ''} ${
                  dragOverStage === stage ? 'drag-over' : ''
                }`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOverStage(stage)
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget === e.target) setDragOverStage(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOverStage(null)
                  const id = dragCardId.current ?? e.dataTransfer.getData('text/plain')
                  if (id) move(id, stage)
                  dragCardId.current = null
                }}
              >
                <header className="pl-column-head">
                  <span className="pl-column-name">{stageLabel(stage)}</span>
                  <span className="pl-column-count">{columnCards.length}</span>
                </header>
                <div className="pl-column-cards">
                  {columnCards.map((card) => (
                    <article
                      key={card.id}
                      className="pl-card"
                      draggable
                      onDragStart={(e) => {
                        dragCardId.current = card.id
                        e.dataTransfer.setData('text/plain', card.id)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => {
                        dragCardId.current = null
                        setDragOverStage(null)
                      }}
                    >
                      <button type="button" className="pl-card-open" onClick={() => setOpenCardId(card.id)}>
                        <span className="pl-card-name">{cardName(card)}</span>
                        {(card.company || card.job_title) && (
                          <span className="pl-card-meta">
                            {[card.job_title, card.company].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </button>
                      <div className="pl-card-foot">
                        {card.score !== null && (
                          <span className="pl-score" title={card.rationale ?? undefined}>{card.score}</span>
                        )}
                        <label className="pl-move">
                          <span className="pl-visually-hidden">Move {cardName(card)} to stage</span>
                          <select
                            value={card.stage}
                            onChange={(e) => move(card.id, e.target.value)}
                            title="Move to stage"
                          >
                            {stages.map((s) => (
                              <option key={s} value={s}>{stageLabel(s)}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </article>
                  ))}
                  {columnCards.length === 0 && <div className="pl-column-empty">No prospects</div>}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {enrolling && (
        <EnrollDialog
          stages={stages}
          enrolledContactIds={enrolledContactIds}
          onClose={() => setEnrolling(false)}
          onEnrolled={(card) => {
            setEnrolling(false)
            setCards((prev) => [...prev, card])
          }}
        />
      )}
      {openCardId && (
        <CardDetailDialog
          cardId={openCardId}
          stages={stages}
          me={me}
          onChanged={reload}
          onRemoved={() => {
            setOpenCardId(null)
            reload()
          }}
          onClose={() => setOpenCardId(null)}
        />
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addCriterion,
  assignReviewers,
  createPlan,
  deleteCriterion,
  getEvaluationOverview,
  updateCriterion,
  updatePlan,
  type EvaluationOverview,
} from '../api'
import { appConfirm } from '../components/dialogs'
import '../workspace/review.css'

/**
 * Evaluation admin (docs/06 §4): plan cards with criteria weights, reviewer
 * assignment (everyone or round-robin N) and review progress.
 *
 * Loading discipline (eval defect F3 — "permanent Loading…"): the section used
 * to treat `overview === null` as "still loading", so any load that neither
 * resolved with a payload nor rejected — a hung request, or a 200 whose body
 * failed to parse as JSON, which the fetch client turns into `null` — parked
 * the whole section on "Loading…" forever with no error and no way out. The
 * load now ends in exactly one of three states (ready / error / timed out),
 * always clears the busy flag in a `finally`, and always renders the section
 * chrome so the screen is never blank and Retry is always reachable.
 */

const LOAD_TIMEOUT_MS = 15_000

/** Resolve/reject no matter what the underlying request does. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The server did not respond in time. Check your connection and retry.')),
      ms,
    )
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err: unknown) => { clearTimeout(timer); reject(err) },
    )
  })
}

const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/**
 * Accept a partial payload rather than crashing on it: a missing `stats` or
 * `reviewers` array should cost the user those numbers, not the whole screen.
 * A payload that is not an object at all (null body, HTML error page) is a
 * genuine failure and is reported as one.
 */
function normaliseOverview(raw: unknown): EvaluationOverview {
  if (!raw || typeof raw !== 'object') {
    throw new Error('The server returned an unexpected response for the evaluation overview.')
  }
  const o = raw as Record<string, unknown>
  return {
    plans: asArray<EvaluationOverview['plans'][number]>(o.plans),
    criteria: asArray<EvaluationOverview['criteria'][number]>(o.criteria),
    reviewers: asArray<EvaluationOverview['reviewers'][number]>(o.reviewers),
    stats: asArray<EvaluationOverview['stats'][number]>(o.stats),
  }
}

const message = (e: unknown): string =>
  e instanceof Error && e.message ? e.message : 'Something went wrong. Please retry.'

export function EvaluationSection() {
  const [overview, setOverview] = useState<EvaluationOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [newPlan, setNewPlan] = useState('')
  const [creating, setCreating] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const reload = useCallback(() => {
    setLoading(true)
    setError(null)
    withTimeout(getEvaluationOverview(), LOAD_TIMEOUT_MS)
      .then((raw) => {
        if (!alive.current) return
        setOverview(normaliseOverview(raw))
      })
      .catch((e: unknown) => {
        if (!alive.current) return
        setError(message(e))
      })
      .finally(() => {
        // The one guarantee that matters: "Loading…" always ends.
        if (alive.current) setLoading(false)
      })
  }, [])
  useEffect(() => { reload() }, [reload])

  /** Every mutation reports its outcome — a silent rejection reads as "nothing happened". */
  const run = useCallback((label: string, action: () => Promise<unknown>) => {
    setError(null)
    action()
      .then(() => {
        if (!alive.current) return
        setNote(label)
        reload()
      })
      .catch((e: unknown) => {
        if (alive.current) setError(message(e))
      })
  }, [reload])

  const submitNewPlan = () => {
    const name = newPlan.trim()
    if (!name || creating) return
    setCreating(true)
    setError(null)
    createPlan(name)
      .then(() => {
        if (!alive.current) return
        setNewPlan('')
        setNote(`Created “${name}”`)
        reload()
      })
      .catch((e: unknown) => { if (alive.current) setError(message(e)) })
      .finally(() => { if (alive.current) setCreating(false) })
  }

  return (
    <div className="forms-section">
      <div className="forms-header">
        <h1>
          Evaluation <span className="forms-sub">Review rounds, criteria and reviewer assignment</span>
        </h1>
        {note && <span className="builder-saved">{note}</span>}
        <div className="eval-newplan">
          <input
            aria-label="New plan name"
            placeholder="New review round…"
            value={newPlan}
            onChange={(e) => setNewPlan((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitNewPlan() }}
          />
          <button className="fbtn primary" disabled={creating || !newPlan.trim()} onClick={submitNewPlan}>
            {creating ? 'Creating…' : '+ Create plan'}
          </button>
        </div>
      </div>
      <div className="forms-scroll">
        {error && (
          <div className="builder-error eval-error" role="alert">
            <span>{error}</span>
            <button className="fbtn" onClick={reload}>Retry</button>
          </div>
        )}
        {loading && <p className="pane-sub">Loading…</p>}
        {!loading && overview && overview.plans.length === 0 && !error && (
          <div className="eval-empty">
            <h2>No review rounds yet</h2>
            <p>
              A review round holds the scoring criteria and the reviewer assignments for a set of
              submissions. Name one above to get started — you can add criteria and assign reviewers
              once it exists.
            </p>
            {overview.reviewers.length === 0 && (
              <p className="pane-sub">
                No reviewers are seated on this event yet. Invite people as reviewers in Settings and
                they will appear here for assignment.
              </p>
            )}
          </div>
        )}
        {overview && overview.plans.length > 0 && (
          <div className="eval-grid">
            {overview.plans.map((plan) => (
              <PlanCard key={plan.id} plan={plan} overview={overview} run={run} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PlanCard({
  plan,
  overview,
  run,
}: {
  plan: EvaluationOverview['plans'][number]
  overview: EvaluationOverview
  run: (label: string, action: () => Promise<unknown>) => void
}) {
  const criteria = overview.criteria.filter((c) => c.plan_id === plan.id)
  const stats = overview.stats.find((s) => s.plan_id === plan.id)
  const [chosen, setChosen] = useState<string[]>(overview.reviewers.map((r) => r.id))
  const [strategy, setStrategy] = useState<'all' | 'round_robin'>('all')
  const [perSubmission, setPerSubmission] = useState(2)
  const [assigning, setAssigning] = useState(false)
  const [critName, setCritName] = useState('')
  const [critWeight, setCritWeight] = useState('1')

  const pct = stats && stats.assignments > 0 ? Math.round((stats.completed / stats.assignments) * 100) : 0

  const addCrit = () => {
    const name = critName.trim()
    if (!name) return
    const weight = Number(critWeight)
    setCritName('')
    setCritWeight('1')
    run(`${plan.name}: added “${name}”`, () =>
      addCriterion(plan.id, { name, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 }),
    )
  }

  return (
    <div className="eval-card">
      <h3>
        <input
          className="eval-title"
          aria-label="Plan name"
          defaultValue={plan.name}
          onBlur={(e) => {
            const name = (e.target as HTMLInputElement).value.trim()
            if (name && name !== plan.name) run(`Renamed to “${name}”`, () => updatePlan(plan.id, { name }))
          }}
        />
        <select
          aria-label="Plan status"
          value={plan.status}
          onChange={(e) => {
            const status = (e.target as HTMLSelectElement).value
            run(`${plan.name}: ${status}`, () => updatePlan(plan.id, { status }))
          }}
          style={{ marginLeft: 'auto', fontSize: 11 }}
        >
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="closed">closed</option>
        </select>
      </h3>
      {plan.description && <p className="eval-desc">{plan.description}</p>}
      <p className="eval-desc">
        {stats?.submissions ?? 0} submissions · {stats?.completed ?? 0}/{stats?.assignments ?? 0} reviews complete
      </p>
      <div className="eval-progress"><span style={{ width: `${pct}%` }} /></div>
      <label className="eval-anon">
        <input
          type="checkbox"
          checked={plan.anonymise_submitters === 1}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked
            run(`${plan.name}: ${on ? 'anonymised' : 'submitters visible'}`, () =>
              updatePlan(plan.id, { anonymise_submitters: on }),
            )
          }}
        />
        Hide submitter identities from reviewers
      </label>

      {criteria.length === 0 && <p className="pane-sub">No criteria yet — reviewers will only be able to comment.</p>}
      {criteria.map((c) => (
        <div className="crit-row" key={c.id}>
          <span className="crit-name">{c.name}</span>
          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>weight</span>
          <input
            type="number"
            aria-label={`Weight for ${c.name}`}
            min={0.5}
            step={0.5}
            defaultValue={c.weight}
            onBlur={(e) => {
              const w = Number((e.target as HTMLInputElement).value)
              if (Number.isFinite(w) && w > 0 && w !== c.weight) {
                run(`${c.name}: weight ${w}`, () => updateCriterion(c.id, { weight: w }))
              }
            }}
          />
          <button
            className="fbtn-link danger"
            aria-label={`Remove ${c.name}`}
            onClick={() => {
              void appConfirm(`Remove criterion "${c.name}"?`, { title: 'Remove criterion', confirmLabel: 'Remove', danger: true })
                .then((confirmed) => {
                  if (confirmed) run(`Removed “${c.name}”`, () => deleteCriterion(c.id))
                })
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="crit-add">
        <input
          aria-label="New criterion name"
          placeholder="Add a criterion…"
          value={critName}
          onChange={(e) => setCritName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addCrit() }}
        />
        <input
          aria-label="New criterion weight"
          type="number"
          min={0.5}
          step={0.5}
          value={critWeight}
          onChange={(e) => setCritWeight((e.target as HTMLInputElement).value)}
        />
        <button className="fbtn-link" disabled={!critName.trim()} onClick={addCrit}>+ Add criterion</button>
      </div>

      <div className="eval-assign">
        <strong style={{ fontSize: 12 }}>Reviewers</strong>
        {overview.reviewers.length === 0 && (
          <p className="pane-sub">No reviewers are seated on this event yet.</p>
        )}
        {overview.reviewers.map((r) => (
          <label key={r.id}>
            <input
              type="checkbox"
              checked={chosen.includes(r.id)}
              onChange={(e) =>
                setChosen((prev) =>
                  (e.target as HTMLInputElement).checked ? [...prev, r.id] : prev.filter((id) => id !== r.id),
                )
              }
            />
            {r.name ?? r.email}
          </label>
        ))}
        <div className="assign-controls">
          <select
            aria-label="Assignment strategy"
            value={strategy}
            onChange={(e) => setStrategy((e.target as HTMLSelectElement).value as 'all' | 'round_robin')}
          >
            <option value="all">all reviewers see all</option>
            <option value="round_robin">round-robin</option>
          </select>
          {strategy === 'round_robin' && (
            <select
              aria-label="Reviewers per submission"
              value={perSubmission}
              onChange={(e) => setPerSubmission(Number((e.target as HTMLSelectElement).value))}
            >
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n} per submission</option>)}
            </select>
          )}
          <button
            className="fbtn"
            disabled={assigning || chosen.length === 0}
            onClick={() => {
              setAssigning(true)
              run(`${plan.name}: assigning…`, () =>
                assignReviewers(plan.id, {
                  reviewer_contact_ids: chosen,
                  strategy,
                  per_submission: perSubmission,
                })
                  .then((r) => {
                    setAssigning(false)
                    return r
                  })
                  .catch((e: unknown) => {
                    setAssigning(false)
                    throw e
                  }),
              )
            }}
          >
            {assigning ? 'Assigning…' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  )
}

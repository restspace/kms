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
import {
  addPlanReviewer,
  addReviewer,
  changePlanSubmissions,
  getPlanSubmissions,
  remindReviewers,
  removePlanReviewer,
  sendReviewerSigninLink,
  type MembershipFilter,
  type PlanSubmissionsPayload,
} from './evaluationApi'
import { appConfirm } from '../components/dialogs'
import '../workspace/review.css'

/**
 * Evaluation admin (docs/06 §4): plan cards with criteria weights, the round's
 * submission set, reviewer provisioning/assignment and review progress.
 *
 * Loading discipline (eval defect F3 — "permanent Loading…"): the section used
 * to treat `overview === null` as "still loading", so any load that neither
 * resolved with a payload nor rejected — a hung request, or a 200 whose body
 * failed to parse as JSON, which the fetch client turns into `null` — parked
 * the whole section on "Loading…" forever with no error and no way out. The
 * load now ends in exactly one of three states (ready / error / timed out),
 * always clears the busy flag in a `finally`, and always renders the section
 * chrome so the screen is never blank and Retry is always reachable.
 *
 * Lane L3 additions:
 *  - a submission picker (filter + "Add matching", and an explicit checkbox
 *    list). Without it a round had no submission set at all, so Assign dealt
 *    out nothing and reported "0 submissions" — the top eval bug.
 *  - reviewer provisioning: create/look up a contact by name + email, seat
 *    them as a reviewer, and send them a sign-in link (CFP-10).
 *  - per-reviewer "Remind" / "Remind all lagging" (ABS-09).
 *  - optional Open/Close dates for the round (ABS-01).
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

/** Overview payload plus the fields lane L3 added to the endpoint. */
export interface Overview extends EvaluationOverview {
  pool: Array<{ plan_id: string; contact_id: string }>
  workload: Array<{ plan_id: string; contact_id: string; assigned: number; completed: number }>
  /** Per-reviewer totals across every active plan — what GET /review/queue
   * actually hands that reviewer, unlike `workload` which is per-plan. */
  queue_totals: Array<{ contact_id: string; assigned: number; completed: number }>
}

type Plan = EvaluationOverview['plans'][number] & {
  opens_at?: string | null
  closes_at?: string | null
}

/**
 * Accept a partial payload rather than crashing on it: a missing `stats` or
 * `reviewers` array should cost the user those numbers, not the whole screen.
 * A payload that is not an object at all (null body, HTML error page) is a
 * genuine failure and is reported as one.
 */
function normaliseOverview(raw: unknown): Overview {
  if (!raw || typeof raw !== 'object') {
    throw new Error('The server returned an unexpected response for the evaluation overview.')
  }
  const o = raw as Record<string, unknown>
  return {
    plans: asArray<EvaluationOverview['plans'][number]>(o.plans),
    criteria: asArray<EvaluationOverview['criteria'][number]>(o.criteria),
    reviewers: asArray<EvaluationOverview['reviewers'][number]>(o.reviewers),
    stats: asArray<EvaluationOverview['stats'][number]>(o.stats),
    pool: asArray<Overview['pool'][number]>(o.pool),
    workload: asArray<Overview['workload'][number]>(o.workload),
    queue_totals: asArray<Overview['queue_totals'][number]>(o.queue_totals),
  }
}

/** A note to show when a mutation succeeds, or a function of its result. */
export type Label = string | ((result: unknown) => string)

const message = (e: unknown): string =>
  e instanceof Error && e.message ? e.message : 'Something went wrong. Please retry.'

/** ISO → the `YYYY-MM-DDTHH:mm` a datetime-local input wants, in local time. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local value → ISO, or null when the field was cleared. */
function fromLocalInput(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function EvaluationSection() {
  const [overview, setOverview] = useState<Overview | null>(null)
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

  /**
   * Every mutation reports its outcome — a silent rejection reads as "nothing
   * happened". `label` may be a function of the result so an action can report its
   * own outcome (Assign says how many assignments it actually created, which
   * is the difference between "done" and the old silent no-op).
   */
  const run = useCallback((label: Label, action: () => Promise<unknown>) => {
    setError(null)
    action()
      .then((result) => {
        if (!alive.current) return
        setNote(typeof label === 'function' ? label(result) : label)
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
              submissions. Name one above to get started — you can add criteria, choose the
              submissions it covers and assign reviewers once it exists.
            </p>
          </div>
        )}
        {overview && overview.plans.length > 0 && (
          <div className="eval-grid">
            {overview.plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                overview={overview}
                run={run}
                onNote={setNote}
                onError={setError}
              />
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
  onNote,
  onError,
}: {
  plan: Plan
  overview: Overview
  run: (label: Label, action: () => Promise<unknown>) => void
  onNote: (note: string) => void
  onError: (error: string) => void
}) {
  const criteria = overview.criteria.filter((c) => c.plan_id === plan.id)
  const stats = overview.stats.find((s) => s.plan_id === plan.id)
  const pooled = overview.pool.filter((p) => p.plan_id === plan.id).map((p) => p.contact_id)
  // The ticks mirror exactly this plan's pool rows — nothing more. This used
  // to fall back to "everyone checked" whenever `pooled` was empty, on the
  // theory that an empty pool meant "never configured". But an emptied pool
  // (every reviewer deliberately unticked) is indistinguishable from a
  // never-touched one by that test, so the very case the fallback was meant
  // to help — a brand-new plan — also fired for "I removed them all", and a
  // page reload (a fresh mount, re-running this initializer against the
  // now-empty pool) put every reviewer's tick back. The pool is the only
  // truth; there is no third state to default into.
  const [chosen, setChosen] = useState<string[]>(pooled)
  // …and it keeps following the stored pool afterwards: a failed removal
  // visibly comes back, a successful one stays gone, on every refetch.
  const pooledKey = pooled.join(',')
  useEffect(() => {
    setChosen(pooled)
    // pooledKey is the stable identity of `pooled` (a fresh array each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pooledKey])

  // ABS-07: mirrored locally so the checkbox shows what the *server* stored —
  // set from the row the PUT hands back, reverted if the save fails, and
  // re-synced from every refetch.
  const [anon, setAnon] = useState(plan.anonymise_submitters === 1)
  useEffect(() => { setAnon(plan.anonymise_submitters === 1) }, [plan.anonymise_submitters])

  // CFP-11: the demo/dev sign-in link, shown with the reviewer it belongs to.
  const [signin, setSignin] = useState<{ who: string; email: string; link: string } | null>(null)
  // Target for the Copy button's manual-selection fallback (see below).
  const signinInputRef = useRef<HTMLInputElement | null>(null)
  const [strategy, setStrategy] = useState<'all' | 'round_robin'>('all')
  const [perSubmission, setPerSubmission] = useState(2)
  const [assigning, setAssigning] = useState(false)
  const [critName, setCritName] = useState('')
  const [critWeight, setCritWeight] = useState('1')
  const [addingCrit, setAddingCrit] = useState(false)

  const pct = stats && stats.assignments > 0 ? Math.round((stats.completed / stats.assignments) * 100) : 0

  /**
   * "+ Add criterion" used to occasionally create the criterion twice: the
   * handler is reachable from both Enter and the button, `setCritName('')`
   * only clears the field on the *next* render, and nothing marked the request
   * in flight — so two events in the same tick both read the same non-empty
   * name and both POSTed. The ref is the guard (state would be a render too
   * late) and it is released when the request settles.
   */
  const addingRef = useRef(false)
  const addCrit = () => {
    const name = critName.trim()
    if (!name || addingRef.current) return
    addingRef.current = true
    setAddingCrit(true)
    const weight = Number(critWeight)
    setCritName('')
    setCritWeight('1')
    run(`${plan.name}: added “${name}”`, () =>
      addCriterion(plan.id, { name, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 }).finally(() => {
        addingRef.current = false
        setAddingCrit(false)
      }),
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
          aria-label="Hide submitter identities from reviewers"
          checked={anon}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked
            setAnon(on)
            run(`${plan.name}: ${on ? 'anonymised' : 'submitters visible'}`, () =>
              updatePlan(plan.id, { anonymise_submitters: on })
                .then((res) => {
                  // Trust the stored row over the click that caused it.
                  const stored = (res as { plan?: { anonymise_submitters?: number } } | null)?.plan
                  if (stored && typeof stored.anonymise_submitters === 'number') {
                    setAnon(stored.anonymise_submitters === 1)
                  }
                  return res
                })
                .catch((err: unknown) => {
                  setAnon(!on)
                  throw err
                }),
            )
          }}
        />
        Hide submitter identities from reviewers
      </label>

      {/* ABS-01 — optional window. Leave both blank for "always open". */}
      <div className="eval-window" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0' }}>
        <label style={{ fontSize: 11, display: 'grid', gap: 2 }}>
          Reviews open
          <input
            type="datetime-local"
            aria-label="Reviews open"
            defaultValue={toLocalInput(plan.opens_at)}
            onBlur={(e) => {
              const next = fromLocalInput((e.target as HTMLInputElement).value)
              if (next !== (plan.opens_at ?? null)) {
                run(`${plan.name}: opening date saved`, () => updatePlan(plan.id, { opens_at: next }))
              }
            }}
          />
        </label>
        <label style={{ fontSize: 11, display: 'grid', gap: 2 }}>
          Reviews close
          <input
            type="datetime-local"
            aria-label="Reviews close"
            defaultValue={toLocalInput(plan.closes_at)}
            onBlur={(e) => {
              const next = fromLocalInput((e.target as HTMLInputElement).value)
              if (next !== (plan.closes_at ?? null)) {
                run(`${plan.name}: closing date saved`, () => updatePlan(plan.id, { closes_at: next }))
              }
            }}
          />
        </label>
      </div>

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
        <button className="fbtn-link" disabled={addingCrit || !critName.trim()} onClick={addCrit}>
          {addingCrit ? 'Adding…' : '+ Add criterion'}
        </button>
      </div>

      <SubmissionPicker plan={plan} run={run} />

      <div className="eval-assign">
        <strong style={{ fontSize: 12 }}>Reviewers</strong>
        {overview.reviewers.length === 0 && (
          <p className="pane-sub">No reviewers on this event yet — add one below.</p>
        )}
        {overview.reviewers.map((r) => {
          const load = overview.workload.find((w) => w.plan_id === plan.id && w.contact_id === r.id)
          const outstanding = load ? load.assigned - load.completed : 0
          const queueTotal = overview.queue_totals.find((q) => q.contact_id === r.id)
          return (
            <div key={r.id} className="eval-reviewer" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <label style={{ flex: 1 }}>
                <input
                  type="checkbox"
                  aria-label={`${r.name ?? r.email} in this round`}
                  checked={chosen.includes(r.id)}
                  onChange={(e) => {
                    const on = (e.target as HTMLInputElement).checked
                    // Persist immediately (the pool is server state), and put
                    // the tick back if the write fails.
                    setChosen((prev) =>
                      on ? [...new Set([...prev, r.id])] : prev.filter((id) => id !== r.id),
                    )
                    const who = r.name ?? r.email
                    run(
                      on ? `${who} added to ${plan.name}` : `${who} removed from ${plan.name}`,
                      () =>
                        (on ? addPlanReviewer(plan.id, r.id) : removePlanReviewer(plan.id, r.id)).catch(
                          (err: unknown) => {
                            setChosen((prev) =>
                              on ? prev.filter((id) => id !== r.id) : [...new Set([...prev, r.id])],
                            )
                            throw err
                          },
                        ),
                    )
                  }}
                />
                {r.name ?? r.email}
                {load && (
                  <span className="pane-sub" style={{ marginLeft: 6 }}>
                    {load.completed}/{load.assigned} done
                  </span>
                )}
                {queueTotal && queueTotal.assigned !== load?.assigned && (
                  <span className="pane-sub" style={{ marginLeft: 6 }} title="Assignments across every active plan — matches this reviewer's actual queue">
                    ({queueTotal.assigned} across all active plans)
                  </span>
                )}
              </label>
              <button
                className="fbtn-link"
                aria-label={`Send sign-in link to ${r.name ?? r.email}`}
                onClick={() => {
                  sendReviewerSigninLink(r.id)
                    .then((res) => {
                      // The panel is labelled with the identity the *server*
                      // minted the link for, not the row that was clicked.
                      if (res.dev_link) {
                        setSignin({ who: res.name ?? r.name ?? res.email, email: res.email, link: res.dev_link })
                      } else {
                        setSignin(null)
                        onNote(`Sign-in link sent to ${res.email}`)
                      }
                    })
                    .catch((e: unknown) => onError(message(e)))
                }}
              >
                Send sign-in link
              </button>
              {outstanding > 0 && (
                <button
                  className="fbtn-link"
                  aria-label={`Remind ${r.name ?? r.email}`}
                  onClick={() =>
                    remindReviewers(plan.id, [r.id])
                      .then((res) =>
                        onNote(res.sent > 0 ? `Reminder sent to ${r.name ?? r.email}` : 'Already reminded today'),
                      )
                      .catch((e: unknown) => onError(message(e)))
                  }
                >
                  Remind
                </button>
              )}
            </div>
          )
        })}

        {/* CFP-11: on the demo instance a reviewer account is only reachable
            through this link, so it is shown as a durable, copyable panel
            naming its owner — not a transient note that could be mistaken for
            somebody else's link. */}
        {signin && (
          <div className="eval-signin" role="status" style={{ display: 'grid', gap: 4, margin: '6px 0', fontSize: 12 }}>
            <strong>Sign-in link for {signin.who} ({signin.email})</strong>
            <span className="pane-sub">
              Valid for 15 minutes, single use. Send it to this reviewer — opening it here signs you in as them.
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                ref={signinInputRef}
                readOnly
                aria-label={`Sign-in link for ${signin.who}`}
                value={signin.link}
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }}
                onFocus={(e) => (e.target as HTMLInputElement).select()}
              />
              <button
                className="fbtn-link"
                onClick={() => {
                  // Writing to the clipboard needs a permission the browser
                  // will not always grant (headless runs never do, and neither
                  // does an unfocused or insecure context) — and
                  // `navigator.clipboard` may be absent entirely, in which
                  // case the old `navigator.clipboard?.writeText(...).then(…)`
                  // threw on `.then` of undefined. A refused copy is not an
                  // error the organiser caused or can fix: fall back to
                  // selecting the link so Ctrl+C works, and say so as an
                  // ordinary note rather than a red failure.
                  const selectInstead = () => {
                    const el = signinInputRef.current
                    el?.focus()
                    el?.select()
                    onNote('Press Ctrl+C (Cmd+C) to copy — the link is selected.')
                  }
                  let attempt: Promise<void> | undefined
                  try {
                    attempt = navigator.clipboard?.writeText(signin.link)
                  } catch {
                    attempt = undefined
                  }
                  if (!attempt) {
                    selectInstead()
                    return
                  }
                  void attempt.then(() => onNote(`Copied the sign-in link for ${signin.who}`), selectInstead)
                }}
              >
                Copy
              </button>
              <button className="fbtn-link" onClick={() => setSignin(null)}>Dismiss</button>
            </div>
          </div>
        )}

        <AddReviewer planId={plan.id} run={run} />

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
              run(
                (result) => {
                  // The old silent "0 submissions" outcome now says why.
                  const res = result as { submissions: number; created: number }
                  return res.submissions === 0
                    ? 'No submissions in this round yet — add some above, then assign.'
                    : `${plan.name}: ${res.created} new assignment(s) across ${res.submissions} submission(s)`
                },
                () =>
                  assignReviewers(plan.id, {
                    reviewer_contact_ids: chosen,
                    strategy,
                    per_submission: perSubmission,
                  }).finally(() => setAssigning(false)),
              )
            }}
          >
            {assigning ? 'Assigning…' : 'Assign'}
          </button>
          <button
            className="fbtn-link"
            onClick={() =>
              remindReviewers(plan.id)
                .then((res) =>
                  onNote(
                    res.lagging.length === 0
                      ? 'Nobody is behind on this round.'
                      : `Reminded ${res.sent} of ${res.lagging.length} lagging reviewer(s)`,
                  ),
                )
                .catch((e: unknown) => onError(message(e)))
            }
          >
            Remind all lagging
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * CFP-10: create or look up a contact by name + email, seat them as a reviewer
 * on the event and drop them into this round's pool. Before this there was no
 * route to a usable reviewer anywhere in the product.
 */
function AddReviewer({ planId, run }: { planId: string; run: (label: Label, action: () => Promise<unknown>) => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const submit = () => {
    const address = email.trim()
    if (!address || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const label = name.trim() || address
    setName('')
    setEmail('')
    run(`Added ${label} as a reviewer`, () =>
      addReviewer({ name: name.trim() || undefined, email: address, plan_id: planId }).finally(() => {
        busyRef.current = false
        setBusy(false)
      }),
    )
  }

  return (
    <div className="eval-addreviewer" style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
      <input
        aria-label="Reviewer name"
        placeholder="Reviewer name"
        value={name}
        onChange={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <input
        aria-label="Reviewer email"
        placeholder="reviewer@example.com"
        type="email"
        value={email}
        onChange={(e) => setEmail((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
      />
      <button className="fbtn-link" disabled={busy || !email.trim()} onClick={submit}>
        {busy ? 'Adding…' : '+ Add reviewer'}
      </button>
    </div>
  )
}

/**
 * The round's submission set (docs/06 §4). Two ways in, as the spec asks: a
 * track/format/status filter with "Add matching", and an explicit checkbox
 * list of the event's submissions.
 */
function SubmissionPicker({
  plan,
  run,
}: {
  plan: Plan
  run: (label: Label, action: () => Promise<unknown>) => void
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<PlanSubmissionsPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<MembershipFilter>({})
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(() => {
    setBusy(true)
    setError(null)
    getPlanSubmissions(plan.id)
      .then((payload) => { if (alive.current) setData(payload) })
      .catch((e: unknown) => { if (alive.current) setError(message(e)) })
      .finally(() => { if (alive.current) setBusy(false) })
  }, [plan.id])

  useEffect(() => { if (open && !data) load() }, [open, data, load])

  const mutate = (label: string, body: Parameters<typeof changePlanSubmissions>[1]) => {
    setBusy(true)
    setError(null)
    changePlanSubmissions(plan.id, body)
      .then((res) => {
        if (!alive.current) return
        // Refresh both this list and the card's counters.
        load()
        run(`${label} (${res.changed} changed, ${res.total} in round)`, () => Promise.resolve())
      })
      .catch((e: unknown) => { if (alive.current) { setError(message(e)); setBusy(false) } })
  }

  const matching = (data?.items ?? []).filter(
    (i) =>
      (!filter.track_id || i.track_id === filter.track_id) &&
      (!filter.format || i.format === filter.format) &&
      (!filter.status || i.status === filter.status),
  )

  return (
    <div className="eval-submissions" style={{ marginTop: 8 }}>
      <button className="fbtn-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide submissions' : 'Choose submissions'}
      </button>
      {open && (
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          {error && <p className="builder-error" role="alert">{error}</p>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              aria-label="Filter by track"
              value={filter.track_id ?? ''}
              onChange={(e) => setFilter((f) => ({ ...f, track_id: (e.target as HTMLSelectElement).value || undefined }))}
            >
              <option value="">Any track</option>
              {(data?.tracks ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select
              aria-label="Filter by format"
              value={filter.format ?? ''}
              onChange={(e) => setFilter((f) => ({ ...f, format: (e.target as HTMLSelectElement).value || undefined }))}
            >
              <option value="">Any format</option>
              {(data?.formats ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select
              aria-label="Filter by status"
              value={filter.status ?? ''}
              onChange={(e) => setFilter((f) => ({ ...f, status: (e.target as HTMLSelectElement).value || undefined }))}
            >
              <option value="">Any status</option>
              {['pending', 'accept_queue', 'accepted', 'decline_queue', 'declined'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button
              className="fbtn"
              disabled={busy}
              onClick={() => mutate('Added matching submissions', { mode: 'add', filter })}
            >
              Add matching ({matching.length})
            </button>
            <button
              className="fbtn-link"
              disabled={busy}
              onClick={() => mutate('Removed matching submissions', { mode: 'remove', filter })}
            >
              Remove matching
            </button>
          </div>

          {busy && !data && <p className="pane-sub">Loading submissions…</p>}
          {data && data.items.length === 0 && (
            <p className="pane-sub">This event has no reviewable submissions yet.</p>
          )}
          {data && data.items.length > 0 && (
            <div className="eval-sublist" style={{ maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 2 }}>
              {data.items.map((item) => (
                <label key={item.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                  <input
                    type="checkbox"
                    aria-label={`${item.title} in this round`}
                    checked={item.member === 1}
                    disabled={busy}
                    onChange={(e) =>
                      mutate(
                        (e.target as HTMLInputElement).checked ? `Added ${item.code}` : `Removed ${item.code}`,
                        {
                          mode: (e.target as HTMLInputElement).checked ? 'add' : 'remove',
                          submission_ids: [item.id],
                        },
                      )
                    }
                  />
                  <span style={{ color: 'var(--text-faint)' }}>{item.code}</span>
                  <span style={{ flex: 1 }}>{item.title}</span>
                  <span className="pane-sub">{item.track_name ?? '—'} · {item.status}</span>
                  {item.assignments > 0 && <span className="pane-sub">{item.assignments} assigned</span>}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

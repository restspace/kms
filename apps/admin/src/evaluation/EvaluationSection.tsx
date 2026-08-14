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
import { buildAssignBody, buildScalePatch, parseCapInput, resolveDateInputBlur } from './evaluationLogic'
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
  pool: Array<{ plan_id: string; contact_id: string; max_assignments?: number | null }>
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

/** ISO → a short human-readable local date-time for the summary lines. */
function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function EvaluationSection() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [newPlan, setNewPlan] = useState('')
  const [creating, setCreating] = useState(false)
  // Replay defect #1: the round the organiser just created, so its card can
  // open with the criteria editor active (see PlanCard's autoEditCriteria).
  const [freshPlanId, setFreshPlanId] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // Notes are transient confirmations — dismiss themselves after a moment.
  // Errors stay until retried or dismissed.
  useEffect(() => {
    if (!note) return
    const t = window.setTimeout(() => { if (alive.current) setNote(null) }, 6000)
    return () => window.clearTimeout(t)
  }, [note])

  // Replay defect #1 (supporting fix): every mutation triggers a reload, so
  // two quick edits put two overview fetches in flight — and if the older
  // response resolved last it silently reinstated a stale overview (criteria
  // lists missing their newest rows, which reads as "mangled"). Only the
  // newest request may write state.
  const loadSeq = useRef(0)

  const reload = useCallback(() => {
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    withTimeout(getEvaluationOverview(), LOAD_TIMEOUT_MS)
      .then((raw) => {
        if (!alive.current || seq !== loadSeq.current) return
        setOverview(normaliseOverview(raw))
      })
      .catch((e: unknown) => {
        if (!alive.current || seq !== loadSeq.current) return
        setError(message(e))
      })
      .finally(() => {
        // The one guarantee that matters: "Loading…" always ends.
        if (alive.current && seq === loadSeq.current) setLoading(false)
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
      .then((res) => {
        if (!alive.current) return
        setNewPlan('')
        setNote(`Created “${name}”`)
        // Replay defect #1 (cross-round criteria bleed): after Create, the new
        // round's card used to appear last, closed, while any previously
        // opened criteria editor — belonging to the *old* round — stayed open
        // and kept accepting input. Criteria typed "for the new round" were
        // POSTed with the old round's plan id. Remember the new id so its
        // card mounts with the criteria editor open and focused: the active
        // criteria target is now the round the organiser just created.
        setFreshPlanId(typeof res?.id === 'string' ? res.id : null)
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
                autoEditCriteria={plan.id === freshPlanId}
              />
            ))}
          </div>
        )}
      </div>
      {/*
        * Transient outcome/error reporting. These used to render at the TOP
        * (a note beside the h1, an error block at the head of the scroll
        * area), so every confirmation reflowed the whole section — visible
        * jank on each click. The bar overlays the bottom edge instead
        * (position: absolute in review.css), so showing or clearing a
        * message never moves the content above it.
        */}
      {(error || note) && (
        <div
          className={`eval-status-bar${error ? ' is-error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          <span className="eval-status-bar-text">{error ?? note}</span>
          {error && <button className="fbtn" onClick={reload}>Retry</button>}
          <button
            className="fbtn"
            aria-label="Dismiss message"
            onClick={() => { setError(null); setNote(null) }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}

function PlanCard({
  plan,
  overview,
  run,
  onNote,
  onError,
  autoEditCriteria = false,
}: {
  plan: Plan
  overview: Overview
  run: (label: Label, action: () => Promise<unknown>) => void
  onNote: (note: string) => void
  onError: (error: string) => void
  /** Replay defect #1: true for a just-created round — its card mounts with
   *  the criteria editor open and the name input focused, so criteria typed
   *  right after Create land on this round, not on whichever older round's
   *  editor happened to be open. */
  autoEditCriteria?: boolean
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
  const signinCodeRef = useRef<HTMLElement | null>(null)
  const [strategy, setStrategy] = useState<'all' | 'round_robin'>('all')
  const [perSubmission, setPerSubmission] = useState(2)
  const [assigning, setAssigning] = useState(false)
  const [critName, setCritName] = useState('')
  const [critWeight, setCritWeight] = useState('1')
  // 0026 — criterion field types: numeric scale (default), dropdown, long text.
  const [critKind, setCritKind] = useState<'score' | 'choice' | 'text'>('score')
  const [critOptions, setCritOptions] = useState('')
  const [addingCrit, setAddingCrit] = useState(false)
  // Each section reads as a one-line summary until its ✎ opens the editor.
  const [editTiming, setEditTiming] = useState(false)
  const [editScale, setEditScale] = useState(false)
  const [editCriteria, setEditCriteria] = useState(autoEditCriteria)
  const [editReviewers, setEditReviewers] = useState(false)
  // Focus the new round's criterion-name input once its editor is on screen.
  const critNameRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (autoEditCriteria) critNameRef.current?.focus()
    // Mount-time only: the card is keyed by plan.id, so a fresh round is a
    // fresh mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ABS-05: submissions ticked for a scoped Assign (server already accepts
  // submission_ids — this was the missing UI half).
  const [assignPicked, setAssignPicked] = useState<Set<string>>(new Set())
  const toggleAssignPicked = useCallback((id: string, on: boolean) => {
    setAssignPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const [onlySelected, setOnlySelected] = useState(false)

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
    // Replay defect #2: a second criterion with the same name makes the
    // reviewer scorecard ambiguous. Same case-insensitive trim compare the
    // server now enforces (409 duplicate_criterion_name) — checked here too
    // so the organiser gets told before the field is cleared.
    if (criteria.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) {
      onError(`“${name}” is already a criterion on ${plan.name} — names must be unique within a round.`)
      return
    }
    // A dropdown needs at least two options before it means anything.
    const options = critOptions.split(',').map((o) => o.trim()).filter(Boolean)
    if (critKind === 'choice' && options.length < 2) return
    addingRef.current = true
    setAddingCrit(true)
    const weight = Number(critWeight)
    setCritName('')
    setCritWeight('1')
    setCritOptions('')
    setCritKind('score')
    run(`${plan.name}: added “${name}”`, () =>
      addCriterion(plan.id, {
        name,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
        kind: critKind,
        ...(critKind === 'choice' ? { options } : {}),
      }).finally(() => {
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
      <div className="eval-inline">
        <span className="eval-inline-text">
          {plan.opens_at || plan.closes_at
            ? [
                plan.opens_at ? `Opens ${fmtWhen(plan.opens_at)}` : null,
                plan.closes_at ? `Closes ${fmtWhen(plan.closes_at)}` : null,
              ].filter(Boolean).join(' · ')
            : 'Always open'}
        </span>
        <button
          className="fbtn-link eval-editicon"
          aria-label="Edit timing"
          aria-expanded={editTiming}
          onClick={() => setEditTiming((v) => !v)}
        >
          ✎
        </button>
      </div>
      {editTiming && (
      <div className="eval-window" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0' }}>
        <label style={{ fontSize: 11, display: 'grid', gap: 2 }}>
          Reviews open
          <input
            type="datetime-local"
            aria-label="Reviews open"
            defaultValue={toLocalInput(plan.opens_at)}
            onBlur={(e) => {
              const input = e.target as HTMLInputElement
              // #24: commit-on-blur, but validated — see resolveDateInputBlur.
              const outcome = resolveDateInputBlur(
                input.value,
                input.validity.badInput,
                plan.opens_at ?? null,
                fromLocalInput,
              )
              if (outcome.action === 'invalid') {
                input.value = toLocalInput(plan.opens_at)
                onError('That opening date is incomplete — it was not saved.')
                return
              }
              if (outcome.action === 'save') {
                run(`${plan.name}: opening date saved`, () => updatePlan(plan.id, { opens_at: outcome.next }))
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
              const input = e.target as HTMLInputElement
              const outcome = resolveDateInputBlur(
                input.value,
                input.validity.badInput,
                plan.closes_at ?? null,
                fromLocalInput,
              )
              if (outcome.action === 'invalid') {
                input.value = toLocalInput(plan.closes_at)
                onError('That closing date is incomplete — it was not saved.')
                return
              }
              if (outcome.action === 'save') {
                run(`${plan.name}: closing date saved`, () => updatePlan(plan.id, { closes_at: outcome.next }))
              }
            }}
          />
        </label>
      </div>
      )}

      {/* ABS-01 — the per-round scoring scale. Reviewer buttons and the save
          clamp already build from these bounds; this is the only editor. */}
      <div className="eval-inline">
        <span className="eval-inline-text">
          Scale {plan.scoring_scale_min}–{plan.scoring_scale_max}
        </span>
        <button
          className="fbtn-link eval-editicon"
          aria-label="Edit scale"
          aria-expanded={editScale}
          onClick={() => setEditScale((v) => !v)}
        >
          ✎
        </button>
      </div>
      {editScale && (
      <div className="eval-window" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0', alignItems: 'end' }}>
        <label style={{ fontSize: 11, display: 'grid', gap: 2 }}>
          Min
          <input
            type="number"
            aria-label="Scale minimum"
            defaultValue={plan.scoring_scale_min}
            onBlur={(e) => {
              const patch = buildScalePatch('scoring_scale_min', (e.target as HTMLInputElement).value, plan.scoring_scale_min)
              if (patch) run(`${plan.name}: scale saved`, () => updatePlan(plan.id, patch))
            }}
          />
        </label>
        <label style={{ fontSize: 11, display: 'grid', gap: 2 }}>
          Max
          <input
            type="number"
            aria-label="Scale maximum"
            defaultValue={plan.scoring_scale_max}
            onBlur={(e) => {
              const patch = buildScalePatch('scoring_scale_max', (e.target as HTMLInputElement).value, plan.scoring_scale_max)
              if (patch) run(`${plan.name}: scale saved`, () => updatePlan(plan.id, patch))
            }}
          />
        </label>
        {(stats?.completed ?? 0) > 0 && (
          <span className="pane-sub">Reviews are already recorded — the scale can no longer change.</span>
        )}
      </div>
      )}

      <div className="eval-inline">
        <strong style={{ fontSize: 12 }}>Criteria</strong>
        <span className="eval-inline-text">
          {criteria.length > 0
            ? criteria
                .map((c) => ((c.kind ?? 'score') === 'score' ? `${c.name}: ${c.weight}` : `${c.name} (${c.kind})`))
                .join(', ')
            : 'None'}
        </span>
        <button
          className="fbtn-link eval-editicon"
          aria-label="Edit criteria"
          aria-expanded={editCriteria}
          onClick={() => setEditCriteria((v) => !v)}
        >
          ✎
        </button>
      </div>
      {editCriteria && (
      <>
      {criteria.length === 0 && <p className="pane-sub">No criteria yet — reviewers will only be able to comment.</p>}
      {criteria.map((c) => (
        <div className="crit-row" key={c.id}>
          <span className="crit-name">{c.name}</span>
          {(c.kind ?? 'score') === 'score' ? (
            <>
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
            </>
          ) : (
            <span style={{ color: 'var(--text-faint)', fontSize: 11 }} title={
              c.kind === 'choice'
                ? `Options: ${(() => { try { return (JSON.parse(c.options ?? '[]') as string[]).join(', ') } catch { return '' } })()}`
                : 'Free-text answer — not part of the numeric score'
            }>
              {c.kind === 'choice' ? 'dropdown' : 'long text'}
            </span>
          )}
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
          ref={critNameRef}
          aria-label="New criterion name"
          placeholder="Add a criterion…"
          value={critName}
          onChange={(e) => setCritName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addCrit() }}
        />
        <select
          aria-label="New criterion type"
          value={critKind}
          onChange={(e) => setCritKind((e.target as HTMLSelectElement).value as 'score' | 'choice' | 'text')}
        >
          <option value="score">scale</option>
          <option value="choice">dropdown</option>
          <option value="text">long text</option>
        </select>
        {critKind === 'score' && (
          <input
            aria-label="New criterion weight"
            type="number"
            min={0.5}
            step={0.5}
            value={critWeight}
            onChange={(e) => setCritWeight((e.target as HTMLInputElement).value)}
          />
        )}
        {critKind === 'choice' && (
          <input
            aria-label="New criterion options"
            placeholder="Options, comma-separated"
            value={critOptions}
            onChange={(e) => setCritOptions((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addCrit() }}
          />
        )}
        <button
          className="fbtn-link"
          disabled={
            addingCrit ||
            !critName.trim() ||
            (critKind === 'choice' && critOptions.split(',').map((o) => o.trim()).filter(Boolean).length < 2)
          }
          title={critKind === 'choice' ? 'A dropdown needs at least two comma-separated options' : undefined}
          onClick={addCrit}
        >
          {addingCrit ? 'Adding…' : '+ Add criterion'}
        </button>
      </div>
      </>
      )}

      <SubmissionPicker
        plan={plan}
        run={run}
        assignPicked={assignPicked}
        onToggleAssignPicked={toggleAssignPicked}
      />

      <div className="eval-assign">
        <div className="eval-inline">
          <strong style={{ fontSize: 12 }}>Reviewers</strong>
          <span className="eval-inline-text" />
          <button
            className="fbtn-link eval-editicon"
            aria-label="Edit reviewers"
            aria-expanded={editReviewers}
            onClick={() => setEditReviewers((v) => !v)}
          >
            ✎
          </button>
        </div>
        {overview.reviewers.length === 0 && (
          <p className="pane-sub">No reviewers on this event yet — use ✎ to add one.</p>
        )}
        {(() => {
          // Default view: only reviewers the round has actually dealt
          // submissions to — which keeps showing someone who was unticked
          // after assignment (their reviews still exist). The editor (✎)
          // lists everyone.
          const shown = editReviewers
            ? overview.reviewers
            : overview.reviewers.filter((r) =>
                overview.workload.some(
                  (w) => w.plan_id === plan.id && w.contact_id === r.id && w.assigned > 0,
                ),
              )
          if (shown.length === 0) {
            return !editReviewers && overview.reviewers.length > 0 ? (
              <p className="pane-sub">No reviewers have assignments in this round yet — use ✎ to assign.</p>
            ) : null
          }
          return (
            <table className="eval-revtable">
              <thead>
                <tr>
                  <th>Active</th>
                  <th>Name</th>
                  <th>Done</th>
                  <th>All Plans</th>
                  {editReviewers && <th>Cap</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const load = overview.workload.find((w) => w.plan_id === plan.id && w.contact_id === r.id)
                  const outstanding = load ? load.assigned - load.completed : 0
                  const queueTotal = overview.queue_totals.find((q) => q.contact_id === r.id)
                  const who = r.name ?? r.email
                  // ABS-06: the cap lives on the pool row, so it only means
                  // anything once this reviewer is actually in the pool.
                  const poolRow = overview.pool.find((p) => p.plan_id === plan.id && p.contact_id === r.id)
                  return (
                    <tr key={r.id} className="eval-reviewer">
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${who} in this round`}
                          checked={chosen.includes(r.id)}
                          onChange={(e) => {
                            const on = (e.target as HTMLInputElement).checked
                            // Persist immediately (the pool is server state), and put
                            // the tick back if the write fails.
                            setChosen((prev) =>
                              on ? [...new Set([...prev, r.id])] : prev.filter((id) => id !== r.id),
                            )
                            // Pooling is not dealing (2026-08-12 eval: a
                            // reviewer ticked into a second round saw no new
                            // queue task because Assign was never pressed) —
                            // say so in the confirmation instead of letting
                            // the tick read as "they now have the work".
                            const dealHint =
                              on && (stats?.submissions ?? 0) > 0
                                ? ` — now click Assign to deal them the round's ${stats!.submissions} submission(s)`
                                : ''
                            run(
                              on ? `${who} added to ${plan.name}${dealHint}` : `${who} removed from ${plan.name}`,
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
                      </td>
                      <td>
                        {who}
                        <button
                          className="fbtn-link"
                          aria-label={`Send sign-in link to ${who}`}
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
                      </td>
                      <td>
                        {load ? (
                          `${load.completed}/${load.assigned}`
                        ) : chosen.includes(r.id) && (stats?.submissions ?? 0) > 0 ? (
                          // In the pool but never dealt anything: without this
                          // the row is indistinguishable from "all done", and
                          // the reviewer's queue silently stays empty.
                          <span className="pane-sub" title="In the pool, but no submissions have been dealt to them — click Assign">
                            not dealt — use Assign
                          </span>
                        ) : (
                          '—'
                        )}
                        {outstanding > 0 && (
                          <button
                            className="fbtn-link"
                            aria-label={`Remind ${who}`}
                            onClick={() =>
                              remindReviewers(plan.id, [r.id])
                                .then((res) =>
                                  onNote(res.sent > 0 ? `Reminder sent to ${who}` : 'Already reminded today'),
                                )
                                .catch((e: unknown) => onError(message(e)))
                            }
                          >
                            Remind
                          </button>
                        )}
                      </td>
                      <td title="Assignments across every active plan — matches this reviewer's actual queue">
                        {queueTotal ? `${queueTotal.completed}/${queueTotal.assigned}` : '—'}
                      </td>
                      {editReviewers && (
                        <td>
                          {poolRow ? (
                            <input
                              type="number"
                              min={1}
                              step={1}
                              aria-label={`Assignment cap for ${who}`}
                              title="Blank = unlimited"
                              placeholder="∞"
                              style={{ width: 48 }}
                              defaultValue={poolRow.max_assignments ?? ''}
                              onBlur={(e) => {
                                const next = parseCapInput((e.target as HTMLInputElement).value, poolRow.max_assignments ?? null)
                                if (next === undefined) return
                                run(
                                  next === null ? `${who}: cap cleared` : `${who}: capped at ${next}`,
                                  () => addPlanReviewer(plan.id, r.id, next),
                                )
                              }}
                            />
                          ) : (
                            <span className="pane-sub">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )
        })()}

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
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              {/* 2026-08-12 eval: the link used to sit in a truncated one-line
                  read-only input, so the full URL was neither readable nor
                  reliably selectable. A wrapping code block shows the whole
                  URL; user-select:all makes one click select the entire link
                  for hand-off even where the Copy button's clipboard
                  permission is refused. */}
              <code
                ref={signinCodeRef}
                aria-label={`Sign-in link for ${signin.who}`}
                tabIndex={0}
                style={{
                  flex: 1,
                  fontFamily: 'monospace',
                  fontSize: 11,
                  lineHeight: 1.5,
                  wordBreak: 'break-all',
                  overflowWrap: 'anywhere',
                  whiteSpace: 'pre-wrap',
                  userSelect: 'all',
                  padding: '4px 6px',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  background: 'var(--surface-raised)',
                }}
              >
                {signin.link}
              </code>
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
                    const el = signinCodeRef.current
                    if (el) {
                      el.focus()
                      const range = document.createRange()
                      range.selectNodeContents(el)
                      const selection = window.getSelection()
                      selection?.removeAllRanges()
                      selection?.addRange(range)
                    }
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

        {editReviewers && (
        <>
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
          {/* ABS-05: scope Assign to just the submissions ticked for it in
              "Choose submissions" — server already accepts submission_ids. */}
          <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              aria-label="Only assign selected submissions"
              checked={onlySelected}
              disabled={assignPicked.size === 0}
              onChange={(e) => setOnlySelected((e.target as HTMLInputElement).checked)}
            />
            Only selected submissions ({assignPicked.size})
          </label>
          <button
            className="fbtn"
            disabled={assigning || chosen.length === 0 || (onlySelected && assignPicked.size === 0)}
            onClick={() => {
              setAssigning(true)
              const scoped = onlySelected && assignPicked.size > 0
              run(
                (result) => {
                  // The old silent "0 submissions" outcome now says why.
                  const res = result as { submissions: number; created: number; unassigned?: Array<{ submission_id: string; short: number }> }
                  const scopeNote = scoped ? ` (${assignPicked.size} selected submission(s))` : ''
                  const shortfallNote =
                    res.unassigned && res.unassigned.length > 0
                      ? ` — ${res.unassigned.length} submission(s) short of reviewers (caps reached)`
                      : ''
                  if (scoped) setAssignPicked(new Set())
                  return res.submissions === 0
                    ? 'No submissions in this round yet — add some above, then assign.'
                    : `${plan.name}: ${res.created} new assignment(s) across ${res.submissions} submission(s)${scopeNote}${shortfallNote}`
                },
                () =>
                  assignReviewers(
                    plan.id,
                    buildAssignBody(
                      { reviewer_contact_ids: chosen, strategy, per_submission: perSubmission },
                      onlySelected,
                      assignPicked,
                    ),
                  ).finally(() => setAssigning(false)),
              )
            }}
          >
            {assigning ? 'Assigning…' : 'Assign'}
          </button>
        </div>
        </>
        )}
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
  assignPicked,
  onToggleAssignPicked,
}: {
  plan: Plan
  run: (label: Label, action: () => Promise<unknown>) => void
  /** ABS-05: submission ids ticked for a scoped Assign (separate from plan
   *  membership — a submission can be a member without being picked). */
  assignPicked: Set<string>
  onToggleAssignPicked: (id: string, on: boolean) => void
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
                  {item.member === 1 && (
                    <input
                      type="checkbox"
                      aria-label={`assign ${item.code}`}
                      title="assign"
                      checked={assignPicked.has(item.id)}
                      onChange={(e) => onToggleAssignPicked(item.id, (e.target as HTMLInputElement).checked)}
                    />
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

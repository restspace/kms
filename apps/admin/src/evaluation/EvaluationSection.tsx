import { useCallback, useEffect, useState } from 'react'
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
 */

export function EvaluationSection() {
  const [overview, setOverview] = useState<EvaluationOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const reload = useCallback(() => {
    getEvaluationOverview()
      .then(setOverview)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [])
  useEffect(reload, [reload])

  if (error) return <div className="forms-scroll"><div className="builder-error">{error}</div></div>
  if (!overview) return <div className="forms-scroll"><p className="pane-sub">Loading…</p></div>

  return (
    <div className="forms-section">
      <div className="forms-header">
        <h1>
          Evaluation <span className="forms-sub">Review rounds, criteria and reviewer assignment</span>
        </h1>
        {note && <span className="builder-saved">{note}</span>}
        <button
          className="fbtn primary"
          onClick={() => {
            const name = window.prompt('Plan name')
            if (name?.trim()) void createPlan(name.trim()).then(reload)
          }}
        >
          + Create plan
        </button>
      </div>
      <div className="forms-scroll">
        <div className="eval-grid">
          {overview.plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} overview={overview} reload={reload} setNote={setNote} />
          ))}
        </div>
      </div>
    </div>
  )
}

function PlanCard({
  plan,
  overview,
  reload,
  setNote,
}: {
  plan: EvaluationOverview['plans'][number]
  overview: EvaluationOverview
  reload: () => void
  setNote: (n: string) => void
}) {
  const criteria = overview.criteria.filter((c) => c.plan_id === plan.id)
  const stats = overview.stats.find((s) => s.plan_id === plan.id)
  const [chosen, setChosen] = useState<string[]>(overview.reviewers.map((r) => r.id))
  const [strategy, setStrategy] = useState<'all' | 'round_robin'>('all')
  const [perSubmission, setPerSubmission] = useState(2)
  const [assigning, setAssigning] = useState(false)

  const pct = stats && stats.assignments > 0 ? Math.round((stats.completed / stats.assignments) * 100) : 0

  return (
    <div className="eval-card">
      <h3>
        {plan.name}
        <select
          value={plan.status}
          onChange={(e) => void updatePlan(plan.id, { status: e.target.value }).then(reload)}
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

      {criteria.map((c) => (
        <div className="crit-row" key={c.id}>
          <span className="crit-name">{c.name}</span>
          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>weight</span>
          <input
            type="number"
            min={0.5}
            step={0.5}
            defaultValue={c.weight}
            onBlur={(e) => {
              const w = Number(e.target.value)
              if (Number.isFinite(w) && w > 0 && w !== c.weight) void updateCriterion(c.id, { weight: w }).then(reload)
            }}
          />
          <button
            className="fbtn-link danger"
            onClick={() => {
              void appConfirm(`Remove criterion "${c.name}"?`, { title: 'Remove criterion', confirmLabel: 'Remove', danger: true })
                .then((confirmed) => {
                  if (confirmed) void deleteCriterion(c.id).then(reload)
                })
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="fbtn-link"
        onClick={() => {
          const name = window.prompt('Criterion name')
          if (!name?.trim()) return
          const weight = Number(window.prompt('Weight', '1')) || 1
          void addCriterion(plan.id, { name: name.trim(), weight }).then(reload)
        }}
      >
        + Add criterion
      </button>

      <div className="eval-assign">
        <strong style={{ fontSize: 12 }}>Reviewers</strong>
        {overview.reviewers.map((r) => (
          <label key={r.id}>
            <input
              type="checkbox"
              checked={chosen.includes(r.id)}
              onChange={(e) =>
                setChosen((prev) => (e.target.checked ? [...prev, r.id] : prev.filter((id) => id !== r.id)))
              }
            />
            {r.name ?? r.email}
          </label>
        ))}
        <div className="assign-controls">
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as 'all' | 'round_robin')}>
            <option value="all">all reviewers see all</option>
            <option value="round_robin">round-robin</option>
          </select>
          {strategy === 'round_robin' && (
            <select value={perSubmission} onChange={(e) => setPerSubmission(Number(e.target.value))}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n} per submission</option>)}
            </select>
          )}
          <button
            className="fbtn"
            disabled={assigning || chosen.length === 0}
            onClick={() => {
              setAssigning(true)
              void assignReviewers(plan.id, {
                reviewer_contact_ids: chosen,
                strategy,
                per_submission: perSubmission,
              })
                .then((r) => {
                  setNote(`${plan.name}: ${r.total_assignments} assignments across ${r.submissions} submissions`)
                  reload()
                })
                .finally(() => setAssigning(false))
            }}
          >
            {assigning ? 'Assigning…' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  )
}

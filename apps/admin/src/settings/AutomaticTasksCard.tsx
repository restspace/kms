import { useEffect, useState } from 'react'
import { listTaskDefinitions, type TaskDefinitionRow } from '../api'
import { navigate, NEW_TASK_RULE } from '../router'

/**
 * Lists `tasks` rows with `assignment_mode='automatic'` — the rules that
 * `autoAssignAcceptTasksCore` (evaluation.ts) turns into `task_assignments`
 * when a submission's acceptance actually sends. These are conceptually
 * distinct from the Workspace → Tasks grid (which lists assignments, one row
 * per assignee) even though both read the same `tasks` table, so they get
 * their own list here rather than being folded into that grid — see the
 * conversation that led to this card for why a rule with zero assignments
 * was previously invisible everywhere in the app.
 *
 * Add/Edit both hand off to the Workspace Tasks tab's rule editor
 * (`AutomaticTaskRuleForm`) via `?taskRule=`, then bounce back here — see
 * `router.ts`'s `taskRule`/`sec` fields.
 */

const readableEnum = (value: string) => value.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase())

export function AutomaticTasksCard() {
  const [rules, setRules] = useState<Array<TaskDefinitionRow & { assignment_count: number }> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = () => {
    setError(null)
    return listTaskDefinitions('automatic')
      .then((r) => setRules(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load automatic tasks'))
  }

  useEffect(() => {
    void reload()
  }, [])

  const openRule = (id: string) => {
    navigate({ v: 'workspace', tab: 'tasks', taskRule: id, sec: 'automatic-tasks' })
  }

  return (
    <section className="settings-card" id="automatic-tasks">
      <h2>Automatic tasks</h2>
      <p className="settings-hint">
        Task rules that assign themselves — currently only the <strong>On accept</strong> trigger fires (when a
        submission's acceptance is actually sent, not the moment it's queued). A rule with no assignments yet is
        still live; it just hasn't matched anyone.
      </p>

      {error && rules === null ? (
        <div className="settings-error">
          {error}{' '}
          <button type="button" className="settings-ghost" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      ) : rules === null ? (
        <div className="settings-hint">Loading…</div>
      ) : (
        <>
          {error && <div className="settings-error">{error}</div>}
          {rules.length === 0 ? (
            <div className="settings-empty">No automatic tasks yet.</div>
          ) : (
            <table className="settings-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Trigger</th>
                  <th>Target</th>
                  <th>Action</th>
                  <th>Assignments</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rules.map((t) => (
                  <tr key={t.id}>
                    <td>{t.title}</td>
                    <td>{readableEnum(t.trigger)}</td>
                    <td>{readableEnum(t.target)}</td>
                    <td>{readableEnum(t.action_type)}</td>
                    <td>{t.assignment_count}</td>
                    <td>
                      <button className="settings-ghost" onClick={() => openRule(t.id)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="settings-template-actions">
            <button type="button" onClick={() => openRule(NEW_TASK_RULE)}>
              + Add automatic task
            </button>
          </div>
        </>
      )}
    </section>
  )
}

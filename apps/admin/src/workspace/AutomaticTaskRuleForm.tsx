import { useEffect, useState } from 'react'
import { TaskCreateForm } from './TaskCreateForm'
import { createTask, getTaskDefinition, updateTask, type TaskDefinitionRow } from '../api'
import { navigate, NEW_TASK_RULE } from '../router'

/**
 * Settings → Automatic tasks' Add/Edit destination. Rule definitions
 * (`tasks` rows) have no edit surface of their own in the Workspace Tasks
 * grid — that grid lists assignments (see the CNT-01 doc comment on
 * `createComponent` in App.tsx) — so a rule with zero assignments is
 * otherwise unreachable. Rather than build a second bespoke form, this reuses
 * TaskCreateForm (with `hideTargetPicker`, since editing a definition via PUT
 * never touches assignments) and drives it from `?taskRule=` instead of
 * DataTabManager's own create-tab machinery, so it's reachable, reload-safe,
 * and independent of having any assignment rows to click into.
 *
 * Save and Cancel both bounce back to Settings at the anchor the caller came
 * from (`?sec=`, defaulting to Automatic tasks itself).
 */
export function AutomaticTaskRuleForm({ ruleId, returnAnchor }: { ruleId: string; returnAnchor: string | null }) {
  const isNew = ruleId === NEW_TASK_RULE
  // TaskCreateForm reads `initialValues` only in its own useState initializer
  // (mount-once) — patching this *after* mount, from an effect, would arrive
  // too late to change its defaults. So the new-rule defaults are set here
  // synchronously, in the very first render, not via an effect.
  const [initial, setInitial] = useState<Partial<TaskDefinitionRow> | null>(
    isNew ? { assignment_mode: 'automatic', trigger: 'on_accept' } : null,
  )
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (isNew) return
    let cancelled = false
    setInitial(null)
    setLoadError(null)
    getTaskDefinition(ruleId)
      .then((r) => { if (!cancelled) setInitial(r.task) })
      .catch((e: unknown) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load the task.') })
    return () => { cancelled = true }
  }, [ruleId, isNew])

  const returnToSettings = () => {
    navigate({ v: 'settings', tab: null, taskRule: null, sec: returnAnchor ?? 'automatic-tasks' })
  }

  const handleSubmit = async (data: Record<string, unknown>) => {
    if (isNew) await createTask(data)
    else await updateTask(ruleId, data)
    returnToSettings()
    return true
  }

  if (loadError) {
    return (
      <div className="settings-error" role="alert">
        {loadError}{' '}
        <button type="button" className="settings-ghost" onClick={returnToSettings}>
          Back to Settings
        </button>
      </div>
    )
  }
  if (!initial) return <div className="settings-hint">Loading…</div>

  return (
    <TaskCreateForm
      title={isNew ? 'New automatic task' : `Edit "${initial.title}"`}
      initialValues={initial}
      onSubmit={handleSubmit}
      onCancel={returnToSettings}
      hideTargetPicker
    />
  )
}

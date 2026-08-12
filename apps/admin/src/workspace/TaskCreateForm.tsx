import { useEffect, useState, type FormEvent } from 'react'
import type { CreateFormProps } from '../components/DataTabManager'
import { getTaskAudiences, queryResource, type ContactRow, type SubmissionRow, type TaskAudience } from '../api'
import { appAlert } from '../components/dialogs'

/**
 * CNT-01: creating a task from the Tasks tab silently produced nothing. The
 * grid lists `task_assignments` (one row per assignee) while `POST
 * /app/api/tasks` only ever wrote the task *definition*, and the generic
 * RecordForm this replaces had no way to name an assignee — so a manual task
 * created zero assignment rows and the list stayed at 0 with no error.
 *
 * This bespoke form keeps the definition fields and adds target selection:
 * a contact multi-select (same search-as-you-type pattern as the participant
 * picker in extras.tsx) or a submission multi-select, whose ids POST /tasks
 * now materialises into assignments in the same request.
 *
 * The `group` target from the schema enum is deliberately absent: no groups
 * tables exist in packages/db, so offering it would be a dead option that
 * could only ever produce an empty task.
 */

const ACTION_TYPES = ['acknowledge', 'file_upload', 'portal_form', 'external_link'] as const
const TRIGGERS = ['none', 'on_accept', 'on_schedule'] as const

/** CNT-01 audiences — labels mirror the messaging composer's AUDIENCE_LABELS
 * (messaging.tsx) so "Speakers" means the same set on both surfaces. */
const AUDIENCE_LABELS: Record<TaskAudience, string> = {
  speakers: 'Speakers (anyone attached to a submission)',
  accepted_speakers: 'Accepted speakers',
  roster: 'All contacts on roster',
  all_contacts: 'Everyone on this event',
}
const AUDIENCES = Object.keys(AUDIENCE_LABELS) as TaskAudience[]

const readableEnum = (value: string) =>
  value.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase())

const contactName = (c: ContactRow) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email

export function TaskCreateForm({ initialValues, onSubmit, onCancel, title, onDirtyChange }: CreateFormProps) {
  const [fields, setFields] = useState({
    title: typeof initialValues?.title === 'string' ? initialValues.title : '',
    description: typeof initialValues?.description === 'string' ? initialValues.description : '',
    target: initialValues?.target === 'submission' ? 'submission' : 'contact',
    assignment_mode: initialValues?.assignment_mode === 'automatic' ? 'automatic' : 'manual',
    trigger: typeof initialValues?.trigger === 'string' ? initialValues.trigger : 'none',
    action_type: typeof initialValues?.action_type === 'string' ? initialValues.action_type : 'acknowledge',
    due_at: typeof initialValues?.due_at === 'string' ? initialValues.due_at.slice(0, 10) : '',
  })
  const [required, setRequired] = useState(initialValues?.required === true || initialValues?.required === 1)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // --- Target pickers -----------------------------------------------------
  const [query, setQuery] = useState('')
  const [contactResults, setContactResults] = useState<ContactRow[]>([])
  const [submissionResults, setSubmissionResults] = useState<SubmissionRow[]>([])
  const [pickedContacts, setPickedContacts] = useState<ContactRow[]>([])
  const [pickedSubmissions, setPickedSubmissions] = useState<SubmissionRow[]>([])

  // --- Audience (CNT-01) ---------------------------------------------------
  // '' = specific people (the pickers below); otherwise a named audience the
  // server expands into assignments at create time.
  const [audience, setAudience] = useState<'' | TaskAudience>('')
  const [audienceCounts, setAudienceCounts] = useState<Partial<Record<TaskAudience, number>> | null>(null)

  useEffect(() => {
    let cancelled = false
    getTaskAudiences()
      .then((r) => {
        if (cancelled) return
        const counts: Partial<Record<TaskAudience, number>> = {}
        for (const a of r.audiences) counts[a.audience] = a.count
        setAudienceCounts(counts)
      })
      .catch(() => {
        /* counts are a nicety; the options still work without them */
      })
    return () => { cancelled = true }
  }, [])

  const audienceLabel = (a: TaskAudience) => {
    const count = audienceCounts?.[a]
    return count === undefined ? AUDIENCE_LABELS[a] : `${AUDIENCE_LABELS[a]} — ${count}`
  }

  const setField = (key: keyof typeof fields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }))
    onDirtyChange?.(true)
  }

  const runSearch = async (q: string, target: string) => {
    setQuery(q)
    if (!q.trim()) {
      setContactResults([])
      setSubmissionResults([])
      return
    }
    try {
      if (target === 'submission') {
        const result = await queryResource<SubmissionRow>('submissions')({ from: 0, size: 8, filters: { q } })
        setSubmissionResults(result.items)
      } else {
        const result = await queryResource<ContactRow>('contacts')({ from: 0, size: 8, filters: { q } })
        setContactResults(result.items)
      }
    } catch {
      /* a failed lookup just shows no suggestions; the form stays usable */
    }
  }

  const switchTarget = (target: string) => {
    setField('target', target)
    setQuery('')
    setContactResults([])
    setSubmissionResults([])
  }

  const clearSearch = () => {
    setQuery('')
    setContactResults([])
    setSubmissionResults([])
    onDirtyChange?.(true)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitError(null)
    if (!fields.title.trim()) {
      setSubmitError('Title is required.')
      return
    }
    const useAudience = fields.target === 'contact' && audience !== ''
    const targetIds = useAudience
      ? { audience }
      : fields.target === 'submission'
        ? { submission_ids: pickedSubmissions.map((s) => s.id) }
        : { assignee_contact_ids: pickedContacts.map((c) => c.id) }
    const targetCount = useAudience
      ? (audienceCounts?.[audience as TaskAudience] ?? 1) // a chosen audience is a valid target even before counts load
      : (Object.values(targetIds)[0] as string[]).length
    // A manual task with no targets can only ever produce zero assignment
    // rows — the exact silent-failure shape CNT-01 flagged. Automatic tasks
    // are legitimately definition-only until their trigger fires.
    if (targetCount === 0 && fields.assignment_mode === 'manual') {
      setSubmitError(
        useAudience
          ? 'That audience has nobody in it yet — pick another, or select people directly.'
          : fields.target === 'submission'
            ? 'Pick at least one submission, or switch the assignment mode to Automatic.'
            : 'Pick at least one assignee, or switch the assignment mode to Automatic.',
      )
      return
    }
    setIsSubmitting(true)
    try {
      const ok = await onSubmit({
        title: fields.title.trim(),
        description: fields.description.trim() || null,
        target: fields.target,
        assignment_mode: fields.assignment_mode,
        trigger: fields.trigger,
        action_type: fields.action_type,
        due_at: fields.due_at || null,
        required,
        ...targetIds,
      })
      if (!ok) {
        setSubmitError('The task could not be saved.')
        return
      }
      if (targetCount === 0) {
        // Nothing will appear in the grid yet — say so rather than closing on
        // an apparently empty list (the CNT-01 symptom).
        await appAlert(
          `Task created — assignments will be created when the ${readableEnum(fields.trigger).toLowerCase()} trigger fires.`,
          'Task created',
        )
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unexpected error.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const picked: Array<{ id: string; label: string }> =
    fields.target === 'submission'
      ? pickedSubmissions.map((s) => ({ id: s.id, label: `${s.code} — ${s.title}` }))
      : pickedContacts.map((c) => ({ id: c.id, label: `${contactName(c)} — ${c.email}` }))

  const removePicked = (id: string) => {
    setPickedContacts((prev) => prev.filter((c) => c.id !== id))
    setPickedSubmissions((prev) => prev.filter((s) => s.id !== id))
    onDirtyChange?.(true)
  }

  return (
    <form className="record-form" onSubmit={handleSubmit} noValidate>
      <div className="record-form-header">
        <h2>{title}</h2>
      </div>
      {submitError && <div className="record-form-submit-error" role="alert"><span>{submitError}</span></div>}
      <div className="record-form-fields">
        <div className="record-form-field">
          <label htmlFor="task-title">Title<span className="record-form-required" aria-hidden="true"> *</span></label>
          <input id="task-title" value={fields.title} disabled={isSubmitting} onChange={(e) => setField('title', e.target.value)} />
        </div>
        <div className="record-form-field">
          <label htmlFor="task-desc">Description</label>
          <textarea id="task-desc" rows={3} value={fields.description} disabled={isSubmitting} onChange={(e) => setField('description', e.target.value)} />
        </div>
        <div className="record-form-field">
          <label htmlFor="task-target">Target</label>
          <select id="task-target" value={fields.target} disabled={isSubmitting} onChange={(e) => switchTarget(e.target.value)}>
            <option value="contact">Contacts</option>
            <option value="submission">Submissions</option>
          </select>
        </div>
        <div className="record-form-field">
          <label htmlFor="task-mode">Assignment mode</label>
          <select id="task-mode" value={fields.assignment_mode} disabled={isSubmitting} onChange={(e) => setField('assignment_mode', e.target.value)}>
            <option value="manual">Manual</option>
            <option value="automatic">Automatic</option>
          </select>
        </div>
        <div className="record-form-field">
          <label htmlFor="task-trigger">Trigger</label>
          <select id="task-trigger" value={fields.trigger} disabled={isSubmitting} onChange={(e) => setField('trigger', e.target.value)}>
            {TRIGGERS.map((t) => <option key={t} value={t}>{readableEnum(t)}</option>)}
          </select>
        </div>
        <div className="record-form-field">
          <label htmlFor="task-action">Action type</label>
          <select id="task-action" value={fields.action_type} disabled={isSubmitting} onChange={(e) => setField('action_type', e.target.value)}>
            {ACTION_TYPES.map((t) => <option key={t} value={t}>{readableEnum(t)}</option>)}
          </select>
        </div>
        <div className="record-form-field">
          <label htmlFor="task-due">Due date</label>
          <input id="task-due" type="date" value={fields.due_at} disabled={isSubmitting} onChange={(e) => setField('due_at', e.target.value)} />
        </div>
        <div className="record-form-field">
          <label htmlFor="task-required" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              id="task-required"
              type="checkbox"
              checked={required}
              disabled={isSubmitting}
              onChange={(e) => { setRequired(e.target.checked); onDirtyChange?.(true) }}
            />
            Required
          </label>
        </div>

        {fields.target === 'contact' && (
          <div className="record-form-field">
            <label htmlFor="task-audience">Assign to</label>
            <select
              id="task-audience"
              value={audience}
              disabled={isSubmitting}
              onChange={(e) => { setAudience(e.target.value as '' | TaskAudience); onDirtyChange?.(true) }}
            >
              <option value="">Specific people (pick below)</option>
              {AUDIENCES.map((a) => (
                <option key={a} value={a}>{audienceLabel(a)}</option>
              ))}
            </select>
            {audience !== '' && (
              <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '2px 0 0' }}>
                {audienceCounts?.[audience] !== undefined
                  ? `${audienceCounts[audience]} ${audienceCounts[audience] === 1 ? 'person' : 'people'} will be assigned when the task is saved.`
                  : 'Everyone in this audience will be assigned when the task is saved.'}
              </p>
            )}
          </div>
        )}

        {(fields.target === 'submission' || audience === '') && (
        <div className="record-form-field">
          <label htmlFor="task-target-search">
            {fields.target === 'submission' ? 'Submissions' : 'Assignees'}
          </label>
          <input
            id="task-target-search"
            placeholder={fields.target === 'submission' ? 'Search submissions by title or code…' : 'Search contacts by name or email…'}
            value={query}
            disabled={isSubmitting}
            autoComplete="off"
            onChange={(e) => void runSearch(e.target.value, fields.target)}
          />
          {fields.target === 'contact' && contactResults.length > 0 && (
            <ul className="contact-picker-results">
              {contactResults.map((c) => {
                const already = pickedContacts.some((p) => p.id === c.id)
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      disabled={already}
                      onClick={() => { setPickedContacts((prev) => [...prev, c]); clearSearch() }}
                    >
                      {contactName(c)} — {c.email}{already ? ' (already added)' : ''}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {fields.target === 'submission' && submissionResults.length > 0 && (
            <ul className="contact-picker-results">
              {submissionResults.map((s) => {
                const already = pickedSubmissions.some((p) => p.id === s.id)
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      disabled={already}
                      onClick={() => { setPickedSubmissions((prev) => [...prev, s]); clearSearch() }}
                    >
                      {s.code} — {s.title}{already ? ' (already added)' : ''}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {picked.length > 0 ? (
            <ul className="contact-picker-results" data-testid="task-picked-targets">
              {picked.map((p) => (
                <li key={p.id}>
                  <span style={{ marginRight: 8 }}>{p.label}</span>
                  <button type="button" className="record-form-delete" disabled={isSubmitting} onClick={() => removePicked(p.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '2px 0 0' }}>
              {fields.target === 'submission'
                ? 'Each submission is assigned to its speakers. Leave empty only for an automatic, trigger-driven task.'
                : 'Nobody assigned yet. Leave empty only for an automatic, trigger-driven task.'}
            </p>
          )}
        </div>
        )}
      </div>

      <div className="record-form-actions">
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

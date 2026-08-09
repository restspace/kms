import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appConfirm } from '../components/dialogs'
import {
  addQuestion,
  deleteQuestion,
  getBuilderMeta,
  getFormDetail,
  reorderQuestions,
  updateForm,
  updateQuestion,
  type BuilderMeta,
  type FormQuestion,
  type FormRow,
} from '../api'

/**
 * Form builder wizard (docs/04 §2): left rail of steps, content pane, sticky
 * save. Form-level fields save via the Save button (and on step change);
 * question operations persist immediately through their endpoints.
 *
 * Judgment call: rich-text fields (welcome/success message) are edited as
 * HTML in a textarea for M1 — a proper editor is polish, not plumbing.
 */

const STEPS = [
  { n: 1, key: 'setup', title: 'Submission Setup', sub: 'Submission type and participants' },
  { n: 2, key: 'welcome', title: 'Welcome Screen', sub: 'Welcome message and terms' },
  { n: 3, key: 'abstract', title: 'Abstract Information', sub: 'Session or abstract questions' },
  { n: 4, key: 'participant', title: 'Participant Information', sub: 'Participant and contact fields' },
  { n: 5, key: 'settings', title: 'Form Settings', sub: 'Deadlines, limits, and success page' },
  { n: 6, key: 'notifications', title: 'Notifications', sub: 'Admin alerts and email templates' },
] as const

type StepKey = (typeof STEPS)[number]['key']

const ALL_ROLES = ['speaker', 'co-speaker', 'moderator', 'panelist'] as const

interface RoleRow {
  role: string
  enabled: boolean
  min: number
  max: number | null
}

interface RuleDraft {
  id: string
  question_id: string
  op: 'equals' | 'is_any_of'
  value: string[]
  assign_evaluation_plan_id: string
  add_tag_ids: string[]
  set_track_id: string
}

/** Editable subset of the form sent on Save. expected_updated_at makes the
 * save conditional: a concurrent edit elsewhere turns into a 409, not a
 * silent overwrite. */
function editablePatch(form: FormRow): Record<string, unknown> {
  return {
    internal_name: form.internal_name,
    external_title: form.external_title,
    page_heading: form.page_heading,
    welcome_message: form.welcome_message,
    welcome_message_visible: form.welcome_message_visible === 1,
    collection_type: form.collection_type,
    collect_participants: form.collect_participants === 1,
    close_at: form.close_at,
    submission_limit: form.submission_limit,
    allow_multiple_drafts: form.allow_multiple_drafts === 1,
    success_message: form.success_message,
    auto_redirect_to_portal: form.auto_redirect_to_portal === 1,
    confirmation_email_enabled: form.confirmation_email_enabled === 1,
    routing_rules: form.routing_rules,
    participant_roles: form.participant_roles,
    expected_updated_at: form.updated_at,
  }
}

export function FormBuilder({
  formId,
  eventSlug,
  onClose,
}: {
  formId: string
  eventSlug: string
  onClose: () => void
}) {
  const [form, setForm] = useState<FormRow | null>(null)
  const [questions, setQuestions] = useState<FormQuestion[]>([])
  const [meta, setMeta] = useState<BuilderMeta | null>(null)
  const [step, setStep] = useState<StepKey>('setup')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dirtyRef = useRef(false)

  useEffect(() => {
    void Promise.all([getFormDetail(formId), getBuilderMeta()])
      .then(([detail, builderMeta]) => {
        setForm(detail.form)
        setQuestions(detail.questions)
        setMeta(builderMeta)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [formId])

  const patch = useCallback((changes: Partial<FormRow>) => {
    dirtyRef.current = true
    setForm((prev) => (prev ? { ...prev, ...changes } : prev))
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
    if (!form) return false
    setSaving(true)
    setError(null)
    try {
      const result = await updateForm(form.id, editablePatch(form))
      setForm((prev) => (prev ? { ...result.form } : prev))
      dirtyRef.current = false
      setSavedAt(new Date().toLocaleTimeString())
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      return false
    } finally {
      setSaving(false)
    }
  }, [form])

  const goToStep = useCallback(
    (next: StepKey) => {
      if (dirtyRef.current) void save()
      setStep(next)
    },
    [save],
  )

  if (!form || !meta) {
    return (
      <div className="forms-section">
        <div className="forms-header">
          <button className="fbtn" onClick={onClose}>← Forms</button>
          <h1>{error ?? 'Loading…'}</h1>
        </div>
      </div>
    )
  }

  const stepIndex = STEPS.findIndex((s) => s.key === step)
  const publicUrl = `/submit/${eventSlug}/${form.id}`
  const abstractQuestions = questions.filter((q) => q.section === 'abstract')

  return (
    <div className="forms-section">
      <div className="forms-header">
        <button className="fbtn" onClick={() => { if (dirtyRef.current) void save(); onClose() }}>← Forms</button>
        <h1>{form.internal_name}</h1>
        {savedAt && <span className="builder-saved">Saved {savedAt}</span>}
        <button className="fbtn" onClick={() => window.open(publicUrl, '_blank')}>View Form</button>
        <button
          className="fbtn"
          onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${publicUrl}`)}
        >
          Copy Link
        </button>
        <button className="fbtn primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="builder">
        <nav className="builder-rail" aria-label="Builder steps">
          {STEPS.map((s) => (
            <button key={s.key} className={s.key === step ? 'active' : ''} onClick={() => goToStep(s.key)}>
              <span className="rail-n">{s.n}</span> {s.title}
            </button>
          ))}
        </nav>
        <div className="builder-pane">
          {error && <div className="builder-error">{error}</div>}
          <h2>{STEPS[stepIndex]!.title}</h2>
          <p className="pane-sub">{STEPS[stepIndex]!.sub}</p>

          {step === 'setup' && <SetupStep form={form} patch={patch} />}
          {step === 'welcome' && <WelcomeStep form={form} patch={patch} />}
          {step === 'abstract' && (
            <>
              <QuestionList
                formId={form.id}
                section="abstract"
                questions={questions}
                setQuestions={setQuestions}
                meta={meta}
                setError={setError}
              />
              <RoutingPanel form={form} patch={patch} meta={meta} questions={abstractQuestions} />
            </>
          )}
          {step === 'participant' && (
            <>
              <RolesPanel form={form} patch={patch} />
              <h2 style={{ marginTop: 24 }}>Form Questions</h2>
              <p className="pane-sub">
                Collect information for participants and the primary contact for this submission.
              </p>
              <QuestionList
                formId={form.id}
                section="participant"
                questions={questions}
                setQuestions={setQuestions}
                meta={meta}
                setError={setError}
              />
            </>
          )}
          {step === 'settings' && <SettingsStep form={form} patch={patch} />}
          {step === 'notifications' && <NotificationsStep form={form} patch={patch} />}

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, maxWidth: 680 }}>
            {stepIndex > 0 ? (
              <button className="fbtn" onClick={() => goToStep(STEPS[stepIndex - 1]!.key)}>Back</button>
            ) : <span />}
            {stepIndex < STEPS.length - 1 ? (
              <button className="fbtn primary" onClick={() => goToStep(STEPS[stepIndex + 1]!.key)}>Next</button>
            ) : (
              <button className="fbtn primary" disabled={saving} onClick={() => void save().then((ok) => ok && onClose())}>
                Save
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 1 — Submission Setup
// ---------------------------------------------------------------------------

function SetupStep({ form, patch }: { form: FormRow; patch: (c: Partial<FormRow>) => void }) {
  return (
    <section>
      <p className="pane-sub">What kind of submissions do you want to collect?</p>
      <div className="setup-cards">
        <div
          className={`setup-card${form.collection_type === 'abstracts' ? ' selected' : ''}`}
          onClick={() => patch({ collection_type: 'abstracts' })}
        >
          <h3>Abstracts</h3>
          <p>Collect abstract submissions for review before sessions are finalized.</p>
        </div>
        <div
          className={`setup-card${form.collection_type === 'sessions' ? ' selected' : ''}`}
          onClick={() => patch({ collection_type: 'sessions' })}
        >
          <h3>Sessions</h3>
          <p>Collect full session proposals with details for your program.</p>
        </div>
      </div>
      <label className="btoggle">
        <input
          type="checkbox"
          checked={form.collect_participants === 1}
          onChange={(e) => patch({ collect_participants: e.target.checked ? 1 : 0 })}
        />
        <span>
          <strong>Participants</strong>
          <p className="bhelp">Include a step to collect speaker and participant contact information.</p>
        </span>
      </label>
      <p className="bhelp">You can adjust these choices later by editing this form.</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — Welcome Screen
// ---------------------------------------------------------------------------

function WelcomeStep({ form, patch }: { form: FormRow; patch: (c: Partial<FormRow>) => void }) {
  return (
    <section>
      <div className="bfield">
        <label>
          Internal Form Name *<span className="bcount">{form.internal_name.length}/255</span>
        </label>
        <input type="text" maxLength={255} value={form.internal_name} onChange={(e) => patch({ internal_name: e.target.value })} />
      </div>
      <div className="bfield">
        <label>
          External Form Title *<span className="bcount">{(form.external_title ?? '').length}/255</span>
        </label>
        <input type="text" maxLength={255} value={form.external_title ?? ''} onChange={(e) => patch({ external_title: e.target.value })} />
      </div>
      <div className="bfield">
        <label>
          Page Heading *<span className="bcount">{(form.page_heading ?? '').length}/15</span>
        </label>
        <input type="text" maxLength={15} value={form.page_heading ?? ''} onChange={(e) => patch({ page_heading: e.target.value.slice(0, 15) })} />
        <p className="bhelp">Hard 15-character cap, shown as the compact public header.</p>
      </div>
      <label className="btoggle">
        <input
          type="checkbox"
          checked={form.welcome_message_visible === 1}
          onChange={(e) => patch({ welcome_message_visible: e.target.checked ? 1 : 0 })}
        />
        <span><strong>Show welcome message</strong></span>
      </label>
      <div className="bfield">
        <label>Welcome Message (HTML)</label>
        <textarea
          rows={10}
          value={form.welcome_message ?? ''}
          onChange={(e) => patch({ welcome_message: e.target.value })}
        />
        <p className="bhelp">Rendered on the public form: h1–h3, p, ul/ol, links, bold/italic, images.</p>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Question list with drag reorder + editors
// ---------------------------------------------------------------------------

function QuestionList({
  formId,
  section,
  questions,
  setQuestions,
  meta,
  setError,
}: {
  formId: string
  section: 'abstract' | 'participant'
  questions: FormQuestion[]
  setQuestions: (qs: FormQuestion[]) => void
  meta: BuilderMeta
  setError: (e: string | null) => void
}) {
  const rows = useMemo(
    () => questions.filter((q) => q.section === section).sort((a, b) => a.position - b.position),
    [questions, section],
  )
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<FormQuestion | null>(null)
  const [logicFor, setLogicFor] = useState<FormQuestion | null>(null)

  const run = useCallback(
    (p: Promise<{ questions: FormQuestion[] }>) =>
      p.then((r) => setQuestions(r.questions)).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed')),
    [setQuestions, setError],
  )

  const handleDrop = useCallback(
    (targetId: string) => {
      if (!dragId || dragId === targetId) return
      const ids = rows.map((r) => r.id).filter((id) => id !== dragId)
      ids.splice(ids.indexOf(targetId), 0, dragId)
      void run(reorderQuestions(formId, section, ids))
    },
    [dragId, rows, formId, section, run],
  )

  return (
    <section>
      <div className="qlist">
        {rows.map((q) => (
          <div
            key={q.id}
            className={`qrow${dragId === q.id ? ' dragging' : ''}${dropId === q.id ? ' drop-target' : ''}`}
            draggable
            onDragStart={() => setDragId(q.id)}
            onDragEnd={() => { setDragId(null); setDropId(null) }}
            onDragOver={(e) => { e.preventDefault(); setDropId(q.id) }}
            onDragLeave={() => setDropId((d) => (d === q.id ? null : d))}
            onDrop={(e) => { e.preventDefault(); setDropId(null); handleDrop(q.id) }}
          >
            <span className="qdrag" aria-hidden="true">⠿</span>
            <span className="qlabel">{q.label}</span>
            {q.required && <span className="qreq">*</span>}
            {q.locked && <span className="qchip locked">Locked</span>}
            <span className="qchip">{q.type}</span>
            {q.max_chars !== null && <span className="qchip">Max {q.max_chars.toLocaleString()} chars</span>}
            {q.visibility !== null && <span className="qchip cond">Conditional</span>}
            <span className="qspacer" />
            <label className="qrequired">
              <input
                type="checkbox"
                checked={q.required}
                disabled={q.locked}
                onChange={(e) => void run(updateQuestion(formId, q.id, { required: e.target.checked }))}
              />
              Required
            </label>
            <button className="fbtn-link" onClick={() => setEditing(q)}>Edit</button>
            <button className="fbtn-link" onClick={() => setLogicFor(q)}>Logic</button>
            {!q.locked && (
              <button
                className="fbtn-link danger"
                onClick={() => {
                  void appConfirm(`Remove "${q.label}"?`, { title: 'Remove question', confirmLabel: 'Remove', danger: true })
                    .then((confirmed) => {
                      if (confirmed) void run(deleteQuestion(formId, q.id))
                    })
                }}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="qrow">No questions yet.</div>}
      </div>
      <button className="fbtn" onClick={() => setAdding(true)}>+ Add Field</button>

      {adding && (
        <AddFieldModal
          meta={meta}
          section={section}
          usedFieldIds={new Set(rows.map((r) => r.field_id))}
          onAdd={(body) => { setAdding(false); void run(addQuestion(formId, { ...body, section })) }}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && (
        <QuestionEditModal
          question={editing}
          onSave={(patchBody) => { setEditing(null); void run(updateQuestion(formId, editing.id, patchBody)) }}
          onClose={() => setEditing(null)}
        />
      )}
      {logicFor && (
        <LogicModal
          question={logicFor}
          earlier={rows.filter((r) => r.position < logicFor.position)}
          onSave={(visibility) => { setLogicFor(null); void run(updateQuestion(formId, logicFor.id, { visibility })) }}
          onClose={() => setLogicFor(null)}
        />
      )}
    </section>
  )
}

function Modal({ title, children, footer, onClose }: {
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="fmodal-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="fmodal" role="dialog" aria-label={title}>
        <div className="fmodal-head">
          {title}
          <button className="fbtn-link" onClick={onClose}>✕</button>
        </div>
        <div className="fmodal-body">{children}</div>
        {footer && <div className="fmodal-foot">{footer}</div>}
      </div>
    </div>
  )
}

const CREATABLE_TYPES = ['text', 'textarea', 'wysiwyg', 'number', 'email', 'phone', 'url', 'date', 'dropdown', 'multiselect', 'checkbox', 'radio', 'heading']

function AddFieldModal({ meta, section, usedFieldIds, onAdd, onClose }: {
  meta: BuilderMeta
  section: 'abstract' | 'participant'
  usedFieldIds: Set<string>
  onAdd: (body: Record<string, unknown>) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('')
  const [type, setType] = useState('text')
  const [optionsText, setOptionsText] = useState('')
  const [maxChars, setMaxChars] = useState('')

  const scope = section === 'participant' ? 'contact' : 'submission'
  const candidates = meta.fields.filter(
    (f) =>
      (f.scope === scope || f.scope === 'session') &&
      !usedFieldIds.has(f.id) &&
      f.label.toLowerCase().includes(query.toLowerCase()),
  )

  if (creating) {
    const needsOptions = ['dropdown', 'multiselect', 'radio'].includes(type)
    return (
      <Modal
        title="Create Field"
        onClose={onClose}
        footer={
          <>
            <button className="fbtn" onClick={() => setCreating(false)}>Back</button>
            <button
              className="fbtn primary"
              disabled={!label.trim() || (needsOptions && !optionsText.trim())}
              onClick={() =>
                onAdd({
                  new_field: {
                    label: label.trim(),
                    type,
                    options: needsOptions
                      ? optionsText.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({ value: l, label: l }))
                      : undefined,
                    max_chars: maxChars ? Number(maxChars) : undefined,
                  },
                })
              }
            >
              Create & add
            </button>
          </>
        }
      >
        <div className="bfield">
          <label>Label *</label>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="bfield">
          <label>Type</label>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {CREATABLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {['dropdown', 'multiselect', 'radio'].includes(type) && (
          <div className="bfield">
            <label>Options (one per line)</label>
            <textarea rows={5} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} />
          </div>
        )}
        {['text', 'textarea', 'wysiwyg'].includes(type) && (
          <div className="bfield">
            <label>Max characters</label>
            <input type="number" value={maxChars} onChange={(e) => setMaxChars(e.target.value)} />
          </div>
        )}
      </Modal>
    )
  }

  return (
    <Modal title="Add Field" onClose={onClose}>
      <button className="field-pick" onClick={() => setCreating(true)}>
        <strong>Create Field ›</strong>
      </button>
      <div className="bfield" style={{ marginTop: 8 }}>
        <input type="text" placeholder="Search the field library…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {candidates.map((f) => (
        <button key={f.id} className="field-pick" onClick={() => onAdd({ field_id: f.id })}>
          {f.label} <span className="qchip">{f.type}</span>
          {f.system === 1 && <span className="qchip locked">system</span>}
        </button>
      ))}
      {candidates.length === 0 && <p className="bhelp">No unused library fields match.</p>}
    </Modal>
  )
}

function QuestionEditModal({ question, onSave, onClose }: {
  question: FormQuestion
  onSave: (patch: Record<string, unknown>) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState(question.label)
  const [help, setHelp] = useState(question.help_text ?? '')
  const [maxChars, setMaxChars] = useState(question.max_chars?.toString() ?? '')
  const hasOptions = ['dropdown', 'multiselect', 'radio'].includes(question.type)
  const [optionsText, setOptionsText] = useState(
    (question.options ?? []).map((o) => o.label).join('\n'),
  )

  return (
    <Modal
      title={`Edit — ${question.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="fbtn" onClick={onClose}>Cancel</button>
          <button
            className="fbtn primary"
            disabled={!label.trim()}
            onClick={() =>
              onSave({
                label: label.trim(),
                help_text: help.trim() || null,
                max_chars: maxChars ? Number(maxChars) : null,
                ...(hasOptions
                  ? { options: optionsText.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({ value: l, label: l })) }
                  : {}),
              })
            }
          >
            Save
          </button>
        </>
      }
    >
      <div className="bfield">
        <label>Label *</label>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="bfield">
        <label>Help text</label>
        <input type="text" value={help} onChange={(e) => setHelp(e.target.value)} />
      </div>
      {['text', 'textarea', 'wysiwyg'].includes(question.type) && (
        <div className="bfield">
          <label>Max characters</label>
          <input type="number" value={maxChars} onChange={(e) => setMaxChars(e.target.value)} />
        </div>
      )}
      {hasOptions && (
        <div className="bfield">
          <label>Options (one per line)</label>
          <textarea rows={6} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} />
          {question.locked && <p className="bhelp">System field — options edits apply to this form only.</p>}
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Conditional logic editor (docs/04 §3)
// ---------------------------------------------------------------------------

const CONDITION_OPS = ['equals', 'not_equals', 'contains', 'not_contains', 'is_any_of', 'is_empty', 'is_not_empty'] as const

interface CondDraft {
  question_id: string
  op: string
  value: string[]
}

function LogicModal({ question, earlier, onSave, onClose }: {
  question: FormQuestion
  earlier: FormQuestion[]
  onSave: (visibility: Record<string, unknown> | null) => void
  onClose: () => void
}) {
  const existing = question.visibility as {
    action?: string
    match?: string
    conditions?: Array<{ question_id: string; op: string; value?: unknown }>
  } | null
  const [enabled, setEnabled] = useState(existing !== null)
  const [action, setAction] = useState(existing?.action === 'hide' ? 'hide' : 'show')
  const [match, setMatch] = useState(existing?.match === 'any' ? 'any' : 'all')
  const [conditions, setConditions] = useState<CondDraft[]>(() =>
    (existing?.conditions ?? []).map((c) => ({
      question_id: c.question_id,
      op: c.op,
      value: Array.isArray(c.value) ? c.value.map(String) : c.value !== undefined ? [String(c.value)] : [],
    })),
  )

  const referable = earlier.filter((q) => q.type !== 'heading')

  const setCond = (i: number, next: Partial<CondDraft>) =>
    setConditions((prev) => prev.map((c, j) => (j === i ? { ...c, ...next } : c)))

  return (
    <Modal
      title={`Conditional logic — ${question.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="fbtn" onClick={onClose}>Cancel</button>
          <button
            className="fbtn primary"
            onClick={() => {
              if (!enabled || conditions.length === 0) {
                onSave(null)
                return
              }
              onSave({
                action,
                match,
                conditions: conditions
                  .filter((c) => c.question_id)
                  .map((c) => ({
                    question_id: c.question_id,
                    op: c.op,
                    ...(c.op === 'is_empty' || c.op === 'is_not_empty'
                      ? {}
                      : { value: c.op === 'is_any_of' ? c.value : c.value[0] ?? '' }),
                  })),
              })
            }}
          >
            Save
          </button>
        </>
      }
    >
      <label className="btoggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span><strong>Only show this question conditionally</strong></span>
      </label>
      {enabled && (
        <>
          {referable.length === 0 ? (
            <p className="bhelp">No earlier questions to reference — move this question down first.</p>
          ) : (
            <>
              <div className="cond-row">
                <select value={action} onChange={(e) => setAction(e.target.value)}>
                  <option value="show">Show</option>
                  <option value="hide">Hide</option>
                </select>
                this question when
                <select value={match} onChange={(e) => setMatch(e.target.value)}>
                  <option value="all">all</option>
                  <option value="any">any</option>
                </select>
                of the following are true:
              </div>
              {conditions.map((cond, i) => {
                const target = referable.find((q) => q.id === cond.question_id)
                const valueChoices = target?.options ?? null
                return (
                  <div className="cond-row" key={i}>
                    <select value={cond.question_id} onChange={(e) => setCond(i, { question_id: e.target.value, value: [] })}>
                      <option value="">Question…</option>
                      {referable.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
                    </select>
                    <select value={cond.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                      {CONDITION_OPS.map((op) => <option key={op} value={op}>{op.replace(/_/g, ' ')}</option>)}
                    </select>
                    {cond.op !== 'is_empty' && cond.op !== 'is_not_empty' && (
                      valueChoices ? (
                        cond.op === 'is_any_of' ? (
                          <select
                            multiple
                            value={cond.value}
                            onChange={(e) =>
                              setCond(i, { value: Array.from(e.target.selectedOptions).map((o) => o.value) })
                            }
                          >
                            {valueChoices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        ) : (
                          <select value={cond.value[0] ?? ''} onChange={(e) => setCond(i, { value: [e.target.value] })}>
                            <option value="">Value…</option>
                            {valueChoices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        )
                      ) : (
                        <input
                          type="text"
                          placeholder="Value"
                          value={cond.value[0] ?? ''}
                          onChange={(e) => setCond(i, { value: [e.target.value] })}
                        />
                      )
                    )}
                    <button className="fbtn-link danger" onClick={() => setConditions((prev) => prev.filter((_, j) => j !== i))}>−</button>
                  </div>
                )
              })}
              <button
                className="fbtn"
                onClick={() => setConditions((prev) => [...prev, { question_id: '', op: 'equals', value: [] }])}
              >
                + Add condition
              </button>
              <p className="bhelp">Only earlier questions can be referenced, so rules can never cycle.</p>
            </>
          )}
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Routing panel (docs/04 §4)
// ---------------------------------------------------------------------------

function RoutingPanel({ form, patch, meta, questions }: {
  form: FormRow
  patch: (c: Partial<FormRow>) => void
  meta: BuilderMeta
  questions: FormQuestion[]
}) {
  const parsed = form.routing_rules as {
    rules?: Array<Record<string, unknown>>
    fallback?: Record<string, unknown>
  } | null

  const rules: RuleDraft[] = useMemo(
    () =>
      (parsed?.rules ?? []).map((r, i) => {
        const when = (r.when ?? {}) as Record<string, unknown>
        const then = (r.then ?? {}) as Record<string, unknown>
        return {
          id: typeof r.id === 'string' ? r.id : `r${i}`,
          question_id: String(when.question_id ?? ''),
          op: when.op === 'is_any_of' ? 'is_any_of' : 'equals',
          value: Array.isArray(when.value) ? when.value.map(String) : when.value !== undefined ? [String(when.value)] : [],
          assign_evaluation_plan_id: String(then.assign_evaluation_plan_id ?? ''),
          add_tag_ids: Array.isArray(then.add_tag_ids) ? then.add_tag_ids.map(String) : [],
          set_track_id: String(then.set_track_id ?? ''),
        }
      }),
    [parsed],
  )
  const fallbackPlan = String((parsed?.fallback as Record<string, unknown> | undefined)?.assign_evaluation_plan_id ?? '')

  const write = (nextRules: RuleDraft[], nextFallback: string) => {
    const config = {
      rules: nextRules.map((r) => ({
        id: r.id,
        when: {
          question_id: r.question_id,
          op: r.op,
          value: r.op === 'is_any_of' ? r.value : r.value[0] ?? '',
        },
        then: {
          ...(r.assign_evaluation_plan_id ? { assign_evaluation_plan_id: r.assign_evaluation_plan_id } : {}),
          ...(r.add_tag_ids.length > 0 ? { add_tag_ids: r.add_tag_ids } : {}),
          ...(r.set_track_id ? { set_track_id: r.set_track_id } : {}),
        },
      })),
      ...(nextFallback ? { fallback: { assign_evaluation_plan_id: nextFallback } } : {}),
    }
    patch({ routing_rules: config })
  }

  const optionQuestions = questions.filter((q) => q.options !== null && q.options.length > 0)

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Routing</h2>
      <p className="pane-sub">
        Rules run in order after a submission is created; later rules may overwrite earlier ones.
        Applied rules are recorded on the submission.
      </p>
      {rules.map((rule, i) => {
        const target = optionQuestions.find((q) => q.id === rule.question_id)
        const setRule = (next: Partial<RuleDraft>) =>
          write(rules.map((r, j) => (j === i ? { ...r, ...next } : r)), fallbackPlan)
        return (
          <div className="rule-card" key={rule.id}>
            <div className="rule-head">
              Rule {i + 1}
              <button className="fbtn-link danger" onClick={() => write(rules.filter((_, j) => j !== i), fallbackPlan)}>
                Remove
              </button>
            </div>
            <div className="cond-row">
              When
              <select value={rule.question_id} onChange={(e) => setRule({ question_id: e.target.value, value: [] })}>
                <option value="">Question…</option>
                {optionQuestions.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
              </select>
              <select value={rule.op} onChange={(e) => setRule({ op: e.target.value as RuleDraft['op'] })}>
                <option value="equals">equals</option>
                <option value="is_any_of">is any of</option>
              </select>
              {target && (
                rule.op === 'is_any_of' ? (
                  <select
                    multiple
                    value={rule.value}
                    onChange={(e) => setRule({ value: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                  >
                    {(target.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <select value={rule.value[0] ?? ''} onChange={(e) => setRule({ value: [e.target.value] })}>
                    <option value="">Value…</option>
                    {(target.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )
              )}
            </div>
            <div className="cond-row">
              → assign plan
              <select value={rule.assign_evaluation_plan_id} onChange={(e) => setRule({ assign_evaluation_plan_id: e.target.value })}>
                <option value="">none</option>
                {meta.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              add tags
              <select
                multiple
                value={rule.add_tag_ids}
                onChange={(e) => setRule({ add_tag_ids: Array.from(e.target.selectedOptions).map((o) => o.value) })}
              >
                {meta.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              set track
              <select value={rule.set_track_id} onChange={(e) => setRule({ set_track_id: e.target.value })}>
                <option value="">keep answer</option>
                {meta.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>
        )
      })}
      <div className="cond-row">
        <button
          className="fbtn"
          onClick={() =>
            write(
              [...rules, { id: `r${Date.now()}`, question_id: '', op: 'equals', value: [], assign_evaluation_plan_id: '', add_tag_ids: [], set_track_id: '' }],
              fallbackPlan,
            )
          }
        >
          + Add rule
        </button>
        Fallback plan (when no rule matches):
        <select value={fallbackPlan} onChange={(e) => write(rules, e.target.value)}>
          <option value="">none</option>
          {meta.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Participant roles panel (docs/04 §2.4)
// ---------------------------------------------------------------------------

function RolesPanel({ form, patch }: { form: FormRow; patch: (c: Partial<FormRow>) => void }) {
  const configured: RoleRow[] = useMemo(() => {
    let parsed = form.participant_roles ?? []
    if (parsed.length === 0) parsed = [{ role: 'speaker', min: 1, max: null }]
    return ALL_ROLES.map((role) => {
      const found = parsed.find((p) => p.role === role)
      return { role, enabled: Boolean(found), min: found?.min ?? 0, max: found?.max ?? null }
    })
  }, [form.participant_roles])

  const write = (rows: RoleRow[]) =>
    patch({
      participant_roles: rows.filter((r) => r.enabled).map((r) => ({ role: r.role, min: r.min, max: r.max })),
    })

  return (
    <section>
      <h2>Participant roles</h2>
      <p className="pane-sub">
        Choose which roles submitters can add. Optionally set minimum and maximum counts per role.
      </p>
      <div className="qlist" style={{ padding: '0 12px' }}>
        {configured.map((row, i) => (
          <div className="roles-row" key={row.role}>
            <input
              type="checkbox"
              checked={row.enabled}
              disabled={row.role === 'speaker'}
              onChange={(e) => write(configured.map((r, j) => (j === i ? { ...r, enabled: e.target.checked } : r)))}
            />
            <span className="role-name">{row.role}</span>
            Min
            <input
              type="number"
              min={0}
              value={row.min}
              disabled={!row.enabled}
              onChange={(e) => write(configured.map((r, j) => (j === i ? { ...r, min: Number(e.target.value) || 0 } : r)))}
            />
            Max
            <input
              type="number"
              min={0}
              placeholder="∞"
              value={row.max ?? ''}
              disabled={!row.enabled}
              onChange={(e) =>
                write(configured.map((r, j) => (j === i ? { ...r, max: e.target.value === '' ? null : Number(e.target.value) } : r)))
              }
            />
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Step 5 — Form Settings
// ---------------------------------------------------------------------------

/** ISO ↔ datetime-local (browser-local time; stored as UTC ISO). */
const isoToLocal = (iso: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function SettingsStep({ form, patch }: { form: FormRow; patch: (c: Partial<FormRow>) => void }) {
  return (
    <section>
      <div className="bfield">
        <label>Close Date</label>
        <input
          type="datetime-local"
          value={isoToLocal(form.close_at)}
          onChange={(e) => patch({ close_at: e.target.value ? new Date(e.target.value).toISOString() : null })}
        />
        <p className="bhelp">If set, form and submissions will close after the specified date.</p>
      </div>
      <label className="btoggle">
        <input
          type="checkbox"
          checked={form.submission_limit !== null}
          onChange={(e) => patch({ submission_limit: e.target.checked ? 3 : null })}
        />
        <span>
          <strong>Set Submission Limit</strong>
          <p className="bhelp">
            Limit how many sessions one user may have for this form — saved drafts included.
            When off, the event default (3) applies.
          </p>
        </span>
      </label>
      {form.submission_limit !== null && (
        <div className="bfield" style={{ maxWidth: 120 }}>
          <label>Limit</label>
          <input
            type="number"
            min={1}
            value={form.submission_limit}
            onChange={(e) => patch({ submission_limit: Math.max(1, Number(e.target.value) || 1) })}
          />
        </div>
      )}
      <label className="btoggle">
        <input
          type="checkbox"
          checked={form.allow_multiple_drafts === 1}
          onChange={(e) => patch({ allow_multiple_drafts: e.target.checked ? 1 : 0 })}
        />
        <span><strong>Allow multiple draft submissions</strong></span>
      </label>
      <label className="btoggle">
        <input
          type="checkbox"
          checked={form.auto_redirect_to_portal === 1}
          onChange={(e) => patch({ auto_redirect_to_portal: e.target.checked ? 1 : 0 })}
        />
        <span>
          <strong>Auto-redirect to speaker portal</strong>
          <p className="bhelp">After 10 seconds on the confirmation page. If off, submitters use Continue to portal.</p>
        </span>
      </label>
      <div className="bfield">
        <label>Success page message (HTML)</label>
        <textarea rows={5} value={form.success_message ?? ''} onChange={(e) => patch({ success_message: e.target.value })} />
        <p className="bhelp">Shown on the public confirmation page after submit.</p>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Step 6 — Notifications
// ---------------------------------------------------------------------------

function NotificationsStep({ form, patch }: { form: FormRow; patch: (c: Partial<FormRow>) => void }) {
  return (
    <section>
      <label className="btoggle">
        <input
          type="checkbox"
          checked={form.confirmation_email_enabled === 1}
          onChange={(e) => patch({ confirmation_email_enabled: e.target.checked ? 1 : 0 })}
        />
        <span>
          <strong>Submission Confirmation</strong>
          <p className="bhelp">Email sent to the submitter after a successful submission.</p>
        </span>
      </label>
      <p className="bhelp">
        Template customisation and admin new/updated-submission alerts arrive with the
        communications milestone (M2).
      </p>
    </section>
  )
}

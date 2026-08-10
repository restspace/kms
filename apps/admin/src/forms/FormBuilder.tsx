import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { appConfirm, ModalDialog } from '../components/dialogs'
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
import { isoToLocalInput, localInputToIso } from '../utils/dates'
import { effectiveFormStatus } from './formStatus'

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
    status: form.status,
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

const isStepKey = (value: string | null | undefined): value is StepKey =>
  value !== null && value !== undefined && STEPS.some((s) => s.key === value)

/**
 * `initialStep` comes from the URL (router.ts `fstep`) and `onStepChange`
 * reports moves back; an unknown step falls back to the first one.
 */
export function FormBuilder({
  formId,
  eventSlug,
  timezone,
  initialStep,
  onStepChange,
  onClose,
}: {
  formId: string
  eventSlug: string
  timezone: string
  initialStep?: string | null
  onStepChange?: (step: string) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<FormRow | null>(null)
  const [questions, setQuestions] = useState<FormQuestion[]>([])
  const [meta, setMeta] = useState<BuilderMeta | null>(null)
  const [step, setStep] = useState<StepKey>(isStepKey(initialStep) ? initialStep : 'setup')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const editVersionRef = useRef(0)
  // The form as of *right now*, updated synchronously by `patch` — a save
  // started in the same tick as an edit must not read a pre-render snapshot
  // (CFP-S1: "click responses return pre-update DOM").
  const formRef = useRef<FormRow | null>(null)
  // Saves are serialised through this chain instead of being dropped while
  // one is in flight. Dropping them is what made wizard navigation need two
  // clicks: Next -> goToStep -> save() returned false (busy) -> no advance.
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true))
  const savesInFlightRef = useRef(0)
  // Snapshot of the status as fetched, so the Settings step can tell "the
  // admin just flipped Closed -> Open in this session" (which the save will
  // treat as a reopen and clear a stale close date) apart from "status was
  // already open" (which it will not touch).
  const loadedStatusRef = useRef<FormRow['status'] | null>(null)

  useEffect(() => {
    void Promise.all([getFormDetail(formId), getBuilderMeta()])
      .then(([detail, builderMeta]) => {
        formRef.current = detail.form
        setForm(detail.form)
        loadedStatusRef.current = detail.form.status
        setQuestions(detail.questions)
        setMeta(builderMeta)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [formId])

  const patch = useCallback((changes: Partial<FormRow>) => {
    dirtyRef.current = true
    editVersionRef.current += 1
    if (!formRef.current) return
    formRef.current = { ...formRef.current, ...changes }
    setForm(formRef.current)
  }, [])

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])

  /**
   * One save attempt, retried in place when the admin edits something while
   * the request is in flight: the server's fresh `updated_at` is adopted (so
   * the optimistic-concurrency guard still matches) while the newer local
   * values are kept, and the loop saves again. Previously this bailed out with
   * "Newer changes were made while saving", which stranded the edit *and*
   * blocked wizard navigation.
   */
  const runSave = useCallback(async (): Promise<boolean> => {
    if (!formRef.current) return false
    savesInFlightRef.current += 1
    setSaving(true)
    setError(null)
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = formRef.current
        if (!current) return false
        const version = editVersionRef.current
        let result: { form: FormRow }
        try {
          result = await updateForm(current.id, editablePatch(current))
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Save failed')
          return false
        }
        loadedStatusRef.current = result.form.status
        if (editVersionRef.current === version) {
          formRef.current = { ...result.form }
          setForm(formRef.current)
          dirtyRef.current = false
          setSavedAt(new Date().toLocaleTimeString())
          return true
        }
        formRef.current = { ...(formRef.current as FormRow), updated_at: result.form.updated_at }
        setForm(formRef.current)
      }
      setError('Changes are still arriving faster than they can be saved. Press Save again.')
      return false
    } finally {
      savesInFlightRef.current -= 1
      if (savesInFlightRef.current === 0) setSaving(false)
    }
  }, [])

  /** Serialised save: a second request waits for the first instead of being
   * silently dropped, so one click on Save/Next is always enough. */
  const save = useCallback((): Promise<boolean> => {
    const next = saveChainRef.current.then(runSave, runSave)
    saveChainRef.current = next.then(
      () => true,
      () => false,
    )
    return next
  }, [runSave])

  const goToStep = useCallback(
    async (next: StepKey) => {
      if (dirtyRef.current && !(await save())) return
      setStep(next)
      onStepChange?.(next)
    },
    [save, onStepChange],
  )

  if (!form || !meta) {
    return (
      <div className="forms-section">
        <div className="forms-header">
          <button type="button" className="fbtn" onClick={onClose}>← Forms</button>
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
        <button type="button" className="fbtn" onClick={() => void (async () => {
          if (dirtyRef.current && !(await save())) return
          onClose()
        })()}>← Forms</button>
        <h1>{form.internal_name}</h1>
        {savedAt && <span className="builder-saved">Saved {savedAt}</span>}
        <button type="button" className="fbtn" onClick={() => window.open(publicUrl, '_blank')}>View Form</button>
        <button
          type="button"
          className="fbtn"
          onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${publicUrl}`)}
        >
          Copy Link
        </button>
        <button type="button" className="fbtn primary" onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="builder">
        <nav className="builder-rail" aria-label="Builder steps">
          {STEPS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={s.key === step ? 'active' : ''}
              onClick={() => void goToStep(s.key)}
            >
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
          {step === 'settings' && (
            <SettingsStep form={form} patch={patch} timezone={timezone} wasClosed={loadedStatusRef.current === 'closed'} />
          )}
          {step === 'notifications' && <NotificationsStep form={form} patch={patch} />}

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, maxWidth: 680 }}>
            {stepIndex > 0 ? (
              <button type="button" className="fbtn" onClick={() => void goToStep(STEPS[stepIndex - 1]!.key)}>Back</button>
            ) : <span />}
            {stepIndex < STEPS.length - 1 ? (
              <button type="button" className="fbtn primary" onClick={() => void goToStep(STEPS[stepIndex + 1]!.key)}>Next</button>
            ) : (
              <button type="button" className="fbtn primary" onClick={() => void save().then((ok) => ok && onClose())}>
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
        <label htmlFor="form-internal-name">
          Internal Form Name *<span className="bcount">{form.internal_name.length}/255</span>
        </label>
        <input id="form-internal-name" type="text" maxLength={255} value={form.internal_name} onChange={(e) => patch({ internal_name: e.target.value })} />
      </div>
      <div className="bfield">
        <label htmlFor="form-external-title">
          External Form Title *<span className="bcount">{(form.external_title ?? '').length}/255</span>
        </label>
        <input id="form-external-title" type="text" maxLength={255} value={form.external_title ?? ''} onChange={(e) => patch({ external_title: e.target.value })} />
      </div>
      <div className="bfield">
        <label htmlFor="form-page-heading">
          Page Heading *<span className="bcount">{(form.page_heading ?? '').length}/15</span>
        </label>
        <input id="form-page-heading" type="text" maxLength={15} value={form.page_heading ?? ''} onChange={(e) => patch({ page_heading: e.target.value.slice(0, 15) })} />
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
  /** Functional updates only — see `run`: every list mutation composes onto
   * the *current* list, never onto the array captured when the handler was
   * created (CFP-S1 "stale-reference races"). */
  setQuestions: Dispatch<SetStateAction<FormQuestion[]>>
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
  // In-flight latches. Every list action is a plain SPA interaction, so the
  // only protection against a double-fire (impatient double-click, or a
  // second click landing before the optimistic re-render) is a ref set
  // synchronously inside the handler — the same shape as the evaluation
  // criteria fix. Without it, "Create & add" posted twice and left a
  // duplicated field behind (CFP-S1).
  const addInFlightRef = useRef(false)
  const removingRef = useRef<Set<string>>(new Set())

  // Race guard (CFP-01): each question-field edit (e.g. the Required
  // checkbox) returns a FULL question-list snapshot from the server. Two
  // edits fired close together — check Required on field A, then quickly on
  // field B — race independently over the network, so their snapshot
  // responses can resolve out of order relative to when their writes
  // actually committed on the server. Applying whichever snapshot lands last
  // as-is means an older snapshot (taken before B's write landed) can
  // overwrite B's now-checked box back to unchecked, even though B's own
  // save already succeeded — that was the reported "Required reverts right
  // after a completed save".
  //
  // `pendingRef` tracks, per question id, the locally-applied patch and how
  // many of its own requests are still outstanding. The checkbox (or any
  // other field edit routed through `run`) is applied to local state
  // immediately (optimistic, so the UI never visibly reverts), and any
  // snapshot processed while that question still has an outstanding request
  // gets the pending patch re-applied on top — last-write-wins on the field
  // the user actually touched, not on whichever response happened to arrive
  // last.
  const pendingRef = useRef<Map<string, { count: number; patch: Record<string, unknown> }>>(new Map())

  const mergeWithPending = useCallback(
    (serverQuestions: FormQuestion[]): FormQuestion[] =>
      pendingRef.current.size === 0
        ? serverQuestions
        : serverQuestions.map((q) => {
            const pending = pendingRef.current.get(q.id)
            return pending ? ({ ...q, ...pending.patch } as FormQuestion) : q
          }),
    [],
  )

  const run = useCallback(
    (p: Promise<{ questions: FormQuestion[] }>, optimistic?: { qid: string; patch: Record<string, unknown> }) => {
      const release = () => {
        if (!optimistic) return
        const entry = pendingRef.current.get(optimistic.qid)
        if (!entry) return
        if (entry.count <= 1) pendingRef.current.delete(optimistic.qid)
        else pendingRef.current.set(optimistic.qid, { ...entry, count: entry.count - 1 })
      }
      if (optimistic) {
        const existing = pendingRef.current.get(optimistic.qid)
        pendingRef.current.set(optimistic.qid, {
          count: (existing?.count ?? 0) + 1,
          patch: { ...existing?.patch, ...optimistic.patch },
        })
        setQuestions((prev) =>
          prev.map((q) => (q.id === optimistic.qid ? ({ ...q, ...optimistic.patch } as FormQuestion) : q)),
        )
      }
      return p
        .then((r) => {
          release()
          setQuestions(() => mergeWithPending(r.questions))
        })
        .catch((e: unknown) => {
          release()
          setError(e instanceof Error ? e.message : 'Failed')
        })
    },
    [setQuestions, setError, mergeWithPending],
  )

  const addField = useCallback(
    (body: Record<string, unknown>) => {
      if (addInFlightRef.current) return
      addInFlightRef.current = true
      setAdding(false)
      void run(addQuestion(formId, { ...body, section })).then(() => {
        addInFlightRef.current = false
      })
    },
    [formId, section, run],
  )

  const removeQuestion = useCallback(
    (q: FormQuestion) => {
      if (removingRef.current.has(q.id)) return
      removingRef.current.add(q.id)
      void appConfirm(`Remove "${q.label}"?`, { title: 'Remove question', confirmLabel: 'Remove', danger: true })
        .then((confirmed) => (confirmed ? run(deleteQuestion(formId, q.id)) : undefined))
        .then(() => {
          removingRef.current.delete(q.id)
        })
    },
    [formId, run],
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
                onChange={(e) => {
                  const required = e.target.checked
                  void run(updateQuestion(formId, q.id, { required }), { qid: q.id, patch: { required } })
                }}
              />
              Required
            </label>
            <button type="button" className="fbtn-link" onClick={() => setEditing(q)}>Edit</button>
            <button type="button" className="fbtn-link" onClick={() => setLogicFor(q)}>Logic</button>
            {!q.locked && (
              <button type="button" className="fbtn-link danger" onClick={() => removeQuestion(q)}>
                Remove
              </button>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="qrow">No questions yet.</div>}
      </div>
      <button type="button" className="fbtn" onClick={() => setAdding(true)}>+ Add Field</button>

      {adding && (
        <AddFieldModal
          meta={meta}
          section={section}
          usedFieldIds={new Set(rows.map((r) => r.field_id))}
          onAdd={addField}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && (
        <QuestionEditModal
          question={editing}
          onSave={(patchBody) => {
            setEditing(null)
            void run(updateQuestion(formId, editing.id, patchBody), { qid: editing.id, patch: patchBody })
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {logicFor && (
        <LogicModal
          question={logicFor}
          earlier={rows.filter((r) => r.position < logicFor.position)}
          onSave={(visibility) => {
            setLogicFor(null)
            void run(updateQuestion(formId, logicFor.id, { visibility }), { qid: logicFor.id, patch: { visibility } })
          }}
          onClose={() => setLogicFor(null)}
        />
      )}
    </section>
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
  // Second latch, alongside QuestionList's: set synchronously so a double
  // click on "Create & add" (or two library picks in the same tick) can never
  // reach `onAdd` twice, even before the modal has unmounted.
  const submittedRef = useRef(false)
  const [submitted, setSubmitted] = useState(false)
  const submitOnce = (body: Record<string, unknown>) => {
    if (submittedRef.current) return
    submittedRef.current = true
    setSubmitted(true)
    onAdd(body)
  }
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
      <ModalDialog
        open
        title="Create Field"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="fbtn" onClick={() => setCreating(false)}>Back</button>
            <button
              type="button"
              className="fbtn primary"
              disabled={submitted || !label.trim() || (needsOptions && !optionsText.trim())}
              onClick={() =>
                submitOnce({
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
              {submitted ? 'Adding…' : 'Create & add'}
            </button>
          </>
        }
      >
        <div className="bfield">
          <label htmlFor="new-field-label">Label *</label>
          <input id="new-field-label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="bfield">
          <label htmlFor="new-field-type">Type</label>
          <select id="new-field-type" value={type} onChange={(e) => setType(e.target.value)}>
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
      </ModalDialog>
    )
  }

  return (
    <ModalDialog open title="Add Field" onClose={onClose}>
      <button type="button" className="field-pick" onClick={() => setCreating(true)}>
        <strong>Create Field ›</strong>
      </button>
      <div className="bfield" style={{ marginTop: 8 }}>
        <input type="text" placeholder="Search the field library…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {candidates.map((f) => (
        <button
          key={f.id}
          type="button"
          className="field-pick"
          disabled={submitted}
          onClick={() => submitOnce({ field_id: f.id })}
        >
          {f.label} <span className="qchip">{f.type}</span>
          {f.system === 1 && <span className="qchip locked">system</span>}
        </button>
      ))}
      {candidates.length === 0 && <p className="bhelp">No unused library fields match.</p>}
    </ModalDialog>
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
    <ModalDialog
      open
      title={`Edit — ${question.label}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="fbtn" onClick={onClose}>Cancel</button>
          <button
            type="button"
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
    </ModalDialog>
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
    <ModalDialog
      open
      title={`Conditional logic — ${question.label}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="fbtn" onClick={onClose}>Cancel</button>
          <button
            type="button"
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
                    <button type="button" className="fbtn-link danger" onClick={() => setConditions((prev) => prev.filter((_, j) => j !== i))}>−</button>
                  </div>
                )
              })}
              <button
                type="button"
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
    </ModalDialog>
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
              <button type="button" className="fbtn-link danger" onClick={() => write(rules.filter((_, j) => j !== i), fallbackPlan)}>
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
          type="button"
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

function SettingsStep({
  form,
  patch,
  timezone,
  wasClosed,
}: {
  form: FormRow
  patch: (c: Partial<FormRow>) => void
  timezone: string
  /** Status as last loaded/saved from the server — true while this session's
   * pending edit is a Closed -> Open transition the save will treat as a
   * reopen (see formsAdmin.ts PUT /:id). */
  wasClosed: boolean
}) {
  const closeAtPast = form.close_at !== null && new Date(form.close_at).getTime() < Date.now()
  const reopening = wasClosed && form.status === 'open'
  // Status duality (docs/04 defect): status='open' and a past close_at are
  // two independent controls that can disagree — the public form is closed
  // either way (submit.tsx isFormClosed). Surface that next to the select so
  // "why does this say Open when submitters see Closed" is answered in place,
  // whether or not the admin is mid-way through an explicit reopen.
  const effStatus = effectiveFormStatus(form)
  return (
    <section>
      <div className="bfield">
        <label htmlFor="form-status">Status</label>
        <select
          id="form-status"
          value={form.status}
          onChange={(e) => patch({ status: e.target.value as FormRow['status'] })}
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
        {effStatus === 'closed-by-date' && !reopening && (
          <p className="bhelp">
            Shows as <strong>Closed (by date)</strong> to submitters — the close date below has passed even
            though Status is set to Open. Clear or move the close date, or set Status to Closed to match.
          </p>
        )}
        {reopening && closeAtPast && (
          <p className="bhelp">
            Reopening clears the past close date below on save — set a new one here if you want this form to
            close again automatically.
          </p>
        )}
      </div>
      {/* Submission deadline. Rendered unconditionally next to Status — the
        * two together are the whole close story, and the input carries a real
        * htmlFor/id pair so it is reachable by its label (the eval agent read
        * the deadline as "not editable" when this input was label-less and
        * only the list's binary Close/Reopen button was discoverable). */}
      <div className="bfield">
        <label htmlFor="form-close-at">Close Date &amp; Time (submission deadline)</label>
        <input
          id="form-close-at"
          type="datetime-local"
          value={isoToLocalInput(form.close_at, timezone)}
          onChange={(e) => patch({ close_at: e.target.value ? localInputToIso(e.target.value, timezone) : null })}
        />
        <p className="bhelp">
          If set, the form stops accepting submissions after this moment ({timezone}). Leave empty to keep it open
          until Status is set to Closed. Press Save to apply.
        </p>
        {form.close_at !== null && (
          <button
            type="button"
            className="fbtn-link"
            onClick={() => patch({ close_at: null })}
          >
            Clear close date
          </button>
        )}
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

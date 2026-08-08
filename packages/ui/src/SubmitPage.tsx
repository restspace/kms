import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  parseParticipantRoles,
  validateAnswers,
  visibleQuestionIds,
  type Answers,
  type AnswerValue,
  type ParticipantRoleConfig,
  type QuestionDef,
} from '@kms/core'

/**
 * The public CFP wizard (docs/04 §5): Welcome → Account → Submission →
 * Participant → Review, then the success page. SSR'd by the Worker and
 * hydrated as a preact island; everything interactive lives here.
 */

export interface SubmitViewer {
  email: string
  first_name: string | null
  last_name: string | null
  mobile_phone: string | null
  biography: string | null
  /** submissions (drafts included) this contact already has on this form */
  submission_count: number
  /** resumable draft, when exactly one open draft exists */
  draft: { id: string; answers: Answers } | null
}

export interface SubmitFormInfo {
  id: string
  external_title: string
  page_heading: string
  welcome_message: string | null
  welcome_message_visible: boolean
  collect_participants: boolean
  participant_roles: string | null
  close_at: string | null
  /** effective limit (form override or event default); null = unlimited */
  submission_limit: number | null
  auto_redirect_to_portal: boolean
  success_message: string | null
}

export interface SubmitBootstrap {
  event: { name: string; slug: string; timezone: string }
  form: SubmitFormInfo
  questions: QuestionDef[]
  viewer: SubmitViewer | null
  closed: boolean
  dev_mode: boolean
  /** base path for this form's endpoints, e.g. /submit/<slug>/<form-id> */
  base_path: string
}

interface ParticipantDraft {
  email: string
  first_name: string
  last_name: string
  mobile_phone: string
  biography: string
  role: string
}

type Step = 'welcome' | 'account' | 'submission' | 'participant' | 'review'

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'welcome', label: 'Welcome!' },
  { key: 'account', label: 'Account' },
  { key: 'submission', label: 'Submission' },
  { key: 'participant', label: 'Participant' },
  { key: 'review', label: 'Review' },
]

const AUTOSAVE_MS = 10_000

function fmtDeadline(iso: string, timezone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    timeZone: timezone,
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

const plainLength = (v: AnswerValue): number =>
  typeof v === 'string' ? v.replace(/<[^>]*>/g, '').length : 0

export function SubmitPage({ data }: { data: SubmitBootstrap }) {
  const { form, event, viewer } = data
  const steps = useMemo(
    () => (form.collect_participants ? STEPS : STEPS.filter((s) => s.key !== 'participant')),
    [form.collect_participants],
  )
  const [step, setStep] = useState<Step>('welcome')
  const [answers, setAnswers] = useState<Answers>(() => viewer?.draft?.answers ?? {})
  const [submissionId, setSubmissionId] = useState<string | null>(viewer?.draft?.id ?? null)
  const [participants, setParticipants] = useState<ParticipantDraft[]>(() => [
    {
      email: viewer?.email ?? '',
      first_name: viewer?.first_name ?? '',
      last_name: viewer?.last_name ?? '',
      mobile_phone: viewer?.mobile_phone ?? '',
      biography: viewer?.biography ?? '',
      role: 'speaker',
    },
  ])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [stepError, setStepError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<{ code: string; portal_url: string; message: string | null; redirect: boolean } | null>(null)

  // Account step state
  const [loginEmail, setLoginEmail] = useState('')
  const [loginState, setLoginState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [devLink, setDevLink] = useState<string | null>(null)

  const abstractQuestions = useMemo(
    () => data.questions.filter((q) => q.section === 'abstract').sort((a, b) => a.position - b.position),
    [data.questions],
  )
  const participantQuestions = useMemo(
    () => data.questions.filter((q) => q.section === 'participant').sort((a, b) => a.position - b.position),
    [data.questions],
  )
  const roleConfigs: ParticipantRoleConfig[] = useMemo(
    () => parseParticipantRoles(form.participant_roles),
    [form.participant_roles],
  )
  const visible = useMemo(() => visibleQuestionIds(abstractQuestions, answers), [abstractQuestions, answers])

  const limit = form.submission_limit
  const overLimit =
    viewer !== null && limit !== null && viewer.submission_count >= limit && !viewer.draft

  // ------------------------------------------------------------------
  // Draft autosave (docs/04 §5 step 3): every 10 s while past Account.
  // ------------------------------------------------------------------
  const dirtyRef = useRef(false)
  const answersRef = useRef(answers)
  answersRef.current = answers
  const submissionIdRef = useRef(submissionId)
  submissionIdRef.current = submissionId

  const setAnswer = useCallback((qid: string, value: AnswerValue) => {
    dirtyRef.current = true
    setAnswers((prev) => ({ ...prev, [qid]: value }))
  }, [])

  useEffect(() => {
    if (!viewer || done || data.closed || overLimit) return
    const interval = setInterval(() => {
      if (!dirtyRef.current) return
      dirtyRef.current = false
      void fetch(`${data.base_path}/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ submission_id: submissionIdRef.current, answers: answersRef.current }),
      })
        .then(async (res) => {
          if (!res.ok) return
          const body = (await res.json()) as { submission_id: string }
          setSubmissionId(body.submission_id)
          setSavedAt(new Date().toLocaleTimeString())
        })
        .catch(() => {
          dirtyRef.current = true // retry on the next tick
        })
    }, AUTOSAVE_MS)
    return () => clearInterval(interval)
  }, [viewer, done, data.closed, overLimit, data.base_path])

  // ------------------------------------------------------------------
  // Success-page countdown redirect (10 s, with a manual button).
  // ------------------------------------------------------------------
  const [countdown, setCountdown] = useState(10)
  useEffect(() => {
    if (!done?.redirect) return
    if (countdown <= 0) {
      window.location.assign(done.portal_url)
      return
    }
    const t = setTimeout(() => setCountdown((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [done, countdown])

  const requestLogin = useCallback(async () => {
    if (!loginEmail.trim()) return
    setLoginState('sending')
    try {
      const res = await fetch('/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          email: loginEmail.trim(),
          event_slug: event.slug,
          redirect_to: data.base_path,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as { dev_link?: string }
      setDevLink(body.dev_link ?? null)
      setLoginState('sent')
    } catch {
      setLoginState('idle')
      setStepError('Could not request a sign-in link. Please try again.')
    }
  }, [loginEmail, event.slug, data.base_path])

  // ------------------------------------------------------------------
  // Step navigation with per-step validation
  // ------------------------------------------------------------------
  const stepIndex = steps.findIndex((s) => s.key === step)

  const validateSubmissionStep = useCallback((): boolean => {
    const validation = validateAnswers(abstractQuestions, answersRef.current)
    const next: Record<string, string> = {}
    for (const err of validation) next[err.question_id] = err.message
    setErrors(next)
    return validation.length === 0
  }, [abstractQuestions])

  const validateParticipantStep = useCallback((): boolean => {
    for (const p of participants) {
      if (!p.email.trim() || !p.first_name.trim() || !p.last_name.trim()) {
        setStepError('Every participant needs a first name, last name and email.')
        return false
      }
    }
    for (const cfg of roleConfigs) {
      const count = participants.filter((p) => p.role === cfg.role).length
      if (count < cfg.min) {
        setStepError(`At least ${cfg.min} ${cfg.role}${cfg.min > 1 ? 's' : ''} required.`)
        return false
      }
      if (cfg.max !== null && count > cfg.max) {
        setStepError(`At most ${cfg.max} ${cfg.role}${cfg.max > 1 ? 's' : ''} allowed.`)
        return false
      }
    }
    setStepError(null)
    return true
  }, [participants, roleConfigs])

  const goNext = useCallback(() => {
    setStepError(null)
    if (step === 'account' && !viewer) return
    if (step === 'submission' && !validateSubmissionStep()) return
    if (step === 'participant' && !validateParticipantStep()) return
    const next = steps[stepIndex + 1]
    if (next) setStep(next.key)
  }, [step, steps, stepIndex, viewer, validateSubmissionStep, validateParticipantStep])

  const goBack = useCallback(() => {
    setStepError(null)
    const prev = steps[stepIndex - 1]
    if (prev) setStep(prev.key)
  }, [steps, stepIndex])

  const submit = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    setStepError(null)
    try {
      const res = await fetch(`${data.base_path}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          submission_id: submissionIdRef.current,
          answers: answersRef.current,
          participants,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        const detail = Array.isArray(body.errors)
          ? (body.errors as Array<{ message: string }>).map((e) => e.message).join('; ')
          : typeof body.error === 'string'
            ? body.error
            : 'Submission failed.'
        setStepError(detail)
        return
      }
      setDone({
        code: body.code as string,
        portal_url: body.portal_url as string,
        message: (body.success_message as string | null) ?? null,
        redirect: Boolean(body.auto_redirect),
      })
    } catch {
      setStepError('Submission failed — please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }, [data.base_path, participants, submitting])

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (data.closed) {
    return (
      <Wizard title={form.external_title}>
        <div className="sb-banner">
          This form is closed{form.close_at ? ` — submissions ended ${fmtDeadline(form.close_at, event.timezone)}` : ''}.
        </div>
        <p>
          Already submitted? Visit your <a href={`/portal/${event.slug}`}>speaker portal</a>.
        </p>
      </Wizard>
    )
  }

  if (done) {
    return (
      <Wizard title={form.external_title}>
        <h2 className="sb-success-head">Submission received — {done.code}</h2>
        {done.message ? (
          <div className="sb-rich" dangerouslySetInnerHTML={{ __html: done.message }} />
        ) : (
          <p>
            You will receive a confirmation email shortly with a link to your speaker portal. We
            will review sessions over the next few weeks and then notify you regarding your status.
          </p>
        )}
        <p className="sb-muted">
          {done.redirect ? `Taking you to your speaker portal in ${countdown}s… ` : ''}
          <a className="sb-button sb-primary" href={done.portal_url}>Continue to portal</a>
        </p>
      </Wizard>
    )
  }

  return (
    <Wizard title={form.external_title}>
      <div className="sb-banner">
        {form.close_at
          ? `Form submissions will be accepted until ${fmtDeadline(form.close_at, event.timezone)}.`
          : 'This form is open.'}
        {limit !== null && <span> · Submission limit: {limit} per user</span>}
      </div>

      <ol className="sb-stepper">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className={s.key === step ? 'active' : i < stepIndex ? 'done' : ''}
            onClick={() => {
              // back-navigation to completed steps only (docs/04 §5 edge cases)
              if (i < stepIndex) setStep(s.key)
            }}
          >
            <span className="sb-step-n">{i + 1}</span> {s.label}
          </li>
        ))}
      </ol>

      {stepError && <div className="sb-error" role="alert">{stepError}</div>}

      {step === 'welcome' && (
        <section>
          {form.welcome_message_visible && form.welcome_message && (
            <div className="sb-rich" dangerouslySetInnerHTML={{ __html: form.welcome_message }} />
          )}
          <Nav onNext={goNext} />
        </section>
      )}

      {step === 'account' && (
        <section>
          {viewer ? (
            <>
              <p>
                Signed in as <strong>{viewer.email}</strong>.
              </p>
              {overLimit ? (
                <div className="sb-error">
                  You have reached the limit of {limit} submissions for this form. Manage your
                  existing submissions in the <a href={`/portal/${event.slug}`}>speaker portal</a>.
                </div>
              ) : (
                viewer.draft && <p className="sb-muted">Resuming your saved draft.</p>
              )}
              <Nav onBack={goBack} onNext={overLimit ? undefined : goNext} />
            </>
          ) : (
            <>
              <p>
                Enter your email and we will send you a sign-in link. Signing in creates your
                speaker portal, where you can track this submission, complete tasks and update
                your profile.
              </p>
              <div className="sb-field">
                <label htmlFor="sb-email">Email address</label>
                <input
                  id="sb-email"
                  type="email"
                  value={loginEmail}
                  placeholder="you@example.com"
                  onChange={(e) => setLoginEmail(e.currentTarget.value)}
                />
              </div>
              {loginState === 'sent' ? (
                <>
                  <p className="sb-muted">
                    Check your email — the link signs you in and returns you to this form.
                  </p>
                  {devLink && (
                    <p className="sb-devlink">
                      DEV_MODE: <a href={devLink}>use your sign-in link</a>
                    </p>
                  )}
                </>
              ) : (
                <button
                  className="sb-button sb-primary"
                  disabled={loginState === 'sending' || !loginEmail.trim()}
                  onClick={() => void requestLogin()}
                >
                  {loginState === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
                </button>
              )}
              <Nav onBack={goBack} />
            </>
          )}
        </section>
      )}

      {step === 'submission' && (
        <section>
          {abstractQuestions.map((q) =>
            visible.has(q.id) ? (
              <QuestionInput
                key={q.id}
                question={q}
                value={answers[q.id]}
                error={errors[q.id]}
                onChange={(v) => setAnswer(q.id, v)}
              />
            ) : null,
          )}
          {savedAt && <p className="sb-muted sb-saved">Draft saved {savedAt}</p>}
          <Nav onBack={goBack} onNext={goNext} />
        </section>
      )}

      {step === 'participant' && (
        <section>
          <p className="sb-muted">
            You are participant 1 and the primary contact. Bios and headshots can also be
            completed later in the portal.
          </p>
          {participants.map((p, i) => (
            <ParticipantCard
              key={i}
              index={i}
              participant={p}
              questions={participantQuestions}
              roles={roleConfigs}
              lockEmail={i === 0}
              onChange={(next) =>
                setParticipants((prev) => prev.map((old, j) => (j === i ? next : old)))
              }
              onRemove={
                i === 0 ? undefined : () => setParticipants((prev) => prev.filter((_, j) => j !== i))
              }
            />
          ))}
          <button
            className="sb-button"
            onClick={() =>
              setParticipants((prev) => [
                ...prev,
                { email: '', first_name: '', last_name: '', mobile_phone: '', biography: '', role: roleConfigs[0]?.role ?? 'speaker' },
              ])
            }
          >
            + Add participant
          </button>
          <Nav onBack={goBack} onNext={goNext} />
        </section>
      )}

      {step === 'review' && (
        <section>
          <h3 className="sb-review-h">
            Submission <button className="sb-link" onClick={() => setStep('submission')}>Edit</button>
          </h3>
          <dl className="sb-review">
            {abstractQuestions
              .filter((q) => visible.has(q.id))
              .map((q) => (
                <div key={q.id}>
                  <dt>{q.label}</dt>
                  <dd>{formatAnswer(answers[q.id])}</dd>
                </div>
              ))}
          </dl>
          {form.collect_participants && (
            <>
              <h3 className="sb-review-h">
                Participants <button className="sb-link" onClick={() => setStep('participant')}>Edit</button>
              </h3>
              <dl className="sb-review">
                {participants.map((p, i) => (
                  <div key={i}>
                    <dt>{p.role}</dt>
                    <dd>
                      {p.first_name} {p.last_name} · {p.email}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          <Nav onBack={goBack} nextLabel={submitting ? 'Submitting…' : 'Submit'} onNext={() => void submit()} nextDisabled={submitting} />
        </section>
      )}
    </Wizard>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Wizard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="sb-main">
      <style dangerouslySetInnerHTML={{ __html: wizardCss }} />
      <h1>{title}</h1>
      {children}
    </main>
  )
}

function Nav({
  onBack,
  onNext,
  nextLabel = 'Next',
  nextDisabled,
}: {
  onBack?: () => void
  onNext?: () => void
  nextLabel?: string
  nextDisabled?: boolean
}) {
  return (
    <div className="sb-nav">
      {onBack ? <button className="sb-button" onClick={onBack}>Back</button> : <span />}
      {onNext && (
        <button className="sb-button sb-primary" disabled={nextDisabled} onClick={onNext}>
          {nextLabel}
        </button>
      )}
    </div>
  )
}

function formatAnswer(v: AnswerValue): string {
  if (v === undefined || v === null || v === '') return '—'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v).replace(/<[^>]*>/g, '')
}

function QuestionInput({
  question: q,
  value,
  error,
  onChange,
}: {
  question: QuestionDef
  value: AnswerValue
  error?: string
  onChange: (v: AnswerValue) => void
}) {
  if (q.type === 'heading') {
    return <h3 className="sb-heading">{q.label}</h3>
  }
  const id = `sb-q-${q.id}`
  const counter =
    q.max_chars && (q.type === 'text' || q.type === 'textarea' || q.type === 'wysiwyg') ? (
      <span className={`sb-counter${plainLength(value) > q.max_chars ? ' over' : ''}`}>
        {plainLength(value)}/{q.max_chars}
      </span>
    ) : null

  let control: React.ReactNode
  switch (q.type) {
    case 'textarea':
    case 'wysiwyg':
      control = (
        <textarea
          id={id}
          rows={q.type === 'wysiwyg' ? 6 : 4}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )
      break
    case 'dropdown':
      control = (
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.currentTarget.value || undefined)}
        >
          <option value="">Select…</option>
          {(q.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )
      break
    case 'radio':
      control = (
        <div className="sb-choices">
          {(q.options ?? []).map((o) => (
            <label key={o.value}>
              <input
                type="radio"
                name={id}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      )
      break
    case 'multiselect':
      control = (
        <div className="sb-choices">
          {(q.options ?? []).map((o) => {
            const selected = Array.isArray(value) ? value : []
            const checked = selected.includes(o.value)
            return (
              <label key={o.value}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange(
                      checked ? selected.filter((v) => v !== o.value) : [...selected, o.value],
                    )
                  }
                />
                {o.label}
              </label>
            )
          })}
        </div>
      )
      break
    case 'checkbox':
      control = (
        <label className="sb-check">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.currentTarget.checked)} />
          {q.help_text ?? 'Yes'}
        </label>
      )
      break
    case 'number':
      control = (
        <input
          id={id}
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
        />
      )
      break
    case 'date':
    case 'datetime':
      control = (
        <input
          id={id}
          type={q.type === 'date' ? 'date' : 'datetime-local'}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )
      break
    case 'file':
      control = <p className="sb-muted">File uploads are completed later in your speaker portal.</p>
      break
    default:
      control = (
        <input
          id={id}
          type={q.type === 'email' ? 'email' : q.type === 'url' ? 'url' : q.type === 'phone' ? 'tel' : 'text'}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )
  }

  return (
    <div className={`sb-field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>
        {q.label}
        {q.required && <span className="sb-req" aria-hidden="true"> *</span>}
        {counter}
      </label>
      {q.help_text && q.type !== 'checkbox' && <p className="sb-help">{q.help_text}</p>}
      {control}
      {error && <p className="sb-field-error" role="alert">{error}</p>}
    </div>
  )
}

/** Participant question keys that map onto contact fields (docs/04 §5 step 4). */
const PARTICIPANT_FIELD_KEYS = new Set(['first_name', 'last_name', 'email', 'mobile_phone', 'biography'])

function ParticipantCard({
  index,
  participant,
  questions,
  roles,
  lockEmail,
  onChange,
  onRemove,
}: {
  index: number
  participant: ParticipantDraft
  questions: QuestionDef[]
  roles: ParticipantRoleConfig[]
  lockEmail: boolean
  onChange: (p: ParticipantDraft) => void
  onRemove?: () => void
}) {
  const set = (key: keyof ParticipantDraft) => (e: { currentTarget: { value: string } }) =>
    onChange({ ...participant, [key]: e.currentTarget.value })

  return (
    <div className="sb-card">
      <div className="sb-card-head">
        <strong>Participant {index + 1}{index === 0 ? ' — primary contact' : ''}</strong>
        <span className="sb-card-tools">
          <select value={participant.role} onChange={set('role')} aria-label="Role">
            {roles.map((r) => (
              <option key={r.role} value={r.role}>{r.role}</option>
            ))}
          </select>
          {onRemove && <button className="sb-link" onClick={onRemove}>Remove</button>}
        </span>
      </div>
      {questions
        .filter((q) => PARTICIPANT_FIELD_KEYS.has(q.field_key))
        .map((q) => {
          const key = q.field_key as keyof ParticipantDraft
          const id = `sb-p${index}-${q.field_key}`
          const isTextarea = q.type === 'wysiwyg' || q.type === 'textarea'
          return (
            <div className="sb-field" key={q.id}>
              <label htmlFor={id}>
                {q.label}
                {q.required && <span className="sb-req" aria-hidden="true"> *</span>}
              </label>
              {q.help_text && <p className="sb-help">{q.help_text}</p>}
              {isTextarea ? (
                <textarea id={id} rows={3} value={participant[key]} onChange={set(key)} />
              ) : (
                <input
                  id={id}
                  type={q.type === 'email' ? 'email' : q.type === 'phone' ? 'tel' : 'text'}
                  value={participant[key]}
                  disabled={key === 'email' && lockEmail}
                  onChange={set(key)}
                />
              )}
            </div>
          )
        })}
    </div>
  )
}

const wizardCss = `
.sb-main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
.sb-banner { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 8px;
  padding: .6rem .9rem; font-size: .9rem; margin: 0 0 1.25rem; }
.sb-stepper { display: flex; flex-wrap: wrap; gap: .25rem 1rem; list-style: none; padding: 0;
  margin: 0 0 1.5rem; font-size: .85rem; color: var(--muted); }
.sb-stepper li { display: flex; align-items: center; gap: .4rem; }
.sb-stepper li.done { cursor: pointer; }
.sb-stepper li.active { color: var(--fg); font-weight: 600; }
.sb-step-n { display: inline-flex; align-items: center; justify-content: center; width: 1.4rem;
  height: 1.4rem; border-radius: 50%; border: 1px solid var(--line); font-size: .75rem; }
.sb-stepper li.active .sb-step-n { background: var(--accent); border-color: var(--accent); color: #fff; }
.sb-stepper li.done .sb-step-n { border-color: var(--accent); color: var(--accent); }
.sb-field { margin: 0 0 1rem; }
.sb-field label { display: flex; align-items: baseline; gap: .35rem; font-weight: 600;
  font-size: .9rem; margin-bottom: .3rem; }
.sb-field input[type=text], .sb-field input[type=email], .sb-field input[type=url],
.sb-field input[type=tel], .sb-field input[type=number], .sb-field input[type=date],
.sb-field input[type=datetime-local], .sb-field textarea, .sb-field select {
  width: 100%; padding: .5rem .65rem; border: 1px solid var(--line); border-radius: 8px;
  font: inherit; background: var(--bg); color: var(--fg); }
.sb-field.has-error input, .sb-field.has-error textarea, .sb-field.has-error select { border-color: #dc2626; }
.sb-field-error { color: #dc2626; font-size: .82rem; margin: .3rem 0 0; }
.sb-req { color: #dc2626; }
.sb-help { font-size: .82rem; color: var(--muted); margin: -.1rem 0 .35rem; }
.sb-counter { margin-left: auto; font-weight: 400; font-size: .78rem; color: var(--muted); }
.sb-counter.over { color: #dc2626; font-weight: 600; }
.sb-choices { display: flex; flex-direction: column; gap: .35rem; }
.sb-choices label, .sb-check { display: flex; gap: .5rem; align-items: center; font-size: .95rem; }
.sb-nav { display: flex; justify-content: space-between; margin-top: 1.75rem; }
.sb-button { font: inherit; padding: .5rem 1.1rem; border-radius: 8px; border: 1px solid var(--line);
  background: transparent; color: var(--fg); cursor: pointer; }
.sb-button.sb-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.sb-button:disabled { opacity: .55; cursor: default; }
.sb-link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer;
  font: inherit; font-size: .85rem; text-decoration: underline; }
.sb-error { border: 1px solid #fca5a5; background: color-mix(in srgb, #dc2626 8%, transparent);
  color: #dc2626; border-radius: 8px; padding: .6rem .9rem; font-size: .9rem; margin: 0 0 1rem; }
.sb-devlink { border: 1px dashed var(--line); border-radius: 8px; padding: .5rem .8rem; font-size: .85rem; }
.sb-muted { color: var(--muted); }
.sb-saved { font-size: .8rem; }
.sb-card { border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem; margin: 0 0 1rem; }
.sb-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: .75rem; }
.sb-card-tools { display: flex; gap: .75rem; align-items: center; }
.sb-card-tools select { font: inherit; font-size: .85rem; padding: .25rem .4rem; border-radius: 6px;
  border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
.sb-review { margin: 0 0 1.5rem; }
.sb-review > div { display: grid; grid-template-columns: 11rem 1fr; gap: .75rem; padding: .45rem 0;
  border-bottom: 1px solid var(--line); font-size: .92rem; }
.sb-review dt { color: var(--muted); }
.sb-review dd { margin: 0; overflow-wrap: anywhere; }
.sb-review-h { display: flex; gap: .75rem; align-items: baseline; font-size: 1.05rem; margin: 1.25rem 0 .5rem; }
.sb-rich h1, .sb-rich h2, .sb-rich h3 { line-height: 1.25; margin: 1.1rem 0 .45rem; }
.sb-rich p, .sb-rich ul, .sb-rich ol { margin: 0 0 .8rem; }
.sb-rich img { max-width: 100%; }
.sb-success-head { margin-top: 0; }
`

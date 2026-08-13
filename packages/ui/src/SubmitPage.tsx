import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  discardHiddenAnswers,
  isValidEmailShape,
  isValidUrlShape,
  MAX_PARTICIPANTS_PER_SUBMISSION,
  parseParticipantRoles,
  validateAnswers,
  visibleQuestionIds,
  type Answers,
  type AnswerValue,
  type ParticipantRoleConfig,
  type QuestionDef,
  type ValidationError,
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
  /** resumable draft, when exactly one open draft exists. Never auto-applied
   * — the Account step asks the submitter to resume it or start fresh
   * (ABS defect: silently resuming used to overwrite an unrelated draft
   * under the same code with no warning). */
  draft: { id: string; title: string; answers: Answers } | null
  /** Workplan 15 W3 (D7): guidance this person was given on an earlier
   * proposal anywhere in the organisation, looked up at render time — never
   * copied between events, because a copy forks the moment someone edits it.
   * Absent on a bootstrap from an older deploy. */
  revise_invites?: Array<{ submission_id: string; title: string; guidance: string; event_name: string }>
}

export interface SubmitFormInfo {
  id: string
  external_title: string
  page_heading: string
  welcome_message: string | null
  welcome_message_visible: boolean
  collect_participants: boolean
  participant_roles: string | null
  /** 'closed' means the organiser closed the form early, independent of
   *  close_at — the deadline message only reflects reality when the form is
   *  still 'open' (or hasn't reached close_at yet). */
  status: 'open' | 'closed'
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
  role: string
  is_primary_contact: boolean
  answers: Answers
}

/** Questions of type 'file' have no upload control on this page (docs/04 §5
 * — headshots/attachments are completed later in the portal); exclude them
 * from client-side required/shape validation so the step can never be
 * permanently blocked, matching the server's transitional treatment. */
function filterFileErrors(questions: QuestionDef[], errors: ValidationError[]): ValidationError[] {
  const fileIds = new Set(questions.filter((q) => q.type === 'file').map((q) => q.id))
  return errors.filter((e) => !fileIds.has(e.question_id))
}

/** Early on-blur shape check for email/url questions (submit-time authority
 * stays with validateAnswers — this just surfaces the same shared-shape rule
 * sooner). Empty values are left for the required check at step-advance. */
function liveShapeError(q: QuestionDef, value: AnswerValue): string | undefined {
  if (q.type !== 'email' && q.type !== 'url') return undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (q.type === 'email') return isValidEmailShape(value) ? undefined : `${q.label} must be a valid email`
  return isValidUrlShape(value) ? undefined : `${q.label} must be a valid link (http:// or https://)`
}

/** Best-effort display name/email for a participant card title, read from
 * whichever configured questions map onto those field keys — no special
 * rendering, just a friendlier heading than "Participant 2". */
function participantIdentity(questions: QuestionDef[], answers: Answers): { name: string; email: string } {
  const byKey = (key: string): AnswerValue => {
    const q = questions.find((qq) => qq.field_key === key)
    return q ? answers[q.id] : undefined
  }
  const first = byKey('first_name')
  const last = byKey('last_name')
  const email = byKey('email')
  const name = [first, last].filter((v) => typeof v === 'string' && v.trim()).join(' ')
  return { name, email: typeof email === 'string' ? email : '' }
}

// Item 2: matches the organiser workspace's own `readableRole` (admin's
// workspace/extras.tsx) so 'co-speaker' reads "Co-Speaker" here too, not the
// raw hyphenated role id.
const readableRole = (role: string): string =>
  role.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('-')

/** Ids of identity questions synthesized client-side when a
 * collect-participants form configures no name/email participant questions.
 * Their answers are sent as flat `{first_name, last_name, email}` fields on
 * the participant payload (which the server lifts into identity), never as
 * question-keyed answers. */
const SYNTH_IDENTITY_PREFIX = '__identity-'
const IDENTITY_FALLBACKS: Array<{ key: 'first_name' | 'last_name' | 'email'; label: string; type: 'text' | 'email' }> = [
  { key: 'first_name', label: 'First Name', type: 'text' },
  { key: 'last_name', label: 'Last Name', type: 'text' },
  { key: 'email', label: 'Email', type: 'email' },
]

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
  // ABS defect (data loss): a signed-in submitter with an existing draft used
  // to have it silently loaded here and reused by the next autosave, which
  // meant "start a new submission" quietly overwrote an unrelated draft under
  // the same code. Neither `answers` nor `submissionId` seed from the draft
  // any more — the Account step below makes the submitter choose Resume or
  // Start new first, and only that choice (resumeDraft/startNewDraft) applies
  // draft state.
  const [answers, setAnswers] = useState<Answers>({})
  const [submissionId, setSubmissionId] = useState<string | null>(null)
  // null = undecided (only meaningful while viewer.draft exists); the Account
  // step blocks progress until this resolves to 'resume' or 'new'.
  const [draftChoice, setDraftChoice] = useState<'resume' | 'new' | null>(null)
  const [draftChoiceError, setDraftChoiceError] = useState<string | null>(null)
  const [startingNew, setStartingNew] = useState(false)
  // W3/D7: the "you were asked to revise this" panel is dismissible — it is a
  // reminder, not a gate, and a submitter who is here about something else
  // should be able to get it out of the way.
  const [invitesDismissed, setInvitesDismissed] = useState(false)
  /** Which prior submission this one answers, once the submitter says so. */
  const [resubmissionOf, setResubmissionOf] = useState<string | null>(null)
  const participantQuestions = useMemo(() => {
    const configured = data.questions
      .filter((q) => q.section === 'participant')
      .sort((a, b) => a.position - b.position)
    if (!form.collect_participants) return configured
    // A collect-participants form whose configured questions cover no
    // name/email leaves every added slot unidentifiable — the server rejects
    // it with participants_invalid and the step is a dead end (CFP defect).
    // Synthesize the missing identity inputs; `submit` sends their values as
    // flat fields the server lifts into the participant's identity.
    const have = new Set(configured.map((q) => q.field_key))
    const basePosition = configured.reduce((max, q) => Math.max(max, q.position), 0)
    const fallbacks = IDENTITY_FALLBACKS.filter((f) => !have.has(f.key)).map(
      (f, i): QuestionDef => ({
        id: `${SYNTH_IDENTITY_PREFIX}${f.key}`,
        section: 'participant',
        field_key: f.key,
        field_id: `${SYNTH_IDENTITY_PREFIX}${f.key}`,
        label: f.label,
        help_text: null,
        type: f.type,
        position: basePosition + i + 1,
        required: true,
        locked: false,
        options: null,
        max_chars: 255,
        visibility: null,
      }),
    )
    return [...configured, ...fallbacks]
  }, [data.questions, form.collect_participants])
  const primaryParticipantAnswers = useMemo((): Answers => {
    const seed: Record<string, string | null | undefined> = {
      email: viewer?.email,
      first_name: viewer?.first_name,
      last_name: viewer?.last_name,
      mobile_phone: viewer?.mobile_phone,
      biography: viewer?.biography,
    }
    const answers: Answers = {}
    for (const q of participantQuestions) {
      const v = seed[q.field_key]
      if (v) answers[q.id] = v
    }
    return answers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer])
  const [participants, setParticipants] = useState<ParticipantDraft[]>(() => [
    { role: 'speaker', is_primary_contact: true, answers: primaryParticipantAnswers },
  ])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [participantErrors, setParticipantErrors] = useState<Record<string, string>[]>([])
  const [stepError, setStepError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<{ code: string; portal_url: string; message: string | null; redirect: boolean } | null>(null)

  // Account step state
  const [loginEmail, setLoginEmail] = useState('')
  const [loginState, setLoginState] = useState<'idle' | 'sending' | 'sent' | 'created'>('idle')
  const [devLink, setDevLink] = useState<string | null>(null)

  const abstractQuestions = useMemo(
    () => data.questions.filter((q) => q.section === 'abstract').sort((a, b) => a.position - b.position),
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
  const resubmissionOfRef = useRef<string | null>(null)
  resubmissionOfRef.current = resubmissionOf

  const setAnswer = useCallback((qid: string, value: AnswerValue) => {
    dirtyRef.current = true
    setAnswers((prev) => ({ ...prev, [qid]: value }))
  }, [])

  // Account step: an authenticated submitter with an existing draft chooses
  // explicitly rather than being dropped into it. "Resume" just adopts the
  // bootstrap-supplied draft id/answers (already loaded, no round trip
  // needed). "Start new" asks the server for a genuinely fresh draft up
  // front — via `force_new`, which skips the reuse-most-recent-draft lookup
  // the autosave endpoint otherwise applies — so the limit can be checked
  // and reported immediately instead of failing silently on the next
  // autosave tick.
  const resumeDraft = useCallback(() => {
    if (!viewer?.draft) return
    setSubmissionId(viewer.draft.id)
    setAnswers(viewer.draft.answers)
    setDraftChoiceError(null)
    setDraftChoice('resume')
  }, [viewer])

  // `priorId` (W3/D7) is set when the submitter starts from the revise panel:
  // the new draft records what it answers, so "did they act on the guidance?"
  // is answerable later. The guidance itself is never copied onto the new row.
  const startNewDraft = useCallback(async (priorId?: string) => {
    setDraftChoiceError(null)
    setStartingNew(true)
    try {
      const res = await fetch(`${data.base_path}/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          submission_id: null,
          answers: {},
          force_new: true,
          ...(priorId ? { resubmission_of: priorId } : {}),
        }),
      })
      const body = (await res.json().catch(() => ({}))) as { submission_id?: string; error?: string }
      if (!res.ok) {
        setDraftChoiceError(
          body.error === 'limit_reached'
            ? `You have reached your submission limit${limit !== null ? ` (${limit})` : ''}. Manage your existing submissions in the speaker portal instead.`
            : 'Could not start a new submission — please try again.',
        )
        return
      }
      setSubmissionId(body.submission_id ?? null)
      setAnswers({})
      setParticipants([{ role: 'speaker', is_primary_contact: true, answers: primaryParticipantAnswers }])
      setDraftChoice('new')
      if (priorId) setResubmissionOf(priorId)
    } catch {
      setDraftChoiceError('Could not start a new submission — please check your connection and try again.')
    } finally {
      setStartingNew(false)
    }
  }, [data.base_path, limit, primaryParticipantAnswers])

  useEffect(() => {
    if (!viewer || done || data.closed || overLimit) return
    // Autosave stays paused while the resume-vs-new choice is pending: there
    // is no submissionId to save against yet, and applying either choice
    // resets `answers` anyway.
    if (viewer.draft && draftChoice === null) return
    const interval = setInterval(() => {
      if (!dirtyRef.current) return
      dirtyRef.current = false
      void fetch(`${data.base_path}/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ submission_id: submissionIdRef.current, answers: answersRef.current }),
      })
        .then(async (res) => {
          if (!res.ok) {
            // The limit can close underneath an open wizard (another tab, a
            // second device). Say so instead of autosaving silently forever.
            const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
            if (res.status === 409 && body.error === 'limit_reached') {
              setStepError(body.message ?? 'You have reached the submission limit for this form.')
            }
            return
          }
          const body = (await res.json()) as { submission_id: string }
          setSubmissionId(body.submission_id)
          setSavedAt(new Date().toLocaleTimeString())
        })
        .catch(() => {
          dirtyRef.current = true // retry on the next tick
        })
    }, AUTOSAVE_MS)
    return () => clearInterval(interval)
  }, [viewer, done, data.closed, overLimit, data.base_path, draftChoice])

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

  // Account step (docs/04 §5 step 2): an unrecognised email gets a real
  // account and an in-wizard session right away — no email round trip, which
  // matters on a deployment with no working mail provider. An email that is
  // already registered never gets silently signed in; it falls back to the
  // normal sign-in mechanism (a real magic-link email, or the inline demo
  // link for the two seeded addresses).
  const requestLogin = useCallback(async () => {
    const email = loginEmail.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStepError('Enter a valid email address.')
      return
    }
    setStepError(null)
    setLoginState('sending')
    try {
      const res = await fetch(`${data.base_path}/account`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        status?: 'created' | 'existing'
        dev_link?: string | null
        error?: string
      }
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      if (body.status === 'created') {
        // The response already set the session cookie — reload into the
        // authenticated bootstrap rather than faking viewer state client-side.
        setLoginState('created')
        window.location.assign(data.base_path)
        return
      }
      setDevLink(body.dev_link ?? null)
      setLoginState('sent')
    } catch {
      setLoginState('idle')
      setStepError('Could not sign you in. Please try again.')
    }
  }, [loginEmail, data.base_path])

  // ------------------------------------------------------------------
  // Step navigation with per-step validation
  // ------------------------------------------------------------------
  const stepIndex = steps.findIndex((s) => s.key === step)

  const validateSubmissionStep = useCallback((): boolean => {
    const validation = filterFileErrors(abstractQuestions, validateAnswers(abstractQuestions, answersRef.current))
    const next: Record<string, string> = {}
    for (const err of validation) next[err.question_id] = err.message
    setErrors(next)
    return validation.length === 0
  }, [abstractQuestions])

  const validateParticipantStep = useCallback((): boolean => {
    const nextErrors: Record<string, string>[] = []
    let anyFieldErrors = false
    const isEmptyAnswer = (v: AnswerValue) =>
      v === undefined || v === null || v === false ||
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.length === 0)
    for (const [i, p] of participants.entries()) {
      // A never-touched extra slot is ignored (and dropped at submit), not a
      // wall of "required" errors the submitter can only escape by noticing
      // the Remove link.
      if (i > 0 && Object.values(p.answers).every(isEmptyAnswer)) {
        nextErrors.push({})
        continue
      }
      const validation = filterFileErrors(participantQuestions, validateAnswers(participantQuestions, p.answers))
      const errs: Record<string, string> = {}
      for (const err of validation) errs[err.question_id] = err.message
      if (validation.length > 0) anyFieldErrors = true
      nextErrors.push(errs)
    }
    setParticipantErrors(nextErrors)
    if (anyFieldErrors) {
      setStepError('Please fix the highlighted participant fields.')
      return false
    }
    const active = participants.filter((p, i) => i === 0 || !Object.values(p.answers).every(isEmptyAnswer))
    for (const cfg of roleConfigs) {
      const count = active.filter((p) => p.role === cfg.role).length
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
  }, [participants, roleConfigs, participantQuestions])

  const goNext = useCallback(() => {
    setStepError(null)
    if (step === 'account' && !viewer) return
    if (step === 'account' && viewer?.draft && draftChoice === null) return
    if (step === 'submission' && !validateSubmissionStep()) return
    if (step === 'participant' && !validateParticipantStep()) return
    const next = steps[stepIndex + 1]
    if (next) setStep(next.key)
  }, [step, steps, stepIndex, viewer, draftChoice, validateSubmissionStep, validateParticipantStep])

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
      const isEmptyAnswer = (v: AnswerValue) =>
        v === undefined || v === null || v === false ||
        (typeof v === 'string' && v.trim() === '') ||
        (Array.isArray(v) && v.length === 0)
      const outgoingParticipants = participants
        // An accidental never-filled extra slot is dropped, not a dead end
        // (the primary slot always goes through — the server re-asserts the
        // signed-in submitter as participant 1 regardless).
        .filter((p, i) => i === 0 || !Object.values(p.answers).every(isEmptyAnswer))
        .map((p) => {
          const kept = discardHiddenAnswers(participantQuestions, p.answers)
          // Synthesized identity questions travel as flat fields, not answers
          // — the server has no configured question to key them by.
          const flat: Record<string, string> = {}
          for (const q of participantQuestions) {
            if (!q.id.startsWith(SYNTH_IDENTITY_PREFIX)) continue
            const v = kept[q.id]
            delete kept[q.id]
            if (typeof v === 'string' && v.trim() !== '') flat[q.field_key] = v.trim()
          }
          return {
            role: p.role,
            is_primary_contact: p.is_primary_contact,
            answers: kept,
            ...flat,
          }
        })
      const res = await fetch(`${data.base_path}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          submission_id: submissionIdRef.current,
          answers: answersRef.current,
          participants: outgoingParticipants,
          // W3/D7: carried here too, for the submitter who never triggered an
          // autosave — the draft path stamps it on create, this covers the
          // straight-through case.
          ...(resubmissionOfRef.current ? { resubmission_of: resubmissionOfRef.current } : {}),
        }),
      })
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        const detail = Array.isArray(body.errors)
          ? (body.errors as Array<{ message: string }>).map((e) => e.message).join('; ')
          : typeof body.message === 'string'
            ? body.message
            : typeof body.detail === 'string'
              ? body.detail
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
  }, [data.base_path, participants, participantQuestions, submitting])

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (data.closed) {
    return (
      <Wizard title={form.external_title} eventName={event.name}>
        <div className="sb-banner">
          {form.status === 'closed'
            ? 'This form is closed — the organisers closed submissions early.'
            : `This form is closed${form.close_at ? ` — submissions ended ${fmtDeadline(form.close_at, event.timezone)}` : ''}.`}
        </div>
        <p>
          Already submitted? Visit your <a href={`/portal/${event.slug}`}>speaker portal</a>.
        </p>
      </Wizard>
    )
  }

  if (done) {
    return (
      <Wizard title={form.external_title} eventName={event.name}>
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
    <Wizard title={form.external_title} eventName={event.name}>
      <div className="sb-banner">
        {form.close_at
          ? `Form submissions will be accepted until ${fmtDeadline(form.close_at, event.timezone)}.`
          : 'This form is open.'}
        {limit !== null && <span> · Submission limit: {limit} per user for this form</span>}
      </div>

      <ol className="sb-stepper">
        {steps.map((s, i) => (
          <li key={s.key} className={s.key === step ? 'active' : i < stepIndex ? 'done' : ''}>
            <button
              type="button"
              className="sb-step-btn"
              aria-current={s.key === step ? 'step' : undefined}
              disabled={i > stepIndex}
              onClick={() => {
                // back-navigation to completed steps only (docs/04 §5 edge cases)
                if (i < stepIndex) setStep(s.key)
              }}
            >
              <span className="sb-step-n">{i + 1}</span> {s.label}
            </button>
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
              {/* Workplan 15 W3 (D7): the guidance this person was given last
                  time, shown back inside this year's form. Looked up at render
                  time on the org-scoped contact — never copied forward, so
                  editing it in the workspace changes what is shown here. */}
              {!invitesDismissed &&
                (viewer.revise_invites ?? []).length > 0 &&
                !resubmissionOf && (
                  <div className="sb-card sb-revise-invite">
                    <p>
                      <strong>You were asked to revise and resubmit.</strong>
                    </p>
                    {viewer.revise_invites!.map((invite) => (
                      <div key={invite.submission_id} className="sb-revise-item">
                        <p className="sb-muted">
                          {invite.event_name} — “{invite.title}”
                        </p>
                        <p style={{ whiteSpace: 'pre-line' }}>{invite.guidance}</p>
                        <button
                          type="button"
                          className="sb-button sb-primary"
                          disabled={startingNew || overLimit}
                          onClick={() => void startNewDraft(invite.submission_id)}
                        >
                          {startingNew ? 'Starting…' : 'Start a revised submission'}
                        </button>
                      </div>
                    ))}
                    {draftChoiceError && <div className="sb-error" role="alert">{draftChoiceError}</div>}
                    <button type="button" className="sb-link" onClick={() => setInvitesDismissed(true)}>
                      Dismiss
                    </button>
                  </div>
                )}
              {resubmissionOf && (
                <p className="sb-muted">Starting a revised submission — we will link it to your earlier proposal.</p>
              )}
              {overLimit ? (
                <div className="sb-error">
                  You have reached the limit of {limit} submissions for this form. Manage your
                  existing submissions in the <a href={`/portal/${event.slug}`}>speaker portal</a>.
                </div>
              ) : viewer.draft && draftChoice === null ? (
                <div className="sb-card">
                  <p>
                    You have a saved draft, <strong>{viewer.draft.title}</strong>. Resume it, or start a
                    new submission — starting new never changes your existing draft.
                  </p>
                  {draftChoiceError && <div className="sb-error" role="alert">{draftChoiceError}</div>}
                  <div className="sb-nav" style={{ justifyContent: 'flex-start', gap: '.75rem' }}>
                    <button type="button" className="sb-button sb-primary" onClick={resumeDraft}>
                      Resume draft “{viewer.draft.title}”
                    </button>
                    <button
                      type="button"
                      className="sb-button"
                      disabled={startingNew}
                      onClick={() => void startNewDraft()}
                    >
                      {startingNew ? 'Starting…' : 'Start a new submission'}
                    </button>
                  </div>
                </div>
              ) : (
                viewer.draft &&
                draftChoice && (
                  <p className="sb-muted">
                    {draftChoice === 'resume' ? 'Resuming your saved draft.' : 'Starting a new submission.'}
                  </p>
                )
              )}
              <Nav
                onBack={goBack}
                onNext={overLimit || (viewer.draft && draftChoice === null) ? undefined : goNext}
              />
            </>
          ) : (
            <>
              <p>
                Enter your email to get started. New here? We will set up your speaker account
                right away, no email required, so you can keep going. Already signed up? We will
                send you a sign-in link instead.
              </p>
              <div className="sb-field">
                <label htmlFor="sb-email">Email address</label>
                <input
                  id="sb-email"
                  type="email"
                  value={loginEmail}
                  placeholder="you@example.com"
                  required
                  disabled={loginState === 'sending' || loginState === 'created'}
                  onChange={(e) => setLoginEmail(e.currentTarget.value)}
                />
              </div>
              {loginState === 'sent' ? (
                <>
                  <p className="sb-muted">
                    An account already exists for <strong>{loginEmail.trim()}</strong>, so we
                    emailed you a sign-in link instead. Opening the link brings you straight
                    back to this form, signed in and ready to continue. If you opened it in
                    another tab or window, press Continue below to pick up here.
                  </p>
                  {devLink && (
                    <p className="sb-devlink">
                      Demo login: <a href={devLink}>use your sign-in link</a>
                    </p>
                  )}
                  <div className="sb-nav" style={{ justifyContent: 'flex-start', gap: '.75rem' }}>
                    <button
                      type="button"
                      className="sb-button sb-primary"
                      onClick={() => window.location.assign(data.base_path)}
                    >
                      I clicked the link — continue
                    </button>
                    <button type="button" className="sb-button" onClick={() => setLoginState('idle')}>
                      Use a different email
                    </button>
                  </div>
                </>
              ) : loginState === 'created' ? (
                <p className="sb-muted">Setting up your account…</p>
              ) : (
                <button
                  className="sb-button sb-primary"
                  disabled={loginState === 'sending' || !loginEmail.trim()}
                  onClick={() => void requestLogin()}
                >
                  {loginState === 'sending' ? 'Continuing…' : 'Continue'}
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
                onBlur={() => {
                  if (q.type !== 'email' && q.type !== 'url') return
                  const msg = liveShapeError(q, answers[q.id])
                  setErrors((prev) => {
                    if (msg) return { ...prev, [q.id]: msg }
                    if (!(q.id in prev)) return prev
                    const { [q.id]: _dropped, ...rest } = prev
                    return rest
                  })
                }}
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
              errors={participantErrors[i] ?? {}}
              lockPrimaryEmail={i === 0}
              onAnswerChange={(qid, v) =>
                setParticipants((prev) =>
                  prev.map((old, j) => (j === i ? { ...old, answers: { ...old.answers, [qid]: v } } : old)),
                )
              }
              onAnswerBlur={(qid) => {
                const q = participantQuestions.find((qq) => qq.id === qid)
                if (!q) return
                const msg = liveShapeError(q, participants[i]?.answers[qid])
                setParticipantErrors((prev) => {
                  const current = { ...(prev[i] ?? {}) }
                  if (msg) current[qid] = msg
                  else delete current[qid]
                  const next = [...prev]
                  next[i] = current
                  return next
                })
              }}
              onRoleChange={(role) =>
                setParticipants((prev) => prev.map((old, j) => (j === i ? { ...old, role } : old)))
              }
              onRemove={
                i === 0 ? undefined : () => setParticipants((prev) => prev.filter((_, j) => j !== i))
              }
            />
          ))}
          {participants.length >= MAX_PARTICIPANTS_PER_SUBMISSION ? (
            <p className="sb-muted">
              Maximum of {MAX_PARTICIPANTS_PER_SUBMISSION} participants per submission.
            </p>
          ) : (
            <button
              type="button"
              className="sb-button"
              onClick={() =>
                setParticipants((prev) =>
                  prev.length >= MAX_PARTICIPANTS_PER_SUBMISSION
                    ? prev
                    : [...prev, { role: roleConfigs[0]?.role ?? 'speaker', is_primary_contact: false, answers: {} }],
                )
              }
            >
              + Add participant
            </button>
          )}
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
                  <dd>{formatAnswer(q, answers[q.id])}</dd>
                </div>
              ))}
          </dl>
          {form.collect_participants && (
            <>
              <h3 className="sb-review-h">
                Participants <button className="sb-link" onClick={() => setStep('participant')}>Edit</button>
              </h3>
              <dl className="sb-review">
                {participants.map((p, i) => {
                  const identity = participantIdentity(participantQuestions, p.answers)
                  return (
                    <div key={i}>
                      <dt>{p.role}</dt>
                      <dd>{[identity.name, identity.email].filter(Boolean).join(' · ') || '—'}</dd>
                    </div>
                  )
                })}
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

function Wizard({
  title,
  eventName,
  children,
}: {
  title: string
  eventName?: string
  children: React.ReactNode
}) {
  // CFP defect: a fresh form defaults external_title to its internal name, so
  // the H1 alone often gives no clue which event the page belongs to (the
  // event name only ever showed up in the <title>, submit.tsx). An eyebrow
  // above the H1 makes it visible on the page itself — shown unconditionally
  // rather than trying to detect when external_title already repeats the
  // event name, since a duplicate line reads as confirmation, not clutter.
  return (
    <main className="sb-main">
      <style dangerouslySetInnerHTML={{ __html: wizardCss }} />
      {eventName && <p className="sb-eyebrow">{eventName}</p>}
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

function formatAnswer(q: QuestionDef, v: AnswerValue): string {
  if (v === undefined || v === null || v === '') return '—'
  // Option-based questions (dropdown/radio/multiselect, including the
  // canonical Track question) store the option's `value` — for Track that's
  // the track id, not its name — so resolve back through `options` to show
  // the label the submitter actually picked, same as the pickers themselves.
  const options = q.options ?? []
  const labelFor = (raw: unknown) => {
    const match = options.find((o) => o.value === raw)
    return match ? match.label : String(raw)
  }
  if (Array.isArray(v)) return options.length > 0 ? v.map(labelFor).join(', ') : v.join(', ')
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (options.length > 0) return labelFor(v)
  return String(v).replace(/<[^>]*>/g, '')
}

export function QuestionInput({
  question: q,
  value,
  error,
  onChange,
  onBlur,
  idPrefix = '',
  disabled = false,
}: {
  question: QuestionDef
  value: AnswerValue
  error?: string
  onChange: (v: AnswerValue) => void
  /** Live shape-check on blur (email/url) — separate from submit-time validateAnswers. */
  onBlur?: () => void
  /** Distinguishes ids across repeated instances (e.g. per-participant cards). */
  idPrefix?: string
  disabled?: boolean
}) {
  if (q.type === 'heading') {
    return <h3 className="sb-heading">{q.label}</h3>
  }
  const id = `sb-q-${idPrefix}${q.id}`
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
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.value)}
          onBlur={onBlur}
        />
      )
      break
    case 'dropdown':
      control = (
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
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
                disabled={disabled}
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
                  disabled={disabled}
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
          <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
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
          disabled={disabled}
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
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )
      break
    case 'file':
      control = <p className="sb-muted">Uploads are completed later in your speaker portal.</p>
      break
    default:
      control = (
        <input
          id={id}
          type={q.type === 'email' ? 'email' : q.type === 'url' ? 'url' : q.type === 'phone' ? 'tel' : 'text'}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.value)}
          onBlur={q.type === 'email' || q.type === 'url' ? onBlur : undefined}
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

function ParticipantCard({
  index,
  participant,
  questions,
  roles,
  errors,
  lockPrimaryEmail,
  onAnswerChange,
  onAnswerBlur,
  onRoleChange,
  onRemove,
}: {
  index: number
  participant: ParticipantDraft
  questions: QuestionDef[]
  roles: ParticipantRoleConfig[]
  errors: Record<string, string>
  lockPrimaryEmail: boolean
  onAnswerChange: (questionId: string, value: AnswerValue) => void
  onAnswerBlur: (questionId: string) => void
  onRoleChange: (role: string) => void
  onRemove?: () => void
}) {
  const visible = visibleQuestionIds(questions, participant.answers)
  const identity = participantIdentity(questions, participant.answers)
  const title = identity.name || identity.email || `Participant ${index + 1}`

  return (
    <div className="sb-card">
      <div className="sb-card-head">
        <strong>{title}{index === 0 ? ' — primary contact' : ''}</strong>
        <span className="sb-card-tools">
          <select value={participant.role} onChange={(e) => onRoleChange(e.currentTarget.value)} aria-label={`Role for ${title}`}>
            {roles.map((r) => (
              <option key={r.role} value={r.role}>{readableRole(r.role)}</option>
            ))}
          </select>
          {onRemove && <button type="button" className="sb-link" onClick={onRemove}>Remove</button>}
        </span>
      </div>
      {questions
        .filter((q) => visible.has(q.id))
        .map((q) => (
          <QuestionInput
            key={q.id}
            idPrefix={`p${index}-`}
            question={q}
            value={participant.answers[q.id]}
            error={errors[q.id]}
            disabled={lockPrimaryEmail && q.field_key === 'email'}
            onChange={(v) => onAnswerChange(q.id, v)}
            onBlur={() => onAnswerBlur(q.id)}
          />
        ))}
    </div>
  )
}

const wizardCss = `
.sb-main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
.sb-eyebrow { margin: 0 0 .35rem; font-size: .8rem; font-weight: 600; letter-spacing: .03em;
  text-transform: uppercase; color: var(--text-muted); }
.sb-banner { border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius);
  padding: .6rem .9rem; font-size: .9rem; margin: 0 0 1.25rem; }
.sb-stepper { display: flex; flex-wrap: wrap; gap: .25rem 1rem; list-style: none; padding: 0;
  margin: 0 0 1.5rem; font-size: .85rem; color: var(--text-muted); }
.sb-stepper li { display: flex; align-items: center; gap: .4rem; }
.sb-step-btn { display: flex; align-items: center; gap: .4rem; font: inherit; color: inherit;
  background: none; border: 0; padding: 0; cursor: default; }
.sb-stepper li.done .sb-step-btn { cursor: pointer; }
.sb-stepper li.active .sb-step-btn { color: var(--text); font-weight: 600; }
.sb-step-btn:disabled { cursor: default; }
.sb-step-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--radius); }
.sb-step-n { display: inline-flex; align-items: center; justify-content: center; width: 1.4rem;
  height: 1.4rem; border-radius: 50%; border: 1px solid var(--border); font-size: .75rem; }
.sb-stepper li.active .sb-step-n { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); }
.sb-stepper li.done .sb-step-n { border-color: var(--accent); color: var(--accent); }
.sb-field { margin: 0 0 1rem; }
.sb-field label { display: flex; align-items: baseline; gap: .35rem; font-weight: 600;
  font-size: .9rem; margin-bottom: .3rem; }
.sb-field input[type=text], .sb-field input[type=email], .sb-field input[type=url],
.sb-field input[type=tel], .sb-field input[type=number], .sb-field input[type=date],
.sb-field input[type=datetime-local], .sb-field textarea, .sb-field select {
  width: 100%; padding: .5rem .65rem; border: 1px solid var(--border); border-radius: var(--radius);
  font: inherit; background: var(--surface); color: var(--text); }
.sb-field.has-error input, .sb-field.has-error textarea, .sb-field.has-error select { border-color: var(--danger); }
.sb-field-error { color: var(--danger-strong); font-size: .82rem; margin: .3rem 0 0; }
.sb-req { color: var(--danger-strong); }
.sb-help { font-size: .82rem; color: var(--text-muted); margin: -.1rem 0 .35rem; }
.sb-counter { margin-left: auto; font-weight: 400; font-size: .78rem; color: var(--text-muted); }
.sb-counter.over { color: var(--danger-strong); font-weight: 600; }
.sb-choices { display: flex; flex-direction: column; gap: .35rem; }
.sb-choices label, .sb-check { display: flex; gap: .5rem; align-items: center; font-size: .95rem; }
.sb-nav { display: flex; justify-content: space-between; margin-top: 1.75rem; }
.sb-button { font: inherit; padding: .5rem 1.1rem; border-radius: var(--radius); border: 1px solid var(--border);
  background: transparent; color: var(--text); cursor: pointer; }
.sb-button.sb-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); }
.sb-button:disabled { opacity: .55; cursor: default; }
.sb-link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer;
  font: inherit; font-size: .85rem; text-decoration: underline; }
.sb-error { border: 1px solid var(--danger-border); background: var(--danger-soft);
  color: var(--danger-strong); border-radius: var(--radius); padding: .6rem .9rem; font-size: .9rem; margin: 0 0 1rem; }
.sb-devlink { border: 1px dashed var(--border); border-radius: var(--radius); padding: .5rem .8rem; font-size: .85rem; }
.sb-muted { color: var(--text-muted); }
.sb-saved { font-size: .8rem; }
.sb-card { border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem 1.1rem; margin: 0 0 1rem; }
/* W3/D7: the revise-and-resubmit panel — an invitation, so it reads as an
   accent card rather than a warning. */
.sb-revise-invite { border-color: var(--accent); }
.sb-revise-item + .sb-revise-item { border-top: 1px solid var(--border); padding-top: .75rem; margin-top: .75rem; }
.sb-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: .75rem; }
.sb-card-tools { display: flex; gap: .75rem; align-items: center; }
.sb-card-tools select { font: inherit; font-size: .85rem; padding: .25rem .4rem; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--surface); color: var(--text); }
.sb-review { margin: 0 0 1.5rem; }
.sb-review > div { display: grid; grid-template-columns: 11rem 1fr; gap: .75rem; padding: .45rem 0;
  border-bottom: 1px solid var(--border); font-size: .92rem; }
.sb-review dt { color: var(--text-muted); }
.sb-review dd { margin: 0; overflow-wrap: anywhere; }
.sb-review-h { display: flex; gap: .75rem; align-items: baseline; font-size: 1.05rem; margin: 1.25rem 0 .5rem; }
.sb-rich h1, .sb-rich h2, .sb-rich h3 { line-height: 1.25; margin: 1.1rem 0 .45rem; }
.sb-rich p, .sb-rich ul, .sb-rich ol { margin: 0 0 .8rem; }
.sb-rich img { max-width: 100%; }
.sb-success-head { margin-top: 0; }

/* Compact (640): phone layout, appended so the desktop rules above stand.
   .sb-main is needed alongside Page's element-level main rule — it wins
   on specificity, so both files need the change. */
@media (max-width: 640px) {
  .sb-main { padding: 1.5rem 1rem 3rem; }
  .sb-stepper { position: sticky; top: 0; z-index: 2; background: var(--bg);
    padding: .5rem 0; margin: 0 0 1rem; }
  .sb-choices label, .sb-check { min-height: 36px; }
  .sb-nav { gap: .75rem; }
  .sb-button { min-height: 44px; }
  .sb-review > div { grid-template-columns: 1fr; gap: .15rem; }
}
`

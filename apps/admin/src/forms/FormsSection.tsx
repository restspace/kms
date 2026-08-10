import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createForm,
  deleteForm,
  duplicateForm,
  listForms,
  updateForm,
  type FormRow,
} from '../api'
import { appConfirm } from '../components/dialogs'
import { fmtDateInTz } from '../utils/dates'
import { FormBuilder } from './FormBuilder'
import { EFFECTIVE_STATUS_LABEL, effectiveFormStatus } from './formStatus'
import './forms.css'

/**
 * Forms section (docs/04 §1): the forms list with counts and row actions,
 * opening into the 6-step builder wizard.
 */

/**
 * `routeFormId`/`routeStep` come from the URL (router.ts `form`/`fstep`): the
 * open form is addressable, and opening/closing one reports back through
 * `onOpenForm` so Back closes the builder.
 */
export function FormsSection({
  eventSlug,
  timezone,
  routeFormId,
  routeStep,
  onOpenForm,
  onStepChange,
}: {
  eventSlug: string
  timezone: string
  routeFormId?: string | null
  routeStep?: string | null
  onOpenForm?: (formId: string | null) => void
  onStepChange?: (step: string) => void
}) {
  const [forms, setForms] = useState<FormRow[] | null>(null)
  const [localFormId, setLocalFormId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The route wins when the host wires it up; otherwise fall back to local
  // state so the section still works standalone (tests, storybook-style use).
  const openFormId = onOpenForm ? (routeFormId ?? null) : localFormId
  const setOpenFormId = (id: string | null) => {
    setLocalFormId(id)
    onOpenForm?.(id)
  }

  // Every row action ends in `reload()`, and those refetches are not ordered
  // by the network. CFP defect ("closing a form appears to succeed but reverts
  // to Open"): two row actions in quick succession start two list GETs, and
  // whichever *responds* last wins — so an older response, taken before the
  // write landed, repaints the list with the pre-close status and the closure
  // looks like it was rolled back even though the server has it. Stamp each
  // refetch and drop any response that is not the newest one.
  const reloadSeqRef = useRef(0)
  const reload = useCallback(() => {
    const seq = (reloadSeqRef.current += 1)
    listForms()
      .then((r) => {
        if (seq !== reloadSeqRef.current) return
        setForms(r.items)
      })
      .catch((e: unknown) => {
        if (seq !== reloadSeqRef.current) return
        setError(e instanceof Error ? e.message : 'Failed to load forms')
      })
  }, [])

  // The Close/Reopen control is a single button whose label and action flip in
  // place. While its PUT and the follow-up refetch are in flight the row still
  // shows the pre-write label, so a second click — a double click, or an agent
  // re-using a element handle from before the re-render — silently toggles the
  // form straight back. Disable the button for the row being written.
  // Held in a ref as well as state: state updates are async, so two clicks in
  // the same tick would both pass a state-only check.
  const statusBusyRef = useRef<string | null>(null)
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null)

  useEffect(reload, [reload])

  if (openFormId) {
    return (
      <FormBuilder
        key={openFormId}
        formId={openFormId}
        eventSlug={eventSlug}
        timezone={timezone}
        initialStep={routeStep}
        onStepChange={onStepChange}
        onClose={() => {
          setOpenFormId(null)
          reload()
        }}
      />
    )
  }

  return (
    <div className="forms-section">
      <div className="forms-header">
        <h1>
          Submission Forms{' '}
          <span className="forms-sub">Collect abstract, session and participant information</span>
        </h1>
        <button
          className="fbtn primary"
          onClick={() => {
            void createForm({ internal_name: 'Untitled form', idempotency_key: crypto.randomUUID() }).then((r) => {
              setOpenFormId(r.form.id)
            })
          }}
        >
          + Create Form
        </button>
      </div>
      <div className="forms-scroll">
        {error && <div className="builder-error">{error}</div>}
        {forms === null ? (
          <p className="pane-sub">Loading…</p>
        ) : forms.length === 0 ? (
          <p className="pane-sub">No forms yet — create one to open your call for speakers.</p>
        ) : (
          <div className="forms-list">
            {forms.map((f) => {
              const effStatus = effectiveFormStatus(f)
              const closed = effStatus !== 'open'
              return (
              <div key={f.id} className="form-card" onClick={() => setOpenFormId(f.id)}>
                <div className="form-count">{f.submission_count ?? 0}</div>
                <div className="form-card-main">
                  <div className="form-card-name">
                    {f.internal_name}{' '}
                    <span className={`form-chip ${closed ? 'closed' : 'open'}`} title={
                      effStatus === 'closed-by-date'
                        ? 'Status is set to Open, but the close date has passed — the public form treats it as closed.'
                        : undefined
                    }>
                      {EFFECTIVE_STATUS_LABEL[effStatus]}
                    </span>{' '}
                    <span className="form-chip kind">
                      {f.collection_type === 'abstracts' ? 'Abstracts' : 'Sessions'}
                      {f.collect_participants === 1 ? ' & Participants' : ''}
                    </span>
                  </div>
                  <div className="form-card-meta">
                    {f.submission_count ?? 0} submissions · {f.draft_count ?? 0} drafts
                    {f.close_at ? ` · Closes ${fmtDateInTz(f.close_at, timezone)}` : ''} · Created {fmtDateInTz(f.created_at, timezone)}
                  </div>
                </div>
                <div className="form-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="fbtn"
                    onClick={() => window.open(`/submit/${eventSlug}/${f.id}`, '_blank')}
                  >
                    View
                  </button>
                  <button
                    className="fbtn"
                    onClick={() => {
                      void navigator.clipboard.writeText(`${window.location.origin}/submit/${eventSlug}/${f.id}`)
                    }}
                  >
                    Copy link
                  </button>
                  <button
                    className="fbtn"
                    onClick={() => void duplicateForm(f.id).then(reload)}
                  >
                    Duplicate
                  </button>
                  <button
                    className="fbtn"
                    disabled={statusBusyId === f.id}
                    aria-busy={statusBusyId === f.id}
                    onClick={() => {
                      if (statusBusyRef.current !== null) return
                      statusBusyRef.current = f.id
                      setStatusBusyId(f.id)
                      // Reopen is keyed off *effective* status (docs/04 defect: a form
                      // whose status column is still 'open' but whose close_at has
                      // elapsed reads as "Closed" to the public — the button must
                      // reflect that, and must always send close_at:null explicitly
                      // rather than relying on a literal closed->open transition on
                      // the server, so a single click reopens no matter which side of
                      // the status/close_at duality caused the closure.
                      void updateForm(f.id, closed ? { status: 'open', close_at: null } : { status: 'closed' })
                        .then(
                          // Trust the row the write returned rather than only a
                          // follow-up list GET: the PUT's own response is the
                          // authoritative post-write state, so the chip is
                          // correct even if the refetch is slow or superseded.
                          (r) => {
                            setForms((prev) =>
                              prev === null ? prev : prev.map((row) => (row.id === f.id ? { ...row, ...r.form } : row)),
                            )
                          },
                          (e: unknown) => setError(e instanceof Error ? e.message : 'Could not change the form status'),
                        )
                        .finally(() => {
                          statusBusyRef.current = null
                          setStatusBusyId((current) => (current === f.id ? null : current))
                          reload()
                        })
                    }}
                  >
                    {statusBusyId === f.id ? '…' : closed ? 'Reopen' : 'Close'}
                  </button>
                  <button
                    className="fbtn danger"
                    onClick={() => {
                      void appConfirm(`Delete "${f.internal_name}"? Its submissions are kept.`, {
                        title: 'Delete form',
                        confirmLabel: 'Delete',
                        danger: true,
                      }).then((confirmed) => {
                        if (confirmed) void deleteForm(f.id).then(reload)
                      })
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

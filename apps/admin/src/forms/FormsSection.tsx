import { useCallback, useEffect, useState } from 'react'
import {
  createForm,
  deleteForm,
  duplicateForm,
  listForms,
  updateForm,
  type FormRow,
} from '../api'
import { FormBuilder } from './FormBuilder'
import './forms.css'

/**
 * Forms section (docs/04 §1): the forms list with counts and row actions,
 * opening into the 6-step builder wizard.
 */

const fmtDate = (iso: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function FormsSection({ eventSlug }: { eventSlug: string }) {
  const [forms, setForms] = useState<FormRow[] | null>(null)
  const [openFormId, setOpenFormId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    listForms()
      .then((r) => setForms(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load forms'))
  }, [])

  useEffect(reload, [reload])

  if (openFormId) {
    return (
      <FormBuilder
        formId={openFormId}
        eventSlug={eventSlug}
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
            void createForm({ internal_name: 'Untitled form' }).then((r) => {
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
            {forms.map((f) => (
              <div key={f.id} className="form-card" onClick={() => setOpenFormId(f.id)}>
                <div className="form-count">{f.submission_count ?? 0}</div>
                <div className="form-card-main">
                  <div className="form-card-name">
                    {f.internal_name}{' '}
                    <span className={`form-chip ${f.status}`}>{f.status === 'open' ? 'Open' : 'Closed'}</span>{' '}
                    <span className="form-chip kind">
                      {f.collection_type === 'abstracts' ? 'Abstracts' : 'Sessions'}
                      {f.collect_participants === 1 ? ' & Participants' : ''}
                    </span>
                  </div>
                  <div className="form-card-meta">
                    {f.submission_count ?? 0} submissions · {f.draft_count ?? 0} drafts
                    {f.close_at ? ` · Closes ${fmtDate(f.close_at)}` : ''} · Created {fmtDate(f.created_at)}
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
                    onClick={() =>
                      void updateForm(f.id, { status: f.status === 'open' ? 'closed' : 'open' }).then(reload)
                    }
                  >
                    {f.status === 'open' ? 'Close' : 'Reopen'}
                  </button>
                  <button
                    className="fbtn danger"
                    onClick={() => {
                      if (window.confirm(`Delete "${f.internal_name}"? Its submissions are kept.`)) {
                        void deleteForm(f.id).then(reload)
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

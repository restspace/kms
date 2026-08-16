import { useEffect, useState } from 'react'
import { getBuilderMeta, listForms, updateForm, type FormRow } from '../api'

/**
 * Admin-alert recipient picker (the gap FormBuilder's Notifications step
 * flagged as "arrives with M2" — docs/08). `notify_admins_on_create` /
 * `notify_admins_on_update` already drive submit.tsx's
 * submission_received_admin / submission_updated_admin sends; this is the
 * first UI that can set them, so it lives in Settings rather than per-form
 * in the builder — recipients are staff picking, not form design.
 */

const staffName = (s: { name: string | null; email: string }) => s.name ?? s.email

export function SubmissionNotificationsCard() {
  const [forms, setForms] = useState<FormRow[] | null>(null)
  const [staff, setStaff] = useState<Array<{ id: string; email: string; name: string | null }>>([])
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ on_create: string[]; on_update: string[] } | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const reload = () => {
    setError(null)
    return Promise.all([listForms(), getBuilderMeta()])
      .then(([f, meta]) => {
        setForms(f.items)
        setStaff(meta.staff)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load forms'))
  }

  useEffect(() => {
    void reload()
  }, [])

  const open = (f: FormRow) => {
    setNote(null)
    if (openId === f.id) {
      setOpenId(null)
      setDraft(null)
      return
    }
    setOpenId(f.id)
    setDraft({ on_create: f.notify_admins_on_create ?? [], on_update: f.notify_admins_on_update ?? [] })
  }

  const toggle = (list: 'on_create' | 'on_update', id: string) => {
    if (!draft) return
    const current = draft[list]
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    setDraft({ ...draft, [list]: next })
  }

  const save = async (f: FormRow) => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      await updateForm(f.id, {
        notify_admins_on_create: draft.on_create,
        notify_admins_on_update: draft.on_update,
      })
      await reload()
      setNote(`Notification recipients saved for "${f.internal_name}".`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save recipients.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-card">
      <h2>Submission notifications</h2>
      <p className="settings-hint">
        Who gets emailed when a form receives a new or edited submission. Only event staff (owners, admins and
        reviewers) can be picked — add them under the event's team page first if someone you want is missing.
        Wording for these emails is edited under <strong>Email templates</strong> above (
        <code>submission_received_admin</code> / <code>submission_updated_admin</code>).
      </p>

      {note && <div className="settings-hint" role="status">{note}</div>}

      {error && forms === null ? (
        <div className="settings-error">
          {error}{' '}
          <button type="button" className="settings-ghost" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      ) : forms === null ? (
        <div className="settings-hint">Loading…</div>
      ) : forms.length === 0 ? (
        <div className="settings-empty">No forms yet.</div>
      ) : (
        <>
          {error && <div className="settings-error">{error}</div>}
          <table className="settings-table">
            <thead>
              <tr>
                <th>Form</th>
                <th>New submissions</th>
                <th>Updated submissions</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <FormRowFragment
                  key={f.id}
                  form={f}
                  staff={staff}
                  isOpen={openId === f.id}
                  draft={openId === f.id ? draft : null}
                  saving={saving}
                  onOpen={() => open(f)}
                  onToggle={toggle}
                  onSave={() => void save(f)}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

function FormRowFragment({
  form,
  staff,
  isOpen,
  draft,
  saving,
  onOpen,
  onToggle,
  onSave,
}: {
  form: FormRow
  staff: Array<{ id: string; email: string; name: string | null }>
  isOpen: boolean
  draft: { on_create: string[]; on_update: string[] } | null
  saving: boolean
  onOpen: () => void
  onToggle: (list: 'on_create' | 'on_update', id: string) => void
  onSave: () => void
}) {
  const countOf = (ids: string[] | null) => (ids?.length ? `${ids.length} recipient${ids.length === 1 ? '' : 's'}` : 'None')
  return (
    <>
      <tr>
        <td>{form.internal_name}</td>
        <td>{countOf(form.notify_admins_on_create)}</td>
        <td>{countOf(form.notify_admins_on_update)}</td>
        <td>
          <button className="settings-ghost" onClick={onOpen}>
            {isOpen ? 'Close' : 'Edit'}
          </button>
        </td>
      </tr>
      {isOpen && draft && (
        <tr>
          <td colSpan={4}>
            {staff.length === 0 ? (
              <p className="settings-hint">
                No staff with an owner, admin or reviewer role on this event yet — nobody can be picked.
              </p>
            ) : (
              <div className="settings-recipient-editor">
                <div className="settings-recipient-group">
                  <span>Notify on new submission</span>
                  {staff.map((s) => (
                    <label key={s.id} className="settings-recipient-checkbox">
                      <input
                        type="checkbox"
                        checked={draft.on_create.includes(s.id)}
                        onChange={() => onToggle('on_create', s.id)}
                      />
                      {staffName(s)}
                    </label>
                  ))}
                </div>
                <div className="settings-recipient-group">
                  <span>Notify on submission updated</span>
                  {staff.map((s) => (
                    <label key={s.id} className="settings-recipient-checkbox">
                      <input
                        type="checkbox"
                        checked={draft.on_update.includes(s.id)}
                        onChange={() => onToggle('on_update', s.id)}
                      />
                      {staffName(s)}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="settings-template-actions">
              <button disabled={saving} onClick={onSave}>
                {saving ? 'Saving…' : 'Save recipients'}
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

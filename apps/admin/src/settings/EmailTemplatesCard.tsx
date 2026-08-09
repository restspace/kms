import { Fragment, useEffect, useState } from 'react'
import { listEmailTemplates, updateEmailTemplate, type EmailTemplateRow, type MergeField } from '../api'

/**
 * Email templates (SPK-14). Every system email has shipped with a code
 * default and an optional per-event `email_templates` override since docs/08
 * — but the override had no UI, so rewording "Congratulations, your talk was
 * accepted" meant hand-writing SQL against D1.
 *
 * Deliberately minimal, and *not* a template editor in the marketing sense:
 * one row per shipped template key, expandable into a subject/body pair that
 * starts pre-filled with the code default. Saving stores the override for
 * this event; "Reset" clears it and the code default takes over again (the
 * server treats empty as absent, so the two are the same operation).
 *
 * Follows RoomsTracksCard/ContactFieldsCard: scoped to the session's current
 * event, no draft state beyond the open row. Unlike those, edits are not
 * saved on blur — a half-typed email body is a much worse thing to persist
 * than a half-typed room name, so each row has an explicit Save.
 */

interface Draft {
  subject: string
  body: string
}

const asDraft = (t: EmailTemplateRow): Draft => ({
  subject: t.subject ?? t.default_subject ?? '',
  body: t.body_richtext ?? t.default_body ?? '',
})

const titleCase = (key: string): string =>
  key.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase())

export function EmailTemplatesCard() {
  const [templates, setTemplates] = useState<EmailTemplateRow[] | null>(null)
  const [mergeFields, setMergeFields] = useState<MergeField[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const reload = () =>
    listEmailTemplates()
      .then((r) => {
        setTemplates(r.items)
        setMergeFields(r.merge_fields)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load templates'))

  useEffect(() => {
    void reload()
  }, [])

  const open = (t: EmailTemplateRow) => {
    setNote(null)
    if (openKey === t.key) {
      setOpenKey(null)
      setDraft(null)
      return
    }
    setOpenKey(t.key)
    setDraft(asDraft(t))
  }

  const save = async (t: EmailTemplateRow) => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      await updateEmailTemplate(t.key, { subject: draft.subject, body_richtext: draft.body })
      await reload()
      setNote(`“${titleCase(t.key)}” saved for this event.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the template.')
    } finally {
      setSaving(false)
    }
  }

  const reset = async (t: EmailTemplateRow) => {
    setSaving(true)
    setError(null)
    try {
      await updateEmailTemplate(t.key, { subject: null, body_richtext: null })
      await reload()
      setDraft({ subject: t.default_subject ?? '', body: t.default_body ?? '' })
      setNote(`“${titleCase(t.key)}” restored to the built-in wording.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset the template.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-card">
      <h2>Email templates</h2>
      <p className="settings-hint">
        Wording for the emails this event sends. Each one has a built-in default; saving here stores an override
        for <strong>this event only</strong>. Bodies are HTML fragments — the event theme supplies the wrapper.
      </p>
      <p className="settings-hint">
        Merge fields available to every template:{' '}
        {mergeFields.map((f, i) => (
          <span key={f.field}>
            {i > 0 && ', '}
            <code title={f.description}>{`{{${f.field}}}`}</code>
          </span>
        ))}
        . Individual templates also carry their own — <code>{'{{submission.title}}'}</code>,{' '}
        <code>{'{{task.title}}'}</code>, <code>{'{{magic_link}}'}</code> and so on; the built-in default for each
        template is the reference for what it can use. Unknown fields render as empty text.
      </p>

      {error && <div className="settings-error">{error}</div>}
      {note && <div className="settings-hint" role="status">{note}</div>}

      {templates === null ? (
        <div className="settings-hint">Loading…</div>
      ) : (
        <table className="settings-table">
          <thead>
            <tr>
              <th>Template</th>
              <th>Subject</th>
              <th>Source</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <Fragment key={t.key}>
                <tr>
                  <td><code>{t.key}</code></td>
                  <td>{t.subject ?? t.default_subject ?? '—'}</td>
                  <td>
                    {t.overridden ? (
                      <span className="settings-revoked-chip">customised</span>
                    ) : (
                      <span className="settings-hint">default</span>
                    )}
                  </td>
                  <td>
                    <button className="settings-ghost" onClick={() => open(t)}>
                      {openKey === t.key ? 'Close' : 'Edit'}
                    </button>
                  </td>
                </tr>
                {openKey === t.key && draft && (
                  <tr>
                    <td colSpan={4}>
                      <div className="settings-template-editor">
                        <label htmlFor={`tpl-subject-${t.key}`}>Subject</label>
                        <input
                          id={`tpl-subject-${t.key}`}
                          type="text"
                          value={draft.subject}
                          onChange={(e) => setDraft({ ...draft, subject: (e.target as HTMLInputElement).value })}
                        />
                        <label htmlFor={`tpl-body-${t.key}`}>Body</label>
                        <textarea
                          id={`tpl-body-${t.key}`}
                          rows={10}
                          value={draft.body}
                          onChange={(e) => setDraft({ ...draft, body: (e.target as HTMLTextAreaElement).value })}
                        />
                        <div className="settings-template-actions">
                          <button disabled={saving} onClick={() => void save(t)}>
                            {saving ? 'Saving…' : 'Save override'}
                          </button>
                          <button className="settings-ghost" disabled={saving || !t.overridden} onClick={() => void reset(t)}>
                            Reset to default
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

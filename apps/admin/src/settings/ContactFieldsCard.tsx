import { useEffect, useState } from 'react'
import {
  createContactField,
  deleteContactField,
  listContactFields,
  reorderContactFields,
  updateContactField,
  type ContactFieldDef,
} from '../api'
import { appConfirm } from '../components/dialogs'
import '../components/RoomsTracksFields.css'

/**
 * Speaker fields (SPK-15): the settings-side editor for per-event custom
 * fields on contact/speaker records — the fixed field set (name, email,
 * company, job title, mobile, pronouns, biography, notes) had no way to grow.
 * Follows RoomsTracksCard's pattern: each row edit is an immediate API call
 * against the current event, not a draft that needs a Save button, so a
 * freshly added field shows up on the Speakers record form the moment the
 * organiser switches tabs there.
 *
 * `key` is server-derived from the label at creation time and never exposed
 * for editing — renaming a field only changes its `label`, its identity
 * (and any values already recorded under it) survive.
 */

interface FieldDraft {
  id: string
  label: string
  type: ContactFieldDef['type']
  /** Comma-separated draft text for `type === 'select'`; parsed on blur. */
  optionsText: string
}

const TYPE_LABELS: Record<ContactFieldDef['type'], string> = {
  text: 'Text',
  select: 'Select',
  multiline: 'Multiline',
}

const parseOptions = (json: string | null): string[] => {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

const asDraft = (f: ContactFieldDef): FieldDraft => ({
  id: f.id,
  label: f.label,
  type: f.type,
  optionsText: parseOptions(f.options).join(', '),
})

export function ContactFieldsCard() {
  const [fields, setFields] = useState<FieldDraft[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const reload = () => {
    setError(null)
    return listContactFields()
      .then((r) => setFields(r.items.map(asDraft)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load speaker fields'))
  }

  useEffect(() => {
    reload()
    // Intentionally once on mount — every subsequent change already updates local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAdd = async () => {
    try {
      const n = (fields?.length ?? 0) + 1
      const created = await createContactField({ label: `New field ${n}`, type: 'text' })
      setFields((cur) => [...(cur ?? []), asDraft(created)])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add the field.')
    }
  }

  const handleLabelBlur = async (row: FieldDraft) => {
    const label = row.label.trim()
    if (!label) {
      // Empty labels are rejected server-side; reload discards the edit
      // rather than leaving the row in a state the server never accepted.
      reload()
      return
    }
    setSaving(row.id)
    try {
      await updateContactField(row.id, { label })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename the field.')
    } finally {
      setSaving(null)
    }
  }

  const handleTypeChange = async (row: FieldDraft, type: ContactFieldDef['type']) => {
    setFields((cur) => (cur ?? []).map((f) => (f.id === row.id ? { ...f, type } : f)))
    setSaving(row.id)
    try {
      // Switching away from 'select' drops its options — a text/multiline
      // value that used to be constrained to a pick-list should not silently
      // keep an invisible options list a later switch-back would resurrect
      // with stale choices.
      const body: Record<string, unknown> = { type }
      if (type !== 'select') body.options = null
      await updateContactField(row.id, body)
      if (type !== 'select') setFields((cur) => (cur ?? []).map((f) => (f.id === row.id ? { ...f, optionsText: '' } : f)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change the field type.')
    } finally {
      setSaving(null)
    }
  }

  const handleOptionsBlur = async (row: FieldDraft) => {
    const options = row.optionsText
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
    setSaving(row.id)
    try {
      await updateContactField(row.id, { options })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update the field options.')
    } finally {
      setSaving(null)
    }
  }

  const handleRemove = async (row: FieldDraft) => {
    const confirmed = await appConfirm(
      `Delete "${row.label || 'this field'}"? Any values already recorded on speakers are removed too.`,
      { title: 'Delete speaker field', confirmLabel: 'Delete', danger: true },
    )
    if (!confirmed) return
    try {
      await deleteContactField(row.id)
      setFields((cur) => (cur ?? []).filter((f) => f.id !== row.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete the field.')
    }
  }

  const handleMove = async (index: number, direction: -1 | 1) => {
    const cur = fields ?? []
    const target = index + direction
    if (target < 0 || target >= cur.length) return
    const next = [...cur]
    ;[next[index], next[target]] = [next[target], next[index]]
    setFields(next)
    try {
      await reorderContactFields(next.map((f) => f.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reorder the fields.')
      reload()
    }
  }

  return (
    <section className="settings-card">
      <h2>Speaker fields</h2>
      <p className="settings-hint">
        Custom fields shown on every speaker record for this event — e.g. a &ldquo;Travel preferences&rdquo; select
        or a free-text field. Changes appear on the Speakers tab&rsquo;s create/edit form immediately.
      </p>
      {/*
        * Item 3 fix: `error` used to render alongside `fields === null`'s
        * permanent "Loading…" placeholder — a rejected `listContactFields()`
        * left `fields` at its initial `null` forever (nothing ever calls
        * `setFields` on the error path), so the card showed an error banner
        * that never replaced the spinner text below it, and no way to retry
        * short of a full page reload.
        */}
      {error && fields === null ? (
        <div className="settings-error">
          {error}{' '}
          <button type="button" className="settings-ghost" onClick={() => reload()}>
            Retry
          </button>
        </div>
      ) : fields === null ? (
        <div className="settings-hint">Loading…</div>
      ) : (
        <div className="rt-field">
          {error && <div className="settings-error">{error}</div>}
          {fields.map((row, index) => (
            <div key={row.id} className={saving === row.id ? 'rt-row-saving' : undefined}>
              <div className="rt-row">
                <button
                  type="button"
                  className="rt-row-move"
                  aria-label={`Move "${row.label}" up`}
                  onClick={() => void handleMove(index, -1)}
                  disabled={index === 0}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="rt-row-move"
                  aria-label={`Move "${row.label}" down`}
                  onClick={() => void handleMove(index, 1)}
                  disabled={index === fields.length - 1}
                >
                  ↓
                </button>
                <input
                  type="text"
                  className="rt-row-name"
                  placeholder="Field label"
                  aria-label="Field label"
                  value={row.label}
                  onChange={(e) =>
                    setFields((cur) => (cur ?? []).map((f) => (f.id === row.id ? { ...f, label: e.target.value } : f)))
                  }
                  onBlur={() => void handleLabelBlur(row)}
                />
                <select
                  className="rt-row-type"
                  aria-label="Field type"
                  value={row.type}
                  onChange={(e) => void handleTypeChange(row, e.target.value as ContactFieldDef['type'])}
                >
                  {(Object.keys(TYPE_LABELS) as ContactFieldDef['type'][]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
                {row.type === 'select' && (
                  <input
                    type="text"
                    className="rt-row-options"
                    placeholder="Options, comma separated"
                    aria-label="Field options"
                    value={row.optionsText}
                    onChange={(e) =>
                      setFields((cur) => (cur ?? []).map((f) => (f.id === row.id ? { ...f, optionsText: e.target.value } : f)))
                    }
                    onBlur={() => void handleOptionsBlur(row)}
                  />
                )}
                <button type="button" className="rt-row-remove" aria-label="Remove field" onClick={() => void handleRemove(row)}>
                  ×
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="rt-add" onClick={() => void handleAdd()}>
            + Add field
          </button>
        </div>
      )}
    </section>
  )
}

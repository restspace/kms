import { useCallback, useEffect, useRef, useState } from 'react'
import { createTag, deleteTag, getTagUsage, listTags, restoreTag, updateTag, type TagRow } from '../api'
import { appConfirm } from '../components/dialogs'
import { TagRowEditor, type TagDraftRow } from '../components/RoomsTracksFields'
import '../components/RoomsTracksFields.css'

/**
 * Tags: the settings-side editor for the event's label vocabulary. Until this
 * card, nothing in the app could create a tag — the seed and the importer's
 * create-by-name were the only writers, while the form builder's "add tags"
 * routing action and the Submissions tab's tag filter both read a list an
 * organiser had no way to add to.
 *
 * Same discipline as RoomsTracksCard: every edit is a live API call rather
 * than a draft needing a Save button, adding is name-first (nothing is created
 * until a non-empty name is committed, so a stray click leaves no "New tag 3"
 * behind), and delete is undoable — a tag delete takes its links with it, so
 * without an Undo a mis-click loses a hand-built worklist with no way back.
 */

const asDraft = (t: TagRow): TagDraftRow => ({ key: t.id, name: t.name, color: t.color ?? '' })

export function TagsCard() {
  const [tags, setTags] = useState<TagDraftRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [newName, setNewName] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [undo, setUndo] = useState<{ tag: TagRow; submissionIds: string[]; contactIds: string[]; note: string } | null>(
    null,
  )
  const [undoBusy, setUndoBusy] = useState(false)
  const undoTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    },
    [],
  )

  const load = useCallback(() => {
    setError(null)
    listTags()
      .then((r) => setTags(r.items.map(asDraft)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load tags'))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleCommitNew = async () => {
    // Disabling the input while in flight can itself fire a blur; ignore the
    // re-entrant call rather than creating the tag twice (RoomsTracksCard).
    if (adding) return
    const name = (newName ?? '').trim()
    if (!name) {
      setNewName(null)
      return
    }
    setAdding(true)
    try {
      const created = await createTag({ name })
      // Server order is name, case-insensitive — match it here so a new tag
      // lands where a reload would put it rather than at the bottom.
      setTags((cur) =>
        [...(cur ?? []), asDraft(created)].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      )
      setNewName(null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add the tag.')
    } finally {
      setAdding(false)
    }
  }

  const handleNameBlur = async (row: TagDraftRow) => {
    const name = row.name.trim()
    if (!name) {
      // An empty name is refused server-side; reload rather than leave the row
      // showing an edit that was never stored.
      load()
      return
    }
    setSaving(row.key)
    try {
      await updateTag(row.key, { name })
      setError(null)
    } catch (e) {
      // A duplicate name is the common case here (name_exists), and the row
      // still shows the rejected text — reload puts the stored name back.
      // The reload goes FIRST: load() clears the error banner synchronously as
      // it starts, so setting the message before it would wipe the message.
      load()
      setError(e instanceof Error ? e.message : 'Failed to rename the tag.')
    } finally {
      setSaving(null)
    }
  }

  const handleColorBlur = async (row: TagDraftRow) => {
    setSaving(row.key)
    try {
      await updateTag(row.key, { color: row.color || null })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update the tag colour.')
    } finally {
      setSaving(null)
    }
  }

  const handleRemove = async (row: TagDraftRow) => {
    // Name the blast radius before asking: a tag on nothing and a tag on forty
    // submissions are very different deletes.
    let usage: { submission_count: number; contact_count: number } | null = null
    try {
      usage = await getTagUsage(row.key)
    } catch {
      // Advisory only — an unreachable usage endpoint must not make the tag
      // undeletable; the confirm falls back to generic wording.
    }
    const impact =
      usage === null
        ? 'Anything carrying it keeps its other tags and loses this one.'
        : usage.submission_count === 0 && usage.contact_count === 0
          ? 'Nothing is tagged with it.'
          : `${usage.submission_count} submission${usage.submission_count === 1 ? '' : 's'}` +
            (usage.contact_count > 0
              ? ` and ${usage.contact_count} contact${usage.contact_count === 1 ? '' : 's'}`
              : '') +
            ' will lose it.'
    const confirmed = await appConfirm(`Delete "${row.name || 'this tag'}"? ${impact}`, {
      title: 'Delete tag',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!confirmed) return
    try {
      const res = await deleteTag(row.key)
      setTags((cur) => (cur ?? []).filter((t) => t.key !== row.key))
      const links = res.submission_ids.length + res.contact_ids.length
      setUndo({
        tag: res.tag,
        submissionIds: res.submission_ids,
        contactIds: res.contact_ids,
        note:
          links > 0
            ? `Tag "${res.tag.name}" deleted — removed from ${links} record${links === 1 ? '' : 's'}.`
            : `Tag "${res.tag.name}" deleted.`,
      })
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
      // 15s, like the room delete: this is the only way back, not a courtesy.
      undoTimer.current = window.setTimeout(() => setUndo(null), 15000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete the tag.')
    }
  }

  const handleUndo = async () => {
    if (!undo || undoBusy) return
    setUndoBusy(true)
    try {
      await restoreTag(undo.tag, undo.submissionIds, undo.contactIds)
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
      setUndo(null)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to restore the tag.')
    } finally {
      setUndoBusy(false)
    }
  }

  return (
    <section className="settings-card">
      <h2>Tags</h2>
      <p className="settings-hint">
        Free-form labels that cut across tracks &mdash; &ldquo;keynote material&rdquo;, &ldquo;needs AV&rdquo;,
        &ldquo;first-time speaker&rdquo;. Tags added here can be attached to any submission from its detail panel,
        filtered on from the Submissions tab, and applied automatically by a form&rsquo;s routing rules. A submission
        form&rsquo;s Tags question offers this same list; an import creates any tag name it meets that is not here yet.
      </p>

      {undo && (
        <div className="settings-undo-toast" role="status">
          <span>{undo.note}</span>
          <button type="button" disabled={undoBusy} onClick={() => void handleUndo()}>
            {undoBusy ? 'Restoring…' : 'Undo'}
          </button>
          <button type="button" className="settings-ghost" onClick={() => setUndo(null)}>
            Dismiss
          </button>
        </div>
      )}

      {error && tags === null ? (
        <div className="settings-error">
          {error}{' '}
          <button type="button" className="settings-ghost" onClick={() => load()}>
            Retry
          </button>
        </div>
      ) : tags === null ? (
        <div className="settings-hint">Loading…</div>
      ) : (
        <>
          {error && <div className="settings-error">{error}</div>}
          <div className="rt-field settings-tags-field">
            {tags.map((row) => (
              <div key={row.key} className={saving === row.key ? 'rt-row-saving' : undefined}>
                <TagRowEditor
                  row={row}
                  onNameChange={(name) =>
                    setTags((cur) => (cur ?? []).map((t) => (t.key === row.key ? { ...t, name } : t)))
                  }
                  onColorChange={(color) =>
                    setTags((cur) => (cur ?? []).map((t) => (t.key === row.key ? { ...t, color } : t)))
                  }
                  onNameBlur={() => void handleNameBlur(row)}
                  onColorBlur={() => void handleColorBlur(row)}
                  onRemove={() => void handleRemove(row)}
                />
              </div>
            ))}
            {newName !== null ? (
              <input
                type="text"
                className="rt-row-name rt-new-row"
                placeholder="Tag name"
                aria-label="New tag name"
                autoFocus
                value={newName}
                disabled={adding}
                onChange={(e) => setNewName((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleCommitNew()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setNewName(null)
                  }
                }}
                onBlur={() => {
                  if (newName.trim() === '') setNewName(null)
                  else void handleCommitNew()
                }}
              />
            ) : (
              <button type="button" className="rt-add" onClick={() => setNewName('')}>
                + Add tag
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}

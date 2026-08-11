import { useCallback, useEffect, useState } from 'react'
import {
  dismissChaseDraft,
  escalateChaseDraft,
  getChaseDrafts,
  getChaseSettings,
  sendAllChaseDrafts,
  sendChaseDraft,
  updateChaseDraft,
  type ChaseDraftRow,
  type ChaseRung,
} from '../api'
import type { AppNavTarget } from './DashboardSection'

/**
 * Assisted chasing (workplan 13 W4c/W4d). Per D5 the reminder sweep stages
 * drafts instead of sending; this is the human side of that pipeline — a
 * panel on the Speaker Tracking board grouping staged drafts by speaker, and
 * a one-time banner pointing at the 'auto' → 'assisted' setting (D5 keeps
 * 'auto' the default, so most events see the banner until dismissed).
 */

const RUNG_LABELS: Record<ChaseRung, string> = {
  tool_email: 'Tool email',
  personal_email: 'Personal email',
  cc_chair: 'CC chair',
  text: 'Text',
  call: 'Call',
}

export const daysAgo = (iso: string, now = Date.now()): number =>
  Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000))

export interface ChaseDraftGroup {
  contact_id: string
  contact_name: string | null
  contact_email: string | null
  drafts: ChaseDraftRow[]
}

/** Groups while preserving the server's contact-sorted order (no re-sort here). */
export const groupDraftsByContact = (items: ChaseDraftRow[]): ChaseDraftGroup[] => {
  const order: string[] = []
  const groups = new Map<string, ChaseDraftGroup>()
  for (const d of items) {
    let g = groups.get(d.contact_id)
    if (!g) {
      g = { contact_id: d.contact_id, contact_name: d.contact_name, contact_email: d.contact_email, drafts: [] }
      groups.set(d.contact_id, g)
      order.push(d.contact_id)
    }
    g.drafts.push(d)
  }
  return order.map((id) => groups.get(id)!)
}

type DraftEdit = { subject: string; body: string }

export function ChaseInboxPanel() {
  const [drafts, setDrafts] = useState<ChaseDraftRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [edits, setEdits] = useState<Record<string, DraftEdit>>({})
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({})

  const reload = useCallback(() => {
    setError(null)
    return getChaseDrafts({ status: 'staged' })
      .then((r) => setDrafts(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load the chase inbox'))
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const draftFor = (d: ChaseDraftRow): DraftEdit => edits[d.id] ?? { subject: d.subject, body: d.body }
  const setEdit = (id: string, patch: Partial<DraftEdit>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { subject: '', body: '' }), ...patch } }))

  const runRow = async (id: string, fn: () => Promise<void>) => {
    setRowBusy((prev) => ({ ...prev, [id]: true }))
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That action failed.')
    } finally {
      setRowBusy((prev) => ({ ...prev, [id]: false }))
    }
  }

  const save = (d: ChaseDraftRow) =>
    runRow(d.id, async () => {
      const draft = draftFor(d)
      const r = await updateChaseDraft(d.id, { subject: draft.subject, body: draft.body })
      setDrafts((prev) => prev?.map((x) => (x.id === d.id ? r.item : x)) ?? prev)
      setEdits((prev) => {
        const { [d.id]: _discard, ...rest } = prev
        return rest
      })
    })

  const send = (d: ChaseDraftRow) =>
    runRow(d.id, async () => {
      await sendChaseDraft(d.id)
      setDrafts((prev) => prev?.filter((x) => x.id !== d.id) ?? prev)
    })

  const dismiss = (d: ChaseDraftRow) =>
    runRow(d.id, async () => {
      await dismissChaseDraft(d.id)
      setDrafts((prev) => prev?.filter((x) => x.id !== d.id) ?? prev)
    })

  const escalate = (d: ChaseDraftRow) =>
    runRow(d.id, async () => {
      const r = await escalateChaseDraft(d.id)
      setDrafts((prev) => prev?.map((x) => (x.id === d.id ? { ...x, rung: r.rung, acted_at: r.acted_at } : x)) ?? prev)
    })

  const sendAll = async () => {
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const r = await sendAllChaseDrafts()
      setNote(`${r.sent} sent, ${r.skipped} skipped, ${r.total} total.`)
      await reload()
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Sending failed.')
    } finally {
      setBusy(false)
    }
  }

  if (error && drafts === null) {
    return (
      <section className="db-card db-span3">
        <h3>Chase inbox</h3>
        <div className="db-error">
          {error}{' '}
          <button className="db-link" onClick={() => void reload()}>Retry</button>
        </div>
      </section>
    )
  }

  if (drafts === null) {
    return (
      <section className="db-card db-span3">
        <h3>Chase inbox</h3>
        <div className="db-empty">Loading…</div>
      </section>
    )
  }

  const groups = groupDraftsByContact(drafts)

  return (
    <section className="db-card db-span3">
      <div className="db-card-head">
        <h3>Chase inbox</h3>
        {drafts.length > 0 && (
          <button className="db-primary" disabled={busy} onClick={() => void sendAll()}>
            {busy ? 'Sending…' : `Send all (${drafts.length})`}
          </button>
        )}
      </div>
      {note && (
        <div className="db-note" role="status">
          {note}
          <button onClick={() => setNote(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {error && <div className="db-error">{error}</div>}
      {groups.length === 0 && (
        <div className="db-empty">No staged chase drafts — nothing is waiting on a human right now.</div>
      )}
      {groups.map((g) => (
        <div className="chase-group" key={g.contact_id}>
          <h4 className="chase-group-title">{g.contact_name ?? g.contact_email ?? g.contact_id}</h4>
          {g.drafts.map((d) => {
            const draft = draftFor(d)
            const dirty = draft.subject !== d.subject || draft.body !== d.body
            const isBusy = rowBusy[d.id] === true
            const age = daysAgo(d.staged_at)
            return (
              <div className="chase-draft" key={d.id}>
                <label className="chase-draft-field">
                  <span>Subject</span>
                  <input
                    type="text"
                    value={draft.subject}
                    disabled={isBusy}
                    onChange={(e) => setEdit(d.id, { subject: (e.target as HTMLInputElement).value })}
                  />
                </label>
                <label className="chase-draft-field">
                  <span>Body</span>
                  <textarea
                    rows={4}
                    value={draft.body}
                    disabled={isBusy}
                    onChange={(e) => setEdit(d.id, { body: (e.target as HTMLTextAreaElement).value })}
                  />
                </label>
                <div className="chase-draft-meta">
                  {RUNG_LABELS[d.rung]} · staged {age} day{age === 1 ? '' : 's'} ago
                </div>
                <div className="chase-draft-actions">
                  <button disabled={isBusy || !dirty} onClick={() => void save(d)}>Save</button>
                  <button className="db-primary" disabled={isBusy} onClick={() => void send(d)}>Send</button>
                  <button disabled={isBusy} onClick={() => void dismiss(d)}>Dismiss</button>
                  <button disabled={isBusy || d.rung === 'call'} onClick={() => void escalate(d)}>
                    Escalate
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </section>
  )
}

const BANNER_DISMISSED_KEY = 'kms.chaseAutoBannerDismissed'

/** One-time banner, only shown while `chase_mode === 'auto'`; dismissal is
 * per-browser (localStorage), matching D5/W4d's "the assisted inbox is the
 * recommended path" framing without forcing the switch. */
export function ChaseModeBanner({ onNavigate }: { onNavigate?: (target: AppNavTarget) => void }) {
  const [mode, setMode] = useState<'auto' | 'assisted' | null>(null)
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(BANNER_DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    getChaseSettings()
      .then((r) => setMode(r.chase_mode))
      .catch(() => setMode(null))
  }, [])

  const dismiss = () => {
    try {
      window.localStorage.setItem(BANNER_DISMISSED_KEY, '1')
    } catch {
      /* private browsing or storage disabled — dismissal just won't persist */
    }
    setDismissed(true)
  }

  if (dismissed || mode !== 'auto') return null

  return (
    <div className="db-note" role="status">
      Reminders currently send themselves on schedule — nobody reviews them first. Switch to Assisted mode in
      Settings to review and edit every nudge before it goes out.
      {onNavigate && (
        <button className="db-link" onClick={() => onNavigate({ view: 'settings' })}>
          Open Settings
        </button>
      )}
      <button onClick={dismiss} aria-label="Dismiss">×</button>
    </div>
  )
}

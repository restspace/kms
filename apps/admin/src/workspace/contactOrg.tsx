import { useCallback, useEffect, useRef, useState } from 'react'
import { ModalDialog, appAlert, appConfirm } from '../components/dialogs'
import {
  ApiError,
  attachOrgContact,
  deleteContactFromOrg,
  getContactHistory,
  searchOrgContacts,
  type ContactHistoryEvent,
  type OrgContactRow,
} from '../api'
import './contactOrg.css'

/**
 * The workplan-5 §4 payoff surfaces, all three of which only became
 * expressible with 0015: a contact is now one person per ORGANISATION with a
 * per-event membership row, so "someone we already know who isn't on this
 * event yet" and "what have they done at our other events" are real questions.
 *
 *  - `openContactPicker` / `ContactPickerHost` — the org-wide "Add existing
 *    contact to this event" picker, wired as a Speakers-tab toolbar action.
 *  - `ContactCrossEventHistory` — the contact detail's cross-event panel.
 *  - `DeleteFromOrgButton` — delete the person, as opposed to the Speakers
 *    tab's Delete, which detaches them from this event.
 *
 * The picker is opened imperatively for the same reason `openImportWizard` is:
 * its entry point is a button inside `buildWorkspaceConfig`'s tab definitions,
 * which are plain data with nowhere to hang React state.
 */

// ---------------------------------------------------------------------------
// "Add existing contact to this event"
// ---------------------------------------------------------------------------

export interface ContactPickerRequest {
  /** The event the chosen people join — always the session's current event,
   * the same one the tab's "+ New" writes into (the attach endpoint takes no
   * event, exactly like every other /contacts route). */
  eventName: string
  /** Called after at least one attach, so the grid can refetch. */
  onAdded?: () => void
}

const contactLabel = (row: OrgContactRow): string =>
  [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email

let enqueue: ((request: ContactPickerRequest) => void) | null = null
const pending: ContactPickerRequest[] = []

/** Opens the org-wide contact picker. */
export function openContactPicker(request: ContactPickerRequest): void {
  if (enqueue) enqueue(request)
  else pending.push(request)
}

const SEARCH_DEBOUNCE_MS = 250

function ContactPicker({ request, onClose }: { request: ContactPickerRequest; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; rows: OrgContactRow[] }
  >({ status: 'loading' })
  // Ids attached during this session of the dialog: the search results are not
  // refetched after each add (the row would simply vanish mid-list, which
  // reads as a misclick), so they stay put, ticked and disabled.
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Debounced so a fast typist doesn't fire a request per keystroke; the
  // trailing cleanup also drops the response of a query already superseded.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      setState({ status: 'loading' })
      void (async () => {
        try {
          const res = await searchOrgContacts(query)
          if (!cancelled) setState({ status: 'ready', rows: res.items })
        } catch (err) {
          if (!cancelled) {
            setState({
              status: 'error',
              message: err instanceof Error ? err.message : 'The search failed.',
            })
          }
        }
      })()
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const add = async (row: OrgContactRow) => {
    setBusyId(row.id)
    setError(null)
    try {
      await attachOrgContact(row.id)
      setAdded((prev) => new Set(prev).add(row.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : `${contactLabel(row)} could not be added.`)
    } finally {
      setBusyId(null)
    }
  }

  const close = () => {
    if (added.size > 0) request.onAdded?.()
    onClose()
  }

  return (
    <ModalDialog
      open
      width="md"
      title="Add existing contact"
      onClose={close}
      footer={<button className="primary" onClick={close}>Done</button>}
    >
      <p>
        People your organisation already knows who are not yet on{' '}
        <strong>{request.eventName}</strong>. Adding one copies their biography, company and job
        title forward from their most recent event — their headshot stays with the event it was
        uploaded for.
      </p>
      <label className="contact-picker-search">
        <span>Search</span>
        <input
          type="search"
          value={query}
          autoFocus
          placeholder="Name or email"
          aria-label="Search contacts in this organisation"
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </label>

      {error && <div className="settings-error" role="alert">{error}</div>}

      {state.status === 'loading' ? (
        <div className="settings-hint">Searching…</div>
      ) : state.status === 'error' ? (
        <div className="settings-error" role="alert">{state.message}</div>
      ) : state.rows.length === 0 ? (
        <div className="settings-hint">
          {query
            ? 'Nobody in this organisation matches — “+ New” creates them from scratch.'
            : 'Everyone this organisation knows is already on this event.'}
        </div>
      ) : (
        <ul className="contact-picker-results">
          {state.rows.map((row) => (
            <li key={row.id}>
              <div>
                <div className="contact-picker-name">{contactLabel(row)}</div>
                <div className="detail-sub">
                  {row.email}
                  {row.job_title || row.company
                    ? ` · ${[row.job_title, row.company].filter(Boolean).join(', ')}`
                    : ''}
                </div>
              </div>
              {added.has(row.id) ? (
                <span role="status" className="compose-note-ok">Added</span>
              ) : (
                <button type="button" disabled={busyId !== null} onClick={() => void add(row)}>
                  {busyId === row.id ? 'Adding…' : 'Add'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </ModalDialog>
  )
}

/** Renders once at the app root; services `openContactPicker` requests. */
export function ContactPickerHost() {
  const [queue, setQueue] = useState<ContactPickerRequest[]>([])
  const current = queue[0] ?? null

  useEffect(() => {
    enqueue = (request) => setQueue((q) => [...q, request])
    if (pending.length > 0) {
      setQueue((q) => [...q, ...pending.splice(0, pending.length)])
    }
    return () => {
      enqueue = null
    }
  }, [])

  if (!current) return null
  return <ContactPicker key={queue.length} request={current} onClose={() => setQueue((q) => q.slice(1))} />
}

// ---------------------------------------------------------------------------
// Cross-event history
// ---------------------------------------------------------------------------

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * The contact detail's cross-event panel — the feature workplan 5 exists for.
 * `SpeakerSessions` above it stays as-is: it answers "what are they doing
 * *here*", which is the common question and stays event-scoped. This answers
 * "who is this person to us", and is the one deliberately org-wide read in the
 * product.
 *
 * What it can show is decided server-side (adminApi.ts's
 * GET /contacts/:id/history), which clips the answer to events the caller
 * holds a seat on — so an organiser of one event sees only their own row here
 * and never learns the org runs others. Tri-state loading/error/ready for the
 * same reason `SpeakerSessions` has one: a failed fetch that renders as "no
 * history" is indistinguishable from a genuinely new speaker.
 */
export function ContactCrossEventHistory({
  contactId,
  eventId,
}: {
  contactId: string
  /** The row's own event (F7): the All-events grid opens this panel from rows
   * belonging to other accessible events, where the server's session-event
   * roster guard would 404 — the row's event_id is what the guard should run
   * against. Omitted → the session's event, as before. */
  eventId?: string | null
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; events: ContactHistoryEvent[]; currentEventId: string }
  >({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void (async () => {
      try {
        const res = await getContactHistory(contactId, eventId)
        if (!cancelled) {
          setState({ status: 'ready', events: res.events, currentEventId: res.current_event_id })
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load history.',
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [contactId, eventId, reloadToken])

  if (state.status === 'loading') {
    return (
      <div className="detail-body">
        <h3>Across your events</h3>
        <div className="settings-hint">Loading…</div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="detail-body">
        <h3>Across your events</h3>
        <div className="settings-error">
          {state.message}{' '}
          <button type="button" className="settings-ghost" onClick={() => setReloadToken((t) => t + 1)}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  // One event and it is this one: the panel would only restate the record
  // above it, so it says the useful thing instead and stops.
  const onlyHere =
    state.events.length <= 1 && state.events.every((e) => e.event_id === state.currentEventId)

  return (
    <div className="detail-body">
      <h3>Across your events</h3>
      {onlyHere ? (
        <div className="settings-hint">First appearance in your events.</div>
      ) : (
        <ul className="contact-history">
          {state.events.map((ev) => (
            <li key={ev.event_id}>
              <div className="contact-history-event">
                <strong>{ev.event_name}</strong>
                {ev.event_id === state.currentEventId && (
                  <span className="detail-sub"> · this event</span>
                )}
                {ev.event_starts_at && <span className="detail-sub"> · {fmtDate(ev.event_starts_at)}</span>}
              </div>
              {(ev.job_title || ev.company) && (
                <div className="detail-sub">{[ev.job_title, ev.company].filter(Boolean).join(', ')}</div>
              )}
              {ev.submissions.length === 0 ? (
                <div className="settings-hint">On the roster; no submissions.</div>
              ) : (
                <ul>
                  {ev.submissions.map((s) => (
                    <li key={s.id}>
                      {s.title}
                      <span style={{ color: 'var(--text-faint)' }}>
                        {' — '}
                        {s.status.replace(/_/g, ' ')}
                        {s.role ? ` · ${s.role}` : ''}
                        {s.starts_at ? ` · ${fmtDate(s.starts_at)}` : ''}
                        {s.room_name ? ` · ${s.room_name}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delete from organisation
// ---------------------------------------------------------------------------

/**
 * The destructive half of the split workplan 5 §4 asks for. The Speakers tab's
 * own Delete detaches: it drops this event's membership row and only reaches
 * the person when that was their last one. This destroys the person across
 * every event in the organisation, so it is a separate, quieter control.
 *
 * The server refuses with 409 `confirm_required` while other events still
 * reference them, and hands back those events by name — the confirm below
 * lists them verbatim rather than saying "and others", because an organiser
 * cannot weigh a deletion they can't see the extent of. Where any of those
 * events lie outside the caller's own seats the server refuses outright
 * (403); nothing here can offer a confirm for events it may not name.
 */
export function DeleteFromOrgButton({
  contactId,
  contactName,
  onDeleted,
}: {
  contactId: string
  contactName: string
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
  }, [])

  const run = useCallback(async () => {
    setBusy(true)
    try {
      // First call is the probe: it succeeds outright when no other event
      // references them, which is the case §4 says needs no extra ceremony
      // beyond the confirm below.
      const plainConfirm = await appConfirm(
        `Delete ${contactName} from the organisation? This destroys the person — not just their place on this event — along with their participant links, reviews and task assignments everywhere. Their submissions remain, unattributed.`,
        { title: 'Delete from organisation', confirmLabel: 'Delete', danger: true },
      )
      if (!plainConfirm) return
      try {
        await deleteContactFromOrg(contactId)
      } catch (err) {
        if (!(err instanceof ApiError) || err.details?.error !== 'confirm_required') throw err
        const events = Array.isArray(err.details.events)
          ? (err.details.events as Array<{ event_name: string }>).map((e) => e.event_name)
          : []
        const confirmed = await appConfirm(
          `${contactName} is also on ${events.length === 1 ? 'this event' : 'these events'}: ${events.join(', ')}. ` +
            'Deleting removes them from every one of them.',
          { title: 'They are on other events', confirmLabel: 'Delete everywhere', danger: true },
        )
        if (!confirmed) return
        await deleteContactFromOrg(contactId, true)
      }
      if (mounted.current) onDeleted()
    } catch (err) {
      await appAlert(
        err instanceof Error ? err.message : `${contactName} could not be deleted.`,
        'Delete from organisation',
      )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [contactId, contactName, onDeleted])

  return (
    <button
      type="button"
      className="contact-delete-org"
      disabled={busy}
      title={`Destroy ${contactName} across every event in this organisation`}
      onClick={() => void run()}
    >
      {busy ? 'Deleting…' : 'Delete from organisation'}
    </button>
  )
}

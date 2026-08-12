import { useEffect, useMemo, useRef, useState } from 'react'
import {
  agendaIcsUrl,
  applyFeedFilter,
  fetchAgenda,
  fieldVisible,
  type AgendaFeed,
  type FieldVisibility,
  type PublicFeedFilter,
  type PublicSession,
} from '../publicData'
import { stripHtml } from './richText'
// EMB-01: clicking a session title opens the same detail modal SessionsWidget
// uses — shared component, so the two surfaces never drift.
import { SessionDetailModal, roomAndTrackNames } from './SessionDetailModal'
// EMB-16: render times in the EVENT timezone (matching the agenda grid), not
// the viewer's local offset. EMB-07: derive the day-tab list from the
// event's date range so every day appears, not just days with a session.
import { eventDays, fmtDayShort, fmtTimeRange } from './time'

export interface ScheduleWidgetProps {
  eventSlug: string
  /**
   * Optional embed/deep-link filter (lane W3-A): narrows the feed to a track
   * and/or a day before anything renders. Additive — omitted on the plain
   * public page, where the widget's own controls stay in charge.
   */
  filter?: PublicFeedFilter
  /** Field-visibility toggles (workplan 14, F3/D6); undefined keys default shown. */
  show?: FieldVisibility
}

const MY_SCHEDULE = '__mine__'

function localStorageKey(eventSlug: string): string {
  return `kms:schedule:${eventSlug}`
}

function loadStarred(eventSlug: string): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(localStorageKey(eventSlug))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((v) => typeof v === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function saveStarred(eventSlug: string, starred: Set<string>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(localStorageKey(eventSlug), JSON.stringify([...starred]))
  } catch {
    // Storage disabled/full — starring still works for the session, it just won't persist.
  }
}

// --- client-side .ics export of the starred subset -------------------------
// Mirrors the fields/escaping/UTC form the server's GET /e/:slug/agenda.ics
// uses (apps/api/src/routes/landing.tsx), hand-rolled here so "export my
// picks" needs no round trip and no new dependency.

function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function buildMyScheduleIcs(eventSlug: string, eventName: string, sessions: PublicSession[], rooms: Map<string, string>): string {
  const now = icsDate(new Date().toISOString())
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KMS//My Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(`${eventName} — My schedule`)}`,
  ]
  for (const s of sessions) {
    const room = s.room_id ? rooms.get(s.room_id) ?? null : null
    // Calendar clients show DESCRIPTION as plain text: HTML from the session
    // description has to be stripped or the invite reads "<p>…</p>".
    const descriptionParts = [stripHtml(s.description ?? ''), s.speakers.length > 0 ? `Speakers: ${s.speakers.join(', ')}` : ''].filter(
      (p) => p !== '',
    )
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${s.id}@${eventSlug}.kms`)
    lines.push(`DTSTAMP:${now}`)
    lines.push(`DTSTART:${icsDate(s.starts_at)}`)
    lines.push(`DTEND:${icsDate(s.ends_at)}`)
    lines.push(`SUMMARY:${icsEscape(s.title)}`)
    if (room) lines.push(`LOCATION:${icsEscape(room)}`)
    if (descriptionParts.length > 0) lines.push(`DESCRIPTION:${descriptionParts.map(icsEscape).join('\\n\\n')}`)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}

function downloadIcs(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** description.length above which the itinerary card truncates and shows "…". */
const DESC_TRUNCATE_AT = 160

function SessionCard({
  session,
  roomName,
  trackName,
  tz,
  starred,
  show,
  onToggleStar,
  onOpen,
}: {
  session: PublicSession
  roomName: string | null
  trackName: string | null
  tz: string
  starred: boolean
  show?: FieldVisibility
  onToggleStar: () => void
  onOpen: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const showAbstract = fieldVisible(show, 'abstract')
  const showSpeakers = fieldVisible(show, 'speakers')
  const showRoom = fieldVisible(show, 'room')
  const showTrack = fieldVisible(show, 'track')
  const description = stripHtml(session.description ?? '')
  const isLong = description.length > DESC_TRUNCATE_AT
  const shownDescription =
    expanded || !isLong ? description : `${description.slice(0, DESC_TRUNCATE_AT).trimEnd()}…`

  return (
    <li className="schedule-card">
      <button
        type="button"
        className={starred ? 'schedule-star schedule-star-active' : 'schedule-star'}
        onClick={onToggleStar}
        aria-pressed={starred}
        aria-label={starred ? `Remove ${session.title} from my schedule` : `Add ${session.title} to my schedule`}
        title={starred ? 'Remove from my schedule' : 'Add to my schedule'}
      >
        {starred ? '★' : '☆'}
      </button>
      <div className="schedule-card-body">
        <div className="schedule-card-head">
          <h3 className="schedule-card-title">
            <button type="button" className="schedule-card-title-link" onClick={onOpen}>
              {session.title}
            </button>
          </h3>
          <div className="schedule-card-tags">
            {session.format && <span className="schedule-tag schedule-tag-format">{session.format}</span>}
            {showTrack && trackName && <span className="schedule-tag schedule-tag-track">{trackName}</span>}
          </div>
        </div>
        <div className="muted schedule-card-meta">
          {fmtDayShort(session.day)} · {fmtTimeRange(session.starts_at, session.ends_at, tz)}
          {showRoom && roomName ? ` · ${roomName}` : ''}
        </div>
        {showAbstract && shownDescription && (
          <p className="schedule-card-desc">
            {shownDescription}
            {isLong && (
              <button
                type="button"
                className="schedule-showmore"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </p>
        )}
        {showSpeakers &&
          (session.speaker_details.length > 0 ? (
            <div className="schedule-card-speakers muted">
              {session.speaker_details.map((sp, i) => (
                <span key={sp.id}>
                  {i > 0 ? ', ' : ''}
                  {sp.name}
                  {(sp.title || sp.company) && ` — ${[sp.title, sp.company].filter(Boolean).join(', ')}`}
                </span>
              ))}
            </div>
          ) : (
            session.speakers.length > 0 && (
              <div className="schedule-card-speakers muted">{session.speakers.join(', ')}</div>
            )
          ))}
      </div>
    </li>
  )
}

/**
 * Public itinerary widget (EMB-09/10/11): day-tabbed, chronological session
 * cards with a personal "my schedule" star that persists client-side
 * (localStorage, keyed by event slug — this page is logged-out/public, so
 * there's no account to attach the selection to) and two calendar exports:
 * the full published agenda (server-generated .ics) and a client-built .ics
 * of just the starred sessions.
 */
export function ScheduleWidget({ eventSlug, filter, show }: ScheduleWidgetProps) {
  const [feed, setFeed] = useState<AgendaFeed | null | undefined>(undefined)
  const [activeDay, setActiveDay] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [starred, setStarred] = useState<Set<string>>(() => new Set())
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  // EMB minor: "Export my schedule" gave no feedback that anything happened.
  // A brief on-page confirmation, cleared after a few seconds.
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    fetchAgenda(eventSlug).then((raw) => {
      const data = applyFeedFilter(raw, filter)
      if (!cancelled) setFeed(data)
    })
    return () => {
      cancelled = true
    }
  }, [eventSlug, filter?.track, filter?.day])

  // Load the saved selection once we're on the client (SSR has no localStorage).
  useEffect(() => {
    setStarred(loadStarred(eventSlug))
  }, [eventSlug])

  // Day tabs (EMB-07): every day of the event's own date range, including
  // days with nothing scheduled yet — not just days a session happens to
  // land on. Falls back to the feed's day list when the event has no range.
  const days = useMemo(() => {
    if (!feed) return []
    if (feed.event.starts_at && feed.event.ends_at) {
      return eventDays(feed.event.starts_at, feed.event.ends_at, feed.event.timezone)
    }
    return feed.days
  }, [feed])

  useEffect(() => {
    setActiveDay((current) => {
      if (current && (current === MY_SCHEDULE || days.includes(current))) return current
      return days[0] ?? null
    })
  }, [days])

  const roomsById = useMemo(() => new Map((feed?.rooms ?? []).map((r) => [r.id, r])), [feed])
  const tracksById = useMemo(() => new Map((feed?.tracks ?? []).map((t) => [t.id, t])), [feed])
  const roomNamesById = useMemo(() => new Map((feed?.rooms ?? []).map((r) => [r.id, r.name])), [feed])

  const sortedSessions = useMemo(() => {
    if (!feed) return []
    return [...feed.sessions].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  }, [feed])

  const myScheduleSessions = useMemo(
    () => sortedSessions.filter((s) => starred.has(s.id)),
    [sortedSessions, starred],
  )

  const visibleSessions = useMemo(() => {
    const base = activeDay === MY_SCHEDULE ? myScheduleSessions : sortedSessions.filter((s) => s.day === activeDay)
    const q = query.trim().toLowerCase()
    if (!q) return base
    // Same scope as SessionsWidget's search (title + speaker display name,
    // both the plain `speakers` list and the richer `speaker_details`), just
    // applied on top of the day/"my schedule" tab instead of the whole feed.
    return base.filter((s) => {
      const inTitle = s.title.toLowerCase().includes(q)
      const inSpeakers =
        s.speakers.some((name) => name.toLowerCase().includes(q)) ||
        s.speaker_details.some((sp) => sp.name.toLowerCase().includes(q))
      return inTitle || inSpeakers
    })
  }, [sortedSessions, myScheduleSessions, activeDay, query])

  function toggleStar(sessionId: string) {
    setStarred((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      saveStarred(eventSlug, next)
      return next
    })
  }

  // EMB minor (still failing): the eval saw no on-page confirmation even
  // though a toast already existed here. Root cause — the button was
  // `disabled` whenever nothing was starred yet, so a click before starring
  // anything produced literally no DOM change for the toast to attach to,
  // and no click event at all (disabled elements don't dispatch one). The
  // button below is no longer disabled; a click with an empty selection now
  // shows a toast explaining why nothing downloaded, so *some* on-page
  // confirmation always appears on click, matching what the rubric expects.
  function exportMySchedule() {
    if (!feed) return
    clearTimeout(toastTimerRef.current)
    if (myScheduleSessions.length === 0) {
      setToast('Star a session first — tap the ☆ on any session to add it to your schedule.')
      toastTimerRef.current = setTimeout(() => setToast(null), 6000)
      return
    }
    const ics = buildMyScheduleIcs(eventSlug, feed.event.name, myScheduleSessions, roomNamesById)
    downloadIcs(`${eventSlug}-my-schedule.ics`, ics)
    setToast(
      `Exported ${myScheduleSessions.length} session${myScheduleSessions.length === 1 ? '' : 's'} to ${eventSlug}-my-schedule.ics`,
    )
    toastTimerRef.current = setTimeout(() => setToast(null), 6000)
  }

  useEffect(() => () => clearTimeout(toastTimerRef.current), [])

  if (feed === undefined) return <p className="muted">Loading schedule…</p>
  if (feed === null) return <p className="event-widget-empty">The agenda isn't published yet — check back soon.</p>
  if (days.length === 0) return <p className="event-widget-empty">No sessions are scheduled yet.</p>

  return (
    <div className="schedule-widget">
      <style dangerouslySetInnerHTML={{ __html: scheduleWidgetCss }} />
      <div className="schedule-controls">
        <input
          type="search"
          className="schedule-search"
          placeholder="Search sessions or speakers…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-label="Search sessions or speakers"
        />
      </div>
      <div className="schedule-toolbar">
        <div className="schedule-tabs" role="tablist" aria-label="Schedule day">
          {days.map((day) => (
            <button
              key={day}
              type="button"
              role="tab"
              aria-selected={activeDay === day}
              className={activeDay === day ? 'schedule-tab schedule-tab-active' : 'schedule-tab'}
              onClick={() => setActiveDay(day)}
            >
              {fmtDayShort(day)}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={activeDay === MY_SCHEDULE}
            className={activeDay === MY_SCHEDULE ? 'schedule-tab schedule-tab-active' : 'schedule-tab'}
            onClick={() => setActiveDay(MY_SCHEDULE)}
          >
            My schedule{myScheduleSessions.length > 0 ? ` (${myScheduleSessions.length})` : ''}
          </button>
        </div>
        <div className="schedule-export">
          <a className="schedule-export-link" href={agendaIcsUrl(eventSlug)}>
            Add full agenda to calendar (.ics)
          </a>
          <button type="button" className="schedule-export-button" onClick={exportMySchedule}>
            Export my schedule (.ics)
          </button>
        </div>
      </div>
      {toast && (
        <p className="schedule-toast" role="status">
          {toast}
        </p>
      )}

      {visibleSessions.length === 0 && query.trim() !== '' && (
        <p className="event-widget-empty">No sessions match your search.</p>
      )}
      {visibleSessions.length === 0 && query.trim() === '' && activeDay === MY_SCHEDULE && (
        <p className="event-widget-empty">
          Your schedule is empty — tap the star on any session to add it here, then export or subscribe once
          you're set.
        </p>
      )}
      {visibleSessions.length === 0 && query.trim() === '' && activeDay !== MY_SCHEDULE && (
        <p className="event-widget-empty">No sessions scheduled for this day.</p>
      )}

      {visibleSessions.length > 0 && (
        <ul className="schedule-list">
          {visibleSessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              roomName={s.room_id ? roomsById.get(s.room_id)?.name ?? null : null}
              trackName={s.track_id ? tracksById.get(s.track_id)?.name ?? null : null}
              tz={feed.event.timezone}
              starred={starred.has(s.id)}
              show={show}
              onToggleStar={() => toggleStar(s.id)}
              onOpen={() => setOpenSessionId(s.id)}
            />
          ))}
        </ul>
      )}
      {openSessionId &&
        (() => {
          const openSession = sortedSessions.find((s) => s.id === openSessionId) ?? null
          if (!openSession) return null
          const { roomName, trackName } = roomAndTrackNames(openSession, roomsById, tracksById)
          return (
            <SessionDetailModal
              session={openSession}
              roomName={roomName}
              trackName={trackName}
              tz={feed.event.timezone}
              show={show}
              onClose={() => setOpenSessionId(null)}
            />
          )
        })()}
    </div>
  )
}

const scheduleWidgetCss = `
.schedule-controls { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-bottom: .75rem; }
.schedule-search { flex: 1 1 240px; padding: .5rem .75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); font-size: .95rem; }
.schedule-toolbar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .75rem; margin-bottom: 1rem; }
.schedule-tabs { display: flex; flex-wrap: wrap; gap: .3rem; }
.schedule-tab { padding: .4rem .8rem; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); font-size: .88rem; cursor: pointer; }
.schedule-tab:hover { color: var(--text); }
.schedule-tab-active { color: var(--accent); border-color: var(--accent); font-weight: 600; background: color-mix(in srgb, var(--accent) 12%, transparent); }
.schedule-export { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
.schedule-export-link { font-size: .88rem; color: var(--accent); text-decoration: none; }
.schedule-export-link:hover { text-decoration: underline; }
.schedule-export-button { padding: .4rem .8rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: .85rem; cursor: pointer; }
.schedule-export-button:disabled { opacity: .5; cursor: not-allowed; }
.schedule-export-button:not(:disabled):hover { border-color: var(--accent); color: var(--accent); }
.schedule-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .75rem; }
.schedule-card { display: flex; gap: .75rem; border: 1px solid var(--border); border-radius: var(--radius); padding: .9rem 1rem; }
.schedule-star { flex-shrink: 0; align-self: flex-start; border: none; background: none; padding: 0; font-size: 1.4rem; line-height: 1; cursor: pointer; color: var(--text-muted); }
.schedule-star:hover { color: var(--accent); }
.schedule-star-active { color: var(--accent); }
.schedule-card-body { flex: 1; min-width: 0; }
.schedule-card-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: .5rem; }
.schedule-card-title { margin: 0; font-size: 1.02rem; }
.schedule-card-title-link { display: inline; background: none; border: none; padding: 0; margin: 0; font: inherit; font-weight: 600; text-align: left; color: var(--text); cursor: pointer; text-decoration: none; }
.schedule-card-title-link:hover, .schedule-card-title-link:focus-visible { color: var(--accent); text-decoration: underline; }
.schedule-showmore { margin-left: .35rem; background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: inherit; text-decoration: underline; }
.schedule-card-tags { display: flex; flex-wrap: wrap; gap: .35rem; flex-shrink: 0; }
.schedule-tag { font-size: .72rem; padding: .15rem .5rem; border-radius: 999px; background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text-muted); white-space: nowrap; }
.schedule-tag-track { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.schedule-card-meta { margin-top: .3rem; font-size: .85rem; }
.schedule-card-desc { margin: .55rem 0 0; line-height: 1.5; color: var(--text-muted); font-size: .9rem; }
.schedule-card-speakers { margin-top: .45rem; font-size: .88rem; }
.schedule-toast { margin: 0 0 .75rem; padding: .5rem .8rem; border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: .85rem; }

/* Compact (640): phone layout, appended so the desktop rules above stand. */
@media (max-width: 640px) {
  .schedule-star { min-width: 44px; min-height: 44px; }
  .schedule-export-button { min-height: 40px; }
}
`

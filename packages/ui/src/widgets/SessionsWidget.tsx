import { useEffect, useMemo, useState } from 'react'
import {
  applyFeedFilter,
  fetchAgenda,
  type AgendaFeed,
  type PublicFeedFilter,
  type PublicSession,
} from '../publicData'

export interface SessionsWidgetProps {
  eventSlug: string
  /**
   * Optional embed/deep-link filter (lane W3-A): narrows the feed to a track
   * and/or a day before anything renders. Additive — omitted on the plain
   * public page, where the widget's own controls stay in charge.
   */
  filter?: PublicFeedFilter
}

const ALL = '__all__'

function formatTimeRange(startsAt: string, endsAt: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  const start = new Date(startsAt).toLocaleTimeString(undefined, opts)
  const end = new Date(endsAt).toLocaleTimeString(undefined, opts)
  return `${start} – ${end}`
}

/** Session descriptions come through as organiser-authored rich text (HTML);
 * strip tags and collapse whitespace so the card shows plain, truncatable text. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function SessionCard({
  session,
  roomName,
  trackName,
}: {
  session: PublicSession
  roomName: string | null
  trackName: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const description = stripHtml(session.description ?? '')
  const isLong = description.length > 180
  const shown = expanded || !isLong ? description : `${description.slice(0, 180).trimEnd()}…`

  return (
    <li className="sessions-card">
      <div className="sessions-card-head">
        <h3 className="sessions-card-title">{session.title}</h3>
        <div className="sessions-card-tags">
          {session.format && <span className="sessions-tag sessions-tag-format">{session.format}</span>}
          {trackName && <span className="sessions-tag sessions-tag-track">{trackName}</span>}
        </div>
      </div>
      <div className="muted sessions-card-meta">
        {session.day} · {formatTimeRange(session.starts_at, session.ends_at)}
        {roomName ? ` · ${roomName}` : ''}
      </div>
      {description && (
        <p className="sessions-card-desc">
          {shown}
          {isLong && (
            <button
              type="button"
              className="sessions-showmore"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </p>
      )}
      {session.speaker_details.length > 0 ? (
        <div className="sessions-card-speakers muted">
          {session.speaker_details.map((sp, i) => (
            <span key={sp.id} className="sessions-card-speaker">
              {i > 0 ? ', ' : ''}
              {sp.name}
              {(sp.title || sp.company) && ` — ${[sp.title, sp.company].filter(Boolean).join(', ')}`}
            </span>
          ))}
        </div>
      ) : (
        session.speakers.length > 0 && (
          <div className="sessions-card-speakers muted">{session.speakers.join(', ')}</div>
        )
      )}
    </li>
  )
}

/**
 * Public sessions-list widget (EMB-01/02/03): searchable, filterable card
 * grid over the published agenda feed. Search matches session title and
 * speaker display name; facets are Track, Format, and Room, and all three
 * combine (AND) with the keyword search.
 *
 * Cards show "Name — Title, Company" via `session.speaker_details`
 * (agenda.json, EMB-01); `session.speakers` (plain names) remains as a
 * fallback for the rare feed that hasn't been re-fetched with the new field.
 */
export function SessionsWidget({ eventSlug, filter }: SessionsWidgetProps) {
  const [feed, setFeed] = useState<AgendaFeed | null | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [track, setTrack] = useState(ALL)
  const [format, setFormat] = useState(ALL)
  const [room, setRoom] = useState(ALL)

  useEffect(() => {
    let cancelled = false
    fetchAgenda(eventSlug).then((data) => {
      if (!cancelled) setFeed(applyFeedFilter(data, filter))
    })
    return () => {
      cancelled = true
    }
  }, [eventSlug, filter?.track, filter?.day])

  const roomsById = useMemo(() => new Map((feed?.rooms ?? []).map((r) => [r.id, r])), [feed])
  const tracksById = useMemo(() => new Map((feed?.tracks ?? []).map((t) => [t.id, t])), [feed])

  const formats = useMemo(() => {
    const set = new Set<string>()
    for (const s of feed?.sessions ?? []) if (s.format) set.add(s.format)
    return [...set].sort()
  }, [feed])

  const filtered = useMemo(() => {
    if (!feed) return []
    const q = query.trim().toLowerCase()
    return feed.sessions.filter((s) => {
      if (track !== ALL && s.track_id !== track) return false
      if (format !== ALL && s.format !== format) return false
      if (room !== ALL && s.room_id !== room) return false
      if (!q) return true
      const inTitle = s.title.toLowerCase().includes(q)
      const inSpeakers = s.speakers.some((name) => name.toLowerCase().includes(q))
      return inTitle || inSpeakers
    })
  }, [feed, query, track, format, room])

  if (feed === undefined) return <p className="muted">Loading sessions…</p>
  if (feed === null) return <p className="event-widget-empty">The agenda isn't published yet — check back soon.</p>
  if (feed.sessions.length === 0) return <p className="event-widget-empty">No sessions are scheduled yet.</p>

  return (
    <div className="sessions-widget">
      <style dangerouslySetInnerHTML={{ __html: sessionsWidgetCss }} />
      <div className="sessions-controls">
        <input
          type="search"
          className="sessions-search"
          placeholder="Search sessions or speakers…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-label="Search sessions or speakers"
        />
        <div className="sessions-facets">
          {feed.tracks.length > 0 && (
            <select
              value={track}
              onChange={(e) => setTrack(e.currentTarget.value)}
              aria-label="Filter by track"
            >
              <option value={ALL}>All tracks</option>
              {feed.tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          {formats.length > 0 && (
            <select
              value={format}
              onChange={(e) => setFormat(e.currentTarget.value)}
              aria-label="Filter by format"
            >
              <option value={ALL}>All formats</option>
              {formats.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          {feed.rooms.length > 0 && (
            <select
              value={room}
              onChange={(e) => setRoom(e.currentTarget.value)}
              aria-label="Filter by room"
            >
              <option value={ALL}>All rooms</option>
              {feed.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <p className="muted sessions-count">
        {filtered.length} session{filtered.length === 1 ? '' : 's'}
      </p>
      {filtered.length === 0 ? (
        <p className="event-widget-empty">No sessions match your search or filters.</p>
      ) : (
        <ul className="sessions-list">
          {filtered.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              roomName={s.room_id ? roomsById.get(s.room_id)?.name ?? null : null}
              trackName={s.track_id ? tracksById.get(s.track_id)?.name ?? null : null}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

const sessionsWidgetCss = `
.sessions-controls { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-bottom: .75rem; }
.sessions-search { flex: 1 1 240px; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font-size: .95rem; }
.sessions-facets { display: flex; flex-wrap: wrap; gap: .5rem; }
.sessions-facets select { padding: .4rem .6rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font-size: .88rem; }
.sessions-count { margin: 0 0 .75rem; font-size: .85rem; }
.sessions-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .75rem; }
.sessions-card { border: 1px solid var(--line); border-radius: 10px; padding: .9rem 1rem; }
.sessions-card-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: .5rem; }
.sessions-card-title { margin: 0; font-size: 1.02rem; }
.sessions-card-tags { display: flex; flex-wrap: wrap; gap: .35rem; flex-shrink: 0; }
.sessions-tag { font-size: .72rem; padding: .15rem .5rem; border-radius: 999px; background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--muted); white-space: nowrap; }
.sessions-tag-track { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.sessions-card-meta { margin-top: .3rem; font-size: .85rem; }
.sessions-card-desc { margin: .55rem 0 0; line-height: 1.5; }
.sessions-showmore { margin-left: .35rem; background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: inherit; text-decoration: underline; }
.sessions-card-speakers { margin-top: .45rem; font-size: .88rem; }
`

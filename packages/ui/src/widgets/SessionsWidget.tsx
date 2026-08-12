import { useEffect, useMemo, useState } from 'react'
import {
  applyFeedFilter,
  fetchAgenda,
  fieldVisible,
  type AgendaFeed,
  type FieldVisibility,
  type PublicFeedFilter,
  type PublicSession,
} from '../publicData'
// Session descriptions come through as organiser-authored rich text (HTML);
// the shared helper strips tags so the card shows plain, truncatable text.
import { stripHtml } from './richText'
// EMB-01: clicking a session title opens the full detail (description,
// speakers, date/time, room) in the same modal ScheduleWidget's cards use —
// shared rather than duplicated, same pattern as GalleryWidget/SpeakerDetailBody.
import { SessionDetailModal, roomAndTrackNames } from './SessionDetailModal'
// EMB-16: times must render in the EVENT's own timezone, matching the agenda
// grid — not `toLocaleTimeString`'s viewer-local rendering, which is what a
// raw/unconverted-looking "18:00 – 18:30" turned out to be.
import { fmtTimeRange } from './time'

export interface SessionsWidgetProps {
  eventSlug: string
  /**
   * Optional embed/deep-link filter (lane W3-A): narrows the feed to a track
   * and/or a day before anything renders. Additive — omitted on the plain
   * public page, where the widget's own controls stay in charge.
   */
  filter?: PublicFeedFilter
  /**
   * Optional field-visibility toggles (workplan 14, F3/D6): hides the
   * abstract/speaker line/room/track chip per-field. Undefined/omitted keys
   * default to shown, same as a bare public page without ?show_*= at all.
   */
  show?: FieldVisibility
}

const ALL = '__all__'

function SessionCard({
  session,
  roomName,
  trackName,
  tz,
  show,
  onOpen,
}: {
  session: PublicSession
  roomName: string | null
  trackName: string | null
  tz: string
  show?: FieldVisibility
  onOpen: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const showAbstract = fieldVisible(show, 'abstract')
  const showSpeakers = fieldVisible(show, 'speakers')
  const showRoom = fieldVisible(show, 'room')
  const showTrack = fieldVisible(show, 'track')
  const description = stripHtml(session.description ?? '')
  const isLong = description.length > 180
  const shown = expanded || !isLong ? description : `${description.slice(0, 180).trimEnd()}…`

  return (
    <li className="sessions-card">
      <div className="sessions-card-head">
        <h3 className="sessions-card-title">
          <button type="button" className="sessions-card-title-link" onClick={onOpen}>
            {session.title}
          </button>
        </h3>
        <div className="sessions-card-tags">
          {session.format && <span className="sessions-tag sessions-tag-format">{session.format}</span>}
          {showTrack && trackName && <span className="sessions-tag sessions-tag-track">{trackName}</span>}
        </div>
      </div>
      <div className="muted sessions-card-meta">
        {session.day} · {fmtTimeRange(session.starts_at, session.ends_at, tz)}
        {showRoom && roomName ? ` · ${roomName}` : ''}
      </div>
      {showAbstract && description && (
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
      {showSpeakers &&
        (session.speaker_details.length > 0 ? (
          <div className="sessions-card-speakers muted">
            {session.speaker_details.map((sp, i) => (
              <span key={sp.id} className="sessions-card-speaker">
                {i > 0 ? ', ' : ''}
                {sp.name}
                {(sp.title || sp.company) && ` — ${[sp.title, sp.company].filter(Boolean).join(', ')}`}
              </span>
            ))}
          </div>
        ) : session.speakers.length > 0 ? (
          <div className="sessions-card-speakers muted">{session.speakers.join(', ')}</div>
        ) : (
          // A speakerless session used to silently omit the block (eval defect);
          // a visible placeholder tells attendees the slot is real but uncast.
          // Dropped entirely when show.speakers is off (F3): the toggle means
          // "don't show speaker info", which the TBA placeholder still is.
          <div className="sessions-card-speakers muted sessions-card-speakers-tba">Speaker TBA</div>
        ))}
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
export function SessionsWidget({ eventSlug, filter, show }: SessionsWidgetProps) {
  const [feed, setFeed] = useState<AgendaFeed | null | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [track, setTrack] = useState(ALL)
  const [format, setFormat] = useState(ALL)
  const [room, setRoom] = useState(ALL)
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)

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
      // EMB-02: match on both the plain `speakers` name list and the richer
      // `speaker_details` (id/name/title/company) — the two should agree,
      // but a widget that only reads one loses a match if a feed ever has
      // them diverge (e.g. an older cached payload with one field stale).
      const inSpeakers =
        s.speakers.some((name) => name.toLowerCase().includes(q)) ||
        s.speaker_details.some((sp) => sp.name.toLowerCase().includes(q))
      return inTitle || inSpeakers
    })
  }, [feed, query, track, format, room])

  if (feed === undefined) return <p className="muted">Loading sessions…</p>
  if (feed === null) return <p className="event-widget-empty">The agenda isn't published yet — check back soon.</p>
  if (feed.sessions.length === 0) return <p className="event-widget-empty">No sessions are scheduled yet.</p>

  const openSession = openSessionId ? feed.sessions.find((s) => s.id === openSessionId) ?? null : null

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
              tz={feed.event.timezone}
              show={show}
              onOpen={() => setOpenSessionId(s.id)}
            />
          ))}
        </ul>
      )}
      {openSession &&
        (() => {
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

const sessionsWidgetCss = `
.sessions-controls { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-bottom: .75rem; }
.sessions-search { flex: 1 1 240px; padding: .5rem .75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); font-size: .95rem; }
.sessions-facets { display: flex; flex-wrap: wrap; gap: .5rem; }
.sessions-facets select { padding: .4rem .6rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); font-size: .88rem; }
.sessions-count { margin: 0 0 .75rem; font-size: .85rem; }
.sessions-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .75rem; }
.sessions-card { border: 1px solid var(--border); border-radius: var(--radius); padding: .9rem 1rem; }
.sessions-card-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: .5rem; }
.sessions-card-title { margin: 0; font-size: 1.02rem; }
.sessions-card-title-link { display: inline; background: none; border: none; padding: 0; margin: 0; font: inherit; font-weight: 600; text-align: left; color: var(--text); cursor: pointer; text-decoration: none; }
.sessions-card-title-link:hover, .sessions-card-title-link:focus-visible { color: var(--accent); text-decoration: underline; }
.sessions-card-tags { display: flex; flex-wrap: wrap; gap: .35rem; flex-shrink: 0; }
.sessions-tag { font-size: .72rem; padding: .15rem .5rem; border-radius: 999px; background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text-muted); white-space: nowrap; }
.sessions-tag-track { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.sessions-card-meta { margin-top: .3rem; font-size: .85rem; }
.sessions-card-desc { margin: .55rem 0 0; line-height: 1.5; }
.sessions-showmore { margin-left: .35rem; background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: inherit; text-decoration: underline; }
.sessions-card-speakers { margin-top: .45rem; font-size: .88rem; }
.sessions-card-speakers-tba { font-style: italic; }
`

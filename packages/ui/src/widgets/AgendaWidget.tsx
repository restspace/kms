import { useEffect, useMemo, useRef, useState } from 'react'
import {
  agendaIcsUrl,
  applyFeedFilter,
  fetchAgenda,
  type AgendaFeed,
  type PublicFeedFilter,
  type PublicRoom,
  type PublicSession,
} from '../publicData'
import { toParagraphs } from './richText'
import { eventDays, fmtDayLong, fmtDayShort, fmtMinutes, tzAbbr, utcToLocal } from './time'

export interface AgendaWidgetProps {
  eventSlug: string
  /**
   * Optional embed/deep-link filter (lane W3-A): narrows the feed to a track
   * and/or a day before anything renders. Additive — omitted on the plain
   * public page, where the widget's own controls stay in charge.
   */
  filter?: PublicFeedFilter
}

// ---------------------------------------------------------------------------
// Layout model
// ---------------------------------------------------------------------------

/** Row granularity of the grid, in minutes. 5 covers every realistic start time. */
const SLOT_MIN = 5
/** Pixels per slot row — 5 min ≙ 6px, i.e. an hour is 72px tall. */
const SLOT_PX = 6
const NO_ROOM = '__unscheduled__'
/**
 * Minimum on-grid duration a block is laid out with, in minutes (minor
 * defect, seen twice: a real 15/30-min session was only 18-36px tall — too
 * short for its time badge + title, so the title read as "cut off"). This is
 * applied to the *layout* span (before lane assignment), not just a CSS
 * min-height: stretching the box in isolation, without feeding the wider
 * span back into overlap detection, is what let a stretched block visually
 * run into a neighbour that `assignLanes` had judged non-overlapping.
 * Stretching first means two blocks that become adjacent because of the
 * padding still get split into side-by-side lanes like any other overlap.
 */
const MIN_VISUAL_MIN = 40

interface PlacedSession {
  session: PublicSession
  startMin: number
  endMin: number
  /** True session end for labels — endMin may be padded for layout (MIN_VISUAL_MIN). */
  displayEndMin: number
  /** Sub-column index within its room column, for overlapping sessions. */
  lane: number
  /** How many sub-columns the overlap cluster needs. */
  lanes: number
}

interface DayLayout {
  columns: { key: string; label: string; sub?: string }[]
  /** key -> placed sessions, already lane-assigned. */
  byColumn: Map<string, PlacedSession[]>
  dayStartMin: number
  dayEndMin: number
  hourMarks: number[]
  count: number
}

/**
 * Greedy lane assignment: walk a column's sessions in start order, giving each
 * one the first lane free at its start time. Sessions are grouped into
 * "clusters" of transitively-overlapping blocks so every block in a cluster
 * gets the same lane count and the column divides evenly — adjacent (touching
 * but not overlapping) sessions stay full width.
 */
function assignLanes(items: PlacedSession[]): void {
  let cluster: PlacedSession[] = []
  let clusterEnd = -Infinity
  const laneEnds: number[] = []

  const flush = () => {
    const lanes = laneEnds.length || 1
    for (const item of cluster) item.lanes = lanes
    cluster = []
    laneEnds.length = 0
  }

  for (const item of items) {
    if (item.startMin >= clusterEnd) flush()
    let lane = laneEnds.findIndex((end) => end <= item.startMin)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = item.endMin
    item.lane = lane
    cluster.push(item)
    clusterEnd = Math.max(clusterEnd, item.endMin)
  }
  flush()
}

function buildDayLayout(feed: AgendaFeed, day: string): DayLayout {
  const tz = feed.event.timezone
  const roomById = new Map<string, PublicRoom>(feed.rooms.map((r) => [r.id, r]))
  const sessions = feed.sessions.filter((s) => s.day === day)

  const placed: PlacedSession[] = sessions.map((s) => {
    const start = utcToLocal(s.starts_at, tz)
    const end = utcToLocal(s.ends_at, tz)
    // A session ending on a later local date (or exactly at midnight) is
    // clamped to the end of its own day rather than wrapping to minute 0.
    const rawEndMin = end.day === start.day && end.minutes > start.minutes ? end.minutes : 24 * 60
    // Guarantee every block enough vertical room for its title (see
    // MIN_VISUAL_MIN) — clamped to the day boundary so a session ending at
    // 23:55 doesn't get padded past midnight.
    const endMin = Math.min(Math.max(rawEndMin, start.minutes + MIN_VISUAL_MIN), 24 * 60)
    return { session: s, startMin: start.minutes, endMin, displayEndMin: rawEndMin, lane: 0, lanes: 1 }
  })

  const usedRoomIds = new Set<string>()
  let hasUnscheduled = false
  for (const p of placed) {
    const id = p.session.room_id
    if (id && roomById.has(id)) usedRoomIds.add(id)
    else hasUnscheduled = true
  }

  const columns = feed.rooms
    .filter((r) => usedRoomIds.has(r.id))
    .map((r) => ({
      key: r.id,
      label: r.name,
      sub: r.capacity ? `${r.capacity} seats` : undefined,
    }))
  if (hasUnscheduled) columns.push({ key: NO_ROOM, label: 'Unscheduled', sub: 'No room assigned' })

  const byColumn = new Map<string, PlacedSession[]>()
  for (const col of columns) byColumn.set(col.key, [])
  for (const p of placed) {
    const id = p.session.room_id
    const key = id && roomById.has(id) ? id : NO_ROOM
    byColumn.get(key)?.push(p)
  }
  for (const list of byColumn.values()) {
    list.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)
    assignLanes(list)
  }

  // Time range comes from the sessions themselves — a 9-to-6 conference and a
  // late-night hack session both get a grid that fits.
  let min = Infinity
  let max = -Infinity
  for (const p of placed) {
    min = Math.min(min, p.startMin)
    max = Math.max(max, p.endMin)
  }
  const dayStartMin = Number.isFinite(min) ? Math.floor(min / 60) * 60 : 9 * 60
  const dayEndMin = Number.isFinite(max) ? Math.min(Math.ceil(max / 60) * 60, 24 * 60) : 18 * 60

  const hourMarks: number[] = []
  for (let m = dayStartMin; m <= dayEndMin; m += 60) hourMarks.push(m)

  return { columns, byColumn, dayStartMin, dayEndMin, hourMarks, count: placed.length }
}

/** Grid row index (1-based) for a minute-of-day, clamped into the rendered range. */
function rowFor(minutes: number, dayStartMin: number, dayEndMin: number): number {
  const clamped = Math.max(dayStartMin, Math.min(minutes, dayEndMin))
  return Math.round((clamped - dayStartMin) / SLOT_MIN) + 2 // +1 for 1-based, +1 for the header row
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

/**
 * Public agenda grid (rubric EMB-06/07/08): room columns x a time gutter, with
 * each session positioned by its start/end time in the event timezone.
 *
 * Layout is one CSS grid per day: column 1 is the sticky time gutter, one
 * track per room in use that day (plus an "Unscheduled" column for accepted
 * sessions with no room), and an explicit row per 5-minute slot so a block is
 * simply `grid-row: startSlot / endSlot`. Overlapping sessions inside a room
 * are split into lanes (percentage width + offset) so they never sit on top of
 * one another. The grid scrolls horizontally inside its own container, which
 * is how a 6-room event stays usable on a phone.
 */
export function AgendaWidget({ eventSlug, filter }: AgendaWidgetProps) {
  const [feed, setFeed] = useState<AgendaFeed | null | undefined>(undefined)
  const [day, setDay] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setFeed(undefined)
    fetchAgenda(eventSlug).then((data) => {
      if (!cancelled) setFeed(applyFeedFilter(data, filter))
    })
    return () => {
      cancelled = true
    }
  }, [eventSlug, filter?.track, filter?.day])

  // Days the tab strip offers (EMB-07): when the event has a start/end date
  // range, every event day gets a tab — including days with nothing
  // scheduled yet, which render an empty state rather than disappearing.
  // Falls back to the feed's own day list (plus any day a session lands on
  // that the feed omitted) when the event carries no date range.
  const days = useMemo(() => {
    if (!feed) return []
    if (feed.event.starts_at && feed.event.ends_at) {
      return eventDays(feed.event.starts_at, feed.event.ends_at, feed.event.timezone)
    }
    const set = new Set<string>(feed.days)
    for (const s of feed.sessions) set.add(s.day)
    return [...set].sort()
  }, [feed])

  // Default day: today if the event is running, else the first day with content.
  useEffect(() => {
    if (!feed || days.length === 0) {
      setDay(null)
      return
    }
    setDay((current) => {
      if (current && days.includes(current)) return current
      const today = utcToLocal(new Date().toISOString(), feed.event.timezone).day
      if (days.includes(today)) return today
      const populated = days.find((d) => feed.sessions.some((s) => s.day === d))
      return populated ?? days[0] ?? null
    })
  }, [feed, days])

  const layout = useMemo(
    () => (feed && day ? buildDayLayout(feed, day) : null),
    [feed, day],
  )

  const selected = useMemo(
    () => (feed && selectedId ? feed.sessions.find((s) => s.id === selectedId) ?? null : null),
    [feed, selectedId],
  )

  /**
   * Descriptions are organiser-authored rich text (HTML). The modal renders
   * text nodes, so splitting the raw value on blank lines printed the markup
   * verbatim ("<p>…</p>"); `toParagraphs` strips the tags and keeps the
   * paragraphing — the same treatment SessionsWidget's cards get.
   */
  const descriptionParagraphs = useMemo(
    () => (selected?.description ? toParagraphs(selected.description) : []),
    [selected],
  )

  // Escape closes the detail overlay; focus moves into it on open so keyboard
  // and screen-reader users land on the content they just opened.
  useEffect(() => {
    if (!selected) return
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selected])

  if (feed === undefined) return <p className="muted">Loading agenda…</p>
  if (feed === null)
    return <p className="event-widget-empty">The agenda isn't published yet — check back soon.</p>

  const tz = feed.event.timezone
  const roomById = new Map<string, PublicRoom>(feed.rooms.map((r) => [r.id, r]))
  const trackById = new Map(feed.tracks.map((t) => [t.id, t]))

  if (!layout || days.length === 0) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: agendaCss }} />
        <p className="event-widget-empty">No sessions are on the schedule yet — check back soon.</p>
      </>
    )
  }

  const zone = tzAbbr(tz, feed.sessions[0]?.starts_at ?? new Date().toISOString())
  const gridColumns = `var(--ag-gutter) repeat(${layout.columns.length}, minmax(var(--ag-col), 1fr))`
  const rowCount = Math.max(1, Math.round((layout.dayEndMin - layout.dayStartMin) / SLOT_MIN))

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: agendaCss }} />

      <div className="ag-toolbar">
        <div className="ag-days" role="tablist" aria-label="Agenda days">
          {days.map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={d === day}
              className={d === day ? 'ag-day ag-day-active' : 'ag-day'}
              onClick={() => {
                setSelectedId(null)
                setDay(d)
              }}
            >
              {fmtDayShort(d)}
            </button>
          ))}
        </div>
        <a className="ag-ics" href={agendaIcsUrl(eventSlug)}>
          Add to calendar
        </a>
      </div>

      <p className="muted ag-daymeta">
        {day ? fmtDayLong(day) : ''} · {layout.count} session{layout.count === 1 ? '' : 's'} · all times{' '}
        {zone}
      </p>

      {layout.count === 0 ? (
        <p className="event-widget-empty">Nothing scheduled on this day.</p>
      ) : (
        <div className="ag-scroll">
          <div
            className="ag-grid"
            style={{
              gridTemplateColumns: gridColumns,
              gridTemplateRows: `auto repeat(${rowCount}, ${SLOT_PX}px)`,
            }}
          >
            <div className="ag-corner" style={{ gridColumn: 1, gridRow: 1 }} />
            {layout.columns.map((col, i) => (
              <div className="ag-colhead" key={col.key} style={{ gridColumn: i + 2, gridRow: 1 }}>
                <span className="ag-colhead-name">{col.label}</span>
                {col.sub && <span className="ag-colhead-sub">{col.sub}</span>}
              </div>
            ))}

            {layout.hourMarks.slice(0, -1).map((m) => {
              const row = rowFor(m, layout.dayStartMin, layout.dayEndMin)
              return (
                <div
                  key={`line-${m}`}
                  className="ag-hourline"
                  aria-hidden="true"
                  style={{ gridColumn: '1 / -1', gridRow: `${row} / span 1` }}
                />
              )
            })}

            {layout.hourMarks.slice(0, -1).map((m) => (
              <div
                key={`label-${m}`}
                className="ag-gutter"
                style={{
                  gridColumn: 1,
                  gridRow: `${rowFor(m, layout.dayStartMin, layout.dayEndMin)} / span ${60 / SLOT_MIN}`,
                }}
              >
                {fmtMinutes(m)}
              </div>
            ))}

            {layout.columns.map((col, colIndex) =>
              (layout.byColumn.get(col.key) ?? []).map((p) => {
                const s = p.session
                const track = s.track_id ? trackById.get(s.track_id) : undefined
                const startRow = rowFor(p.startMin, layout.dayStartMin, layout.dayEndMin)
                const endRow = Math.max(startRow + 1, rowFor(p.endMin, layout.dayStartMin, layout.dayEndMin))
                const durationMin = p.endMin - p.startMin
                const width = 100 / p.lanes
                return (
                  <button
                    type="button"
                    key={s.id}
                    className="ag-block"
                    style={{
                      gridColumn: colIndex + 2,
                      gridRow: `${startRow} / ${endRow}`,
                      width: `calc(${width}% - 3px)`,
                      marginInlineStart: `${width * p.lane}%`,
                      ...(track?.color ? { ['--ag-track' as string]: track.color } : {}),
                    }}
                    onClick={() => setSelectedId(s.id)}
                    aria-label={`${s.title}, ${fmtMinutes(p.startMin)} to ${fmtMinutes(p.displayEndMin)}, ${col.label}`}
                    title={`${s.title} — ${fmtMinutes(p.startMin)} – ${fmtMinutes(p.displayEndMin)}`}
                  >
                    <span className="ag-block-time">
                      {fmtMinutes(p.startMin)} – {fmtMinutes(p.displayEndMin)}
                    </span>
                    <span className="ag-block-title">{s.title}</span>
                    {durationMin >= 40 && s.speakers.length > 0 && (
                      <span className="ag-block-speakers">{s.speakers.join(', ')}</span>
                    )}
                    {durationMin >= 60 && track && <span className="ag-block-track">{track.name}</span>}
                  </button>
                )
              }),
            )}
          </div>
        </div>
      )}

      {selected && (
        <div className="ag-overlay" onClick={() => setSelectedId(null)}>
          <div
            className="ag-panel"
            role="dialog"
            aria-modal="true"
            aria-label={selected.title}
            tabIndex={-1}
            ref={panelRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ag-panel-head">
              <button type="button" className="ag-back" onClick={() => setSelectedId(null)}>
                ← Back to agenda
              </button>
            </div>
            <h2 className="ag-panel-title">{selected.title}</h2>
            <p className="ag-panel-when">
              {fmtDayLong(selected.day)} ·{' '}
              {fmtMinutes(utcToLocal(selected.starts_at, tz).minutes)} –{' '}
              {fmtMinutes(
                (() => {
                  const start = utcToLocal(selected.starts_at, tz)
                  const end = utcToLocal(selected.ends_at, tz)
                  return end.day === start.day && end.minutes > start.minutes ? end.minutes : 24 * 60
                })(),
              )}{' '}
              {zone}
            </p>
            <dl className="ag-facts">
              <dt>Room</dt>
              <dd>
                {(selected.room_id ? roomById.get(selected.room_id)?.name : null) ??
                  'Not yet assigned'}
              </dd>
              <dt>Format</dt>
              <dd>{selected.format ?? '—'}</dd>
              <dt>Track</dt>
              <dd>{(selected.track_id ? trackById.get(selected.track_id)?.name : null) ?? '—'}</dd>
              {selected.level && (
                <>
                  <dt>Level</dt>
                  <dd>{selected.level}</dd>
                </>
              )}
              {selected.speakers.length > 0 && (
                <>
                  <dt>{selected.speakers.length === 1 ? 'Speaker' : 'Speakers'}</dt>
                  <dd>{selected.speakers.join(', ')}</dd>
                </>
              )}
            </dl>
            {descriptionParagraphs.length > 0 ? (
              <div className="ag-panel-desc">
                {descriptionParagraphs.map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            ) : (
              <p className="muted">No description provided.</p>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Scoped to `.ag-*` and injected next to the markup, the same way EventPage
 * injects `eventShellCss` — the public pages have no stylesheet pipeline, and
 * this widget must not reach into files another lane owns. Colours come from
 * the Page.tsx custom properties so light/dark both work.
 */
const agendaCss = `
.ag-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .5rem; }
.ag-days { display: flex; flex-wrap: wrap; gap: .3rem; }
.ag-day { padding: .35rem .8rem; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--muted); font-size: .9rem; cursor: pointer; }
.ag-day:hover { color: var(--fg); border-color: var(--accent); }
.ag-day-active, .ag-day-active:hover { color: var(--accent); border-color: var(--accent); font-weight: 600; background: color-mix(in srgb, var(--accent) 12%, transparent); }
.ag-ics { font-size: .85rem; color: var(--muted); text-decoration: none; border-bottom: 1px dotted currentColor; }
.ag-ics:hover { color: var(--accent); }
.ag-daymeta { margin: 0 0 .75rem; font-size: .85rem; }

.ag-scroll { overflow-x: auto; overflow-y: visible; border: 1px solid var(--line); border-radius: 12px; }
/* min-content = the gutter plus one --ag-col per room, so wide events overflow
   into the container's horizontal scroll instead of squeezing columns. Using
   max-content here would let a long session title dictate column width. */
.ag-grid { --ag-gutter: 62px; --ag-col: 170px; display: grid; position: relative; min-width: min-content; }

.ag-corner, .ag-colhead { position: sticky; top: 0; z-index: 3; background: var(--bg); border-bottom: 1px solid var(--line); padding: .5rem .6rem; }
.ag-corner { left: 0; z-index: 4; }
.ag-colhead { display: flex; flex-direction: column; gap: .1rem; border-left: 1px solid var(--line); }
.ag-colhead-name { font-weight: 600; font-size: .9rem; }
.ag-colhead-sub { color: var(--muted); font-size: .72rem; }

.ag-gutter { position: sticky; left: 0; z-index: 2; grid-column: 1; background: var(--bg); color: var(--muted); font-size: .72rem; padding: 2px .5rem 0 .6rem; text-align: right; border-right: 1px solid var(--line); }
.ag-hourline { border-top: 1px solid var(--line); pointer-events: none; z-index: 0; }

.ag-block { position: relative; z-index: 1; overflow: hidden; display: flex; flex-direction: column; gap: .1rem; align-items: flex-start; text-align: left; margin-block: 1px; padding: .3rem .45rem; font: inherit; font-size: .78rem; line-height: 1.25; cursor: pointer; color: var(--fg); border: 1px solid var(--line); border-left: 3px solid var(--ag-track, var(--accent)); border-radius: 7px; background: color-mix(in srgb, var(--ag-track, var(--accent)) 10%, var(--bg)); }
.ag-block:hover, .ag-block:focus-visible { border-color: var(--accent); background: color-mix(in srgb, var(--ag-track, var(--accent)) 22%, var(--bg)); }
.ag-block-time { color: var(--muted); font-size: .7rem; white-space: nowrap; }
.ag-block-title { font-weight: 600; }
.ag-block-speakers, .ag-block-track { color: var(--muted); font-size: .7rem; }

.ag-overlay { position: fixed; inset: 0; z-index: 50; background: color-mix(in srgb, #000 55%, transparent); display: flex; align-items: flex-start; justify-content: center; padding: 4vh 1rem; overflow-y: auto; }
.ag-panel { background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 14px; padding: 1.25rem 1.4rem 1.5rem; max-width: 44rem; width: 100%; }
.ag-panel:focus { outline: none; }
.ag-panel-head { margin-bottom: .75rem; }
.ag-back { font-size: .85rem; }
.ag-panel-title { margin: 0 0 .25rem; font-size: 1.35rem; }
.ag-panel-when { margin: 0 0 1rem; color: var(--muted); font-size: .9rem; }
.ag-facts { display: grid; grid-template-columns: max-content 1fr; gap: .35rem .9rem; margin: 0 0 1rem; font-size: .9rem; }
.ag-facts dt { color: var(--muted); }
.ag-facts dd { margin: 0; }
.ag-panel-desc p { margin: 0 0 .75rem; }
.ag-panel-desc p:last-child { margin-bottom: 0; }

@media (max-width: 640px) {
  .ag-grid { --ag-col: 150px; --ag-gutter: 54px; }
}
`

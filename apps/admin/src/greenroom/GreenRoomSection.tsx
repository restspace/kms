// Green room / run-of-show (workplan 12): the day-of screen. Who is on
// now/next in each room, has the speaker arrived, are their slides in, and
// how to reach them. Mobile-first — this is read standing in a corridor on
// conference wifi — so it polls the dashboard way (ETag + jitter, a 304 costs
// nothing) and every actionable control is at least 44px tall.
//
// All time comparisons are UTC instants against the device clock; the event
// timezone (from the payload) is display-only, through agenda/timeUtils.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchGreenRoom,
  greenroomCheckin,
  greenroomNudge,
  type GreenRoomPayload,
  type GreenRoomSession,
  type GreenRoomSpeaker,
} from '../api'
import { fmtDay, fmtRange, fmtMinutes, tzAbbr, utcToLocal } from '../agenda/timeUtils'
import { navigate } from '../router'
import { deriveNowNext, pickDay, sessionEndMs, startsInLabel, telHref, timeLeftLabel, windowByDay } from './logic'
import './greenroom.css'

const POLL_MS = 15_000
const NOW_TICK_MS = 30_000

function agoLabel(updatedAt: number | null): string {
  if (updatedAt === null) return ''
  const s = Math.max(0, Math.round((Date.now() - updatedAt) / 1000))
  if (s < 5) return 'updated just now'
  if (s < 60) return `updated ${s}s ago`
  return `updated ${Math.floor(s / 60)}m ago`
}

function ReadinessChips({ speaker }: { speaker: GreenRoomSpeaker }) {
  if (!speaker.on_roster) {
    return <span className="gr-chip gr-chip-warn">not on the event roster</span>
  }
  const chips: string[] = []
  if (speaker.missing_slides === 1) chips.push('slides missing')
  if (speaker.missing_headshot === 1) chips.push('no headshot')
  if (speaker.missing_bio === 1) chips.push('no bio')
  if (chips.length === 0) return null
  return (
    <>
      {chips.map((label) => (
        <span key={label} className="gr-chip gr-chip-warn">{label}</span>
      ))}
    </>
  )
}

interface SpeakerRowProps {
  contactId: string
  speaker: GreenRoomSpeaker
  busy: boolean
  nudgeNote: string | null
  onToggleArrived: (contactId: string, arrived: boolean) => void
  onNudge: (contactId: string) => void
}

function SpeakerRow({ contactId, speaker, busy, nudgeNote, onToggleArrived, onNudge }: SpeakerRowProps) {
  const arrived = speaker.arrived_at !== null
  const phone = telHref(speaker.mobile_phone)
  const needsSomething =
    speaker.on_roster &&
    (speaker.missing_slides === 1 || speaker.missing_bio === 1 || speaker.missing_headshot === 1 || speaker.outstanding > 0)
  return (
    <div className="gr-speaker">
      <button
        type="button"
        className={`gr-arrive ${arrived ? 'is-arrived' : ''}`}
        disabled={busy || !speaker.on_roster}
        title={
          speaker.on_roster
            ? arrived
              ? 'Tap to undo the check-in'
              : 'Tap when the speaker arrives on-site'
            : 'This person has no roster entry for this event, so arrival cannot be recorded.'
        }
        onClick={() => onToggleArrived(contactId, !arrived)}
      >
        <span className="gr-arrive-dot" aria-hidden="true" />
        {arrived ? `Arrived ${fmtMinutesOf(speaker.arrived_at as string)}` : 'Not arrived'}
      </button>
      <div className="gr-speaker-main">
        <div className="gr-speaker-name">{speaker.name}</div>
        <div className="gr-speaker-meta">
          <ReadinessChips speaker={speaker} />
          {nudgeNote && <span className="gr-chip gr-chip-note">{nudgeNote}</span>}
        </div>
      </div>
      <div className="gr-speaker-actions">
        {phone ? (
          <a className="gr-action" href={phone}>Call</a>
        ) : (
          <span className="gr-action gr-action-none" title="No mobile number on file">no number</span>
        )}
        {needsSomething && (
          <button type="button" className="gr-action" disabled={busy} onClick={() => onNudge(contactId)}>
            Nudge
          </button>
        )}
      </div>
    </div>
  )
}

/** Local-time HH:MM of an arrival instant, in the DEVICE timezone — the tap
 * happened here, in the corridor, and "Arrived 9:12 AM" should read like the
 * organiser's watch. */
function fmtMinutesOf(iso: string): string {
  const d = new Date(iso)
  return fmtMinutes(d.getHours() * 60 + d.getMinutes())
}

interface SessionCardProps {
  session: GreenRoomSession
  tz: string
  kind: 'now' | 'next' | 'later'
  label: string | null
  speakers: Record<string, GreenRoomSpeaker>
  busyIds: ReadonlySet<string>
  nudgeNotes: Record<string, string>
  onToggleArrived: (contactId: string, arrived: boolean) => void
  onNudge: (contactId: string) => void
}

function SessionCard({ session, tz, kind, label, speakers, busyIds, nudgeNotes, onToggleArrived, onNudge }: SessionCardProps) {
  return (
    <article className={`gr-card gr-card-${kind}`}>
      <header className="gr-card-head">
        <span className="gr-card-when">
          {kind === 'now' ? 'On now' : kind === 'next' ? 'Up next' : ''}
          {label && <em>{label}</em>}
        </span>
        <span className="gr-card-time">
          {session.ends_at ? fmtRange(session.starts_at, session.ends_at, tz) : fmtMinutes(utcToLocal(session.starts_at, tz).minutes)}
        </span>
      </header>
      <h4 className="gr-card-title">{session.title}</h4>
      <div className="gr-card-sub">
        {session.code}
        {session.format ? ` · ${session.format}` : ''}
        {session.track_name ? ` · ${session.track_name}` : ''}
      </div>
      <div className="gr-card-speakers">
        {session.speaker_ids.length === 0 && <span className="gr-empty-note">No speakers attached.</span>}
        {session.speaker_ids.map((id) =>
          speakers[id] ? (
            <SpeakerRow
              key={id}
              contactId={id}
              speaker={speakers[id]}
              busy={busyIds.has(id)}
              nudgeNote={nudgeNotes[id] ?? null}
              onToggleArrived={onToggleArrived}
              onNudge={onNudge}
            />
          ) : null,
        )}
      </div>
    </article>
  )
}

export function GreenRoomSection() {
  const [data, setData] = useState<GreenRoomPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [, setAgoTick] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [dayOverride, setDayOverride] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const [nudgeNotes, setNudgeNotes] = useState<Record<string, string>>({})
  const [note, setNote] = useState<string | null>(null)
  const etagRef = useRef<string | null>(null)
  // Bumped by every write; a poll that resolves across a write is stale and
  // must not clobber the write's optimistic (or adopted) state.
  const writeSeqRef = useRef(0)

  const load = useCallback(async (force = false) => {
    const seq = writeSeqRef.current
    try {
      const result = await fetchGreenRoom(force ? null : etagRef.current)
      if (writeSeqRef.current !== seq) return
      if (result.fresh) {
        setData(result.payload)
        etagRef.current = result.etag
      }
      setUpdatedAt(Date.now())
      setError(null)
    } catch (err) {
      if (writeSeqRef.current !== seq) return
      setError(err instanceof Error ? err.message : 'Failed to load the green room')
    }
  }, [])

  // ETag poll — the dashboard's loop (DashboardSection.tsx): self-rescheduling
  // timeout, ±15% jitter, skip while hidden, immediate refetch on visibility.
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const jitteredDelay = () => POLL_MS * (1 + (Math.random() * 0.3 - 0.15))
    const scheduleNext = () => {
      if (cancelled) return
      timer = window.setTimeout(tick, jitteredDelay())
    }
    const tick = () => {
      if (cancelled) return
      if (document.visibilityState === 'hidden') {
        scheduleNext()
        return
      }
      void load().finally(scheduleNext)
    }
    void load(true)
    scheduleNext()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    const agoTimer = window.setInterval(() => setAgoTick((t) => t + 1), 5_000)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.clearInterval(agoTimer)
    }
  }, [load])

  // The clock advances between polls: re-derive now/next twice a minute.
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), NOW_TICK_MS)
    return () => window.clearInterval(t)
  }, [])

  const toggleArrived = useCallback((contactId: string, arrived: boolean) => {
    writeSeqRef.current += 1
    setNote(null)
    setBusyIds((prev) => new Set(prev).add(contactId))
    // Optimistic flip; the server payload replaces it (or the catch reverts it).
    setData((prev) =>
      prev
        ? {
            ...prev,
            speakers: {
              ...prev.speakers,
              [contactId]: { ...prev.speakers[contactId], arrived_at: arrived ? new Date().toISOString() : null },
            },
          }
        : prev,
    )
    void greenroomCheckin(contactId, arrived)
      .then((res) => {
        const { ok: _ok, etag, ...payload } = res
        setData(payload as GreenRoomPayload)
        etagRef.current = etag
        setUpdatedAt(Date.now())
      })
      .catch((err) => {
        setData((prev) =>
          prev
            ? {
                ...prev,
                speakers: {
                  ...prev.speakers,
                  [contactId]: { ...prev.speakers[contactId], arrived_at: arrived ? null : new Date().toISOString() },
                },
              }
            : prev,
        )
        setNote(err instanceof Error ? err.message : 'Check-in failed')
      })
      .finally(() => {
        setBusyIds((prev) => {
          const next = new Set(prev)
          next.delete(contactId)
          return next
        })
      })
  }, [])

  const nudge = useCallback((contactId: string) => {
    setNote(null)
    setBusyIds((prev) => new Set(prev).add(contactId))
    void greenroomNudge(contactId)
      .then((res) => {
        setNudgeNotes((prev) => ({
          ...prev,
          [contactId]:
            res.sent > 0
              ? `reminder sent`
              : res.duplicates > 0
                ? 'already nudged today'
                : 'nothing sent',
        }))
      })
      .catch((err) => {
        setNudgeNotes((prev) => ({ ...prev, [contactId]: err instanceof Error ? err.message : 'Nudge failed' }))
      })
      .finally(() => {
        setBusyIds((prev) => {
          const next = new Set(prev)
          next.delete(contactId)
          return next
        })
      })
  }, [])

  if (error && !data) {
    return (
      <div className="gr-shell">
        <div className="gr-state gr-state-error">
          <p>{error}</p>
          <button type="button" className="gr-action" onClick={() => void load(true)}>Try again</button>
        </div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="gr-shell">
        <div className="gr-state">Loading the run of show…</div>
      </div>
    )
  }

  const tz = data.event.timezone
  const byDay = windowByDay(data.sessions, tz)
  const days = [...byDay.keys()]
  const todayLocal = utcToLocal(new Date(nowMs).toISOString(), tz).day
  const shownDay = dayOverride && days.includes(dayOverride) ? dayOverride : pickDay(days, todayLocal)
  const daySessions = shownDay ? (byDay.get(shownDay) ?? []) : []
  const isToday = shownDay === todayLocal
  const dayDone =
    isToday && daySessions.length > 0 && daySessions.every((s) => sessionEndMs(s) <= nowMs)
  const nextDay = shownDay ? days.find((d) => d > shownDay) : undefined

  // Rooms with anything on the shown day first, in position order; a room
  // with nothing scheduled stays visible but folded to one muted line.
  const roomsWithSessions = data.rooms.filter((r) => daySessions.some((s) => s.room_id === r.id))
  const emptyRooms = data.rooms.filter((r) => !daySessions.some((s) => s.room_id === r.id))
  // Sessions can point at a deleted/unknown room only transiently; keep them
  // visible under a synthetic lane rather than dropping them.
  const knownRoomIds = new Set(data.rooms.map((r) => r.id))
  const orphaned = daySessions.filter((s) => !knownRoomIds.has(s.room_id))

  return (
    <div className="gr-shell">
      <header className="gr-header">
        <div className="gr-header-main">
          <h2>Green room</h2>
          <div className="gr-header-sub">
            {data.event.name}
            {shownDay ? ` — ${fmtDay(shownDay)} (${tzAbbr(tz, data.now)})` : ''}
          </div>
        </div>
        <span className="gr-updated" role="status">{agoLabel(updatedAt)}</span>
      </header>

      {days.length > 1 && (
        <div className="gr-days" role="tablist" aria-label="Event days">
          {days.map((day) => (
            <button
              key={day}
              type="button"
              role="tab"
              aria-selected={day === shownDay}
              className={`gr-day ${day === shownDay ? 'active' : ''}`}
              onClick={() => setDayOverride(day)}
            >
              {fmtDay(day)}
              {day === todayLocal ? ' · today' : ''}
            </button>
          ))}
        </div>
      )}

      {note && <div className="gr-note" role="alert">{note}</div>}

      {days.length === 0 ? (
        <div className="gr-state">
          <p>Nothing is scheduled yet — the run of show appears once accepted sessions have a room and a time slot.</p>
          <button type="button" className="gr-action" onClick={() => navigate({ v: 'agenda' })}>
            Open the agenda
          </button>
        </div>
      ) : (
        <>
          {!isToday && shownDay && (
            <div className="gr-banner">
              {shownDay > todayLocal
                ? `Nothing scheduled today — showing ${fmtDay(shownDay)}.`
                : `The event has wrapped — showing ${fmtDay(shownDay)}.`}
            </div>
          )}
          {dayDone && (
            <div className="gr-banner">
              Done for today.
              {nextDay && (
                <button type="button" className="gr-banner-link" onClick={() => setDayOverride(nextDay)}>
                  See {fmtDay(nextDay)}
                </button>
              )}
            </div>
          )}
          <div className="gr-rooms">
            {roomsWithSessions.map((room) => {
              const { current, next, later } = deriveNowNext(daySessions, room.id, nowMs)
              const cardProps = {
                tz,
                speakers: data.speakers,
                busyIds,
                nudgeNotes,
                onToggleArrived: toggleArrived,
                onNudge: nudge,
              }
              return (
                <section key={room.id} className="gr-room" aria-label={room.name}>
                  <h3 className="gr-room-name">{room.name}</h3>
                  {current && (
                    <SessionCard session={current} kind="now" label={timeLeftLabel(current, nowMs)} {...cardProps} />
                  )}
                  {next && (
                    <SessionCard
                      session={next}
                      kind="next"
                      label={isToday ? startsInLabel(next, nowMs) : null}
                      {...cardProps}
                    />
                  )}
                  {!current && !next && (
                    <div className="gr-room-empty">Done in this room{isToday ? ' for today' : ''}.</div>
                  )}
                  {later.length > 0 && (
                    <details className="gr-later">
                      <summary>
                        {later.length} more {isToday ? 'later today' : 'this day'}
                      </summary>
                      {later.map((s) => (
                        <SessionCard key={s.id} session={s} kind="later" label={null} {...cardProps} />
                      ))}
                    </details>
                  )}
                </section>
              )
            })}
            {orphaned.length > 0 && (
              <section className="gr-room" aria-label="No room">
                <h3 className="gr-room-name">No room assigned</h3>
                {orphaned.map((s) => (
                  <SessionCard
                    key={s.id}
                    session={s}
                    kind="later"
                    label={null}
                    tz={tz}
                    speakers={data.speakers}
                    busyIds={busyIds}
                    nudgeNotes={nudgeNotes}
                    onToggleArrived={toggleArrived}
                    onNudge={nudge}
                  />
                ))}
              </section>
            )}
            {emptyRooms.length > 0 && (
              <div className="gr-empty-rooms">
                {emptyRooms.map((r) => (
                  <span key={r.id} className="gr-chip">{r.name}: nothing scheduled</span>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

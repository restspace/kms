import { useRef, useState } from 'react'
import type { AgendaRoom, AgendaSessionRow, AgendaTrack } from '../api'
import { durationMinutes, fmtDay, formatMinutes, utcToLocal } from './timeUtils'
import { ModalDialog } from '../components/dialogs'
import { navigate } from '../router'

/**
 * The keyboard "Move session" dialog (docs/07 §3 a11y alternative — everything
 * drag-and-drop does: room, date, time, duration, unschedule) and the minimal
 * "+ Add Session" dialog (docs/07 §5 — stored as a manual accepted submission).
 */

const toTimeValue = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

const fromTimeValue = (value: string): number => {
  const [h, m] = value.split(':').map(Number)
  return (h as number) * 60 + (m as number)
}

/** Shortest bookable block; typing less snaps back to it on blur. */
export const MIN_DURATION_MIN = 5

/**
 * Duration is held as text so a half-typed value stays visible, and clamped
 * on blur so a rejected `0` visibly settles on the minimum rather than
 * silently reverting (manual-review “duration 0 does not visibly clamp”).
 */
const clampDuration = (text: string): number => {
  const n = Math.round(Number(text))
  return Number.isFinite(n) && n >= MIN_DURATION_MIN ? n : MIN_DURATION_MIN
}

/** Optional seat count: blank clears it, anything else is at least 1. */
const clampCapacity = (text: string): number | null => {
  if (text.trim() === '') return null
  const n = Math.round(Number(text))
  return Number.isFinite(n) && n >= 1 ? n : 1
}

export interface MoveResult {
  day: string
  startMin: number
  durationMin: number
  roomId: string | null
  /** null clears the seat count; absent is impossible — the field always reports. */
  capacity: number | null
}

interface MoveDialogProps {
  session: AgendaSessionRow
  rooms: AgendaRoom[]
  days: string[]
  timezone: string
  defaultDurationMin: number
  onSave: (result: MoveResult) => void
  onUnschedule: () => void
  onClose: () => void
}

export function MoveDialog({
  session,
  rooms,
  days,
  timezone,
  defaultDurationMin,
  onSave,
  onUnschedule,
  onClose,
}: MoveDialogProps) {
  const scheduled = session.starts_at !== null && session.ends_at !== null
  const local = scheduled ? utcToLocal(session.starts_at as string, timezone) : null
  const [day, setDay] = useState(local?.day ?? days[0] ?? '')
  const [time, setTime] = useState(toTimeValue(local?.minutes ?? 600))
  const [duration, setDuration] = useState(
    String(scheduled ? durationMinutes(session.starts_at as string, session.ends_at as string) : defaultDurationMin),
  )
  const [capacity, setCapacity] = useState(session.capacity === null ? '' : String(session.capacity))
  const [roomId, setRoomId] = useState(session.room_id ?? '')
  const dayRef = useRef<HTMLSelectElement | null>(null)

  return (
    <ModalDialog
      open
      title="Move session"
      onClose={onClose}
      initialFocusRef={dayRef}
      footer={
        <div className="agenda-dialog-actions">
          {scheduled && (
            <button className="danger" onClick={onUnschedule}>Unschedule</button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!day || !time}
            onClick={() =>
              onSave({
                day,
                startMin: fromTimeValue(time),
                durationMin: clampDuration(duration),
                roomId: roomId || null,
                capacity: clampCapacity(capacity),
              })
            }
          >
            Save
          </button>
        </div>
      }
    >
      <p className="agenda-dialog-sub">
        {session.code} · {session.title}
        <button
          type="button"
          className="agenda-dialog-open-link"
          title="Open submission in Workspace"
          onClick={() => {
            onClose()
            navigate({ v: 'workspace', tab: 'submissions', rec: session.id })
          }}
        >
          Open submission ↗
        </button>
      </p>
      <div className="agenda-dialog-grid">
        <label>
          Date
          <select ref={dayRef} value={day} onChange={(e) => setDay(e.target.value)}>
            {days.map((d) => (
              <option key={d} value={d}>{fmtDay(d)}</option>
            ))}
          </select>
        </label>
        <label>
          Start
          <input type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label>
          Duration (min)
          <input
            type="number"
            min={MIN_DURATION_MIN}
            step={5}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            onBlur={() => setDuration(String(clampDuration(duration)))}
          />
        </label>
        <label>
          Capacity
          <input
            type="number"
            min={1}
            step={1}
            value={capacity}
            placeholder="No limit"
            onChange={(e) => setCapacity(e.target.value)}
            onBlur={() => {
              const next = clampCapacity(capacity)
              setCapacity(next === null ? '' : String(next))
            }}
          />
        </label>
        <label>
          Room
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">No room</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}{r.capacity !== null ? ` (${r.capacity})` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
    </ModalDialog>
  )
}

interface AddSessionDialogProps {
  tracks: AgendaTrack[]
  rooms: AgendaRoom[]
  days: string[]
  onSave: (body: {
    title: string
    track_id: string | null
    format: string | null
    room_id: string | null
    day: string | null
    startMin: number | null
    durationMin: number
    capacity: number | null
  }) => void
  onClose: () => void
}

const FORMATS = ['Keynote', 'Featured Keynote', 'Talk', 'Workshop', 'Panel', 'Lightning Talk']

export function AddSessionDialog({ tracks, rooms, days, onSave, onClose }: AddSessionDialogProps) {
  const [title, setTitle] = useState('')
  const [trackId, setTrackId] = useState('')
  const [format, setFormat] = useState('Talk')
  const [roomId, setRoomId] = useState('')
  const [day, setDay] = useState('')
  const [time, setTime] = useState('10:00')
  const [duration, setDuration] = useState('30')
  const [capacity, setCapacity] = useState('')
  const titleRef = useRef<HTMLInputElement | null>(null)

  return (
    <ModalDialog
      open
      title="Add session"
      onClose={onClose}
      initialFocusRef={titleRef}
      footer={
        <div className="agenda-dialog-actions">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={title.trim() === ''}
            onClick={() =>
              onSave({
                title: title.trim(),
                track_id: trackId || null,
                format: format || null,
                room_id: roomId || null,
                day: day || null,
                startMin: day ? fromTimeValue(time) : null,
                durationMin: clampDuration(duration),
                capacity: clampCapacity(capacity),
              })
            }
          >
            Add session
          </button>
        </div>
      }
    >
      <p className="agenda-dialog-sub">Created as a manual, already-accepted session — one pipeline.</p>
      <label className="agenda-dialog-full">
        Title
        <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Session title" />
      </label>
      <div className="agenda-dialog-grid">
        <label>
          Track
          <select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
            <option value="">No track</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label>
          Format
          <select
            value={format}
            onChange={(e) => {
              // Follow the format's stated minutes (eval defect: lightning
              // talks landing as 30-min blocks) — but never clobber a duration
              // the organiser already typed over the old format's default.
              const next = e.target.value
              setDuration((cur) =>
                Number(cur) === (formatMinutes(format) ?? 30) ? String(formatMinutes(next) ?? 30) : cur,
              )
              setFormat(next)
            }}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </label>
        <label>
          Room
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">No room</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
        <label>
          Date
          <select value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="">Unscheduled</option>
            {days.map((d) => (
              <option key={d} value={d}>{fmtDay(d)}</option>
            ))}
          </select>
        </label>
        <label>
          Start
          <input type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} disabled={!day} />
        </label>
        <label>
          Duration (min)
          <input
            type="number"
            min={MIN_DURATION_MIN}
            step={5}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            onBlur={() => setDuration(String(clampDuration(duration)))}
            disabled={!day}
          />
        </label>
        <label>
          Capacity
          <input
            type="number"
            min={1}
            step={1}
            value={capacity}
            placeholder="No limit"
            onChange={(e) => setCapacity(e.target.value)}
            onBlur={() => {
              const next = clampCapacity(capacity)
              setCapacity(next === null ? '' : String(next))
            }}
          />
        </label>
      </div>
    </ModalDialog>
  )
}

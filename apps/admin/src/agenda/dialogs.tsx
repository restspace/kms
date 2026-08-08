import { useEffect, useState } from 'react'
import type { AgendaRoom, AgendaSessionRow, AgendaTrack } from '../api'
import { durationMinutes, fmtDay, utcToLocal } from './timeUtils'

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

export interface MoveResult {
  day: string
  startMin: number
  durationMin: number
  roomId: string | null
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
    scheduled ? durationMinutes(session.starts_at as string, session.ends_at as string) : defaultDurationMin,
  )
  const [roomId, setRoomId] = useState(session.room_id ?? '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="agenda-dialog-scrim" onClick={onClose}>
      <div
        className="agenda-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${session.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Move session</h3>
        <p className="agenda-dialog-sub">{session.code} · {session.title}</p>
        <div className="agenda-dialog-grid">
          <label>
            Date
            <select value={day} onChange={(e) => setDay(e.target.value)} autoFocus>
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
              min={5}
              step={5}
              value={duration}
              onChange={(e) => setDuration(Math.max(5, Number(e.target.value) || 5))}
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
        <div className="agenda-dialog-actions">
          {scheduled && (
            <button className="danger" onClick={onUnschedule}>Unschedule</button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!day || !time}
            onClick={() => onSave({ day, startMin: fromTimeValue(time), durationMin: duration, roomId: roomId || null })}
          >
            Save
          </button>
        </div>
      </div>
    </div>
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
  const [duration, setDuration] = useState(30)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="agenda-dialog-scrim" onClick={onClose}>
      <div className="agenda-dialog" role="dialog" aria-modal="true" aria-label="Add session" onClick={(e) => e.stopPropagation()}>
        <h3>Add session</h3>
        <p className="agenda-dialog-sub">Created as a manual, already-accepted session — one pipeline.</p>
        <label className="agenda-dialog-full">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Session title" />
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
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
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
              min={5}
              step={5}
              value={duration}
              onChange={(e) => setDuration(Math.max(5, Number(e.target.value) || 5))}
              disabled={!day}
            />
          </label>
        </div>
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
                durationMin: duration,
              })
            }
          >
            Add session
          </button>
        </div>
      </div>
    </div>
  )
}

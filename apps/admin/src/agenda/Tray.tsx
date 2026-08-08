import { useMemo, useState } from 'react'
import type { AgendaSessionRow, AgendaTrack } from '../api'
import { getDrag, setDrag } from './dragState'

/**
 * Unscheduled tray (docs/07 §1): accepted sessions with no time or room,
 * searchable, filterable by track/format, draggable onto the calendar.
 * Dropping a scheduled block back here unschedules it (docs/07 §3).
 */

interface TrayProps {
  sessions: AgendaSessionRow[]
  tracks: AgendaTrack[]
  defaultDuration: (s: AgendaSessionRow) => number
  trackColor: (s: AgendaSessionRow) => string | null
  onUnschedule: (id: string) => void
  onOpenMove: (id: string) => void
}

export function Tray({ sessions, tracks, defaultDuration, trackColor, onUnschedule, onOpenMove }: TrayProps) {
  const [q, setQ] = useState('')
  const [trackId, setTrackId] = useState('')
  const [format, setFormat] = useState('')
  const [over, setOver] = useState(false)

  const formats = useMemo(
    () => [...new Set(sessions.map((s) => s.format).filter((f): f is string => f !== null))].sort(),
    [sessions],
  )

  const shown = sessions.filter((s) => {
    if (trackId && s.track_id !== trackId) return false
    if (format && s.format !== format) return false
    if (q) {
      const hay = `${s.code} ${s.title} ${s.speakers.map((sp) => sp.name).join(' ')}`.toLowerCase()
      if (!hay.includes(q.toLowerCase())) return false
    }
    return true
  })

  return (
    <aside
      className={`tray${over ? ' drop-over' : ''}`}
      aria-label="Unscheduled sessions"
      onDragOver={(e) => {
        const drag = getDrag()
        if (!drag || drag.fromTray) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const drag = getDrag()
        setDrag(null)
        if (drag && !drag.fromTray) onUnschedule(drag.id)
      }}
    >
      <div className="tray-head">
        <h3>
          Unscheduled <span className="tray-badge">{sessions.length}</span>
        </h3>
        <input
          type="search"
          placeholder="Search…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search unscheduled sessions"
        />
        <div className="tray-filters">
          <select value={trackId} onChange={(e) => setTrackId(e.target.value)} aria-label="Filter by track">
            <option value="">All tracks</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Filter by format">
            <option value="">All formats</option>
            {formats.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="tray-list">
        {shown.length === 0 && (
          <p className="tray-empty">
            {sessions.length === 0 ? 'Every accepted session is scheduled.' : 'No matches.'}
          </p>
        )}
        {shown.map((s) => {
          const color = trackColor(s)
          return (
            <div
              className="tray-card"
              key={s.id}
              style={color ? { ['--track-color' as string]: color } : undefined}
              draggable
              tabIndex={0}
              role="button"
              aria-label={`${s.title}. Drag onto the calendar, or press M to schedule.`}
              onDragStart={(e) => {
                setDrag({ id: s.id, durationMin: defaultDuration(s), fromTray: true })
                e.dataTransfer.setData('text/plain', s.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => setDrag(null)}
              onKeyDown={(e) => {
                if (e.key === 'm' || e.key === 'M') {
                  e.preventDefault()
                  onOpenMove(s.id)
                }
              }}
              onDoubleClick={() => onOpenMove(s.id)}
            >
              <div className="tray-card-code">
                {s.code}
                {s.format && <span className="tray-card-format">{s.format}</span>}
              </div>
              <div className="tray-card-title">{s.title}</div>
              {s.speakers.length > 0 && (
                <div className="tray-card-speakers">{s.speakers.map((sp) => sp.name).join(', ')}</div>
              )}
            </div>
          )
        })}
      </div>
      {over && <div className="tray-drop-hint">Drop to unschedule</div>}
    </aside>
  )
}

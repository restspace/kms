import { useState } from 'react'
import type { AgendaRoom, AgendaSessionRow } from '../api'
import { getDrag, setDrag } from './dragState'
import type { DropPreview } from './TimeGrid'
import { DROP_SNAP_MIN } from './TimeGrid'
import { durationMinutes, fmtDay, fmtMinutes, snapTo, utcToLocal } from './timeUtils'

/**
 * Room-major board (docs/07 §2): one lane per room across the event days —
 * the primary drag surface. Each day-cell is a horizontal mini-timeline;
 * horizontal position is time-of-day, so a drop picks room, day and time in
 * one gesture.
 */

interface RoomsBoardProps {
  rooms: AgendaRoom[]
  days: string[]
  sessions: AgendaSessionRow[]
  timezone: string
  dayStartMin: number
  dayEndMin: number
  conflictLevel: (id: string) => 'error' | 'warning' | null
  conflictTitle: (id: string) => string
  trackColor: (s: AgendaSessionRow) => string | null
  onDrop: (id: string, roomId: string, day: string, startMin: number, durationMin: number) => void
  onOpenMove: (id: string) => void
  previewDrop: (id: string, roomId: string, day: string, startMin: number, durationMin: number) => DropPreview
}

interface CellGhost {
  roomId: string
  day: string
  startMin: number
  durationMin: number
  preview: DropPreview
}

export function RoomsBoard({
  rooms,
  days,
  sessions,
  timezone,
  dayStartMin,
  dayEndMin,
  conflictLevel,
  conflictTitle,
  trackColor,
  onDrop,
  onOpenMove,
  previewDrop,
}: RoomsBoardProps) {
  const [ghost, setGhost] = useState<CellGhost | null>(null)
  const span = dayEndMin - dayStartMin

  const inCell = (s: AgendaSessionRow, roomId: string, day: string): boolean =>
    s.room_id === roomId && s.starts_at !== null && utcToLocal(s.starts_at, timezone).day === day

  const pct = (min: number) => `${((min - dayStartMin) / span) * 100}%`
  const widthPct = (dur: number) => `${(dur / span) * 100}%`

  const ghostFromEvent = (e: React.DragEvent<HTMLDivElement>, roomId: string, day: string): CellGhost | null => {
    const drag = getDrag()
    if (!drag) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const raw = dayStartMin + ((e.clientX - rect.left) / rect.width) * span
    const startMin = Math.max(dayStartMin, Math.min(snapTo(raw, DROP_SNAP_MIN), dayEndMin - drag.durationMin))
    return {
      roomId,
      day,
      startMin,
      durationMin: drag.durationMin,
      preview: previewDrop(drag.id, roomId, day, startMin, drag.durationMin),
    }
  }

  return (
    <div className="rooms-board" style={{ ['--rb-days' as string]: String(days.length) }}>
      <div className="rb-head">
        <div className="rb-room-label" />
        {days.map((day) => (
          <div className="rb-day-head" key={day}>{fmtDay(day)}</div>
        ))}
      </div>
      {rooms.map((room) => (
        <div className="rb-row" key={room.id}>
          <div className="rb-room-label">
            <span>{room.name}</span>
            {room.capacity !== null && <span className="rb-cap">{room.capacity}</span>}
          </div>
          {days.map((day) => (
            <div
              className="rb-cell"
              key={day}
              onDragOver={(e) => {
                if (!getDrag()) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setGhost(ghostFromEvent(e, room.id, day))
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setGhost((g) => (g && g.roomId === room.id && g.day === day ? null : g))
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                const drag = getDrag()
                const g =
                  ghost && ghost.roomId === room.id && ghost.day === day
                    ? ghost
                    : ghostFromEvent(e, room.id, day)
                setGhost(null)
                setDrag(null)
                if (drag && g) onDrop(drag.id, room.id, day, g.startMin, g.durationMin)
              }}
            >
              {sessions.filter((s) => inCell(s, room.id, day)).map((s) => {
                const local = utcToLocal(s.starts_at as string, timezone)
                const dur = durationMinutes(s.starts_at as string, s.ends_at as string)
                const level = conflictLevel(s.id)
                const color = trackColor(s)
                return (
                  <div
                    className={`rb-block${level ? ` conflict-${level}` : ''}`}
                    key={s.id}
                    style={{
                      left: pct(local.minutes),
                      width: widthPct(dur),
                      ...(color ? { ['--track-color' as string]: color } : {}),
                    }}
                    draggable
                    tabIndex={0}
                    role="button"
                    aria-label={`${s.title}, ${fmtMinutes(local.minutes)} in ${room.name}. Press M to move.`}
                    title={conflictTitle(s.id) || `${s.code} · ${s.title} · ${fmtMinutes(local.minutes)}`}
                    onDragStart={(e) => {
                      setDrag({ id: s.id, durationMin: dur, fromTray: false })
                      e.dataTransfer.setData('text/plain', s.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      setDrag(null)
                      setGhost(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'm' || e.key === 'M') {
                        e.preventDefault()
                        onOpenMove(s.id)
                      }
                    }}
                    onDoubleClick={() => onOpenMove(s.id)}
                  >
                    {level && <span className="tg-block-flag" aria-hidden>⚠</span>}
                    <span className="rb-block-title">{s.title}</span>
                  </div>
                )
              })}
              {ghost && ghost.roomId === room.id && ghost.day === day && (
                <div
                  className={`rb-ghost${ghost.preview.bad ? ' bad' : ''}`}
                  style={{ left: pct(ghost.startMin), width: widthPct(ghost.durationMin) }}
                  title={ghost.preview.titles}
                >
                  {fmtMinutes(ghost.startMin)}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

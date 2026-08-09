import { useEffect, useRef, useState } from 'react'
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

const NO_PREVIEW: DropPreview = { bad: false, titles: '' }
const slotKey = (g: { roomId: string; day: string; startMin: number; durationMin: number }) =>
  `${g.roomId}:${g.day}:${g.startMin}:${g.durationMin}`

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

  // Same rAF budget as TimeGrid (sweep item P2-17): the ghost follows the
  // cursor on every dragover, the conflict preview is recomputed at most
  // once per frame from the latest slot parked in a ref.
  const pendingPreview = useRef<{ id: string; roomId: string; day: string; startMin: number; durationMin: number } | null>(null)
  const previewedSlot = useRef<string | null>(null)
  const frame = useRef<number | null>(null)

  const flushPreview = () => {
    frame.current = null
    const p = pendingPreview.current
    if (!p) return
    const key = slotKey(p)
    if (previewedSlot.current === key) return
    previewedSlot.current = key
    const preview = previewDrop(p.id, p.roomId, p.day, p.startMin, p.durationMin)
    setGhost((g) => (g !== null && slotKey(g) === key ? { ...g, preview } : g))
  }

  const clearPreview = () => {
    pendingPreview.current = null
    previewedSlot.current = null
  }

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  const inCell = (s: AgendaSessionRow, roomId: string, day: string): boolean =>
    s.room_id === roomId && s.starts_at !== null && utcToLocal(s.starts_at, timezone).day === day

  const pct = (min: number) => `${((min - dayStartMin) / span) * 100}%`
  const widthPct = (dur: number) => `${(dur / span) * 100}%`

  /**
   * The slot under the cursor, measured synchronously: React clears
   * `currentTarget` once the handler returns, so a deferred frame could not
   * read the cell rect.
   */
  const slotFromEvent = (
    e: React.DragEvent<HTMLDivElement>,
    roomId: string,
    day: string,
  ): { id: string; roomId: string; day: string; startMin: number; durationMin: number } | null => {
    const drag = getDrag()
    if (!drag) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const raw = dayStartMin + ((e.clientX - rect.left) / rect.width) * span
    const startMin = Math.max(dayStartMin, Math.min(snapTo(raw, DROP_SNAP_MIN), dayEndMin - drag.durationMin))
    return { id: drag.id, roomId, day, startMin, durationMin: drag.durationMin }
  }

  const queuePreview = (slot: { id: string; roomId: string; day: string; startMin: number; durationMin: number }) => {
    pendingPreview.current = slot
    if (frame.current === null) frame.current = requestAnimationFrame(flushPreview)
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
                const slot = slotFromEvent(e, room.id, day)
                if (!slot) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                // Keep the previous verdict until the frame recomputes it, so
                // the ghost does not flicker between red and neutral.
                setGhost((g) =>
                  g !== null && slotKey(g) === slotKey(slot) ? g : { ...slot, preview: g?.preview ?? NO_PREVIEW },
                )
                queuePreview(slot)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  clearPreview()
                  setGhost((g) => (g && g.roomId === room.id && g.day === day ? null : g))
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                const slot = slotFromEvent(e, room.id, day)
                const g = ghost && ghost.roomId === room.id && ghost.day === day ? ghost : null
                clearPreview()
                setGhost(null)
                setDrag(null)
                if (slot) {
                  onDrop(slot.id, room.id, day, g?.startMin ?? slot.startMin, g?.durationMin ?? slot.durationMin)
                }
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
                    aria-label={`${s.title}, ${fmtMinutes(local.minutes)} in ${room.name}. Press Enter to move.`}
                    title={conflictTitle(s.id) || `${s.code} · ${s.title} · ${fmtMinutes(local.minutes)}`}
                    onDragStart={(e) => {
                      setDrag({ id: s.id, durationMin: dur, fromTray: false })
                      e.dataTransfer.setData('text/plain', s.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      setDrag(null)
                      clearPreview()
                      setGhost(null)
                    }}
                    onKeyDown={(e) => {
                      // Enter/Space activates the role=button block; M is kept
                      // as the mnemonic (docs/07 §3 a11y alternative).
                      if (e.key === 'm' || e.key === 'M' || e.key === 'Enter' || e.key === ' ') {
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

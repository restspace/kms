import { useRef, useState } from 'react'
import type { AgendaSessionRow } from '../api'
import { getDrag, setDrag } from './dragState'
import { durationMinutes, fmtMinutes, snapTo, utcToLocal } from './timeUtils'

/**
 * Vertical time grid (docs/07 §2): Day view (columns = rooms or tracks) and
 * Week view (columns = days) share this. 1 px = 1 minute; drops snap to
 * 15 min, resizes to 5 min (docs/07 §3). Ghost turns red when the drop would
 * conflict — dropping is still allowed, the session just gets flagged.
 */

export const DROP_SNAP_MIN = 15
export const RESIZE_SNAP_MIN = 5

export interface GridColumn {
  key: string
  label: string
  sub?: string
  day: string
}

export interface DropPreview {
  bad: boolean
  titles: string
}

interface TimeGridProps {
  columns: GridColumn[]
  sessions: AgendaSessionRow[]
  timezone: string
  dayStartMin: number
  dayEndMin: number
  columnOf: (s: AgendaSessionRow) => string | null
  conflictLevel: (id: string) => 'error' | 'warning' | null
  conflictTitle: (id: string) => string
  trackColor: (s: AgendaSessionRow) => string | null
  onDrop: (id: string, column: GridColumn, startMin: number, durationMin: number) => void
  onResize: (id: string, durationMin: number) => void
  onOpenMove: (id: string) => void
  previewDrop: (id: string, column: GridColumn, startMin: number, durationMin: number) => DropPreview
}

interface Ghost {
  colKey: string
  startMin: number
  durationMin: number
  preview: DropPreview
}

export function TimeGrid({
  columns,
  sessions,
  timezone,
  dayStartMin,
  dayEndMin,
  columnOf,
  conflictLevel,
  conflictTitle,
  trackColor,
  onDrop,
  onResize,
  onOpenMove,
  previewDrop,
}: TimeGridProps) {
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const [resizing, setResizing] = useState<{ id: string; durationMin: number } | null>(null)
  const resizeStart = useRef<{ y: number; durationMin: number } | null>(null)

  const height = dayEndMin - dayStartMin
  const hours: number[] = []
  for (let m = Math.ceil(dayStartMin / 60) * 60; m <= dayEndMin; m += 60) hours.push(m)

  const byColumn = new Map<string, AgendaSessionRow[]>()
  for (const s of sessions) {
    if (!s.starts_at || !s.ends_at) continue
    const key = columnOf(s)
    if (key === null) continue
    const list = byColumn.get(key) ?? []
    list.push(s)
    byColumn.set(key, list)
  }

  const ghostFromEvent = (e: React.DragEvent<HTMLDivElement>, col: GridColumn): Ghost | null => {
    const drag = getDrag()
    if (!drag) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const raw = dayStartMin + (e.clientY - rect.top)
    const startMin = Math.max(
      dayStartMin,
      Math.min(snapTo(raw, DROP_SNAP_MIN), dayEndMin - drag.durationMin),
    )
    return {
      colKey: col.key,
      startMin,
      durationMin: drag.durationMin,
      preview: previewDrop(drag.id, col, startMin, drag.durationMin),
    }
  }

  const startResize = (e: React.PointerEvent<HTMLDivElement>, s: AgendaSessionRow) => {
    e.preventDefault()
    e.stopPropagation()
    const durationMin = durationMinutes(s.starts_at as string, s.ends_at as string)
    resizeStart.current = { y: e.clientY, durationMin }
    setResizing({ id: s.id, durationMin })
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Pointer capture is an enhancement; resizing works without it.
    }
  }

  const moveResize = (e: React.PointerEvent<HTMLDivElement>, s: AgendaSessionRow) => {
    const start = resizeStart.current
    if (!start || resizing?.id !== s.id) return
    const durationMin = Math.max(RESIZE_SNAP_MIN, snapTo(start.durationMin + (e.clientY - start.y), RESIZE_SNAP_MIN))
    setResizing({ id: s.id, durationMin })
  }

  const endResize = (s: AgendaSessionRow) => {
    if (resizing?.id === s.id && resizeStart.current && resizing.durationMin !== resizeStart.current.durationMin) {
      onResize(s.id, resizing.durationMin)
    }
    resizeStart.current = null
    setResizing(null)
  }

  return (
    <div className="tg" style={{ ['--tg-height' as string]: `${height}px` }}>
      <div className="tg-head">
        <div className="tg-gutter-head" />
        {columns.map((col) => (
          <div className="tg-col-head" key={col.key}>
            <span>{col.label}</span>
            {col.sub && <span className="tg-col-sub">{col.sub}</span>}
          </div>
        ))}
      </div>
      <div className="tg-body">
        <div className="tg-gutter">
          {hours.map((m) => (
            <div className="tg-hour-label" key={m} style={{ top: m - dayStartMin }}>
              {fmtMinutes(m)}
            </div>
          ))}
        </div>
        {columns.map((col) => (
          <div
            className="tg-col"
            key={col.key}
            onDragOver={(e) => {
              if (!getDrag()) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setGhost(ghostFromEvent(e, col))
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setGhost((g) => (g?.colKey === col.key ? null : g))
              }
            }}
            onDrop={(e) => {
              e.preventDefault()
              const drag = getDrag()
              const g = ghost?.colKey === col.key ? ghost : ghostFromEvent(e, col)
              setGhost(null)
              setDrag(null)
              if (drag && g) onDrop(drag.id, col, g.startMin, g.durationMin)
            }}
          >
            {hours.map((m) => (
              <div className="tg-hour-line" key={m} style={{ top: m - dayStartMin }} />
            ))}
            {(byColumn.get(col.key) ?? []).map((s) => {
              const local = utcToLocal(s.starts_at as string, timezone)
              const baseDur = durationMinutes(s.starts_at as string, s.ends_at as string)
              const dur = resizing?.id === s.id ? resizing.durationMin : baseDur
              const level = conflictLevel(s.id)
              const color = trackColor(s)
              return (
                <div
                  className={`tg-block${level ? ` conflict-${level}` : ''}`}
                  key={s.id}
                  style={{
                    top: local.minutes - dayStartMin,
                    height: Math.max(dur, 18),
                    ...(color ? { ['--track-color' as string]: color } : {}),
                  }}
                  draggable
                  tabIndex={0}
                  role="button"
                  aria-label={`${s.title}, ${fmtMinutes(local.minutes)}. Press M to move.`}
                  title={conflictTitle(s.id) || `${s.code} · ${s.title}`}
                  onDragStart={(e) => {
                    setDrag({ id: s.id, durationMin: baseDur, fromTray: false })
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
                  <div className="tg-block-time">
                    {fmtMinutes(local.minutes)} – {fmtMinutes(local.minutes + dur)}
                  </div>
                  <div className="tg-block-title">{s.title}</div>
                  {dur >= 40 && s.speakers.length > 0 && (
                    <div className="tg-block-speakers">{s.speakers.map((sp) => sp.name).join(', ')}</div>
                  )}
                  <div
                    className="tg-resize"
                    aria-hidden
                    onPointerDown={(e) => startResize(e, s)}
                    onPointerMove={(e) => moveResize(e, s)}
                    onPointerUp={() => endResize(s)}
                    onPointerCancel={() => endResize(s)}
                  />
                </div>
              )
            })}
            {ghost && ghost.colKey === col.key && (
              <div
                className={`tg-ghost${ghost.preview.bad ? ' bad' : ''}`}
                style={{ top: ghost.startMin - dayStartMin, height: ghost.durationMin }}
                title={ghost.preview.titles}
              >
                <div className="tg-block-time">
                  {fmtMinutes(ghost.startMin)} – {fmtMinutes(ghost.startMin + ghost.durationMin)}
                </div>
                {ghost.preview.bad && <div className="tg-ghost-warning">{ghost.preview.titles}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

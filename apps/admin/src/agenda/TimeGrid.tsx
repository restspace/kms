import { useEffect, useRef, useState } from 'react'
import type { AgendaSessionRow } from '../api'
import { getDrag, setDrag } from './dragState'
import { navigate } from '../router'
import {
  AGENDA_SLOT_STEP_MIN,
  classifySchedule,
  durationMinutes,
  fmtMinutes,
  snapTo,
  utcToLocal,
} from './timeUtils'

/**
 * Vertical time grid (docs/07 §2): Day view (columns = rooms or tracks) and
 * Week view (columns = days) share this. 1 px = 1 minute; drops snap to
 * 15 min, resizes to 5 min (docs/07 §3). Ghost turns red when the drop would
 * conflict — dropping is still allowed, the session just gets flagged.
 */

export const DROP_SNAP_MIN = AGENDA_SLOT_STEP_MIN
export const RESIZE_SNAP_MIN = 5

export interface GridColumn {
  key: string
  label: string
  sub?: string
  day: string
  pill?: number
  pillTitle?: string
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
  /** One-line human message for a conflicted session, rendered inside the block. */
  conflictNote?: (id: string) => string
  trackColor: (s: AgendaSessionRow) => string | null
  onDrop: (id: string, column: GridColumn, startMin: number, durationMin: number) => void
  onResize: (id: string, durationMin: number) => void
  onOpenMove: (id: string) => void
  previewDrop: (id: string, column: GridColumn, startMin: number, durationMin: number) => DropPreview
  /** Dropped on the column header rather than a time slot (docs/13 W5): day-only placement, room stays NULL. */
  onDropDay?: (id: string, day: string) => void
  /** Returns a column key to confine an unscheduled drag's drop target to, or null for no restriction. */
  confineColumnKey?: (id: string) => string | null
}

interface Ghost {
  colKey: string
  startMin: number
  durationMin: number
  preview: DropPreview
}

const NO_PREVIEW: DropPreview = { bad: false, titles: '' }
const slotKey = (g: { colKey: string; startMin: number; durationMin: number }) =>
  `${g.colKey}:${g.startMin}:${g.durationMin}`

export interface LanedSession {
  session: AgendaSessionRow
  startMin: number
  endMin: number
  /** Sub-column index within its room/day column, for overlapping sessions. */
  lane: number
  /** How many sub-columns the overlap cluster needs. */
  lanes: number
}

/**
 * Greedy lane assignment, ported from packages/ui/src/widgets/AgendaWidget.tsx's
 * `assignLanes`: walk a column's sessions in start order, giving each one the
 * first lane free at its start time, grouped into "clusters" of
 * transitively-overlapping blocks so every block in a cluster gets the same
 * lane count and the column divides evenly. Without this, two sessions
 * double-booked into the same room/slot both render at `.tg-block`'s default
 * `left:3px; right:3px` — i.e. fully stacked, with whichever renders last
 * hiding the earlier one's title.
 */
export function assignLanes(items: LanedSession[]): void {
  let cluster: LanedSession[] = []
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

/** Speakers get a line of their own only on blocks with room for it. */
export const showsSpeakers = (s: AgendaSessionRow, durationMin: number): boolean =>
  durationMin >= 40 && s.speakers.length > 0

const MIN_BLOCK_PX = 36
const MIN_SPEAKER_BLOCK_PX = 56
/** Extra floor for the conflict message line (AIA-04) — same 20px as speakers. */
const CONFLICT_NOTE_PX = 20

/**
 * Rendered box height (the grid maps 1 minute to 1 pixel): the true duration,
 * floored so every line the block renders fits whole — time + title need
 * 36px, and the speakers line another 20px. Anything that reasons about
 * vertical space (lane assignment as much as the block itself) must use this
 * rather than the raw duration, or a floored block paints over the one below.
 * A conflicted block carries the warning text as a line of its own, so it
 * budgets one more row — the message must read without hovering (AIA-04).
 */
export function blockHeightPx(s: AgendaSessionRow, durationMin: number, hasConflictNote = false): number {
  const floor =
    (showsSpeakers(s, durationMin) ? MIN_SPEAKER_BLOCK_PX : MIN_BLOCK_PX) + (hasConflictNote ? CONFLICT_NOTE_PX : 0)
  return Math.max(durationMin, floor)
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
  conflictNote,
  trackColor,
  onDrop,
  onResize,
  onOpenMove,
  previewDrop,
  onDropDay,
  confineColumnKey,
}: TimeGridProps) {
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const [dayOverKey, setDayOverKey] = useState<string | null>(null)
  const [resizing, setResizing] = useState<{ id: string; durationMin: number } | null>(null)
  const resizeStart = useRef<{ y: number; durationMin: number } | null>(null)

  // dragover fires far more often than the screen repaints, and the conflict
  // preview is the expensive part (sweep item P2-17). The ghost itself moves
  // synchronously — it must track the cursor — while the preview is computed
  // at most once per animation frame from the latest slot parked in a ref.
  const pendingPreview = useRef<{ id: string; column: GridColumn; startMin: number; durationMin: number } | null>(null)
  const previewedSlot = useRef<string | null>(null)
  const frame = useRef<number | null>(null)

  const flushPreview = () => {
    frame.current = null
    const p = pendingPreview.current
    if (!p) return
    const key = slotKey({ colKey: p.column.key, startMin: p.startMin, durationMin: p.durationMin })
    if (previewedSlot.current === key) return
    previewedSlot.current = key
    const preview = previewDrop(p.id, p.column, p.startMin, p.durationMin)
    setGhost((g) => (g !== null && slotKey(g) === key ? { ...g, preview } : g))
  }

  const queuePreview = (id: string, column: GridColumn, startMin: number, durationMin: number) => {
    pendingPreview.current = { id, column, startMin, durationMin }
    if (frame.current === null) frame.current = requestAnimationFrame(flushPreview)
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

  /** The conflict line a block will render (empty when there is none). */
  const noteFor = (id: string): string => (conflictLevel(id) ? conflictNote?.(id) ?? '' : '')

  const height = dayEndMin - dayStartMin
  const hours: number[] = []
  for (let m = Math.ceil(dayStartMin / 60) * 60; m <= dayEndMin; m += 60) hours.push(m)

  // A time-set/no-room pencilled session has no column of its own — it does
  // not double-book any one room, so it renders as a dashed band across the
  // whole grid instead of vanishing (docs/13 W5). `columnOf` returning null
  // for the wrong day is filtered the same way it always was; only sessions
  // whose day matches a column actually present here are spanning.
  const sameDayColumns = columns.length > 0 && columns.every((c) => c.day === columns[0]?.day)
  const byColumn = new Map<string, AgendaSessionRow[]>()
  const spanning: AgendaSessionRow[] = []
  for (const s of sessions) {
    if (!s.starts_at || !s.ends_at) continue
    const key = columnOf(s)
    if (key === null) {
      if (sameDayColumns && utcToLocal(s.starts_at, timezone).day === columns[0]?.day && s.room_id === null) {
        spanning.push(s)
      }
      continue
    }
    const list = byColumn.get(key) ?? []
    list.push(s)
    byColumn.set(key, list)
  }

  // Lane assignment per column, keyed by session id — computed once here
  // (rather than per-render inside the .map below) so every session in a
  // column sees the whole column's overlap picture, not just itself.
  const laneById = new Map<string, { lane: number; lanes: number }>()
  for (const list of byColumn.values()) {
    const laned: LanedSession[] = list.map((s) => {
      const local = utcToLocal(s.starts_at as string, timezone)
      const durationMin = durationMinutes(s.starts_at as string, s.ends_at as string)
      // Lanes split on *rendered* extents, not true times: a short block is
      // floored to its content height, so a back-to-back neighbour that is
      // clear in minutes can still collide in pixels.
      return {
        session: s,
        startMin: local.minutes,
        endMin: local.minutes + blockHeightPx(s, durationMin, noteFor(s.id) !== ''),
        lane: 0,
        lanes: 1,
      }
    })
    laned.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)
    assignLanes(laned)
    for (const item of laned) laneById.set(item.session.id, { lane: item.lane, lanes: item.lanes })
  }

  /**
   * The slot under the cursor. Read synchronously — React clears
   * `currentTarget` once the handler returns, so the rect cannot be measured
   * from a deferred frame.
   */
  const slotFromEvent = (e: React.DragEvent<HTMLDivElement>): { id: string; startMin: number; durationMin: number } | null => {
    const drag = getDrag()
    if (!drag) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const raw = dayStartMin + (e.clientY - rect.top)
    const startMin = Math.max(
      dayStartMin,
      Math.min(snapTo(raw, DROP_SNAP_MIN), dayEndMin - drag.durationMin),
    )
    return { id: drag.id, startMin, durationMin: drag.durationMin }
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
          <div
            className={`tg-col-head${onDropDay && dayOverKey === col.key ? ' drop-over' : ''}`}
            key={col.key}
            onDragOver={(e) => {
              if (!onDropDay || !getDrag()) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDayOverKey(col.key)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDayOverKey((k) => (k === col.key ? null : k))
              }
            }}
            onDrop={(e) => {
              if (!onDropDay) return
              e.preventDefault()
              const drag = getDrag()
              setDayOverKey(null)
              setDrag(null)
              if (drag) onDropDay(drag.id, col.day)
            }}
          >
            <span>{col.label}</span>
            {col.sub && <span className="tg-col-sub">{col.sub}</span>}
            {col.pill !== undefined && col.pill > 0 && (
              <span className="tg-col-pill" title={col.pillTitle}>{col.pill}</span>
            )}
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
        {spanning.length > 0 && (
          <div className="tg-pencil-lane">
            {spanning.map((s) => {
              const local = utcToLocal(s.starts_at as string, timezone)
              const dur = durationMinutes(s.starts_at as string, s.ends_at as string)
              return (
                <div
                  className="tg-block pencilled"
                  key={s.id}
                  style={{ top: local.minutes - dayStartMin, height: Math.max(dur, MIN_BLOCK_PX) }}
                  draggable
                  tabIndex={0}
                  role="button"
                  aria-label={`${s.title}, ${fmtMinutes(local.minutes)}, no room assigned. Press Enter to move.`}
                  title={`${s.code} · ${s.title} · no room assigned`}
                  onDragStart={(e) => {
                    setDrag({ id: s.id, durationMin: dur, fromTray: false })
                    e.dataTransfer.setData('text/plain', s.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => setDrag(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'm' || e.key === 'M' || e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpenMove(s.id)
                    }
                  }}
                  onDoubleClick={() => onOpenMove(s.id)}
                >
                  <div className="tg-block-time">
                    {fmtMinutes(local.minutes)} – {fmtMinutes(local.minutes + dur)} · no room
                  </div>
                  <div className="tg-block-title">{s.title}</div>
                  <button
                    type="button"
                    className="tg-open-btn"
                    title="Open submission in Workspace"
                    aria-label={`Open ${s.code} in Workspace`}
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      navigate({ v: 'workspace', tab: 'submissions', rec: s.id })
                    }}
                  >
                    ↗
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {columns.map((col) => (
          <div
            className="tg-col"
            key={col.key}
            onDragOver={(e) => {
              const drag = getDrag()
              if (drag && confineColumnKey) {
                const only = confineColumnKey(drag.id)
                if (only !== null && only !== col.key) return
              }
              const slot = slotFromEvent(e)
              if (!slot) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const next = { colKey: col.key, startMin: slot.startMin, durationMin: slot.durationMin }
              // Carry the last preview until the frame recomputes it, so the
              // ghost never flickers between red and neutral.
              setGhost((g) =>
                g !== null && slotKey(g) === slotKey(next) ? g : { ...next, preview: g?.preview ?? NO_PREVIEW },
              )
              queuePreview(slot.id, col, slot.startMin, slot.durationMin)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                clearPreview()
                setGhost((g) => (g?.colKey === col.key ? null : g))
              }
            }}
            onDrop={(e) => {
              const drag = getDrag()
              if (drag && confineColumnKey) {
                const only = confineColumnKey(drag.id)
                if (only !== null && only !== col.key) return
              }
              e.preventDefault()
              const slot = slotFromEvent(e)
              const g = ghost?.colKey === col.key ? ghost : null
              clearPreview()
              setGhost(null)
              setDrag(null)
              if (slot) onDrop(slot.id, col, g?.startMin ?? slot.startMin, g?.durationMin ?? slot.durationMin)
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
              const note = level ? conflictNote?.(s.id) ?? '' : ''
              const color = trackColor(s)
              const pencilled = classifySchedule(s) === 'pencilled'
              const { lane, lanes } = laneById.get(s.id) ?? { lane: 0, lanes: 1 }
              const lanePct = 100 / lanes
              return (
                <div
                  className={`tg-block${pencilled ? ' pencilled' : ''}${level ? ` conflict-${level}` : ''}`}
                  key={s.id}
                  style={{
                    top: local.minutes - dayStartMin,
                    // A 30-min (or shorter — Lightning Talks default to 10)
                    // slot maps to fewer pixels than the block's content
                    // lines need, clipping text mid-glyph. blockHeightPx
                    // floors the box to fit every line it renders — the
                    // speakers line included — so short sessions render
                    // slightly taller than their slot rather than lose or
                    // slice a row (docs/07 eval fix).
                    height: blockHeightPx(s, dur, note !== ''),
                    // Overlapping sessions in the same room/slot split into
                    // side-by-side lanes instead of the CSS default
                    // (`left:3px; right:3px`, i.e. full width) which stacked
                    // them and hid the earlier one's title. `lane === 0,
                    // lanes === 1` reduces to the original 3px/3px inset.
                    left: `calc(${lanePct * lane}% + 3px)`,
                    width: `calc(${lanePct}% - 6px)`,
                    ...(color ? { ['--track-color' as string]: color } : {}),
                  }}
                  draggable
                  tabIndex={0}
                  role="button"
                  aria-label={`${s.title}, ${fmtMinutes(local.minutes)}.${note ? ` Conflict: ${note}` : ''} Press Enter to move.`}
                  title={conflictTitle(s.id) || `${s.code} · ${s.title}`}
                  onDragStart={(e) => {
                    setDrag({ id: s.id, durationMin: baseDur, fromTray: false })
                    e.dataTransfer.setData('text/plain', s.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => {
                    setDrag(null)
                    clearPreview()
                    setGhost(null)
                  }}
                  onKeyDown={(e) => {
                    // Enter/Space is the expected activation for role=button;
                    // M stays as the mnemonic (docs/07 §3 a11y alternative).
                    if (e.key === 'm' || e.key === 'M' || e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpenMove(s.id)
                    }
                  }}
                  onDoubleClick={() => onOpenMove(s.id)}
                >
                  {level && (
                    <span className="tg-block-flag" role="img" aria-label={`${level === 'error' ? 'Conflict' : 'Warning'}:`}>
                      ⚠
                    </span>
                  )}
                  <div className="tg-block-time">
                    {fmtMinutes(local.minutes)} – {fmtMinutes(local.minutes + dur)}
                  </div>
                  <div className="tg-block-title">{s.title}</div>
                  {/* The conflict message reads on the block itself — the
                      hover title and the Conflicts tab are no longer the only
                      places it exists (AIA-04). blockHeightPx has budgeted the
                      row, so it never overflows a short slot. */}
                  {note !== '' && <div className="tg-block-conflict">{note}</div>}
                  {showsSpeakers(s, dur) && (
                    <div className="tg-block-speakers">{s.speakers.map((sp) => sp.name).join(', ')}</div>
                  )}
                  <button
                    type="button"
                    className="tg-open-btn"
                    title="Open submission in Workspace"
                    aria-label={`Open ${s.code} in Workspace`}
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      navigate({ v: 'workspace', tab: 'submissions', rec: s.id })
                    }}
                  >
                    ↗
                  </button>
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

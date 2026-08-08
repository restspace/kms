import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computeConflicts } from '@kms/core'
import {
  addAgendaSession,
  getAgenda,
  removeSessionSpeaker,
  scheduleSession,
  sendScheduleConfirmations,
  setConflictIgnored,
  type AgendaConflictRow,
  type AgendaPayload,
  type AgendaSessionRow,
  type SchedulePatch,
} from '../api'
import { ConflictsView } from './ConflictsView'
import { AddSessionDialog, MoveDialog } from './dialogs'
import { RoomsBoard } from './RoomsBoard'
import { TimeGrid, type DropPreview, type GridColumn } from './TimeGrid'
import { Tray } from './Tray'
import {
  durationMinutes,
  eventDays,
  fmtDay,
  fmtRange,
  localToUtc,
  tzAbbr,
  utcToLocal,
} from './timeUtils'
import './agenda.css'

/**
 * Agenda & scheduling (docs/07, M4): List / Day / Week / Month / Rooms /
 * Conflicts views over the accepted sessions, with the unscheduled tray,
 * drag/drop/resize, undo, the keyboard Move dialog and the invite flow.
 * Conflicts come from the server; the same @kms/core engine runs locally for
 * optimistic updates and red-ghost drop previews.
 */

type AgendaView = 'list' | 'day' | 'week' | 'month' | 'rooms' | 'conflicts'

const VIEWS: Array<{ key: AgendaView; label: string }> = [
  { key: 'list', label: 'List' },
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'rooms', label: 'Rooms' },
  { key: 'conflicts', label: 'Conflicts' },
]

const DAY_START_MIN = 6 * 60
const DAY_END_MIN = 20 * 60

/** Default block length by format (docs/07 §3 "session's default duration"). */
const FORMAT_DURATION: Record<string, number> = {
  Workshop: 90,
  Keynote: 45,
  'Featured Keynote': 45,
  Panel: 45,
  'Lightning Talk': 10,
}

interface UndoEntry {
  id: string
  prev: { starts_at: string | null; ends_at: string | null; room_id: string | null }
}

interface Toast {
  message: string
  undo?: () => void
}

export function AgendaSection({ initialView }: { initialView?: AgendaView } = {}) {
  const [data, setData] = useState<AgendaPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<AgendaView>(initialView ?? 'day')
  const [groupBy, setGroupBy] = useState<'room' | 'track'>('room')
  const [curDay, setCurDay] = useState('')
  const [search, setSearch] = useState('')
  const [moveId, setMoveId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const undoStack = useRef<UndoEntry[]>([])
  const toastTimer = useRef<number | null>(null)

  const showToast = useCallback((t: Toast) => {
    setToast(t)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 6000)
  }, [])

  useEffect(() => {
    getAgenda()
      .then((p) => {
        setData(p)
        setCurDay((d) => d || eventDays(p.event.starts_at, p.event.ends_at, p.event.timezone)[0] || '')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load the agenda'))
  }, [])

  const tz = data?.event.timezone ?? 'UTC'
  const days = useMemo(
    () => (data ? eventDays(data.event.starts_at, data.event.ends_at, tz) : []),
    [data, tz],
  )
  const sessionById = useMemo(
    () => new Map((data?.sessions ?? []).map((s) => [s.id, s])),
    [data],
  )
  const trackById = useMemo(() => new Map((data?.tracks ?? []).map((t) => [t.id, t])), [data])

  const liveConflicts = useMemo(() => (data?.conflicts ?? []).filter((c) => !c.ignored), [data])
  const conflictsBySession = useMemo(() => {
    const map = new Map<string, AgendaConflictRow[]>()
    for (const c of liveConflicts) {
      if (c.severity === 'info') continue
      for (const id of c.session_ids) {
        const list = map.get(id) ?? []
        list.push(c)
        map.set(id, list)
      }
    }
    return map
  }, [liveConflicts])

  const conflictLevel = useCallback(
    (id: string): 'error' | 'warning' | null => {
      const list = conflictsBySession.get(id)
      if (!list || list.length === 0) return null
      return list.some((c) => c.severity === 'error') ? 'error' : 'warning'
    },
    [conflictsBySession],
  )
  const conflictTitle = useCallback(
    (id: string): string => (conflictsBySession.get(id) ?? []).map((c) => `${c.code}: ${c.message}`).join('\n'),
    [conflictsBySession],
  )
  const trackColor = useCallback(
    (s: AgendaSessionRow): string | null => (s.track_id ? trackById.get(s.track_id)?.color ?? null : null),
    [trackById],
  )
  const defaultDuration = useCallback((s: AgendaSessionRow): number => {
    if (s.starts_at && s.ends_at) return durationMinutes(s.starts_at, s.ends_at)
    return FORMAT_DURATION[s.format ?? ''] ?? 30
  }, [])

  /** Recompute conflicts locally after an optimistic change (same engine). */
  const withLocalConflicts = useCallback(
    (base: AgendaPayload, sessions: AgendaSessionRow[]): AgendaPayload => {
      const ignoredSet = new Set(base.conflicts.filter((c) => c.ignored).map((c) => c.signature))
      const conflicts = computeConflicts(sessions, base.rooms, {
        starts_at: base.event.starts_at,
        ends_at: base.event.ends_at,
      }).map((c) => ({ ...c, ignored: ignoredSet.has(c.signature) }))
      return { ...base, sessions, conflicts }
    },
    [],
  )

  const applyPayload = useCallback((p: AgendaPayload) => {
    setData({ event: p.event, rooms: p.rooms, tracks: p.tracks, sessions: p.sessions, conflicts: p.conflicts })
  }, [])

  const commitSchedule = useCallback(
    (
      id: string,
      patch: { starts_at: string | null; ends_at: string | null; room_id: string | null },
      opts: { pushUndo?: boolean; label?: string } = {},
    ) => {
      if (!data) return
      const session = sessionById.get(id)
      if (!session) return
      if (
        session.starts_at === patch.starts_at &&
        session.ends_at === patch.ends_at &&
        session.room_id === patch.room_id
      ) {
        return
      }

      // Invited sessions never change silently (docs/07 §6): ask before
      // cancelling or re-sending; declining still applies the schedule change.
      let notify: SchedulePatch['notify']
      if (session.invited === 1) {
        if (patch.starts_at === null) {
          notify = window.confirm(
            `“${session.title}” has a live calendar invite.\nSend a cancellation email to its speakers?`,
          )
            ? 'cancelled'
            : undefined
        } else {
          notify = window.confirm(
            `“${session.title}” has a live calendar invite.\nEmail its speakers an updated invite for the new slot?`,
          )
            ? 'changed'
            : undefined
        }
      }

      const prev = { starts_at: session.starts_at, ends_at: session.ends_at, room_id: session.room_id }
      if (opts.pushUndo !== false) undoStack.current.push({ id, prev })

      const nextSessions = data.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s))
      setData(withLocalConflicts(data, nextSessions))

      const undo = () => {
        const entry = undoStack.current.pop()
        if (entry) commitSchedule(entry.id, entry.prev, { pushUndo: false, label: 'Undone' })
      }
      showToast({
        message:
          opts.label ??
          (patch.starts_at === null
            ? `${session.code} unscheduled`
            : `${session.code} → ${fmtRange(patch.starts_at, patch.ends_at as string, tz)}`),
        ...(opts.pushUndo !== false ? { undo } : {}),
      })

      scheduleSession(id, { ...patch, ...(notify ? { notify } : {}) })
        .then(applyPayload)
        .catch((e: unknown) => {
          // Server rejected: the block animates back via a fresh load.
          getAgenda().then(setData).catch(() => undefined)
          showToast({ message: e instanceof Error ? e.message : 'Schedule change failed' })
        })
    },
    [data, sessionById, withLocalConflicts, applyPayload, showToast, tz],
  )

  // ⌘Z / Ctrl+Z reverts the last scheduling change (docs/07 §3).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        const target = e.target as HTMLElement | null
        if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
        const entry = undoStack.current.pop()
        if (entry) {
          e.preventDefault()
          commitSchedule(entry.id, entry.prev, { pushUndo: false, label: 'Undone' })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commitSchedule])

  const patchFrom = useCallback(
    (day: string, startMin: number, durationMin: number, roomId: string | null) => ({
      starts_at: localToUtc(day, startMin, tz),
      ends_at: localToUtc(day, startMin + durationMin, tz),
      room_id: roomId,
    }),
    [tz],
  )

  const previewFor = useCallback(
    (id: string, day: string, startMin: number, durationMin: number, roomId: string | null): DropPreview => {
      if (!data) return { bad: false, titles: '' }
      const patch = patchFrom(day, startMin, durationMin, roomId)
      const tentative = data.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s))
      const ignoredSet = new Set(data.conflicts.filter((c) => c.ignored).map((c) => c.signature))
      const hits = computeConflicts(tentative, data.rooms, {
        starts_at: data.event.starts_at,
        ends_at: data.event.ends_at,
      }).filter(
        (c) => c.session_ids.includes(id) && c.severity !== 'info' && !ignoredSet.has(c.signature),
      )
      return { bad: hits.length > 0, titles: hits.map((c) => `${c.code}: ${c.message}`).join('\n') }
    },
    [data, patchFrom],
  )

  const filteredSessions = useMemo(() => {
    if (!data) return []
    if (!search) return data.sessions
    const q = search.toLowerCase()
    return data.sessions.filter((s) =>
      `${s.code} ${s.title} ${s.speakers.map((sp) => sp.name).join(' ')}`.toLowerCase().includes(q),
    )
  }, [data, search])

  const unscheduled = useMemo(
    () => filteredSessions.filter((s) => s.starts_at === null && s.room_id === null),
    [filteredSessions],
  )
  const pendingConfirmations = useMemo(
    () => (data?.sessions ?? []).filter((s) => s.starts_at !== null && s.invited === 0).length,
    [data],
  )
  const errorCount = liveConflicts.filter((c) => c.severity === 'error').length
  const warningCount = liveConflicts.filter((c) => c.severity === 'warning').length

  if (error) return <div className="agenda"><p className="agenda-error">{error}</p></div>
  if (!data) return <div className="agenda"><p className="agenda-loading">Loading agenda…</p></div>

  const moveSession = moveId !== null ? sessionById.get(moveId) ?? null : null
  const dayIndex = days.indexOf(curDay)

  const dayColumns: GridColumn[] =
    groupBy === 'room'
      ? data.rooms.map((r) => ({
          key: r.id,
          label: r.name,
          ...(r.capacity !== null ? { sub: `${r.capacity}` } : {}),
          day: curDay,
        }))
      : [
          ...data.tracks.map((t) => ({ key: t.id, label: t.name, day: curDay })),
          { key: '__none', label: 'No track', day: curDay },
        ]

  const weekColumns: GridColumn[] = days.map((d) => ({ key: d, label: fmtDay(d), day: d }))

  const sessionDay = (s: AgendaSessionRow): string | null =>
    s.starts_at !== null ? utcToLocal(s.starts_at, tz).day : null

  const runAction = <T extends AgendaPayload>(
    action: () => Promise<T>,
    message: (p: T) => string,
  ) => {
    setBusy(true)
    action()
      .then((p) => {
        applyPayload(p)
        showToast({ message: message(p) })
      })
      .catch((e: unknown) => showToast({ message: e instanceof Error ? e.message : 'Action failed' }))
      .finally(() => setBusy(false))
  }

  return (
    <div className="agenda">
      <header className="agenda-header">
        <div>
          <h2>Agenda</h2>
          <p className="agenda-sub">
            Manage your event agenda and schedule · {data.event.name} · {tzAbbr(tz, data.event.starts_at)}
          </p>
        </div>
        <div className="agenda-toolbar">
          <input
            type="search"
            placeholder="Search sessions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search sessions"
          />
          {(view === 'day' || view === 'week') && (
            <label className="agenda-groupby">
              Group by
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'room' | 'track')} disabled={view === 'week'}>
                <option value="room">Room</option>
                <option value="track">Track</option>
              </select>
            </label>
          )}
          <button
            disabled={busy || pendingConfirmations === 0}
            title="Email calendar invites for every scheduled session that has none yet"
            onClick={() =>
              runAction(sendScheduleConfirmations, (p) => `${p.queued} invite${p.queued === 1 ? '' : 's'} queued for ${p.sent_sessions} session${p.sent_sessions === 1 ? '' : 's'}`)
            }
          >
            Send confirmations{pendingConfirmations > 0 ? ` (${pendingConfirmations})` : ''}
          </button>
          <button className="primary" onClick={() => setShowAdd(true)}>+ Add Session</button>
        </div>
      </header>

      <nav className="agenda-views" aria-label="Agenda views">
        {VIEWS.map((v) => (
          <button key={v.key} className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)}>
            {v.label}
            {v.key === 'conflicts' && (errorCount > 0 || warningCount > 0) && (
              <span className="agenda-conflict-chip">
                {errorCount > 0 && <em>{errorCount}</em>}
                {warningCount > 0 && <i>{warningCount}</i>}
              </span>
            )}
          </button>
        ))}
        {view === 'day' && (
          <span className="agenda-day-switch">
            <button disabled={dayIndex <= 0} onClick={() => setCurDay(days[dayIndex - 1] as string)} aria-label="Previous day">‹</button>
            <select value={curDay} onChange={(e) => setCurDay(e.target.value)} aria-label="Day">
              {days.map((d) => (
                <option key={d} value={d}>{fmtDay(d)}</option>
              ))}
            </select>
            <button disabled={dayIndex >= days.length - 1} onClick={() => setCurDay(days[dayIndex + 1] as string)} aria-label="Next day">›</button>
          </span>
        )}
      </nav>

      <div className="agenda-body">
        {view !== 'conflicts' && view !== 'list' && view !== 'month' && (
          <Tray
            sessions={unscheduled}
            tracks={data.tracks}
            defaultDuration={defaultDuration}
            trackColor={trackColor}
            onUnschedule={(id) => commitSchedule(id, { starts_at: null, ends_at: null, room_id: null })}
            onOpenMove={setMoveId}
          />
        )}

        <div className="agenda-view">
          {view === 'day' && (
            <TimeGrid
              columns={dayColumns}
              sessions={filteredSessions}
              timezone={tz}
              dayStartMin={DAY_START_MIN}
              dayEndMin={DAY_END_MIN}
              columnOf={(s) => {
                if (sessionDay(s) !== curDay) return null
                if (groupBy === 'room') return s.room_id
                return s.track_id ?? '__none'
              }}
              conflictLevel={conflictLevel}
              conflictTitle={conflictTitle}
              trackColor={trackColor}
              onDrop={(id, col, startMin, dur) => {
                const roomId = groupBy === 'room' ? col.key : sessionById.get(id)?.room_id ?? null
                commitSchedule(id, patchFrom(col.day, startMin, dur, roomId))
              }}
              onResize={(id, dur) => {
                const s = sessionById.get(id)
                if (!s?.starts_at) return
                const local = utcToLocal(s.starts_at, tz)
                commitSchedule(id, patchFrom(local.day, local.minutes, dur, s.room_id))
              }}
              onOpenMove={setMoveId}
              previewDrop={(id, col, startMin, dur) => {
                const roomId = groupBy === 'room' ? col.key : sessionById.get(id)?.room_id ?? null
                return previewFor(id, col.day, startMin, dur, roomId)
              }}
            />
          )}

          {view === 'week' && (
            <TimeGrid
              columns={weekColumns}
              sessions={filteredSessions}
              timezone={tz}
              dayStartMin={DAY_START_MIN}
              dayEndMin={DAY_END_MIN}
              columnOf={sessionDay}
              conflictLevel={conflictLevel}
              conflictTitle={conflictTitle}
              trackColor={trackColor}
              onDrop={(id, col, startMin, dur) =>
                commitSchedule(id, patchFrom(col.day, startMin, dur, sessionById.get(id)?.room_id ?? null))
              }
              onResize={(id, dur) => {
                const s = sessionById.get(id)
                if (!s?.starts_at) return
                const local = utcToLocal(s.starts_at, tz)
                commitSchedule(id, patchFrom(local.day, local.minutes, dur, s.room_id))
              }}
              onOpenMove={setMoveId}
              previewDrop={(id, col, startMin, dur) =>
                previewFor(id, col.day, startMin, dur, sessionById.get(id)?.room_id ?? null)
              }
            />
          )}

          {view === 'rooms' && (
            <RoomsBoard
              rooms={data.rooms}
              days={days}
              sessions={filteredSessions}
              timezone={tz}
              dayStartMin={DAY_START_MIN}
              dayEndMin={DAY_END_MIN}
              conflictLevel={conflictLevel}
              conflictTitle={conflictTitle}
              trackColor={trackColor}
              onDrop={(id, roomId, day, startMin, dur) => commitSchedule(id, patchFrom(day, startMin, dur, roomId))}
              onOpenMove={setMoveId}
              previewDrop={(id, roomId, day, startMin, dur) => previewFor(id, day, startMin, dur, roomId)}
            />
          )}

          {view === 'month' && (
            <MonthView days={days} sessions={filteredSessions} timezone={tz} onPickDay={(d) => { setCurDay(d); setView('day') }} />
          )}

          {view === 'list' && (
            <ListView sessions={filteredSessions} timezone={tz} trackById={trackById} rooms={data.rooms} conflictLevel={conflictLevel} onOpenMove={setMoveId} />
          )}

          {view === 'conflicts' && (
            <ConflictsView
              conflicts={data.conflicts}
              sessionById={sessionById}
              onOpenMove={setMoveId}
              onRemoveSpeaker={(sessionId, contactId, speakerName, sessionTitle) => {
                if (!window.confirm(`Remove ${speakerName} from “${sessionTitle}”?`)) return
                runAction(
                  () => removeSessionSpeaker(sessionId, contactId),
                  () => `${speakerName} removed from the session`,
                )
              }}
              onIgnore={(signatureValue, ignored) =>
                runAction(
                  () => setConflictIgnored(signatureValue, ignored),
                  () => (ignored ? 'Conflict ignored' : 'Conflict restored'),
                )
              }
            />
          )}
        </div>
      </div>

      {moveSession && (
        <MoveDialog
          session={moveSession}
          rooms={data.rooms}
          days={days}
          timezone={tz}
          defaultDurationMin={defaultDuration(moveSession)}
          onSave={({ day, startMin, durationMin, roomId }) => {
            setMoveId(null)
            commitSchedule(moveSession.id, patchFrom(day, startMin, durationMin, roomId))
          }}
          onUnschedule={() => {
            setMoveId(null)
            commitSchedule(moveSession.id, { starts_at: null, ends_at: null, room_id: null })
          }}
          onClose={() => setMoveId(null)}
        />
      )}

      {showAdd && (
        <AddSessionDialog
          tracks={data.tracks}
          rooms={data.rooms}
          days={days}
          onSave={(body) => {
            setShowAdd(false)
            runAction(
              () =>
                addAgendaSession({
                  title: body.title,
                  track_id: body.track_id,
                  format: body.format,
                  room_id: body.room_id,
                  starts_at: body.day !== null && body.startMin !== null ? localToUtc(body.day, body.startMin, tz) : null,
                  ends_at:
                    body.day !== null && body.startMin !== null
                      ? localToUtc(body.day, body.startMin + body.durationMin, tz)
                      : null,
                }),
              () => `“${body.title}” added`,
            )
          }}
          onClose={() => setShowAdd(false)}
        />
      )}

      {toast && (
        <div className="agenda-toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              onClick={() => {
                setToast(null)
                toast.undo?.()
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Month view: cells with session counts, click through to the day (docs/07 §2)
// ---------------------------------------------------------------------------

function MonthView({
  days,
  sessions,
  timezone,
  onPickDay,
}: {
  days: string[]
  sessions: AgendaSessionRow[]
  timezone: string
  onPickDay: (day: string) => void
}) {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    if (!s.starts_at) continue
    const day = utcToLocal(s.starts_at, timezone).day
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  const first = days[0] ?? ''
  const [fy, fm] = first.split('-').map(Number)
  const year = fy as number
  const month = (fm as number) - 1
  const firstOfMonth = new Date(Date.UTC(year, month, 1, 12))
  const startPad = firstOfMonth.getUTCDay()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate()
  const eventSet = new Set(days)
  const cells: Array<{ day: string; num: number } | null> = []
  for (let i = 0; i < startPad; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, num: d })
  }
  const monthName = firstOfMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  return (
    <div className="month-view">
      <h3>{monthName}</h3>
      <div className="month-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div className="month-dow" key={d}>{d}</div>
        ))}
        {cells.map((cell, i) =>
          cell === null ? (
            <div className="month-cell empty" key={`pad-${i}`} />
          ) : (
            <button
              className={`month-cell${eventSet.has(cell.day) ? ' event-day' : ''}`}
              key={cell.day}
              disabled={!eventSet.has(cell.day)}
              onClick={() => onPickDay(cell.day)}
            >
              <span className="month-num">{cell.num}</span>
              {(counts.get(cell.day) ?? 0) > 0 && (
                <span className="month-count">{counts.get(cell.day)} session{(counts.get(cell.day) ?? 0) > 1 ? 's' : ''}</span>
              )}
            </button>
          ),
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// List view: the grid of sessions with schedule columns (docs/07 §2)
// ---------------------------------------------------------------------------

function ListView({
  sessions,
  timezone,
  trackById,
  rooms,
  conflictLevel,
  onOpenMove,
}: {
  sessions: AgendaSessionRow[]
  timezone: string
  trackById: Map<string, { name: string }>
  rooms: Array<{ id: string; name: string }>
  conflictLevel: (id: string) => 'error' | 'warning' | null
  onOpenMove: (id: string) => void
}) {
  const [sort, setSort] = useState<{ field: 'starts_at' | 'title' | 'code'; dir: 1 | -1 }>({ field: 'starts_at', dir: 1 })
  const roomName = (id: string | null) => (id ? rooms.find((r) => r.id === id)?.name ?? '' : '')

  const sorted = [...sessions].sort((a, b) => {
    const av = a[sort.field] ?? '￿' // unscheduled last
    const bv = b[sort.field] ?? '￿'
    return av < bv ? -sort.dir : av > bv ? sort.dir : 0
  })
  const header = (field: 'starts_at' | 'title' | 'code', label: string) => (
    <th
      role="button"
      tabIndex={0}
      onClick={() => setSort((s) => ({ field, dir: s.field === field && s.dir === 1 ? -1 : 1 }))}
    >
      {label}
      {sort.field === field ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
    </th>
  )

  return (
    <div className="agenda-list">
      <table>
        <thead>
          <tr>
            {header('code', 'Code')}
            {header('title', 'Title')}
            <th>Speakers</th>
            <th>Track</th>
            <th>Format</th>
            <th>Room</th>
            {header('starts_at', 'When')}
            <th>Duration</th>
            <th>Invite</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => {
            const level = conflictLevel(s.id)
            return (
              <tr key={s.id} className={level ? `conflict-${level}` : ''} onDoubleClick={() => onOpenMove(s.id)}>
                <td>{s.code}</td>
                <td className="list-title">
                  {level && <span className="tg-block-flag" aria-hidden>⚠ </span>}
                  {s.title}
                </td>
                <td>{s.speakers.map((sp) => sp.name).join(', ')}</td>
                <td>{s.track_id ? trackById.get(s.track_id)?.name ?? '' : ''}</td>
                <td>{s.format ?? ''}</td>
                <td>{roomName(s.room_id)}</td>
                <td>
                  {s.starts_at && s.ends_at
                    ? `${fmtDay(utcToLocal(s.starts_at, timezone).day)} · ${fmtRange(s.starts_at, s.ends_at, timezone)}`
                    : <span className="list-unscheduled">Unscheduled</span>}
                </td>
                <td>{s.starts_at && s.ends_at ? `${durationMinutes(s.starts_at, s.ends_at)} min` : ''}</td>
                <td>{s.invited === 1 ? '✓' : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {sorted.length === 0 && <p className="conflicts-empty">Nothing here yet — sessions will appear here in list view.</p>}
    </div>
  )
}

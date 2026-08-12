import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { breakpoints } from '@kms/theme'
import {
  buildConflictIndexes,
  computeConflicts,
  computeConflictsForSession,
  type AgendaSessionInput,
  type ConflictIndexes,
} from '@kms/core'
import {
  addAgendaSession,
  getAgenda,
  getBulkJob,
  removeSessionSpeaker,
  scheduleSession,
  sendScheduleConfirmations,
  setAgendaPublished,
  setConflictIgnored,
  type AgendaConflictRow,
  type AgendaPayload,
  type AgendaSessionRow,
  type SchedulePatch,
} from '../api'
import { DesktopOnlyNotice } from '@kms/ui/desktop-only'
import { appConfirm } from '../components/dialogs'
import { createMutationQueue } from './mutationQueue'
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
  formatMinutes,
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

/**
 * The one Tier C screen that gates in JS rather than with display:none.
 * TimeGrid/RoomsBoard measure themselves through useElementSize, and a
 * zero-width mount produces a grid laid out against a 0px column — so the
 * compact branch must not mount them at all. Same matchMedia idiom as
 * DataTabManager's tab-strip dropdown.
 */
const COMPACT_MEDIA_QUERY = `(max-width: ${breakpoints.compact}px)`

/** Grid modes; `list` and `conflicts` stay usable at every width. */
const GRID_VIEWS: AgendaView[] = ['day', 'week', 'month', 'rooms']

interface UndoEntry {
  id: string
  prev: { starts_at: string | null; ends_at: string | null; room_id: string | null }
}

interface Toast {
  message: string
  undo?: () => void
}

const isAgendaView = (value: string | null | undefined): value is AgendaView =>
  value !== null && value !== undefined && VIEWS.some((v) => v.key === value)

/** Only the fields the conflict engine reads — keeps the row type out of core. */
const toEngineSession = (s: AgendaSessionRow): AgendaSessionInput => ({
  id: s.id,
  code: s.code,
  title: s.title,
  starts_at: s.starts_at,
  ends_at: s.ends_at,
  room_id: s.room_id,
  track_id: s.track_id,
  capacity: s.capacity,
  speakers: s.speakers,
})

/**
 * The server refused to move a session that has a live calendar invite
 * without a notification decision (FR-COMM-6). `api.ts` folds the error code
 * into the readable message, so match on the pair.
 */
const isNotifyRequired = (error: unknown): boolean =>
  error instanceof Error &&
  (error as { status?: number }).status === 409 &&
  error.message.includes('invite_notify_required')

/** What the operator decided about the invite email for one schedule write. */
interface NotifyDecision {
  notify?: SchedulePatch['notify']
  /** True once the operator has been asked — even if they declined the mail. */
  asked: boolean
}

type ScheduleBody = SchedulePatch & { capacity?: number | null; notify_ack?: boolean }

/**
 * `initialView`/`initialDay` come from the URL (router.ts `mode`/`day`); the
 * section keeps owning its state and simply reports changes back so the address
 * bar follows along. Invalid values fall back to the defaults.
 */
export function AgendaSection({
  initialView,
  initialDay,
  onViewChange,
  onDayChange,
}: {
  initialView?: string | null
  initialDay?: string | null
  onViewChange?: (view: AgendaView) => void
  onDayChange?: (day: string) => void
} = {}) {
  const [data, setData] = useState<AgendaPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<AgendaView>(isAgendaView(initialView) ? initialView : 'day')
  const [groupBy, setGroupBy] = useState<'room' | 'track'>('room')
  const [curDay, setCurDay] = useState('')
  const [search, setSearch] = useState('')
  const [moveId, setMoveId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [busy, setBusy] = useState(false)
  const [publishBusy, setPublishBusy] = useState(false)
  const [jobNote, setJobNote] = useState<string | null>(null)
  const [jobActive, setJobActive] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [isCompact, setIsCompact] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(COMPACT_MEDIA_QUERY).matches : false
  )
  const undoStack = useRef<UndoEntry[]>([])
  const toastTimer = useRef<number | null>(null)
  const jobTimer = useRef<number | null>(null)

  // Mutations are dispatched from callbacks that may have been created many
  // payloads ago (a dialog can sit open across three server responses), so
  // every one of them reads the board through this ref rather than through
  // the `data` its closure captured (sweep item P2-9).
  const dataRef = useRef<AgendaPayload | null>(null)
  dataRef.current = data

  useEffect(() => {
    const mq = window.matchMedia(COMPACT_MEDIA_QUERY)
    const handler = (e: MediaQueryListEvent) => setIsCompact(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const showToast = useCallback((t: Toast) => {
    setToast(t)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 6000)
  }, [])

  /** Authoritative resync — bypasses the queue's sequence gate on purpose. */
  const reload = useCallback(() => {
    getAgenda().then(setData).catch(() => undefined)
  }, [])

  // One queue for the whole screen: per-session FIFO, newest-response-wins,
  // one toast plus one authoritative refetch per error burst.
  const queue = useMemo(
    () =>
      createMutationQueue({
        onError: (error) =>
          showToast({ message: error instanceof Error ? error.message : 'The agenda change failed' }),
        onRefetch: reload,
      }),
    [reload, showToast],
  )
  useEffect(() => () => queue.dispose(), [queue])
  useEffect(
    () => () => {
      if (jobTimer.current !== null) window.clearTimeout(jobTimer.current)
    },
    [],
  )

  useEffect(() => {
    getAgenda()
      .then((p) => {
        setData(p)
        setCurDay((d) => {
          if (d) return d
          const evDays = eventDays(p.event.starts_at, p.event.ends_at, p.event.timezone)
          // Honour a `?day=` deep link when it names a day of this event.
          if (initialDay && evDays.includes(initialDay)) return initialDay
          return evDays[0] || ''
        })
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load the agenda'))
  }, [])

  // Report view/day back to the router (replaceState — these refine the screen
  // rather than navigate). Reporting from an effect keeps every internal
  // setView/setCurDay call site untouched.
  useEffect(() => {
    onViewChange?.(view)
  }, [onViewChange, view])
  useEffect(() => {
    if (curDay) onDayChange?.(curDay)
  }, [curDay, onDayChange])

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
    return formatMinutes(s.format) ?? 30
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

  /**
   * Invited sessions never change silently (docs/07 §6 / FR-COMM-6). Ask
   * before cancelling or re-sending; declining still applies the schedule
   * change, but the answer is recorded so the server knows a human decided.
   */
  const askNotify = useCallback(
    async (session: AgendaSessionRow, unscheduling: boolean): Promise<NotifyDecision> => {
      const sending = unscheduling
        ? await appConfirm(
            `“${session.title}” has a live calendar invite.\nSend a cancellation email to its speakers?`,
            { title: 'Unscheduling an invited session', confirmLabel: 'Send cancellation', cancelLabel: 'Skip the email' },
          )
        : await appConfirm(
            `“${session.title}” has a live calendar invite.\nEmail its speakers an updated invite for the new slot?`,
            { title: 'Moving an invited session', confirmLabel: 'Send updated invite', cancelLabel: 'Skip the email' },
          )
      return sending ? { notify: unscheduling ? 'cancelled' : 'changed', asked: true } : { asked: true }
    },
    [],
  )

  /**
   * The write itself. A 409 `invite_notify_required` means the server holds a
   * live invite our payload did not know about — a bulk send only *enqueues* a
   * job now, so `invited` can flip minutes after the 202. Prompt with that
   * authoritative knowledge and resend rather than surfacing an error.
   */
  const putSchedule = useCallback(
    async (id: string, body: ScheduleBody, session: AgendaSessionRow, unscheduling: boolean) => {
      try {
        return await scheduleSession(id, body)
      } catch (error) {
        if (!isNotifyRequired(error)) throw error
        const decision = await askNotify(session, unscheduling)
        return await scheduleSession(id, {
          ...body,
          ...(decision.notify ? { notify: decision.notify } : { notify_ack: true }),
        })
      }
    },
    [askNotify],
  )

  /** Drop this session's newest undo entry — the server never took the change. */
  const dropUndo = useCallback((id: string) => {
    const index = undoStack.current.map((e) => e.id).lastIndexOf(id)
    if (index >= 0) undoStack.current.splice(index, 1)
  }, [])

  const commitSchedule = useCallback(
    (
      id: string,
      patch: { starts_at: string | null; ends_at: string | null; room_id: string | null },
      opts: { pushUndo?: boolean; label?: string; capacity?: number | null } = {},
    ) => {
      const current = dataRef.current
      if (!current) return
      const session = current.sessions.find((s) => s.id === id)
      if (!session) return
      const capacityChanges = opts.capacity !== undefined && opts.capacity !== session.capacity
      if (
        session.starts_at === patch.starts_at &&
        session.ends_at === patch.ends_at &&
        session.room_id === patch.room_id &&
        !capacityChanges
      ) {
        return
      }

      // The prompt is async, so the rest of the commit continues inside the
      // IIFE — and reads `dataRef`, never the captured render's `data`.
      void (async () => {
        const decision: NotifyDecision =
          session.invited === 1 ? await askNotify(session, patch.starts_at === null) : { asked: false }

        const prev = { starts_at: session.starts_at, ends_at: session.ends_at, room_id: session.room_id }
        if (opts.pushUndo !== false) undoStack.current.push({ id, prev })

        setData((cur) =>
          cur === null
            ? cur
            : withLocalConflicts(
                cur,
                cur.sessions.map((s) =>
                  s.id === id
                    ? { ...s, ...patch, ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}) }
                    : s,
                ),
              ),
        )

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

        const body: ScheduleBody = {
          ...patch,
          ...(decision.notify ? { notify: decision.notify } : {}),
          ...(decision.asked && !decision.notify ? { notify_ack: true } : {}),
          ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}),
        }

        void queue.enqueue(id, () => putSchedule(id, body, session, patch.starts_at === null), {
          apply: applyPayload,
          onError: () => dropUndo(id),
        })
      })()
    },
    [applyPayload, askNotify, dropUndo, putSchedule, queue, showToast, tz, withLocalConflicts],
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

  const ignoredSignatures = useMemo(
    () => new Set((data?.conflicts ?? []).filter((c) => c.ignored).map((c) => c.signature)),
    [data],
  )

  // Indexes over "every session except the dragged one" — built once per
  // dragged session and thrown away whenever the board changes, so a drag
  // costs one bucketing pass instead of a full sweep per frame (P2-17).
  const indexCache = useMemo(() => new Map<string, ConflictIndexes>(), [data?.sessions])

  const previewFor = useCallback(
    (id: string, day: string, startMin: number, durationMin: number, roomId: string | null): DropPreview => {
      const current = dataRef.current
      const session = current?.sessions.find((s) => s.id === id)
      if (!current || !session) return { bad: false, titles: '' }
      let indexes = indexCache.get(id)
      if (!indexes) {
        indexes = buildConflictIndexes(current.sessions.filter((s) => s.id !== id).map(toEngineSession))
        indexCache.set(id, indexes)
      }
      const tentative = { ...toEngineSession(session), ...patchFrom(day, startMin, durationMin, roomId) }
      const hits = computeConflictsForSession(tentative, indexes, current.rooms, {
        starts_at: current.event.starts_at,
        ends_at: current.event.ends_at,
      }).filter((c) => c.severity !== 'info' && !ignoredSignatures.has(c.signature))
      return { bad: hits.length > 0, titles: hits.map((c) => `${c.code}: ${c.message}`).join('\n') }
    },
    [ignoredSignatures, indexCache, patchFrom],
  )

  const filteredSessions = useMemo(() => {
    if (!data) return []
    if (!search) return data.sessions
    const q = search.toLowerCase()
    return data.sessions.filter((s) =>
      `${s.code} ${s.title} ${s.speakers.map((sp) => sp.name).join(' ')}`.toLowerCase().includes(q),
    )
  }, [data, search])

  // The tray holds everything without a date/time — including sessions with a
  // room preset (previously classified 'pencilled' and rendered nowhere on Day
  // view). Their room/track membership surfaces as header pills instead.
  const unscheduled = useMemo(
    () => filteredSessions.filter((s) => s.starts_at === null),
    [filteredSessions],
  )
  const pencilledCount = useMemo(
    () => filteredSessions.filter((s) => s.starts_at !== null && s.room_id === null).length,
    [filteredSessions],
  )
  const pendingConfirmations = useMemo(
    () => (data?.sessions ?? []).filter((s) => s.starts_at !== null && s.invited === 0).length,
    [data],
  )
  const errorCount = liveConflicts.filter((c) => c.severity === 'error').length
  const warningCount = liveConflicts.filter((c) => c.severity === 'warning').length
  const conflictCount = errorCount + warningCount

  if (error) return <div className="agenda"><p className="agenda-error">{error}</p></div>
  if (!data) return <div className="agenda"><p className="agenda-loading">Loading agenda…</p></div>

  const moveSession = moveId !== null ? sessionById.get(moveId) ?? null : null
  const dayIndex = days.indexOf(curDay)
  // The view strip stays live, so List and Conflicts are one tap away.
  const refuseGrid = isCompact && GRID_VIEWS.includes(view)

  // Header pills: sessions with a room/track preset but no date/time live in
  // the tray, so the column they belong to advertises how many are waiting.
  const unplacedPill = (count: number, name: string) =>
    count > 0
      ? {
          pill: count,
          pillTitle: `${count} session${count === 1 ? '' : 's'} in ${name} with no date/time — see the Unscheduled tray`,
        }
      : {}

  const dayColumns: GridColumn[] =
    groupBy === 'room'
      ? data.rooms.map((r) => ({
          key: r.id,
          label: r.name,
          ...(r.capacity !== null ? { sub: `${r.capacity}` } : {}),
          ...unplacedPill(unscheduled.filter((s) => s.room_id === r.id).length, r.name),
          day: curDay,
        }))
      : [
          ...data.tracks.map((t) => ({
            key: t.id,
            label: t.name,
            ...unplacedPill(unscheduled.filter((s) => s.track_id === t.id).length, t.name),
            day: curDay,
          })),
          { key: '__none', label: 'No track', day: curDay },
        ]

  const weekColumns: GridColumn[] = days.map((d) => ({ key: d, label: fmtDay(d), day: d }))

  const sessionDay = (s: AgendaSessionRow): string | null =>
    s.starts_at !== null ? utcToLocal(s.starts_at, tz).day : null

  // Board-wide writes share one queue key: they each answer with a whole
  // payload, so they must not interleave with each other either.
  const runAction = <T extends AgendaPayload>(
    action: () => Promise<T>,
    message: (p: T) => string,
  ) => {
    setBusy(true)
    void queue
      .enqueue('agenda', action, {
        apply: (p) => {
          applyPayload(p)
          showToast({ message: message(p) })
        },
      })
      .finally(() => setBusy(false))
  }

  const published = data.event.agenda_published === 1

  /** FR-AGENDA-9: the flag gates the public GET /e/:slug/agenda.json feed. */
  const togglePublish = async () => {
    const current = dataRef.current
    if (!current) return
    const next = current.event.agenda_published !== 1
    if (!next) {
      const confirmed = await appConfirm(
        'Unpublish the agenda? The public agenda feed stops answering until you publish again.',
        { title: 'Unpublish agenda', confirmLabel: 'Unpublish', danger: true },
      )
      if (!confirmed) return
    }
    if (next) {
      // Publish-time guard (eval defect): an accepted session still in the
      // tray silently never appears publicly. Name the unplaced sessions and
      // make going live an explicit choice.
      const unplaced = current.sessions.filter((s) => s.starts_at === null)
      if (unplaced.length > 0) {
        const listed = unplaced.slice(0, 6).map((s) => `• ${s.code} · ${s.title}`)
        if (unplaced.length > 6) listed.push(`…and ${unplaced.length - 6} more`)
        const confirmed = await appConfirm(
          `${unplaced.length} accepted session${unplaced.length === 1 ? ' is' : 's are'} not scheduled yet and will NOT appear on the public agenda:\n\n${listed.join('\n')}\n\nPublish anyway?`,
          { title: 'Unscheduled sessions will be missing', confirmLabel: 'Publish anyway', cancelLabel: 'Keep as draft' },
        )
        if (!confirmed) return
      }
    }
    setPublishBusy(true)
    setData((cur) => (cur === null ? cur : { ...cur, event: { ...cur.event, agenda_published: next ? 1 : 0 } }))
    try {
      await setAgendaPublished(current.event.id, next)
      showToast({
        message: next ? `Agenda published at /e/${current.event.slug}/agenda.json` : 'Agenda unpublished',
      })
    } catch (e: unknown) {
      showToast({ message: e instanceof Error ? e.message : 'Publishing failed' })
      reload()
    } finally {
      setPublishBusy(false)
    }
  }

  /**
   * Bulk invites are a job now (P2-19): the 202 carries a job id and the cron
   * expander does the sending, so progress is polled until it settles. The
   * final tick reloads the board — that is when `invited` actually flips.
   */
  const pollJob = (jobId: string, total: number) => {
    const tick = () => {
      getBulkJob(jobId)
        .then((job) => {
          const target = job.total ?? total
          if (job.status === 'done') {
            setJobNote(`Invites sent: ${job.sent} of ${target}${job.failed > 0 ? ` (${job.failed} failed)` : ''}`)
            setJobActive(false)
            reload()
            return
          }
          if (job.status === 'failed') {
            setJobNote(`Invite send failed${job.error ? `: ${job.error}` : ''}`)
            setJobActive(false)
            return
          }
          setJobNote(`Queued ${job.enqueued} of ${target}…`)
          jobTimer.current = window.setTimeout(tick, 3000)
        })
        .catch(() => {
          // A polling hiccup should not strand the button; the next send retries.
          setJobNote(null)
          setJobActive(false)
        })
    }
    tick()
  }

  const sendConfirmations = () => {
    if (jobTimer.current !== null) window.clearTimeout(jobTimer.current)
    setBusy(true)
    setJobActive(true)
    sendScheduleConfirmations()
      .then((p) => {
        applyPayload(p)
        const jobId = (p as { job_id?: string }).job_id
        showToast({
          message: `${p.sent_sessions} session${p.sent_sessions === 1 ? '' : 's'} queued for invites`,
        })
        setJobNote(`Queued 0 of ${p.sent_sessions}…`)
        if (jobId) pollJob(jobId, p.sent_sessions)
        else setJobActive(false) // pre-job server: nothing to poll
      })
      .catch((e: unknown) => {
        showToast({ message: e instanceof Error ? e.message : 'Sending invites failed' })
        setJobNote(null)
        setJobActive(false)
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="agenda">
      <header className="agenda-header">
        <div>
          <h2>
            Agenda
            <span className={`agenda-state-chip${published ? ' live' : ''}`}>{published ? 'Published' : 'Draft'}</span>
          </h2>
          <p className="agenda-sub">
            Manage your event agenda and schedule · {data.event.name} · {tzAbbr(tz, data.event.starts_at)}
          </p>
          <p className="agenda-slot-summary">
            {unscheduled.length} unplaced · {pencilledCount} pencilled · {conflictCount} conflict{conflictCount === 1 ? '' : 's'}
          </p>
          {jobNote && (
            <p className="agenda-job-note" role="status">{jobNote}</p>
          )}
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
            disabled={busy || jobActive || pendingConfirmations === 0}
            title="Email calendar invites for every scheduled session that has none yet"
            onClick={sendConfirmations}
          >
            Send confirmations{pendingConfirmations > 0 ? ` (${pendingConfirmations})` : ''}
          </button>
          <button
            disabled={publishBusy}
            title={
              published
                ? 'Stop serving the public agenda feed'
                : 'Publish the agenda to the public feed (/e/slug/agenda.json)'
            }
            onClick={() => void togglePublish()}
          >
            {published ? 'Unpublish' : 'Publish'}
          </button>
          <button
            className="primary"
            onClick={() => {
              // Rooms/tracks can be added from Settings without leaving this
              // screen open in another tab; the board's `data` is otherwise
              // only refreshed on mount or after a mutation, so a room added
              // moments ago could still be missing from this dialog's list
              // without an explicit resync right before it opens.
              reload()
              setShowAdd(true)
            }}
          >
            + Add Session
          </button>
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
        {refuseGrid ? (
          <DesktopOnlyNotice
            title="The agenda builder needs a wider window."
            message="Dragging sessions across a rooms-by-time grid is the one thing a phone cannot do well. Here is the same day, read-only — every row still has Move."
            summary={
              <ListView
                sessions={filteredSessions}
                timezone={tz}
                trackById={trackById}
                rooms={data.rooms}
                conflictLevel={conflictLevel}
                conflictTitle={conflictTitle}
                onOpenMove={setMoveId}
              />
            }
            action={{ label: 'Switch to the list view', onClick: () => setView('list') }}
          />
        ) : (
        <>
        {view !== 'conflicts' && view !== 'list' && view !== 'month' && (
          <Tray
            sessions={unscheduled}
            tracks={data.tracks}
            rooms={data.rooms}
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
              onDropDay={(id, day) => {
                const s = sessionById.get(id)
                if (s) commitSchedule(id, patchFrom(day, 0, defaultDuration(s), null))
              }}
              confineColumnKey={(id) => {
                // A tray session with a preset room/track only drops into its
                // own column; scheduled blocks keep full freedom.
                const s = sessionById.get(id)
                if (!s || s.starts_at !== null) return null
                return groupBy === 'room' ? s.room_id : s.track_id
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
              onDropDay={(id, day) => {
                const s = sessionById.get(id)
                if (s) commitSchedule(id, patchFrom(day, 0, defaultDuration(s), null))
              }}
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
            <ListView sessions={filteredSessions} timezone={tz} trackById={trackById} rooms={data.rooms} conflictLevel={conflictLevel} conflictTitle={conflictTitle} onOpenMove={setMoveId} />
          )}

          {view === 'conflicts' && (
            <ConflictsView
              conflicts={data.conflicts}
              sessionById={sessionById}
              onOpenMove={setMoveId}
              onRemoveSpeaker={(sessionId, contactId, speakerName, sessionTitle) => {
                void appConfirm(`Remove ${speakerName} from “${sessionTitle}”?`, {
                  title: 'Remove speaker',
                  confirmLabel: 'Remove',
                  danger: true,
                }).then((confirmed) => {
                  if (!confirmed) return
                  runAction(
                    () => removeSessionSpeaker(sessionId, contactId),
                    () => `${speakerName} removed from the session`,
                  )
                })
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
        </>
        )}
      </div>

      {moveSession && (
        <MoveDialog
          session={moveSession}
          rooms={data.rooms}
          days={days}
          timezone={tz}
          defaultDurationMin={defaultDuration(moveSession)}
          onSave={({ day, startMin, durationMin, roomId, capacity }) => {
            setMoveId(null)
            commitSchedule(moveSession.id, patchFrom(day, startMin, durationMin, roomId), { capacity })
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
                  capacity: body.capacity,
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
  conflictTitle,
  onOpenMove,
}: {
  sessions: AgendaSessionRow[]
  timezone: string
  trackById: Map<string, { name: string }>
  rooms: Array<{ id: string; name: string }>
  conflictLevel: (id: string) => 'error' | 'warning' | null
  conflictTitle: (id: string) => string
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
                  {level && (
                    <span className="tg-block-flag" role="img" aria-label="Scheduling conflict" title={conflictTitle(s.id)}>
                      ⚠{' '}
                    </span>
                  )}
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
                <td>
                  {s.starts_at && s.ends_at
                    ? (() => {
                        // Duration/format divergence (eval defect: a 10-min
                        // lightning talk sat in a silent 30-min block).
                        const dur = durationMinutes(s.starts_at, s.ends_at)
                        const expected = formatMinutes(s.format)
                        return expected !== null && expected !== dur ? (
                          <span
                            className="list-duration-mismatch"
                            title={`Format “${s.format}” suggests ${expected} min`}
                          >
                            {dur} min ⚠
                          </span>
                        ) : (
                          `${dur} min`
                        )
                      })()
                    : ''}
                </td>
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

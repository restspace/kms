import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchDashboard,
  fetchOrgDashboard,
  getBulkJob,
  remindTasks,
  type DashboardNudge,
  type DashboardPayload,
  type OrgDashboardPayload,
} from '../api'
import { useEventScopeOptional, type EventFilter } from '../eventScope'
import { fmtDateInTz } from '../utils/dates'
import { ChaseInboxPanel, ChaseModeBanner } from './ChaseInbox'
import './dashboard.css'

/**
 * Dashboards (docs/09, M5): three fixed layouts — Today, Speaker Tracking,
 * Submissions Pipeline — over one polled payload. Every row and nudge
 * deep-links to the screen that resolves it (the M5 stretch): navigation goes
 * up through onNavigate so App can pre-seed the workspace or agenda.
 *
 * CRM-12: those three are per-event. When the sidebar filter says "All
 * events" the section swaps them for a single Organisation board over
 * /app/api/dashboard/org — the org-wide contact/company/event roll-up the
 * per-event payload can't express. The per-event boards (and their local
 * state) are untouched; picking a concrete event brings them straight back.
 */

export type AppNavTarget =
  | { view: 'agenda'; agendaView?: 'conflicts' }
  | { view: 'forms' }
  | { view: 'settings' }
  | {
      view: 'workspace'
      tab: 'speakers' | 'submissions' | 'tasks' | 'messages'
      /** Per-tab local filter seeds applied on arrival. */
      seedFilters?: Partial<Record<'speakers' | 'submissions' | 'tasks' | 'messages', Record<string, unknown>>>
      /** Chip label shown while the seed is active. */
      label?: string
      /**
       * Event filter to land on (`?ev=`): 'all' for the org directory, an id
       * for one event. Emitted by the Organisation board's click-throughs;
       * the section also applies it itself via the event scope, so a host
       * that ignores this field still navigates correctly.
       */
      ev?: EventFilter
    }

const POLL_MS = 15_000

const BOARDS = [
  { key: 'today', label: 'Today', dot: 'var(--accent)' },
  { key: 'tracking', label: 'Speaker Tracking', dot: 'var(--chart-2)' },
  { key: 'pipeline', label: 'Submissions Pipeline', dot: 'var(--chart-4)' },
] as const

type BoardKey = (typeof BOARDS)[number]['key']

const TODAY_TABS = [
  { key: 'forms', label: 'Submission Forms' },
  { key: 'participants', label: 'Participants' },
  { key: 'evaluations', label: 'Evaluations' },
  { key: 'agenda', label: 'Agenda' },
] as const

type TodayTab = (typeof TODAY_TABS)[number]['key']

const fmtDay = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

const statusLabelText = (s: string): string => s.replace(/_/g, ' ')

/**
 * Org board dates: the event rows carry no timezone (they span the whole
 * organisation), so the date part is read literally — midday UTC keeps the
 * calendar day stable either side of the date line.
 */
const fmtEventDay = (iso: string): string => {
  const day = iso.slice(0, 10)
  const d = new Date(`${day}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

const fmtEventRange = (starts: string, ends: string): string => {
  const from = fmtEventDay(starts)
  const to = fmtEventDay(ends)
  return from === to ? from : `${from} – ${to}`
}

/** Contact-anchored seeds: every workspace tab narrows to this speaker. */
const speakerSeeds = (contactId: string) => ({
  speakers: { contact_id: contactId },
  submissions: { contact_id: contactId },
  tasks: { contact_id: contactId },
  messages: { contact_id: contactId },
})

// --- small chart primitives -------------------------------------------------

function Donut({ segments, centre }: { segments: Array<{ value: number; color: string; label: string }>; centre: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0)
  const R = 40
  const C = 2 * Math.PI * R
  let offset = 0
  return (
    <div className="db-donut">
      <svg viewBox="0 0 100 100" role="img" aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(', ')}>
        <circle cx="50" cy="50" r={R} fill="none" stroke="var(--border)" strokeWidth="12" />
        {total > 0 &&
          segments.map((s) => {
            const len = (s.value / total) * C
            const el = (
              <circle
                key={s.label}
                cx="50"
                cy="50"
                r={R}
                fill="none"
                stroke={s.color}
                strokeWidth="12"
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 50 50)"
              />
            )
            offset += len
            return el
          })}
        <text x="50" y="54" textAnchor="middle" className="db-donut-centre">{centre}</text>
      </svg>
      <ul className="db-legend">
        {segments.map((s) => (
          <li key={s.label}>
            <span className="db-legend-dot" style={{ background: s.color }} />
            {s.label} <strong>{s.value}</strong>
            {total > 0 && <span className="db-legend-pct">{Math.round((s.value / total) * 100)}%</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function BarList({ rows, color, onRowClick }: {
  rows: Array<{ key: string; label: string; value: number; sub?: string }>
  color: string
  onRowClick?: (key: string) => void
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  if (rows.length === 0) return <div className="db-empty">Nothing here yet.</div>
  return (
    <div className="db-bars">
      {rows.map((r) => (
        <div
          key={r.key}
          className={`db-bar-row${onRowClick ? ' clickable' : ''}`}
          onClick={onRowClick ? () => onRowClick(r.key) : undefined}
          role={onRowClick ? 'button' : undefined}
          tabIndex={onRowClick ? 0 : undefined}
          onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r.key) } : undefined}
        >
          <span className="db-bar-label" title={r.label}>{r.label}</span>
          <span className="db-bar-track">
            <span className="db-bar-fill" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
          </span>
          <span className="db-bar-value">{r.value}{r.sub && <span className="db-bar-sub">{r.sub}</span>}</span>
        </div>
      ))}
    </div>
  )
}

function PacingChart({ pacing }: { pacing: DashboardPayload['forms']['pacing'] }) {
  if (pacing.length === 0) return <div className="db-empty">No submissions yet.</div>
  const W = 560
  const H = 120
  const PAD = 6
  const maxY = Math.max(1, pacing[pacing.length - 1].cumulative)
  const x = (i: number) => (pacing.length === 1 ? W / 2 : PAD + (i / (pacing.length - 1)) * (W - 2 * PAD))
  const y = (v: number) => H - PAD - (v / maxY) * (H - 2 * PAD)
  const points = pacing.map((p, i) => `${x(i)},${y(p.cumulative)}`).join(' ')
  return (
    <div className="db-pacing">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Cumulative submissions, ${maxY} total`}>
        <polyline points={`${x(0)},${y(0)} ${points}`} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {pacing.map((p, i) => (
          <circle key={p.day} cx={x(i)} cy={y(p.cumulative)} r="3" fill="var(--accent)">
            <title>{`${fmtDay(p.day)}: +${p.count} (${p.cumulative} total)`}</title>
          </circle>
        ))}
      </svg>
      <div className="db-pacing-axis">
        <span>{fmtDay(pacing[0].day)}</span>
        <span>{maxY} cumulative</span>
        <span>{fmtDay(pacing[pacing.length - 1].day)}</span>
      </div>
    </div>
  )
}

// --- the section ------------------------------------------------------------

export function DashboardSection({ onNavigate }: { onNavigate: (target: AppNavTarget) => void }) {
  // Optional so the section still renders standalone in tests: no provider
  // means no "All events" filter, which is the per-event board as before.
  const scope = useEventScopeOptional()
  const orgMode = scope?.filter === 'all'

  const [data, setData] = useState<DashboardPayload | null>(null)
  const [orgData, setOrgData] = useState<OrgDashboardPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [board, setBoard] = useState<BoardKey>('today')
  const [todayTab, setTodayTab] = useState<TodayTab>('forms')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [, setAgoTick] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const etagRef = useRef<string | null>(null)
  const orgEtagRef = useRef<string | null>(null)

  // Which mode a request was issued in. Flipping the filter starts a new
  // generation, so a response still in flight from the old one is dropped
  // rather than repainting (or erroring over) the board that replaced it.
  const genRef = useRef(0)
  useEffect(() => { genRef.current += 1 }, [orgMode])

  const load = useCallback(async (force = false) => {
    const gen = genRef.current
    try {
      if (orgMode) {
        const result = await fetchOrgDashboard(force ? null : orgEtagRef.current)
        if (gen !== genRef.current) return
        if (result.fresh) {
          setOrgData(result.payload)
          orgEtagRef.current = result.etag
        }
      } else {
        const result = await fetchDashboard(force ? null : etagRef.current)
        if (gen !== genRef.current) return
        if (result.fresh) {
          setData(result.payload)
          etagRef.current = result.etag
        }
      }
      setUpdatedAt(Date.now())
      setError(null)
    } catch (err) {
      if (gen !== genRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load the dashboard')
    }
  }, [orgMode])

  // Polling (sweep item 16, client half): a self-rescheduling timeout rather
  // than setInterval so each tick can (a) skip entirely while the tab is
  // hidden — no point paying for a fetch nobody's looking at — and (b) carry
  // its own ±15% jitter, so many admin tabs polling the same event don't all
  // hit the Worker in lockstep. Becoming visible again triggers an immediate
  // refetch (cheap: unchanged data is just a 304) rather than waiting out
  // whatever's left of the current interval.
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

    // Re-render every few seconds so "updated Ns ago" stays honest.
    const agoTimer = window.setInterval(() => setAgoTick((t) => t + 1), 5_000)

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.clearInterval(agoTimer)
    }
  }, [load])

  // Bulk-job progress (sweep item P2-19 follow-through): the server now
  // always returns `sent: 0` for the pre-job clients and hands back a
  // `job_id` to poll instead — `remindTasks`'s declared type predates that
  // change (frozen for this lane), so the extra field is read defensively.
  const remindPollTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (remindPollTimerRef.current !== null) window.clearTimeout(remindPollTimerRef.current)
  }, [])

  const pollRemindJob = useCallback((jobId: string) => {
    const poll = async () => {
      try {
        const job = await getBulkJob(jobId)
        if (job.status === 'done' || job.status === 'failed') {
          remindPollTimerRef.current = null
          setBusy(false)
          const skippedNoEmail = job.skipped_no_email ?? 0
          const skippedDuplicate = job.skipped_duplicate ?? 0
          // A run that sent nothing because everyone was already reminded is
          // the guarantee working, so lead with that rather than reporting a
          // bare "0 reminders sent" that reads like a failure.
          const allAlreadyReminded = job.sent === 0 && job.failed === 0 && skippedDuplicate > 0
          setNote(
            job.status === 'failed'
              ? (job.error ?? 'Sending reminders failed.')
              : allAlreadyReminded
                ? `Already reminded today — ${skippedDuplicate} skipped` +
                  (skippedNoEmail > 0 ? `, ${skippedNoEmail} skipped — no email` : '') +
                  '.'
                : `${job.sent} reminder${job.sent === 1 ? '' : 's'} sent` +
                  (job.failed > 0 ? `, ${job.failed} failed` : '') +
                  (skippedDuplicate > 0 ? `, ${skippedDuplicate} already reminded today` : '') +
                  // Additive (CNT-08 follow-through): a snapshot id can't be
                  // mailed when its contact has no email on file — say so
                  // instead of letting "N sent" imply every overdue id was
                  // reached when some were silently unreachable.
                  (skippedNoEmail > 0 ? `, ${skippedNoEmail} skipped — no email` : '') +
                  '.',
          )
          await load(true)
          return
        }
        setNote(`Sending reminders… ${job.enqueued}/${job.total ?? '?'} queued.`)
        remindPollTimerRef.current = window.setTimeout(() => void poll(), 3_000)
      } catch (err) {
        remindPollTimerRef.current = null
        setBusy(false)
        setNote(err instanceof Error ? err.message : 'Could not check reminder progress')
      }
    }
    void poll()
  }, [load])

  const remind = useCallback(async (ids?: string[]) => {
    setBusy(true)
    try {
      // POST /remind always snapshots a bulk job and hands back its id; the
      // counts in the body are frozen zeros for pre-job clients. Everything
      // the admin sees comes from the poll.
      const r = await remindTasks(ids) as { ok: boolean; sent: number; skipped: number; job_id?: string }
      if (r.job_id) {
        setNote('Sending reminders…')
        pollRemindJob(r.job_id)
        return
      }
      setNote('Reminders queued.')
      await load(true)
      setBusy(false)
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Sending failed')
      setBusy(false)
    }
  }, [load, pollRemindJob])

  const openNudge = useCallback((nudge: DashboardNudge) => {
    switch (nudge.key) {
      case 'unscheduled':
        onNavigate({ view: 'agenda' })
        break
      case 'conflicts':
        onNavigate({ view: 'agenda', agendaView: 'conflicts' })
        break
      case 'pending':
        onNavigate({
          view: 'workspace',
          tab: 'submissions',
          seedFilters: { submissions: { status: 'pending' } },
          label: 'Awaiting a decision',
        })
        break
      case 'staged':
        onNavigate({ view: 'workspace', tab: 'submissions', label: 'Staged decisions' })
        break
      case 'assets':
        onNavigate({
          view: 'workspace',
          tab: 'speakers',
          seedFilters: { speakers: { missing_assets: true } },
          label: 'Missing bio or headshot',
        })
        break
      case 'outstanding':
      case 'overdue':
        setBoard('tracking')
        break
    }
  }, [onNavigate])

  const openSpeaker = useCallback((contactId: string, name: string, tab: 'speakers' | 'tasks') => {
    onNavigate({ view: 'workspace', tab, seedFilters: speakerSeeds(contactId), label: name })
  }, [onNavigate])

  /**
   * Org-board click-through. `ev` travels on the nav target for the host, and
   * is applied here through the event scope as well — `setFilter` is what
   * writes `?ev=` (and, for a concrete event, rebinds the session cookie), so
   * the deep link lands on the right scope without App having to learn a new
   * field first.
   */
  const openOrg = useCallback((target: Extract<AppNavTarget, { view: 'workspace' }>) => {
    if (target.ev && scope && scope.filter !== target.ev) scope.setFilter(target.ev)
    onNavigate(target)
  }, [onNavigate, scope])

  const active = orgMode ? orgData : data
  if (error && !active) {
    return <div className="db-shell"><div className="db-error">{error}</div></div>
  }
  if (!active) {
    return <div className="db-shell"><div className="db-loading">Loading dashboard…</div></div>
  }

  const nowDate = new Date()
  const hour = nowDate.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const agoSec = updatedAt === null ? 0 : Math.max(0, Math.round((Date.now() - updatedAt) / 1000))
  const freshness = (
    <div className="db-freshness" title="Polled every 15 seconds; unchanged data costs a 304.">
      updated {agoSec < 3 ? 'just now' : `${agoSec}s ago`}
    </div>
  )

  // Org mode: one board, no per-event switcher (Today/Tracking/Pipeline are
  // all event-scoped). The per-event boards' own state is left alone, so
  // switching back restores whichever board and tab was last open.
  if (orgMode && orgData) {
    return (
      <div className="db-shell">
        <header className="db-header">
          <div>
            <div className="db-kicker">
              {nowDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}
              {' · ALL EVENTS'}
            </div>
            <h1>{greeting} — {orgData.org.name}</h1>
          </div>
          {freshness}
        </header>
        <OrgBoard data={orgData} onOpen={openOrg} />
      </div>
    )
  }

  if (!data) {
    return <div className="db-shell"><div className="db-loading">Loading dashboard…</div></div>
  }

  const daysToEvent = Math.ceil((Date.parse(data.event.starts_at) - nowDate.getTime()) / 86_400_000)

  return (
    <div className="db-shell">
      <header className="db-header">
        <div>
          <div className="db-kicker">
            {nowDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}
            {daysToEvent > 0 && <> · {daysToEvent} DAYS TO EVENT</>}
          </div>
          <h1>{greeting} — {data.event.name}</h1>
        </div>
        {freshness}
      </header>

      <nav className="db-switcher" aria-label="Dashboards">
        {BOARDS.map((b) => (
          <button
            key={b.key}
            className={board === b.key ? 'active' : ''}
            onClick={() => setBoard(b.key)}
          >
            <span className="db-switch-dot" style={{ background: b.dot }} />
            {b.label}
          </button>
        ))}
      </nav>

      {note && (
        <div className="db-note" role="status">
          {note}
          <button onClick={() => setNote(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {board === 'today' && (
        <TodayBoard
          data={data}
          tab={todayTab}
          onTab={setTodayTab}
          onNudge={openNudge}
          onNavigate={onNavigate}
        />
      )}
      {board === 'tracking' && (
        <TrackingBoard data={data} busy={busy} onRemind={remind} onSpeaker={openSpeaker} onNavigate={onNavigate} />
      )}
      {board === 'pipeline' && <PipelineBoard data={data} onNavigate={onNavigate} />}
    </div>
  )
}

// --- Today ------------------------------------------------------------------

function TodayBoard({ data, tab, onTab, onNudge, onNavigate }: {
  data: DashboardPayload
  tab: TodayTab
  onTab: (t: TodayTab) => void
  onNudge: (n: DashboardNudge) => void
  onNavigate: (t: AppNavTarget) => void
}) {
  const tiles = data.status_tiles
  const statusSeed: Record<string, string> = {
    accepted: 'accepted', pending: 'pending', declined: 'declined', drafts: 'draft', withdrawn: 'withdrawn',
  }
  return (
    <>
      <div className="db-kpis">
        <div className="db-kpi" title="Distinct people listed as a participant on at least one accepted submission">
          <div className="db-kpi-value">{data.kpis.accepted_speakers}</div>
          <div className="db-kpi-label">Participants</div>
        </div>
        <div className="db-kpi">
          <div className="db-kpi-value">{data.kpis.submissions}</div>
          <div className="db-kpi-label">Submissions</div>
        </div>
        {(Object.keys(tiles) as Array<keyof typeof tiles>).map((key) => (
          <button
            key={key}
            className="db-kpi db-kpi-status"
            onClick={() =>
              onNavigate({
                view: 'workspace',
                tab: 'submissions',
                seedFilters: { submissions: { status: statusSeed[key] } },
                label: `Status: ${statusLabelText(statusSeed[key])}`,
              })
            }
            title={`Open ${key} submissions in the workspace`}
          >
            <div className="db-kpi-value">{tiles[key]}</div>
            <div className="db-kpi-label">{key === 'drafts' ? 'Drafts' : key.charAt(0).toUpperCase() + key.slice(1)}</div>
          </button>
        ))}
      </div>

      {data.nudges.length > 0 && (
        <section className="db-nudges" aria-label="Also check">
          <span className="db-nudges-title">Also check</span>
          {data.nudges.map((n) => (
            <button key={n.key} className="db-nudge" onClick={() => onNudge(n)}>
              <span className="db-nudge-count">{n.count}</span>
              {n.text}
            </button>
          ))}
        </section>
      )}

      <nav className="db-tabs" aria-label="Today sections">
        {TODAY_TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => onTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'forms' && (
        <div className="db-grid">
          <section className="db-card db-span2">
            <h3>Submission pacing</h3>
            <PacingChart pacing={data.forms.pacing} />
          </section>
          <section className="db-card">
            <h3>Your forms</h3>
            {data.forms.forms.map((f) => (
              <div className="db-form-row" key={f.id}>
                <div>
                  <div className="db-form-name">{f.internal_name}</div>
                  <div className="db-form-sub">
                    {f.status}{f.close_at ? ` · closes ${fmtDateInTz(f.close_at, data.event.timezone)}` : ''}
                  </div>
                </div>
                <div className="db-form-counts">
                  <strong>{f.submission_count}</strong> submitted
                  {f.draft_count > 0 && <span> · {f.draft_count} drafts</span>}
                </div>
                <button onClick={() => onNavigate({ view: 'forms' })}>Manage</button>
              </div>
            ))}
          </section>
          <section className="db-card db-span3">
            <h3>Recent submissions</h3>
            <table className="db-table">
              <thead>
                <tr><th>Code</th><th>Title</th><th>Status</th><th>Track</th><th>Submitter</th><th>Submitted</th></tr>
              </thead>
              <tbody>
                {data.forms.recent.map((r) => (
                  <tr
                    key={r.id}
                    className="clickable"
                    title="Open in the workspace, with speakers and tasks narrowed to it"
                    onClick={() =>
                      onNavigate({
                        view: 'workspace',
                        tab: 'submissions',
                        seedFilters: {
                          submissions: { q: r.code },
                          speakers: { submission_id: r.id },
                          tasks: { submission_id: r.id },
                        },
                        label: `${r.code} · ${r.title}`,
                      })
                    }
                  >
                    <td>{r.code}</td>
                    <td className="db-td-title">{r.title}</td>
                    <td><span className={`status-chip status-${r.status}`}>{statusLabelText(r.status)}</span></td>
                    <td>{r.track_name ?? ''}</td>
                    <td>{r.submitter_name ?? ''}</td>
                    <td>{fmtDateInTz(r.created_at, data.event.timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {tab === 'participants' && (
        <div className="db-grid">
          <section className="db-card db-span2">
            <h3>Participants by role</h3>
            <BarList
              color="var(--chart-1)"
              rows={data.participants.by_role.map((r) => ({ key: r.role, label: r.role, value: r.n }))}
            />
          </section>
          <section className="db-card">
            <h3>Submission status</h3>
            <Donut
              centre={String(data.participants.status_mix.reduce((a, r) => a + r.n, 0))}
              segments={[
                { label: 'Accepted sessions', color: 'var(--chart-good)', value: data.participants.status_mix.filter((r) => r.status === 'accepted' && r.kind === 'session').reduce((a, r) => a + r.n, 0) },
                { label: 'Accepted abstracts', color: 'var(--chart-good-soft)', value: data.participants.status_mix.filter((r) => r.status === 'accepted' && r.kind === 'abstract').reduce((a, r) => a + r.n, 0) },
                { label: 'Pending sessions', color: 'var(--chart-warn)', value: data.participants.status_mix.filter((r) => r.status === 'pending' && r.kind === 'session').reduce((a, r) => a + r.n, 0) },
                { label: 'Pending abstracts', color: 'var(--chart-warn-soft)', value: data.participants.status_mix.filter((r) => r.status === 'pending' && r.kind === 'abstract').reduce((a, r) => a + r.n, 0) },
              ]}
            />
          </section>
        </div>
      )}

      {tab === 'evaluations' && (
        <div className="db-grid">
          <section className="db-card">
            <h3>Review progress</h3>
            <dl className="db-statlist">
              <div><dt>Reviews written</dt><dd>{data.evaluations.reviews}</dd></div>
              <div><dt>Submissions evaluated</dt><dd>{data.evaluations.evaluated_submissions}</dd></div>
              <div><dt>Reviews in progress</dt><dd>{data.evaluations.in_progress}</dd></div>
              {data.evaluations.plans.length > 0 && (
                <div><dt>Most active plan</dt><dd className="db-dd-text">{data.evaluations.plans[0].name}</dd></div>
              )}
            </dl>
          </section>
          <section className="db-card db-span2">
            <h3>Completed vs assigned, per reviewer</h3>
            <BarList
              color="var(--chart-3)"
              rows={data.evaluations.reviewers.map((r) => ({
                key: r.email,
                label: r.name ?? r.email,
                value: r.completed,
                sub: ` / ${r.assigned}`,
              }))}
            />
          </section>
        </div>
      )}

      {tab === 'agenda' && (
        <div className="db-grid">
          <section className="db-card">
            <h3>Schedule</h3>
            <dl className="db-statlist">
              <div><dt>Scheduled</dt><dd>{data.agenda.scheduled}</dd></div>
              <div><dt>Unscheduled</dt><dd>{data.agenda.unscheduled}</dd></div>
              <div>
                <dt>Conflicts</dt>
                <dd>
                  <button
                    className="db-link"
                    onClick={() => onNavigate({ view: 'agenda', agendaView: 'conflicts' })}
                    title="Open the agenda conflicts view"
                  >
                    {data.agenda.conflicts.error} errors · {data.agenda.conflicts.warning} warnings
                  </button>
                </dd>
              </div>
            </dl>
          </section>
          <section className="db-card">
            <h3>Sessions per day</h3>
            <BarList
              color="var(--chart-4)"
              rows={data.agenda.per_day.map((d) => ({ key: d.day, label: fmtDay(d.day), value: d.count }))}
            />
          </section>
          <section className="db-card">
            <h3>Sessions per room</h3>
            <BarList
              color="var(--chart-1)"
              rows={data.agenda.per_room.map((r) => ({ key: r.room, label: r.room, value: r.count }))}
            />
          </section>
        </div>
      )}
    </>
  )
}

// --- Speaker Tracking (the required board, docs/09 §2) ----------------------

function TrackingBoard({ data, busy, onRemind, onSpeaker, onNavigate }: {
  data: DashboardPayload
  busy: boolean
  onRemind: (ids?: string[]) => void
  onSpeaker: (contactId: string, name: string, tab: 'speakers' | 'tasks') => void
  onNavigate: (t: AppNavTarget) => void
}) {
  const t = data.tracking
  // POST /remind now targets every outstanding (not-complete, due-dated)
  // assignment, not just overdue ones — `remindable_tasks` mirrors that
  // target set exactly. Cast + fallback so a payload from an older
  // deploy (field absent) still renders the button off the overdue count.
  const remindableCount = (t as unknown as { remindable_tasks?: number }).remindable_tasks ?? t.overdue.length
  return (
    <>
      <p className="db-board-desc">
        Confirmation status, outstanding tasks, and an overdue list for accepted speakers.
      </p>
      <ChaseModeBanner onNavigate={onNavigate} />
      <div className="db-grid">
        <ChaseInboxPanel />
        <section className="db-card db-stat-card">
          <div className="db-kpi-value">{t.accepted_speakers}</div>
          <div className="db-kpi-label">Accepted Speakers</div>
        </section>
        <section className="db-card db-stat-card">
          <div className="db-kpi-value">{t.outstanding_tasks}</div>
          <div className="db-kpi-label">Outstanding Speaker Tasks</div>
        </section>
        <section className="db-card">
          <h3>Speaker confirmation</h3>
          <Donut
            centre={String(t.accepted_speakers)}
            segments={[
              { label: 'Confirmed', color: 'var(--chart-good)', value: t.confirmation.confirmed },
              { label: 'Awaiting confirmation', color: 'var(--chart-warn)', value: t.confirmation.awaiting },
            ]}
          />
        </section>
        <section className="db-card db-span2">
          <h3>Top speakers by outstanding tasks</h3>
          <BarList
            color="var(--chart-2)"
            rows={t.top_speakers.map((s) => ({
              key: s.contact_id,
              label: s.name,
              value: s.outstanding,
              sub: s.overdue > 0 ? ` (${s.overdue} overdue)` : undefined,
            }))}
            onRowClick={(key) => {
              const s = t.top_speakers.find((x) => x.contact_id === key)
              if (s) onSpeaker(s.contact_id, s.name, 'tasks')
            }}
          />
        </section>
        <section className="db-card">
          <h3>Asset completeness</h3>
          {t.assets.length === 0 && <div className="db-empty">Every accepted speaker has a bio, headshot and slides.</div>}
          {t.assets.map((a) => (
            <div className="db-asset-row clickable" key={a.contact_id}
              role="button" tabIndex={0}
              title="Open this speaker in the workspace"
              onClick={() => onSpeaker(a.contact_id, a.name, 'speakers')}
              onKeyDown={(e) => { if (e.key === 'Enter') onSpeaker(a.contact_id, a.name, 'speakers') }}
            >
              <span className="db-asset-name">{a.name}</span>
              <span className="db-asset-missing">
                {a.missing_bio === 1 && <span className="db-chip">bio</span>}
                {a.missing_headshot === 1 && <span className="db-chip">headshot</span>}
                {a.missing_slides === 1 && <span className="db-chip">slides</span>}
              </span>
            </div>
          ))}
        </section>
        {/* Workplan 13 W3: accepted-but-awaiting-employer-approval, sorted by
            days-until-event ascending server-side — the withdrawals cluster a
            month out, so the closest exposure leads the list. */}
        <section className="db-card db-span3">
          <h3>Approval pending</h3>
          {t.approval_pending.length === 0 && (
            <div className="db-empty">No accepted talks are awaiting employer approval.</div>
          )}
          {t.approval_pending.length > 0 && (
            <table className="db-table">
              <thead>
                <tr><th>Talk</th><th>Speaker</th><th>Note</th><th>Event in</th></tr>
              </thead>
              <tbody>
                {t.approval_pending.map((row) => (
                  <tr key={row.submission_id}>
                    <td className="db-td-title">{row.code} · {row.title}</td>
                    <td>
                      {row.contact_id ? (
                        <button
                          className="db-link"
                          onClick={() => onSpeaker(row.contact_id!, row.name, 'speakers')}
                          title="Open this speaker in the workspace"
                        >
                          {row.name}
                        </button>
                      ) : (
                        row.name
                      )}
                    </td>
                    <td>{row.approval_note ?? ''}</td>
                    <td className="db-overdue">
                      {row.days_until_event <= 0 ? 'now' : `${row.days_until_event} day${row.days_until_event === 1 ? '' : 's'}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="db-card db-span3">
          <div className="db-card-head">
            <h3>Overdue tasks</h3>
            {remindableCount > 0 && (
              <button className="db-primary" disabled={busy} onClick={() => onRemind()}>
                Remind all outstanding ({remindableCount})
              </button>
            )}
          </div>
          {t.overdue.length === 0 && <div className="db-empty">Nothing is overdue.</div>}
          {t.overdue.length > 0 && (
            <table className="db-table">
              <thead>
                <tr><th>Task</th><th>Speaker</th><th>Due</th><th>Overdue</th><th /></tr>
              </thead>
              <tbody>
                {t.overdue.map((row) => (
                  <tr key={row.assignment_id}>
                    <td>{row.task_title}</td>
                    <td>
                      <button className="db-link" onClick={() => onSpeaker(row.contact_id, row.name, 'tasks')}
                        title="Open this speaker's tasks in the workspace">
                        {row.name}
                      </button>
                    </td>
                    <td>{fmtDateInTz(row.due_at, data.event.timezone)}</td>
                    <td className="db-overdue">{row.days_overdue} day{row.days_overdue === 1 ? '' : 's'}</td>
                    <td>
                      <button disabled={busy} onClick={() => onRemind([row.assignment_id])}>Send reminder</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  )
}

// --- Organisation (CRM-12) --------------------------------------------------

/**
 * The all-events board: who is in the contact database, which companies they
 * come from, and how every event in the organisation is tracking. Each figure
 * deep-links into the org directory (the workspace with `?ev=all`) using the
 * server's filter keys — `events: 'none'` for contacts attached to no event,
 * `company` for one employer.
 */
function OrgBoard({ data, onOpen }: {
  data: OrgDashboardPayload
  onOpen: (target: Extract<AppNavTarget, { view: 'workspace' }>) => void
}) {
  const k = data.kpis
  return (
    <>
      <p className="db-board-desc">
        Everyone in {data.org.name}, across all {k.events} event{k.events === 1 ? '' : 's'}. Pick an event in the
        sidebar for the Today, Speaker Tracking and Submissions Pipeline boards.
      </p>
      <div className="db-kpis">
        <button
          className="db-kpi db-kpi-status"
          title="Open the contact directory across every event"
          onClick={() => onOpen({ view: 'workspace', tab: 'speakers', ev: 'all', label: 'All contacts' })}
        >
          <div className="db-kpi-value">{k.total_contacts}</div>
          <div className="db-kpi-label">Total contacts</div>
          <div className="db-kpi-sub">+{k.new_contacts_30d} in last 30 days</div>
        </button>
        <div className="db-kpi" title="Contacts attached to at least one event">
          <div className="db-kpi-value">{k.contacts_on_events}</div>
          <div className="db-kpi-label">On events</div>
        </div>
        <button
          className="db-kpi db-kpi-status"
          title="Open the contacts attached to no event"
          onClick={() =>
            onOpen({
              view: 'workspace',
              tab: 'speakers',
              ev: 'all',
              seedFilters: { speakers: { events: 'none' } },
              label: 'No event',
            })
          }
        >
          <div className="db-kpi-value">{k.contacts_no_event}</div>
          <div className="db-kpi-label">No event</div>
        </button>
        <div className="db-kpi" title="Submitted or presented at two or more events">
          <div className="db-kpi-value">{k.returning_speakers}</div>
          <div className="db-kpi-label">Returning speakers</div>
        </div>
        <div className="db-kpi">
          <div className="db-kpi-value">{k.events}</div>
          <div className="db-kpi-label">Events</div>
        </div>
      </div>

      <div className="db-grid">
        <section className="db-card db-span3">
          <h3>Top companies</h3>
          <BarList
            color="var(--chart-1)"
            rows={data.top_companies.map((c) => ({ key: c.company, label: c.company, value: c.n }))}
            onRowClick={(company) =>
              onOpen({
                view: 'workspace',
                tab: 'speakers',
                ev: 'all',
                seedFilters: { speakers: { company } },
                label: company,
              })
            }
          />
        </section>
        <section className="db-card db-span3">
          <h3>Events</h3>
          {data.events.length === 0 && <div className="db-empty">No events yet.</div>}
          {data.events.length > 0 && (
            <table className="db-table">
              <thead>
                <tr>
                  <th>Event</th><th>Dates</th><th>Agenda</th>
                  <th>Submissions</th><th>Accepted</th><th>Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((ev) => (
                  <tr
                    key={ev.id}
                    className="clickable"
                    title="Open this event's submissions"
                    onClick={() => onOpen({ view: 'workspace', tab: 'submissions', ev: ev.id, label: ev.name })}
                  >
                    <td className="db-td-title">{ev.name}</td>
                    <td>{fmtEventRange(ev.starts_at, ev.ends_at)}</td>
                    <td>
                      <span className={`status-chip status-${ev.agenda_published ? 'accepted' : 'draft'}`}>
                        {ev.agenda_published ? 'published' : 'draft'}
                      </span>
                    </td>
                    <td>{ev.submissions}</td>
                    <td>{ev.accepted}</td>
                    <td>{ev.scheduled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  )
}

// --- Submissions Pipeline ---------------------------------------------------

const FUNNEL_STAGES = [
  { key: 'received', label: 'Received' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'decided', label: 'Decided' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'scheduled', label: 'Scheduled' },
] as const

function PipelineBoard({ data, onNavigate }: {
  data: DashboardPayload
  onNavigate: (t: AppNavTarget) => void
}) {
  const p = data.pipeline
  const max = Math.max(1, p.funnel.received)
  return (
    <>
      <p className="db-board-desc">
        Funnel of submissions from received to scheduled, with per-form and per-track context.
      </p>
      <div className="db-grid">
        <section className="db-card db-stat-card">
          <div className="db-kpi-value">{p.total}</div>
          <div className="db-kpi-label">Total Submissions</div>
        </section>
        <section className="db-card db-stat-card clickable"
          role="button" tabIndex={0}
          title="Open pending submissions in the workspace"
          onClick={() => onNavigate({ view: 'workspace', tab: 'submissions', seedFilters: { submissions: { status: 'pending' } }, label: 'Awaiting a decision' })}
          onKeyDown={(e) => { if (e.key === 'Enter') onNavigate({ view: 'workspace', tab: 'submissions', seedFilters: { submissions: { status: 'pending' } }, label: 'Awaiting a decision' }) }}
        >
          <div className="db-kpi-value">{p.pending_review}</div>
          <div className="db-kpi-label">Pending Review</div>
        </section>
        <section className="db-card db-span3">
          <h3>Funnel</h3>
          <div className="db-funnel">
            {FUNNEL_STAGES.map((stage) => (
              <div className="db-funnel-row" key={stage.key}>
                <span className="db-bar-label">{stage.label}</span>
                <span className="db-bar-track">
                  <span className="db-bar-fill" style={{ width: `${(p.funnel[stage.key] / max) * 100}%`, background: 'var(--chart-4)' }} />
                </span>
                <span className="db-bar-value">{p.funnel[stage.key]}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="db-card">
          <h3>Submissions by form</h3>
          <BarList color="var(--chart-1)" rows={p.by_form.map((f) => ({ key: f.name, label: f.name, value: f.count }))} />
        </section>
        <section className="db-card db-span2">
          <h3>Submissions by track</h3>
          <BarList color="var(--chart-3)" rows={p.by_track.map((tr) => ({ key: tr.name, label: tr.name, value: tr.count }))} />
        </section>
      </div>
    </>
  )
}

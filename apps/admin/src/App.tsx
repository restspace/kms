import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DataTabManager, TabConfig, type CreateFormProps } from './components/DataTabManager'
import type {
  DataSourceParams,
  DataSourceResult,
} from './components/DataList'
import {
  bulkStatus,
  createContact,
  createTask,
  deleteContact,
  getMe,
  getSubmissionDetail,
  queryResource,
  sendDecisions,
  switchEvent,
  updateContact,
  updateSubmissionStatus,
  type ContactRow,
  type Me,
  type MessageRow,
  type SubmissionRow,
  type TaskAssignmentRow,
} from './api'
import { buildExportUrl } from './api'
import { appAlert, appConfirm } from './components/dialogs'
import { RecordForm } from './components/RecordForm'
import { CreateEventDialog } from './components/CreateEventDialog'
import { FormsSection } from './forms/FormsSection'
import { SettingsSection } from './settings/SettingsSection'
import { EvaluationSection } from './evaluation/EvaluationSection'
import { AgendaSection } from './agenda/AgendaSection'
import { DashboardSection, type AppNavTarget } from './dashboard/DashboardSection'
import { ReviewerWorkspace } from './review/ReviewerWorkspace'
import {
  BulkBar,
  StatusChipsFilter,
  SubmissionDetailPanel,
  SUBMISSION_STATUSES,
  statusLabel,
} from './workspace/extras'
import {
  EventFilterChip,
  EventFilterSelect,
  EventScopeNote,
  EventScopeProvider,
  type EventFilter,
  type EventScopeValue,
} from './eventScope'
import { currentRoute, navigate, useRoute, type ViewKey } from './router'
import './shell.css'

/**
 * Admin SPA shell (docs/12 M0.5→M3, workspace redesign): slim sidebar + event
 * scope control around the tab workspace, Forms, Evaluation and the reviewer
 * workspace. Reviewers see only Review; everything else needs the admin role
 * (enforced server-side too).
 *
 * Two things changed with the redesign:
 *  - the event is a *filter dimension* for the workspace (`'all'` spans every
 *    accessible event) while the per-event surfaces stay bound to the session's
 *    current event — see eventScope.tsx for the two-concept model;
 *  - every addressable piece of state lives in the URL via router.ts, so the
 *    shell derives its view from the route and reports changes back into it.
 */

const NAV_ITEMS: ReadonlyArray<{ key: ViewKey; label: string; soon: string | null }> = [
  { key: 'dashboard', label: 'Dashboard', soon: null },
  { key: 'workspace', label: 'Workspace', soon: null },
  { key: 'forms', label: 'Forms', soon: null },
  { key: 'evaluation', label: 'Evaluation', soon: null },
  { key: 'review', label: 'Review', soon: null },
  { key: 'agenda', label: 'Agenda', soon: null },
  { key: 'settings', label: 'Settings', soon: null },
]

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const contactName = (c: ContactRow): string =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email

const stripHtml = (html: string): string => {
  const el = document.createElement('div')
  el.innerHTML = html
  return el.textContent ?? ''
}

const StatusChip = ({ status }: { status: string }) => (
  <span className={`status-chip status-${status}`}>{status.replace(/_/g, ' ')}</span>
)

const speakerSchema = {
  type: 'object',
  required: ['email'],
  properties: {
    first_name: { type: 'string', title: 'First name' },
    last_name: { type: 'string', title: 'Last name' },
    email: { type: 'string', format: 'email', title: 'Email' },
    company: { type: 'string', title: 'Company' },
    job_title: { type: 'string', title: 'Job title' },
    mobile_phone: { type: 'string', title: 'Mobile phone' },
    pronouns: { type: 'string', title: 'Pronouns' },
    biography: { type: 'string', format: 'textarea', title: 'Biography' },
    notes: { type: 'string', format: 'textarea', title: 'Internal notes' },
  },
}

/**
 * Task *definition* schema (deferred-gap item: tasks were read-only in
 * admin). The Tasks tab's rows are assignments (one per assignee), a
 * different shape from what this schema describes — see the `tasks`
 * TabConfig below for why that means create-only via `createComponent`
 * rather than schema-driven edit-in-grid.
 */
const taskSchema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', title: 'Title' },
    description: { type: 'string', format: 'textarea', title: 'Description' },
    target: { type: 'string', enum: ['contact', 'group', 'submission'], title: 'Target' },
    assignment_mode: { type: 'string', enum: ['manual', 'automatic'], title: 'Assignment mode' },
    trigger: { type: 'string', enum: ['none', 'on_accept', 'on_schedule'], title: 'Trigger' },
    action_type: {
      type: 'string',
      enum: ['acknowledge', 'file_upload', 'portal_form', 'external_link'],
      title: 'Action type',
    },
    due_at: { type: 'string', format: 'date', title: 'Due date' },
    required: { type: 'boolean', title: 'Required' },
  },
}

/**
 * Create-only form for task definitions (see `taskSchema` above). A thin
 * RecordForm wrapper so it can be wired via `TabConfig.createComponent`
 * without also enabling `TabConfig.schema`, which DataTabManager also reads
 * to decide whether a row double-click opens an *edit* form — wrong here,
 * since the tab's rows are assignments, not task definitions.
 */
const TaskCreateForm = ({ initialValues, onSubmit, onCancel, title, onDirtyChange }: CreateFormProps) => (
  <RecordForm
    schema={taskSchema}
    initialValues={initialValues}
    onSubmit={onSubmit}
    onCancel={onCancel}
    title={title}
    onDirtyChange={onDirtyChange}
  />
)

/** Workspace tab keys addressable by dashboard deep-links. */
type WorkspaceTabKey = 'speakers' | 'submissions' | 'tasks' | 'messages'

const WORKSPACE_TAB_KEYS: readonly WorkspaceTabKey[] = ['speakers', 'submissions', 'tasks', 'messages']

const isWorkspaceTabKey = (value: string | null): value is WorkspaceTabKey =>
  value !== null && (WORKSPACE_TAB_KEYS as readonly string[]).includes(value)

/**
 * Tabs whose selected record can be resolved back from an id alone, and so can
 * survive a reload as `?rec=`. Tasks and Messages have no by-id read on the
 * query endpoint yet (see the FE-2 notes) — their selection is not URL-backed.
 */
const REC_RESTORABLE: ReadonlyArray<WorkspaceTabKey> = ['speakers', 'submissions']

type WorkspaceSeeds = Partial<Record<WorkspaceTabKey, Record<string, unknown>>>

/** Filter UI for tabs whose only filters come from dashboard deep-link seeds. */
const NullFilter = () => null

/**
 * Resolve a workspace record from its id so a `?rec=` deep link can re-open the
 * detail tab. Returns null when the record is gone (the caller drops `rec`).
 */
async function loadWorkspaceRecord(
  tab: WorkspaceTabKey,
  id: string,
  eventFilterId: string | null,
): Promise<unknown | null> {
  if (tab === 'speakers') {
    const result = await queryResource<ContactRow>('contacts')({
      from: 0,
      size: 1,
      filters: { contact_id: id, ...(eventFilterId ? { event_id: eventFilterId } : {}) },
    })
    return result.items[0] ?? null
  }
  if (tab === 'submissions') {
    const detail = await getSubmissionDetail(id)
    return (detail.submission as unknown as SubmissionRow | undefined) ?? null
  }
  return null
}

/** Workspace tab configs against the Worker's generic query endpoints. */
function buildWorkspaceConfig(
  onChecklist: (ids: string[]) => void,
  checklistResetKey: number,
  seeds: WorkspaceSeeds,
  currentEventId: string,
  eventFilterId: string | null,
): Record<string, TabConfig> {
  // Event as a filter dimension: with no `event_id` the Worker returns every
  // event this staff email can reach, so the tabs span the organisation.
  const scoped = <T,>(resource: 'contacts' | 'submissions' | 'messages' | 'tasks') => {
    const base = queryResource<T>(resource)
    if (!eventFilterId) return base
    return (params: DataSourceParams): Promise<DataSourceResult<T>> =>
      base({ ...params, filters: { ...params.filters, event_id: eventFilterId } })
  }
  // Export buttons (M6): each tab downloads its current view — active filters
  // and anchor included — through the public REST API's export endpoint.
  // KNOWN LIMITATION: the export endpoint is single-event, so with the filter
  // on "All events" the download covers the *current* event only.
  const exportFor = (resource: 'contacts' | 'submissions' | 'tasks' | 'messages') => ({
    buildUrl: (format: 'csv' | 'xlsx', query: { filters: Record<string, unknown>; sort?: { field: string; direction: 'asc' | 'desc' } }) => {
      const { event_id: scopedEvent, ...rest } = query.filters as Record<string, unknown>
      const eventId = typeof scopedEvent === 'string' && scopedEvent ? scopedEvent : currentEventId
      return buildExportUrl(eventId, resource, format, rest, query.sort)
    },
  })
  /** Cross-event provenance column; hidden on mobile where width is scarce. */
  const eventColumn = { field: 'event_name', header: 'Event', width: '140px', sortable: false, mobileHidden: true }
  const speakers: TabConfig<ContactRow> = {
    displayTitle: 'Speakers',
    dataSource: scoped<ContactRow>('contacts'),
    getItemId: (item) => item.id,
    getItemTitle: contactName,
    columns: [
      { field: 'first_name', header: 'First name', sortable: true },
      { field: 'last_name', header: 'Last name', sortable: true },
      { field: 'email', header: 'Email', width: '1.5fr', sortable: true, mobileRow: 2 },
      { field: 'company', header: 'Company', sortable: true },
      { field: 'job_title', header: 'Job title', mobileHidden: true },
      eventColumn,
    ],
    detailComponent: ({ item, onEdit }) => (
      <div className="detail-panel">
        <h2>{contactName(item)}</h2>
        <div className="detail-sub">{item.job_title ? `${item.job_title} · ` : ''}{item.company ?? ''}</div>
        <dl>
          <dt>Email</dt><dd>{item.email}</dd>
          {item.mobile_phone && <><dt>Mobile</dt><dd>{item.mobile_phone}</dd></>}
          {item.pronouns && <><dt>Pronouns</dt><dd>{item.pronouns}</dd></>}
          {item.event_name && <><dt>Event</dt><dd>{item.event_name}</dd></>}
          <dt>Created</dt><dd>{fmtDate(item.created_at)}</dd>
        </dl>
        {item.biography && <div className="detail-body">{stripHtml(item.biography)}</div>}
        {onEdit && (
          <div className="detail-actions">
            <button onClick={onEdit}>Edit</button>
          </div>
        )}
      </div>
    ),
    globalFilterSets: { id: 'contact_id' },
    globalFilterReceives: { submission_id: 'submission_id' },
    exportConfig: exportFor('contacts'),
    schema: speakerSchema,
    onUpsert: async (data, existing?: ContactRow) =>
      existing ? updateContact(existing.id, data) : createContact(data),
    onDelete: async (item) => {
      const confirmed = await appConfirm(
        `Delete ${contactName(item)}? Their submissions remain, unattributed; ` +
          'their participant links, reviews and task assignments are removed.',
        { title: 'Delete contact', confirmLabel: 'Delete', danger: true },
      )
      if (!confirmed) return false
      await deleteContact(item.id)
      return true
    },
  }

  const submissions: TabConfig<SubmissionRow & { rating: number | null; notified_at: string | null; review_count: number }> = {
    displayTitle: 'Submissions',
    dataSource: scoped('submissions'),
    getItemId: (item) => item.id,
    titleField: 'title',
    initialSort: { field: 'created_at', direction: 'desc' },
    filterConfig: {
      initialFilters: { status: '', ...(seeds.submissions ?? {}) },
      defaultFilters: { status: '' },
      FilterComponent: StatusChipsFilter,
    },
    onChecklist,
    checklistResetKey,
    columns: [
      { field: 'code', header: 'Code', width: '84px', mobileHidden: true },
      { field: 'title', header: 'Title', width: '2.5fr', sortable: true },
      {
        field: 'status',
        header: 'Status',
        width: '128px',
        sortable: true,
        editable: true,
        editRenderer: ({ value, onChange }) => (
          <select
            className={`status-edit status-chip status-${String(value)}`}
            value={String(value)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Status"
          >
            {SUBMISSION_STATUSES.map((s) => (
              <option key={s} value={s}>{statusLabel(s)}</option>
            ))}
          </select>
        ),
        // Return (not fire-and-forget) the write so DataList can await it and
        // roll the cell back on failure — FE-3's failure-aware inline edits.
        onChange: (change) => updateSubmissionStatus(change.item.id, String(change.value)),
      },
      {
        field: 'rating',
        header: 'Rating',
        width: '80px',
        sortable: true,
        render: (value: number | null, item) =>
          value === null ? (
            <span style={{ color: 'var(--text-faint)' }}>—</span>
          ) : (
            <span title={`${item.review_count} review${item.review_count === 1 ? '' : 's'}`}>★ {value}</span>
          ),
      },
      {
        field: 'notified_at',
        header: 'Notified',
        width: '76px',
        sortable: true,
        mobileHidden: true,
        render: (value: string | null) => (value ? '✓' : ''),
      },
      { field: 'format', header: 'Format', width: '100px', sortable: true, mobileHidden: true },
      { field: 'track_name', header: 'Track', sortable: true, mobileRow: 2 },
      { field: 'submitter_name', header: 'Submitter', sortable: true, mobileRow: 2 },
      eventColumn,
    ],
    detailComponent: ({ item }) => <SubmissionDetailPanel id={item.id} />,
    globalFilterSets: { id: 'submission_id' },
    globalFilterReceives: { contact_id: 'contact_id' },
    exportConfig: exportFor('submissions'),
  }

  const tasks: TabConfig<TaskAssignmentRow> = {
    displayTitle: 'Tasks',
    dataSource: scoped<TaskAssignmentRow>('tasks'),
    getItemId: (item) => item.id,
    getItemTitle: (item) => item.task_title,
    columns: [
      { field: 'task_title', header: 'Task', width: '1.6fr', sortable: true },
      { field: 'assignee_name', header: 'Assignee', sortable: true },
      { field: 'submission_code', header: 'For', width: '80px', mobileHidden: true },
      {
        field: 'status',
        header: 'Status',
        width: '110px',
        sortable: true,
        render: (value: string) => <StatusChip status={value} />,
      },
      {
        field: 'due_at',
        header: 'Due',
        width: '100px',
        sortable: true,
        render: (value: string | null, item) => {
          if (!value) return ''
          const overdue = item.status !== 'complete' && new Date(value).getTime() < Date.now()
          return <span style={overdue ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{fmtDate(value)}</span>
        },
      },
      {
        field: 'completed_at',
        header: 'Completed',
        width: '100px',
        sortable: true,
        mobileHidden: true,
        render: (value: string | null) => fmtDate(value),
      },
      eventColumn,
    ],
    detailComponent: ({ item }) => (
      <div className="detail-panel">
        <h2>
          {item.task_title} <StatusChip status={item.status} />
        </h2>
        <div className="detail-sub">{item.action_type}{item.required === 1 ? ' · required' : ''}</div>
        <dl>
          <dt>Assignee</dt><dd>{item.assignee_name ?? item.assignee_email}</dd>
          {item.submission_code && <><dt>Submission</dt><dd>{item.submission_code} — {item.submission_title}</dd></>}
          {item.due_at && <><dt>Due</dt><dd>{fmtDate(item.due_at)}</dd></>}
          {item.completed_at && <><dt>Completed</dt><dd>{fmtDate(item.completed_at)}</dd></>}
        </dl>
      </div>
    ),
    // Receive both anchors (docs/12 M3); anchoring a task narrows other tabs
    // to its assignee.
    globalFilterSets: { contact_id: 'contact_id' },
    globalFilterReceives: { contact_id: 'contact_id', submission_id: 'submission_id' },
    exportConfig: exportFor('tasks'),
    // Create-only (deferred-gap item): this tab's rows are *assignments*, one
    // per assignee, but a create defines a *task* — a different shape. Using
    // `createComponent` (rather than `schema`+`onUpsert` directly on the
    // config) opens the "+ New task" form without also flipping on
    // double-click-to-edit for assignment rows, which would hand the wrong
    // shape to a task-definition form. Editing/deleting task definitions
    // in-grid isn't wired here for the same reason — see the FE-6 report.
    createComponent: TaskCreateForm,
    onUpsert: async (data) => {
      const created = await createTask(data)
      // The cast only satisfies `TabConfig<TaskAssignmentRow>`'s generic
      // signature; the create flow above never reads the result as a row.
      return created as unknown as TaskAssignmentRow
    },
  }

  const messages: TabConfig<MessageRow> = {
    displayTitle: 'Messages',
    dataSource: scoped<MessageRow>('messages'),
    getItemId: (item) => item.id,
    getItemTitle: (item) => item.subject ?? item.template_key ?? item.id,
    initialSort: { field: 'created_at', direction: 'desc' },
    columns: [
      {
        field: 'created_at',
        header: 'Queued',
        width: '130px',
        sortable: true,
        render: (value: string) => {
          const d = new Date(value)
          return Number.isNaN(d.getTime())
            ? value
            : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        },
      },
      { field: 'template_key', header: 'Template', width: '150px', sortable: true },
      { field: 'to_email', header: 'To', width: '1.2fr', sortable: true, mobileRow: 2 },
      { field: 'subject', header: 'Subject', width: '2fr' },
      {
        field: 'status',
        header: 'Status',
        width: '90px',
        sortable: true,
        render: (value: string) => <span className={`status-chip status-${value}`}>{value}</span>,
      },
      eventColumn,
    ],
    detailComponent: ({ item }) => (
      <div className="detail-panel">
        <h2>{item.subject ?? '(no subject)'}</h2>
        <div className="detail-sub">
          {item.template_key} · <span className={`status-chip status-${item.status}`}>{item.status}</span>
        </div>
        <dl>
          <dt>To</dt><dd>{item.contact_name ? `${item.contact_name} <${item.to_email}>` : item.to_email}</dd>
          <dt>Queued</dt><dd>{new Date(item.created_at).toLocaleString()}</dd>
          {item.sent_at && <><dt>Sent</dt><dd>{new Date(item.sent_at).toLocaleString()}</dd></>}
          {item.error && <><dt>Error</dt><dd>{item.error}</dd></>}
        </dl>
      </div>
    ),
    globalFilterReceives: { contact_id: 'contact_id' },
    exportConfig: exportFor('messages'),
  }

  // Dashboard deep-link seeds (M5 stretch) and URL-restored q/flt: tabs without
  // their own filter UI still honour seeded local filters; the preset bar in App
  // clears them.
  if (seeds.speakers) {
    speakers.filterConfig = { initialFilters: seeds.speakers, defaultFilters: {}, FilterComponent: NullFilter }
  }
  if (seeds.tasks) {
    tasks.filterConfig = { initialFilters: seeds.tasks, defaultFilters: {}, FilterComponent: NullFilter }
  }
  if (seeds.messages) {
    messages.filterConfig = { initialFilters: seeds.messages, defaultFilters: {}, FilterComponent: NullFilter }
  }

  return {
    speakers: speakers as TabConfig,
    submissions: submissions as TabConfig,
    tasks: tasks as TabConfig,
    messages: messages as TabConfig,
  }
}

export default function App() {
  const route = useRoute()
  const [me, setMe] = useState<Me | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  // Create Event dialog (FR-EVT-1/2), reachable next to the event dropdown.
  const [createEventOpen, setCreateEventOpen] = useState(false)

  // Dashboard deep-link state (M5 stretch): seeded workspace filters + which
  // tab to land on. The tab itself now travels in the URL.
  const [wsPreset, setWsPreset] = useState<{ seeds: WorkspaceSeeds; label: string | null } | null>(null)
  const [wsTabRequest, setWsTabRequest] = useState<{ configKey: string; token: number } | undefined>(undefined)
  const [detailRequest, setDetailRequest] = useState<{ configKey: string; item: unknown; token: number } | undefined>(undefined)

  // Bulk-action state (docs/06 §5): checks come up from the Submissions tab.
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [checklistResetKey, setChecklistResetKey] = useState(0)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkNote, setBulkNote] = useState<string | null>(null)

  const refreshMe = useCallback(async () => {
    const m = await getMe()
    setMe(m)
  }, [])

  /**
   * Bind the session cookie to a different event. The per-event surfaces are
   * remounted by key afterwards — no page reload, so unsaved workspace state
   * and the URL both survive. The optimistic local update keeps the UI honest
   * while /app/api/me re-reads the authoritative record (timezone included).
   */
  const applyEventCookie = useCallback(async (eventId: string) => {
    setSwitching(true)
    try {
      await switchEvent(eventId)
      setMe((prev) => {
        if (!prev) return prev
        const next = prev.events.find((e) => e.id === eventId)
        return next ? { ...prev, event: { ...prev.event, ...next } } : prev
      })
      await refreshMe()
    } catch (err) {
      await appAlert(err instanceof Error ? err.message : 'Could not switch event', 'Event switch failed')
    } finally {
      setSwitching(false)
    }
  }, [refreshMe])

  // First load: read the session, force reviewers onto Review, and honour an
  // `?ev=` deep link that names an event other than the session's current one.
  const bootstrapped = useRef(false)
  useEffect(() => {
    getMe()
      .then((m) => {
        setMe(m)
        if (m.role === 'reviewer') {
          navigate({ v: 'review' }, { replace: true })
          return
        }
        if (bootstrapped.current) return
        bootstrapped.current = true
        const wanted = route.ev
        if (wanted !== 'all' && wanted !== m.event.id && m.events.some((e) => e.id === wanted)) {
          void applyEventCookie(wanted)
        }
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load'))
    // Intentionally once on mount: the route is read through a ref-like guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isReviewer = me?.role === 'reviewer'
  const view: ViewKey = isReviewer ? 'review' : route.v

  /** Validated workspace filter: an unknown id in the URL degrades to "all". */
  const filter: EventFilter = useMemo(() => {
    if (!me || route.ev === 'all') return 'all'
    const known = route.ev === me.event.id || me.events.some((e) => e.id === route.ev)
    return known ? route.ev : 'all'
  }, [me, route.ev])
  const eventFilterId = filter === 'all' ? null : filter

  const setFilter = useCallback(
    (next: EventFilter) => {
      navigate({ ev: next, rec: null }, { replace: true })
      if (next !== 'all' && me && next !== me.event.id) void applyEventCookie(next)
    },
    [applyEventCookie, me],
  )

  const handleChecklist = useCallback((ids: string[]) => {
    setCheckedIds(ids)
    // Only a fresh selection supersedes the previous action's outcome. The
    // post-action refetch re-emits an empty checklist, and clearing the note
    // on that made the result of a bulk send (notably a fully-skipped repeat
    // send) vanish with the bar.
    if (ids.length > 0) setBulkNote(null)
  }, [])

  // URL-restored search / extra filters ride in as tab seeds alongside the
  // dashboard's.
  const routeSeeds = useMemo<Record<string, unknown> | null>(() => {
    const merged = { ...(route.flt ?? {}), ...(route.q ? { q: route.q } : {}) }
    return Object.keys(merged).length > 0 ? merged : null
  }, [route.flt, route.q])

  const mergedSeeds = useMemo<WorkspaceSeeds>(() => {
    const base = wsPreset?.seeds ?? {}
    if (!routeSeeds) return base
    const out: WorkspaceSeeds = {}
    for (const key of WORKSPACE_TAB_KEYS) {
      out[key] = { ...(base[key] ?? {}), ...routeSeeds }
    }
    return out
  }, [routeSeeds, wsPreset])

  // Rebuilding on checklistResetKey both clears checks and refetches lists —
  // exactly what a bulk action needs.
  const workspaceConfig = useMemo(
    () => buildWorkspaceConfig(handleChecklist, checklistResetKey, mergedSeeds, me?.event.id ?? '', eventFilterId),
    [handleChecklist, checklistResetKey, mergedSeeds, me?.event.id, eventFilterId],
  )

  const workspaceTabs = useMemo(
    () => Object.entries(workspaceConfig).map(([key, cfg]) => ({ key, label: cfg.displayTitle ?? key })),
    [workspaceConfig],
  )

  // Route → tab: re-fire the DataTabManager activate request whenever the URL
  // names a different tab (including a fresh deep link on load).
  useEffect(() => {
    if (!route.tab) return
    setWsTabRequest((prev) =>
      prev?.configKey === route.tab ? prev : { configKey: route.tab as string, token: (prev?.token ?? 0) + 1 },
    )
  }, [route.tab])

  /**
   * Route → open detail tab. `handledRec` also absorbs selections reported *by*
   * the workspace, so mirroring a click into the URL never bounces back as a
   * re-open. A record that 404s just drops out of the URL.
   */
  const handledRec = useRef<string | null>(null)
  useEffect(() => {
    const { rec, tab } = route
    if (view !== 'workspace' || !rec || !isWorkspaceTabKey(tab)) return
    const key = `${tab}:${rec}`
    if (handledRec.current === key) return
    handledRec.current = key
    if (!REC_RESTORABLE.includes(tab)) return
    let cancelled = false
    void loadWorkspaceRecord(tab, rec, eventFilterId)
      .then((item) => {
        if (cancelled) return
        if (!item) {
          navigate({ rec: null }, { replace: true })
          return
        }
        setDetailRequest((prev) => ({ configKey: tab, item, token: (prev?.token ?? 0) + 1 }))
      })
      .catch(() => {
        if (!cancelled) navigate({ rec: null }, { replace: true })
      })
    return () => {
      cancelled = true
    }
  }, [route, view, eventFilterId])

  /**
   * Workspace → route: active list tab. Detail tabs keep the parent's key. The
   * manager's very first report (landing on the default tab) replaces rather
   * than pushes, so Back doesn't bounce between `?v=workspace` and
   * `?v=workspace&tab=speakers`.
   */
  const handleActiveTabChange = useCallback((tab: { type: string; configKey: string } | null) => {
    if (!tab || tab.type !== 'list') return
    navigate({ tab: tab.configKey }, { replace: currentRoute().tab === null })
  }, [])

  /**
   * Workspace → route: selected record. Replaces rather than pushes — arrowing
   * down a list must not bury the Back button under one entry per row.
   */
  const handleWorkspaceSelection = useCallback(
    (selection: { configKey: string; id: string | null } | null) => {
      const configKey = selection?.configKey ?? null
      if (!isWorkspaceTabKey(configKey) || !REC_RESTORABLE.includes(configKey)) return
      const id = selection?.id ?? null
      handledRec.current = id ? `${configKey}:${id}` : null
      navigate({ rec: id }, { replace: true })
    },
    [],
  )

  /**
   * Workspace search (deferred-gap item): DataTabManager already debounces
   * and merges `q` into the active tab's query itself; this only mirrors the
   * committed value into the URL so it survives reload/back (`?q=`), which
   * `routeSeeds` below restores into every tab's initial filters on load.
   */
  const handleSearchChange = useCallback((value: string) => {
    navigate({ q: value || null }, { replace: true })
  }, [])

  const handleNavigate = useCallback((target: AppNavTarget) => {
    if (target.view === 'agenda') {
      navigate({ v: 'agenda', mode: target.agendaView ?? null })
      return
    }
    if (target.view === 'forms') {
      navigate({ v: 'forms', form: null, fstep: null })
      return
    }
    setWsPreset(target.seedFilters || target.label ? { seeds: target.seedFilters ?? {}, label: target.label ?? null } : null)
    navigate({ v: 'workspace', tab: target.tab, rec: null })
  }, [])

  const runBulk = useCallback(
    async (action: 'accept_queue' | 'decline_queue' | 'pending' | 'send_decisions') => {
      if (checkedIds.length === 0) return
      setBulkBusy(true)
      try {
        if (action === 'send_decisions') {
          const r = await sendDecisions(checkedIds)
          const sent = r.accepted + r.declined
          const other = r.skipped - r.skipped_notified
          setBulkNote(
            `${sent} decision ${sent === 1 ? 'email' : 'emails'} sent — ` +
              `${r.accepted} accepted, ${r.declined} declined, ${r.tasks_assigned} tasks assigned` +
              (r.skipped_notified > 0 ? `; ${r.skipped_notified} skipped (already notified)` : '') +
              (other > 0 ? `; ${other} skipped (not in a queue)` : ''),
          )
        } else {
          const r = await bulkStatus(checkedIds, action)
          setBulkNote(`${r.changed} moved to ${statusLabel(action)}`)
        }
        setCheckedIds([])
        setChecklistResetKey((k) => k + 1)
      } catch (e) {
        setBulkNote(e instanceof Error ? e.message : 'Action failed')
      } finally {
        setBulkBusy(false)
      }
    },
    [checkedIds],
  )

  if (loadError) {
    return <div className="shell"><div className="shell-error">{loadError}</div></div>
  }
  if (!me) {
    return <div className="shell"><div className="shell-loading">Loading…</div></div>
  }

  const navItems = isReviewer ? NAV_ITEMS.filter((i) => i.key === 'review') : NAV_ITEMS
  const scope: EventScopeValue = {
    me,
    filter,
    currentEventId: me.event.id,
    currentEvent: me.event,
    events: me.events.length > 0 ? me.events : [me.event],
    setFilter,
    refreshMe,
    switching,
  }

  return (
    <EventScopeProvider value={scope}>
    <div className="shell">
      <aside className="shell-sidebar">
        <div className="shell-brand">
          KMS <span className="shell-brand-sub">{isReviewer ? 'review' : 'admin'}</span>
        </div>
        <div className="shell-event">
          <div className="shell-event-row">
            <EventFilterSelect scope={scope} />
            {!isReviewer && (
              <button
                type="button"
                className="shell-event-add"
                title="Create a new event"
                aria-label="Create a new event"
                onClick={() => setCreateEventOpen(true)}
              >
                +
              </button>
            )}
          </div>
          <div className="shell-event-dates">
            {fmtDate(me.event.starts_at)} – {fmtDate(me.event.ends_at)}
          </div>
        </div>
        {!isReviewer && (
          <CreateEventDialog
            open={createEventOpen}
            onClose={() => setCreateEventOpen(false)}
            defaultTimezone={me.event.timezone}
            onCreated={(id) => {
              setCreateEventOpen(false)
              void refreshMe().then(() => setFilter(id))
            }}
          />
        )}
        <nav className="shell-nav" aria-label="Sections">
          {navItems.map((item) => (
            <div key={item.key} className="shell-nav-group">
              <button
                className={view === item.key ? 'active' : ''}
                disabled={item.soon !== null}
                title={item.soon ? `Arrives with ${item.soon}` : undefined}
                aria-current={view === item.key && !(item.key === 'workspace' && route.tab) ? 'page' : undefined}
                onClick={() => navigate({ v: item.key })}
              >
                {item.label}
                {item.soon && <span className="shell-nav-soon">{item.soon}</span>}
              </button>
              {item.key === 'workspace' && !isReviewer && (
                <div className="shell-nav-children">
                  {workspaceTabs.map((tab) => {
                    const active = view === 'workspace' && route.tab === tab.key
                    return (
                      <button
                        key={tab.key}
                        className={`shell-nav-child ${active ? 'active' : ''}`}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => navigate({ v: 'workspace', tab: tab.key })}
                      >
                        {tab.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="shell-footer">
          <div className="shell-user" title={me.email}>{me.email}</div>
          <a href={`/portal/${me.event.slug}`}>Portal</a>
          <a href="/auth/logout">Log out</a>
        </div>
      </aside>
      <main className="shell-main" style={{ position: 'relative' }}>
        {view === 'workspace' && !isReviewer ? (
          <>
            {wsPreset?.label && (
              <div className="ws-preset-bar" role="status">
                Filtered from dashboard: <strong>{wsPreset.label}</strong>
                <button
                  onClick={() => setWsPreset(null)}
                  title="Clear the dashboard filter"
                  aria-label="Clear the dashboard filter"
                >
                  ×
                </button>
              </div>
            )}
            <DataTabManager
              config={workspaceConfig}
              defaultTabs={['speakers', 'submissions', 'tasks', 'messages']}
              activeTabRequest={wsTabRequest}
              detailRequest={detailRequest}
              onActiveTabChange={handleActiveTabChange}
              onSelectionChange={handleWorkspaceSelection}
              globalFilterIndicator
              headerTrailing={<EventFilterChip scope={scope} />}
              searchValue={route.q ?? ''}
              onSearchChange={handleSearchChange}
            />
            {(checkedIds.length > 0 || bulkNote !== null) && (
              <BulkBar
                count={checkedIds.length}
                busy={bulkBusy}
                note={bulkNote}
                onAction={(a) => void runBulk(a)}
                onClear={() => {
                  setCheckedIds([])
                  setBulkNote(null)
                  setChecklistResetKey((k) => k + 1)
                }}
              />
            )}
          </>
        ) : view === 'forms' && !isReviewer ? (
          <div className="section-with-event" key={me.event.id}>
            <EventScopeNote scope={scope} />
            <FormsSection
              eventSlug={me.event.slug}
              timezone={me.event.timezone}
              routeFormId={route.form}
              routeStep={route.fstep}
              onOpenForm={(id) => navigate({ form: id, fstep: id ? route.fstep : null })}
              onStepChange={(step) => navigate({ fstep: step }, { replace: true })}
            />
          </div>
        ) : view === 'evaluation' && !isReviewer ? (
          <div className="section-with-event" key={me.event.id}>
            <EventScopeNote scope={scope} />
            <EvaluationSection />
          </div>
        ) : view === 'agenda' && !isReviewer ? (
          <AgendaSection
            key={me.event.id}
            initialView={route.mode as never}
            initialDay={route.day}
            onViewChange={(mode) => navigate({ mode }, { replace: true })}
            onDayChange={(day) => navigate({ day }, { replace: true })}
          />
        ) : view === 'dashboard' && !isReviewer ? (
          <DashboardSection key={me.event.id} onNavigate={handleNavigate} />
        ) : view === 'settings' && !isReviewer ? (
          <div className="section-with-event" key={me.event.id}>
            <EventScopeNote scope={scope} />
            <SettingsSection me={me} />
          </div>
        ) : view === 'review' ? (
          <ReviewerWorkspace />
        ) : (
          <div className="shell-placeholder">
            <h2>{NAV_ITEMS.find((i) => i.key === view)?.label}</h2>
            <p>This section arrives with a later milestone.</p>
          </div>
        )}
      </main>
    </div>
    </EventScopeProvider>
  )
}

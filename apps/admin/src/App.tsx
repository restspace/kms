import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DataTabManager, TabConfig, type CreateFormProps } from './components/DataTabManager'
import type {
  DataSourceParams,
  DataSourceResult,
} from './components/DataList'
import {
  ApiError,
  bulkStatus,
  createContact,
  createSubmission,
  createTask,
  updateTask,
  deleteContact,
  getMe,
  getSubmissionDetail,
  listContactFields,
  listRooms,
  queryResource,
  sendDecisions,
  switchEvent,
  updateContact,
  updateSubmission,
  updateSubmissionStatus,
  type ContactFieldDef,
  type ContactRow,
  type Me,
  type MessageRow,
  type RoomRow,
  type SubmissionRow,
  type TaskAssignmentRow,
  getFileLibrary,
  type FileLibraryRow,
  getEvents,
  type EventListRow,
  type BulkJobStatus,
} from './api'
import { buildExportUrl, downloadFilesBundle } from './api'
import { appAlert, appConfirm } from './components/dialogs'
import { RecordFormActionableError } from './components/RecordForm'
import { TaskCreateForm } from './workspace/TaskCreateForm'
import { CreateEventDialog } from './components/CreateEventDialog'
import { FormsSection } from './forms/FormsSection'
import { SettingsSection } from './settings/SettingsSection'
import { EvaluationSection } from './evaluation/EvaluationSection'
import { AgendaSection } from './agenda/AgendaSection'
import { DashboardSection, type AppNavTarget } from './dashboard/DashboardSection'
import { ReviewerWorkspace } from './review/ReviewerWorkspace'
import { EmbedsSection } from './embeds/EmbedsSection'
import {
  BulkBar,
  ConfirmationChipsFilter,
  StatusChipsFilter,
  SubmissionDetailPanel,
  SubmissionEditForm,
  SUBMISSION_STATUSES,
  statusLabel,
  TaskStatusFilter,
} from './workspace/extras'
import { FileLibraryDetail, TaskFilesPanel, formatBytes } from './workspace/FilePanels'
import {
  ComposeForm,
  PortalInviteButton,
  describeSettledJob,
  pollBulkJob,
} from './workspace/messaging'
import { openImportWizard } from './workspace/ImportWizard'
import { HeadshotUploadControl } from './workspace/headshotUpload'
import { resolveTargetEventId } from './utils/importTarget'
import {
  EventFilterChip,
  EventFilterSelect,
  EventScopeNote,
  EventScopeProvider,
  type EventFilter,
  type EventScopeValue,
} from './eventScope'
import { currentRoute, navigate, stableStringify, useRoute, type ViewKey } from './router'
import { AdminErrorBoundary } from './components/AdminErrorBoundary'
import { formatEventDateRange } from './agenda/timeUtils'
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

// Client-side ceiling on the "Send decision emails" progress poll — see
// pollDecisionJob below. deliverNow (jobs/bulkJobs.ts) delivers inline during
// the same tick that flips the job to 'done', so a healthy run settles well
// inside this window; it exists purely so a stuck job can't hang the toast
// forever.
const DECISION_POLL_TIMEOUT_MS = 90_000

/**
 * `pollBulkJob` (workspace/messaging.tsx) polls a bulk_jobs row to a settled
 * state with no ceiling of its own — by design, since a compose/remind job
 * can legitimately take a while and those callers show an open-ended
 * "in progress" state. The decision-email toast is different: it promises
 * delivery "within a minute" (see the note it sets right after POSTing), so
 * if the job is ever stuck 'running' past that — a tick that threw partway,
 * or a dev/demo deployment with no cron trigger actually firing — the toast
 * should say so instead of polling forever at "0/2 processed". This wraps
 * pollBulkJob with exactly that ceiling: cancels the underlying poll and
 * calls `onTimeout` once `timeoutMs` elapses without a settle. Exported
 * (rather than inlined in runBulk) so the regression test can drive it with
 * fake timers without standing up the whole shell.
 */
export function pollDecisionJob(
  jobId: string,
  handlers: {
    onProgress?: (job: BulkJobStatus) => void
    onSettled: (job: BulkJobStatus) => void
    onError: (message: string) => void
    onTimeout: () => void
  },
  timeoutMs: number = DECISION_POLL_TIMEOUT_MS,
): { cancel: () => void } {
  let timeoutId: number | null = null
  const clearOwnTimeout = () => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
      timeoutId = null
    }
  }
  const handle = pollBulkJob(jobId, {
    onProgress: handlers.onProgress,
    onSettled: (job) => {
      clearOwnTimeout()
      handlers.onSettled(job)
    },
    onError: (message) => {
      clearOwnTimeout()
      handlers.onError(message)
    },
  })
  timeoutId = window.setTimeout(() => {
    timeoutId = null
    handle.cancel()
    handlers.onTimeout()
  }, timeoutMs)
  return {
    cancel: () => {
      clearOwnTimeout()
      handle.cancel()
    },
  }
}

const NAV_ITEMS: ReadonlyArray<{ key: ViewKey; label: string; soon: string | null }> = [
  { key: 'dashboard', label: 'Dashboard', soon: null },
  { key: 'workspace', label: 'Workspace', soon: null },
  { key: 'forms', label: 'Forms', soon: null },
  { key: 'evaluation', label: 'Evaluation', soon: null },
  { key: 'review', label: 'Review', soon: null },
  { key: 'agenda', label: 'Agenda', soon: null },
  { key: 'embeds', label: 'Embeds', soon: null },
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

/**
 * Contacts-hygiene item 4: `POST /submit/:slug/:formId/account` (submit.tsx)
 * stakes out a bare `{ email }` contact the moment someone starts a public
 * submission, before any name is collected — and a submission form that
 * doesn't collect participant identity (`collect_participants` off) never
 * requires one either. A visitor who abandons at that point, or who
 * completes such a form, leaves a permanent nameless stub — not seeded, and
 * not flagged at the source (submit.tsx is another lane's region), so this is
 * a narrow, documented heuristic applied at the display boundary instead:
 * a contact with no first *or* last name is treated as a placeholder and
 * kept out of the Speakers tab's default view and the 'Speakers' bulk-email
 * preset (see `speakersDataSource` below and messagingAdmin.ts's
 * `resolveAudience`). A genuine speaker who simply hasn't filled in a name
 * yet is indistinguishable from this stub by design — deliberately narrow,
 * not a hard invariant, and still reachable by searching their email.
 */
export const isPlaceholderContact = (c: Pick<ContactRow, 'first_name' | 'last_name'>): boolean =>
  !(c.first_name ?? '').trim() && !(c.last_name ?? '').trim()

const initials = (c: ContactRow): string => {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) return parts.map((p) => p[0]?.toUpperCase() ?? '').join('')
  return (c.email[0] ?? '?').toUpperCase()
}

/**
 * Speaker headshot (manual-QA item 3): the contacts query already selects
 * `c.*`, which includes `headshot_asset_id` — it just wasn't on the
 * `ContactRow` TS interface. Served through `/files/<id>`, which an
 * authenticated admin session already has access to via fileAuth. Falls back
 * to an initials avatar when no headshot is on file.
 */
const ContactHeadshot = ({ item }: { item: ContactRow }) =>
  item.headshot_asset_id ? (
    <img
      className="contact-headshot"
      src={`/files/${item.headshot_asset_id}`}
      alt={`${contactName(item)} headshot`}
      width={64}
      height={64}
    />
  ) : (
    <div className="contact-headshot contact-headshot-fallback" aria-hidden="true">
      {initials(item)}
    </div>
  )

const stripHtml = (html: string): string => {
  const el = document.createElement('div')
  el.innerHTML = html
  return el.textContent ?? ''
}

/** Just enough of the submissions resource row for the compact list below. */
interface SpeakerSessionRow {
  id: string
  code: string
  title: string
  starts_at: string | null
  room_id: string | null
}

/**
 * Contacts-hygiene item 3: the speaker detail panel had no view of what they
 * are actually presenting. Reuses the submissions resource's existing broad
 * `contact_id` filter (adminApi.ts RESOURCE_SPECS.submissions — submitter OR
 * participant, see its filterDocs) rather than adding a new endpoint; room
 * names come from `listRooms()` (already used by the agenda builder) since
 * the submissions resource doesn't join rooms, fetched once per mount and
 * matched by id.
 */
// Item 2 fix: this used to be `SpeakerSessionRow[] | null` with `if (!rows ||
// rows.length === 0) return null` — a genuine empty result ("no sessions")
// and a *failed* fetch (the `Promise.all` had no `.catch`, so a rejection
// just left `rows` at its initial `null` forever) rendered identically:
// nothing. That's how Marcus Okafor — an actual SESS-18 participant per the
// eval report — could show no Sessions section: not because the broad
// `contact_id` filter (adminApi.ts's submissions resource, submitter OR
// participant) failed to match him, but because *some* transient fetch
// failure for his record silently discarded the section, indistinguishable
// from Priya's genuinely-different case of having sessions. A tri-state
// (loading / error / rows) makes "no sessions" and "couldn't check" visibly
// different, with a Retry for the latter.
export const SpeakerSessions = ({ contactId }: { contactId: string }) => {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; rows: SpeakerSessionRow[] }
  >({ status: 'loading' })
  const [roomNames, setRoomNames] = useState<Map<string, string>>(new Map())
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void (async () => {
      try {
        const [subs, roomList] = await Promise.all([
          queryResource<SpeakerSessionRow>('submissions')({
            from: 0,
            size: 25,
            filters: { contact_id: contactId },
          }),
          listRooms().catch(() => ({ items: [] as RoomRow[] })),
        ])
        if (cancelled) return
        setRoomNames(new Map(roomList.items.map((r) => [r.id, r.name])))
        setState({ status: 'ready', rows: subs.items })
      } catch (err) {
        if (cancelled) return
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load sessions.' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [contactId, reloadToken])

  if (state.status === 'loading') {
    return (
      <div className="detail-body">
        <h3>Sessions</h3>
        <div className="settings-hint">Loading…</div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="detail-body">
        <h3>Sessions</h3>
        <div className="settings-error">
          {state.message}{' '}
          <button type="button" className="settings-ghost" onClick={() => setReloadToken((t) => t + 1)}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (state.rows.length === 0) {
    return (
      <div className="detail-body">
        <h3>Sessions</h3>
        <div className="settings-hint">No sessions.</div>
      </div>
    )
  }

  return (
    <div className="detail-body">
      <h3>Sessions</h3>
      <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
        {state.rows.map((s) => (
          <li key={s.id}>
            {s.title}
            <span style={{ color: 'var(--text-faint)' }}>
              {' — '}
              {s.starts_at ? fmtDate(s.starts_at) : 'unscheduled'}
              {s.room_id && roomNames.get(s.room_id) ? ` · ${roomNames.get(s.room_id)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const StatusChip = ({ status }: { status: string }) => (
  <span className={`status-chip status-${status}`}>{status.replace(/_/g, ' ')}</span>
)

// Contacts-hygiene item 2: the portal profile (portal.ts's LINK_FIELDS) lets a
// speaker save LinkedIn/X/Facebook/Website into `contacts.links` (json), but
// the organiser-side speaker form had no matching control — an organiser
// editing a speaker record from the workspace couldn't see or correct them.
// `link_*` are flat schema keys (RecordForm's static JSON-Schema has no
// nested-object control) that round-trip through `flattenContactLinks` /
// `unflattenContactLinks` below, the same "flatten for the form, re-nest for
// the request" trick `splitCustomFieldsFromFormData` already uses for
// per-event custom fields.
const SOCIAL_LINK_FORM_FIELDS = [
  ['link_linkedin', 'linkedin', 'LinkedIn'],
  ['link_twitter', 'twitter', 'X (Twitter)'],
  ['link_facebook', 'facebook', 'Facebook'],
  ['link_website', 'website', 'Website'],
] as const

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
    ...Object.fromEntries(
      SOCIAL_LINK_FORM_FIELDS.map(([control, , label]) => [control, { type: 'string', format: 'url', title: label }]),
    ),
    notes: { type: 'string', format: 'textarea', title: 'Internal notes' },
  },
}

/** `contacts.links` json → the `link_*` flat form keys, for RecordForm's initialValues seeding. */
const flattenContactLinks = (linksJson: string | null | undefined): Record<string, string> => {
  const links = parseContactFieldValues(linksJson)
  const out: Record<string, string> = {}
  for (const [control, key] of SOCIAL_LINK_FORM_FIELDS) out[control] = links[key] ?? ''
  return out
}

/** The `link_*` flat form keys → the `links` object the API's `pickContactLinks` expects, dropping the flat keys from the payload. */
const unflattenContactLinks = (data: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const links: Record<string, string> = {}
  let hasAnyLinkKey = false
  for (const [key, value] of Object.entries(data)) {
    const control = SOCIAL_LINK_FORM_FIELDS.find(([c]) => c === key)
    if (control) {
      hasAnyLinkKey = true
      if (typeof value === 'string' && value.trim() !== '') links[control[1]] = value.trim()
    } else {
      out[key] = value
    }
  }
  if (hasAnyLinkKey) out.links = links
  return out
}

/**
 * SPK-15: per-event custom fields on speaker/contact records. RecordForm's
 * static JSON-Schema can express these cleanly (a select is just an enum, a
 * multiline field is `format: 'textarea'`) as long as each one gets its own
 * flat top-level schema key — RecordForm falls back to a raw-JSON textarea
 * for nested objects, which is why values travel as `cf__<definition key>`
 * on the form rather than nested under a `custom_fields` property. The API
 * wants that nested shape though (`POST/PUT /contacts { custom_fields: {…} }`,
 * validated against the event's definitions) — `splitCustomFieldsFromFormData`
 * below re-nests them just before the request goes out.
 */
const CONTACT_FIELD_PREFIX = 'cf__'

const parseContactFieldOptions = (json: string | null): string[] => {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

const parseContactFieldValues = (json: string | null | undefined): Record<string, string> => {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Extra `speakerSchema.properties` entries for the event's custom fields. */
const customFieldSchemaProperties = (defs: ContactFieldDef[]): Record<string, Record<string, unknown>> => {
  const props: Record<string, Record<string, unknown>> = {}
  for (const def of defs) {
    if (def.type === 'select') {
      props[CONTACT_FIELD_PREFIX + def.key] = { type: 'string', title: def.label, enum: parseContactFieldOptions(def.options) }
    } else if (def.type === 'multiline') {
      props[CONTACT_FIELD_PREFIX + def.key] = { type: 'string', format: 'textarea', title: def.label }
    } else {
      props[CONTACT_FIELD_PREFIX + def.key] = { type: 'string', title: def.label }
    }
  }
  return props
}

/** A contacts-query row, flattened with `cf__<key>` so RecordForm's initialValues seeding (a plain key match against the schema) finds the current custom-field values on edit. */
const attachCustomFieldFormKeys = (item: ContactRow, defs: ContactFieldDef[]): ContactRow => {
  if (defs.length === 0) return item
  const values = parseContactFieldValues(item.custom_fields_json)
  const flat: Record<string, unknown> = {}
  for (const def of defs) flat[CONTACT_FIELD_PREFIX + def.key] = values[def.key] ?? ''
  return { ...item, ...flat } as ContactRow
}

/** Reverses `attachCustomFieldFormKeys` at submit time: pulls the `cf__` keys back out of the form data into the nested `custom_fields` shape the API expects, leaving the fixed fields untouched. */
const splitCustomFieldsFromFormData = (
  data: Record<string, unknown>,
  defs: ContactFieldDef[],
): Record<string, unknown> => {
  if (defs.length === 0) return data
  const fields: Record<string, unknown> = {}
  const customFields: Record<string, unknown> = {}
  let hasCustom = false
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith(CONTACT_FIELD_PREFIX)) {
      hasCustom = true
      customFields[key.slice(CONTACT_FIELD_PREFIX.length)] = value === undefined || value === '' ? null : value
    } else {
      fields[key] = value
    }
  }
  return hasCustom ? { ...fields, custom_fields: customFields } : fields
}

/**
 * F14/ABS-11: the base schema for submissions. This drives the "+ New"
 * generic RecordForm (a manual submission has no track/room/participants
 * yet) and satisfies `TabConfig.schema`'s edit-gating requirement; the real
 * edit surface is `SubmissionEditForm` (workspace/extras.tsx, wired below as
 * `editComponent`) — it needs a dynamic track/room picker and a participant
 * editor RecordForm's static JSON-Schema can't express.
 */
const submissionSchema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', title: 'Title' },
    description: { type: 'string', format: 'textarea', title: 'Description' },
    format: { type: 'string', title: 'Format' },
    level: { type: 'string', title: 'Level' },
    language: { type: 'string', title: 'Language' },
  },
}

/**
 * Task creation lives in `workspace/TaskCreateForm.tsx` (CNT-01): the old
 * generic RecordForm over a static `taskSchema` could only write a task
 * *definition*, and this tab's rows are assignments (one per assignee), so a
 * created task never appeared and looked like a silent failure. The bespoke
 * form adds the assignee/submission pickers a JSON-Schema field can't
 * express. It stays wired via `createComponent` rather than `schema` so a row
 * double-click doesn't also open an *edit* form over the wrong shape.
 */

/** Workspace tab keys addressable by dashboard deep-links. */
type WorkspaceTabKey = 'speakers' | 'submissions' | 'tasks' | 'messages' | 'files' | 'events'

const WORKSPACE_TAB_KEYS: readonly WorkspaceTabKey[] = ['speakers', 'submissions', 'tasks', 'messages', 'files', 'events']

/**
 * Events tab dataSource (manual-QA item 1: no way to list/switch events from
 * the workspace). Module-level — not eventFilterId-scoped like the other
 * tabs' sources (the Events tab always shows the org's accessible events
 * regardless of the workspace filter) — so its identity never changes and it
 * never needs to be part of `buildScopedSources`. `GET /app/api/events`
 * doesn't paginate (the accessible set is small), so this just slices the
 * one response client-side.
 */
const eventsDataSource = async (params: DataSourceParams): Promise<DataSourceResult<EventListRow>> => {
  const { items } = await getEvents()
  const q = typeof params.filters.q === 'string' ? params.filters.q.trim().toLowerCase() : ''
  const filtered = q ? items.filter((e) => e.name.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q)) : items
  const sorted = params.sort
    ? [...filtered].sort((a, b) => {
        const field = params.sort!.field as keyof EventListRow
        const av = a[field]
        const bv = b[field]
        const cmp = av === bv ? 0 : av > bv ? 1 : -1
        return params.sort!.direction === 'desc' ? -cmp : cmp
      })
    : filtered
  return { items: sorted.slice(params.from, params.from + params.size), total: sorted.length }
}

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
  contactFieldDefs: ContactFieldDef[] = [],
): Promise<unknown | null> {
  if (tab === 'speakers') {
    const result = await queryResource<ContactRow>('contacts')({
      from: 0,
      size: 1,
      filters: { contact_id: id, ...(eventFilterId ? { event_id: eventFilterId } : {}) },
    })
    const item = result.items[0]
    return item ? attachCustomFieldFormKeys(item, contactFieldDefs) : null
  }
  if (tab === 'submissions') {
    const detail = await getSubmissionDetail(id)
    return (detail.submission as unknown as SubmissionRow | undefined) ?? null
  }
  return null
}

/**
 * Event-scoped `dataSource` functions, one per workspace resource, keyed only
 * by `eventFilterId` — see `useScopedSources` below for why these must be
 * memoized independently of `buildWorkspaceConfig`'s other inputs (seeds,
 * checklistResetKey, ...).
 */
interface ScopedSources {
  contacts: (params: DataSourceParams) => Promise<DataSourceResult<ContactRow>>
  submissions: (params: DataSourceParams) => Promise<DataSourceResult<unknown>>
  tasks: (params: DataSourceParams) => Promise<DataSourceResult<TaskAssignmentRow>>
  messages: (params: DataSourceParams) => Promise<DataSourceResult<MessageRow>>
  files: (params: DataSourceParams) => Promise<DataSourceResult<FileLibraryRow>>
}

/**
 * Builds the `ScopedSources` above. Pulled out of `buildWorkspaceConfig` and
 * memoized in `App` on `[eventFilterId]` alone (manual-QA item 2): before
 * this split, every dashboard-bubble click or search keystroke rebuilt
 * *all five* dataSource closures (via `mergedSeeds`/`checklistResetKey`
 * changing), and DataList treats a new `dataSource` identity as a reason to
 * wipe `items` and refetch (see DataList.tsx's `dataSourceVersion` effect) —
 * every grid, not just the one whose filter actually changed. That's the
 * ~2s cross-tab reset/refetch jitter after a bubble click.
 */
function buildScopedSources(eventFilterId: string | null): ScopedSources {
  const scoped = <T,>(resource: 'contacts' | 'submissions' | 'messages' | 'tasks') => {
    const base = queryResource<T>(resource)
    if (!eventFilterId) return base
    return (params: DataSourceParams): Promise<DataSourceResult<T>> =>
      base({ ...params, filters: { ...params.filters, event_id: eventFilterId } })
  }
  return {
    contacts: scoped<ContactRow>('contacts'),
    submissions: scoped('submissions'),
    tasks: scoped<TaskAssignmentRow>('tasks'),
    messages: scoped<MessageRow>('messages'),
    files: (params: DataSourceParams): Promise<DataSourceResult<FileLibraryRow>> =>
      getFileLibrary({
        from: params.from,
        size: params.size,
        event_id: eventFilterId ?? undefined,
        submission_id: typeof params.filters.submission_id === 'string' ? params.filters.submission_id : undefined,
        contact_id: typeof params.filters.contact_id === 'string' ? params.filters.contact_id : undefined,
        q: typeof params.filters.q === 'string' ? params.filters.q : undefined,
      }),
  }
}

const TASK_STATE_FILTER_KEY = 'taskState'

/**
 * Translates the Tasks tab's status chip (`TaskStatusFilter`, workspace/extras.tsx)
 * into the query the tasks resource (adminApi.ts) actually understands.
 * `complete` and `overdue` map straight onto existing filter keys (`status`
 * and `overdue=true`); `open` has no single matching value — the resource's
 * `status` filter only takes the raw assignment statuses `not_started` /
 * `in_progress` / `complete`, one at a time — so it's covered by fetching
 * both incomplete statuses and merging/re-paginating client-side. The demo's
 * task list is small (dozens of rows), so two extra round trips per page is
 * an acceptable price for not touching the (other-lane-owned) route file to
 * add a proper `status=open` alias.
 */
export function tasksDataSourceWithStatusFilter(
  base: (params: DataSourceParams) => Promise<DataSourceResult<TaskAssignmentRow>>,
): (params: DataSourceParams) => Promise<DataSourceResult<TaskAssignmentRow>> {
  return async (params: DataSourceParams): Promise<DataSourceResult<TaskAssignmentRow>> => {
    const { [TASK_STATE_FILTER_KEY]: state, ...rest } = params.filters
    if (state === 'complete') {
      return base({ ...params, filters: { ...rest, status: 'complete' } })
    }
    if (state === 'overdue') {
      return base({ ...params, filters: { ...rest, overdue: 'true' } })
    }
    if (state === 'open') {
      const [notStarted, inProgress] = await Promise.all([
        base({ from: 0, size: 500, filters: { ...rest, status: 'not_started' }, sort: params.sort }),
        base({ from: 0, size: 500, filters: { ...rest, status: 'in_progress' }, sort: params.sort }),
      ])
      const merged: TaskAssignmentRow[] = [...notStarted.items, ...inProgress.items]
      const field = params.sort?.field
      if (field) {
        const dir = params.sort?.direction === 'desc' ? -1 : 1
        merged.sort((a, b) => {
          const av = (a as unknown as Record<string, unknown>)[field]
          const bv = (b as unknown as Record<string, unknown>)[field]
          if (av === bv) return 0
          if (av === null || av === undefined) return 1
          if (bv === null || bv === undefined) return -1
          return av > bv ? dir : -dir
        })
      }
      return { items: merged.slice(params.from, params.from + params.size), total: merged.length }
    }
    return base({ ...params, filters: rest })
  }
}

/**
 * Workspace tab configs against the Worker's generic query endpoints.
 * Exported (only) so `App.filesOpenDetails.test.tsx` can exercise the real
 * Files tab column definitions against DataList, rather than a hand-copied
 * duplicate that could drift from the fix.
 */
export function buildWorkspaceConfig(
  onChecklist: (ids: string[]) => void,
  checklistResetKey: number,
  seeds: WorkspaceSeeds,
  currentEventId: string,
  currentEventName: string,
  scopedSources: ScopedSources,
  onCreateEvent: () => void,
  onSelectEvent: (eventId: string) => void,
  contactFields: ContactFieldDef[],
  eventFilterId: string | null,
): Record<string, TabConfig> {
  // Export buttons (M6): each tab downloads its current view — active filters
  // and anchor included — through the public REST API's export endpoint.
  // KNOWN LIMITATION: the export endpoint is single-event, so with the filter
  // on "All events" the download covers the *current* event only.
  const exportFor = (resource: 'contacts' | 'submissions' | 'tasks' | 'messages') => ({
    buildUrl: (format: 'csv' | 'xlsx', query: { filters: Record<string, unknown>; sort?: { field: string; direction: 'asc' | 'desc' } }) => {
      const { event_id: _scopedEvent, ...rest } = query.filters as Record<string, unknown>
      // Same resolution as the import guard (D3): the sidebar scope is not in
      // `filters`, so it has to be consulted explicitly. "All events" still
      // falls back to the session event — the export endpoint is single-event.
      const eventId = resolveTargetEventId(eventFilterId, query.filters as Record<string, unknown>) ?? currentEventId
      return buildExportUrl(eventId, resource, format, rest, query.sort)
    },
  })
  /**
   * Import entry point (FR-REV-8). An import writes into exactly one event, so
   * "All events" has no target: the sidebar's event scope (or an explicit
   * `event_id` filter) is the target, and its absence is explained rather than
   * silently defaulted to the session event. `reload` refetches the grid once
   * the wizard has committed.
   */
  const importAction = (target: 'sessions' | 'contacts', label: string) => ({
    id: `import-${target}`,
    label: '↥ IMPORT',
    title: `Import ${label} from a CSV or XLSX file (column mapping + dry run first)`,
    onClick: ({ filters, reload }: { filters: Record<string, unknown>; reload: () => void }) => {
      const eventId = resolveTargetEventId(eventFilterId, filters)
      if (!eventId) {
        void appAlert(
          `An import has to know which event it is writing into. Pick a single event in the sidebar (the filter is on "All events"), then import ${label}.`,
          'Choose a target event',
        )
        return
      }
      openImportWizard({
        target,
        eventId,
        eventName: eventId === currentEventId ? currentEventName : eventId,
        onImported: reload,
      })
    },
  })

  /** Cross-event provenance column; hidden on mobile where width is scarce. */
  const eventColumn = { field: 'event_name', header: 'Event', width: '140px', sortable: false, mobileHidden: true }
  // SPK-15: the grid/detail item needs `cf__<key>` flat keys so a subsequent
  // "Edit" seeds RecordForm's initialValues correctly (see
  // attachCustomFieldFormKeys' doc comment) — wrapping the shared dataSource
  // here, rather than in buildScopedSources, keeps that source's identity
  // stable across a contactFields refetch (it's memoized on eventFilterId
  // alone; see buildScopedSources' doc comment for why that matters).
  const speakersDataSource = async (params: DataSourceParams): Promise<DataSourceResult<ContactRow>> => {
    const result = await scopedSources.contacts(params)
    const items = result.items
      // Contacts-hygiene item 4: keep nameless stub contacts out of the
      // roster's default view (isPlaceholderContact's doc comment has the
      // full story). `total` still reflects the unfiltered page count from
      // the server — a small, accepted discrepancy for a display-layer filter.
      .filter((item) => !isPlaceholderContact(item))
      .map((item) => ({ ...attachCustomFieldFormKeys(item, contactFields), ...flattenContactLinks(item.links) }))
    return { ...result, items }
  }
  const speakers: TabConfig<ContactRow> = {
    displayTitle: 'Speakers',
    dataSource: speakersDataSource,
    getItemId: (item) => item.id,
    getItemTitle: contactName,
    // SPK-04: roster filter/column mirroring the dashboard's per-submission
    // Confirmed/Awaiting split, but at the contact level (adminApi.ts's
    // `confirmation` derived column — confirmed/awaiting/null, null covering
    // both "not a participant" and the seed default before any filter chip
    // is chosen).
    filterConfig: {
      initialFilters: { confirmation: '', ...(seeds.speakers ?? {}) },
      defaultFilters: { confirmation: '' },
      FilterComponent: ConfirmationChipsFilter,
    },
    columns: [
      { field: 'first_name', header: 'First name', sortable: true },
      { field: 'last_name', header: 'Last name', sortable: true },
      { field: 'email', header: 'Email', width: '1.5fr', sortable: true, mobileRow: 2 },
      { field: 'company', header: 'Company', sortable: true },
      { field: 'job_title', header: 'Job title', mobileHidden: true },
      {
        field: 'confirmation',
        header: 'Confirmation',
        width: '120px',
        mobileHidden: true,
        render: (value: string | null) =>
          value === 'confirmed' ? (
            <span className="status-chip status-accepted">Confirmed</span>
          ) : value === 'awaiting' ? (
            <span className="status-chip status-pending">Awaiting</span>
          ) : (
            <span style={{ color: 'var(--text-faint)' }}>—</span>
          ),
      },
      eventColumn,
    ],
    detailComponent: ({ item, onEdit, onItemSaved }) => {
      const customValues = parseContactFieldValues(item.custom_fields_json)
      // Contacts-hygiene item 2: same `links` json the portal profile page
      // reads/writes, surfaced read-only here (edited via the `link_*` form
      // fields — see speakerSchema / unflattenContactLinks above).
      const socialLinks = parseContactFieldValues(item.links)
      return (
        <div className="detail-panel">
          <div className="detail-panel-head">
            <ContactHeadshot item={item} />
            <div>
              <h2>{contactName(item)}</h2>
              <div className="detail-sub">{item.job_title ? `${item.job_title} · ` : ''}{item.company ?? ''}</div>
              {/*
                * CNT-10: the speaker edit form (speakerSchema below) is a
                * generic RecordForm schema with no room for a file control,
                * so this lives here instead — same reasoning as
                * PortalInviteButton living outside the form further down.
                */}
              <HeadshotUploadControl
                item={item}
                onUpdated={(headshot_asset_id) => onItemSaved?.({ ...item, headshot_asset_id })}
              />
            </div>
          </div>
          <dl>
            <dt>Email</dt><dd>{item.email}</dd>
            {item.mobile_phone && <><dt>Mobile</dt><dd>{item.mobile_phone}</dd></>}
            {item.pronouns && <><dt>Pronouns</dt><dd>{item.pronouns}</dd></>}
            {item.event_name && <><dt>Event</dt><dd>{item.event_name}</dd></>}
            {contactFields.map((def) =>
              customValues[def.key] ? (
                <Fragment key={def.id}>
                  <dt>{def.label}</dt><dd>{customValues[def.key]}</dd>
                </Fragment>
              ) : null,
            )}
            <dt>Created</dt><dd>{fmtDate(item.created_at)}</dd>
          </dl>
          {item.biography && <div className="detail-body">{stripHtml(item.biography)}</div>}
          {SOCIAL_LINK_FORM_FIELDS.some(([, key]) => socialLinks[key]) && (
            <div className="detail-body">
              <h3>Links</h3>
              <dl>
                {SOCIAL_LINK_FORM_FIELDS.map(([, key, label]) =>
                  socialLinks[key] ? (
                    <Fragment key={key}>
                      <dt>{label}</dt>
                      <dd><a href={socialLinks[key]} target="_blank" rel="noreferrer">{socialLinks[key]}</a></dd>
                    </Fragment>
                  ) : null,
                )}
              </dl>
            </div>
          )}
          <SpeakerSessions contactId={item.id} />
          {/*
            * SPK-06: the organiser can now put a known contact into the speaker
            * portal directly. Deliberately outside the `onEdit` guard — inviting
            * is not an edit, and the panel renders without `onEdit` in read-only
            * contexts where the invite is still the useful action.
            */}
          <div className="detail-actions">
            {onEdit && <button onClick={onEdit}>Edit</button>}
            <PortalInviteButton contactId={item.id} contactName={contactName(item)} />
          </div>
        </div>
      )
    },
    globalFilterSets: { id: 'contact_id' },
    globalFilterReceives: { submission_id: 'submission_id' },
    exportConfig: exportFor('contacts'),
    toolbarActions: [importAction('contacts', 'speakers')],
    schema: {
      ...speakerSchema,
      properties: { ...speakerSchema.properties, ...customFieldSchemaProperties(contactFields) },
    },
    // F13: a duplicate email is a validation rule worth keeping, but the
    // form used to be a dead end — the organiser had no way back to the
    // contact that already owns the address. The API now echoes its id on
    // the 409 (adminApi.ts's `email_exists`); surface it as a recovery
    // action next to the error rather than silently guessing which record
    // to open (consistent with the importer's fill-blanks-only merge: never
    // clobber, always land the organiser on the real record instead).
    onUpsert: async (data, existing?: ContactRow) => {
      const payload = splitCustomFieldsFromFormData(unflattenContactLinks(data), contactFields)
      try {
        return existing ? await updateContact(existing.id, payload) : await createContact(payload)
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.status === 409 &&
          err.details?.error === 'email_exists' &&
          typeof err.details.existing_id === 'string'
        ) {
          const existingId = err.details.existing_id
          throw new RecordFormActionableError(err.message, {
            label: 'Open existing contact',
            onClick: () => navigate({ v: 'workspace', tab: 'speakers', rec: existingId }),
          })
        }
        throw err
      }
    },
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
    dataSource: scopedSources.submissions as (params: DataSourceParams) => Promise<DataSourceResult<SubmissionRow & { rating: number | null; notified_at: string | null; review_count: number }>>,
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
    // A single row click opens this panel, so it carries the record's primary
    // actions rather than being read-only (eval defects AIA-04/CNT-09/CNT-12).
    // `onEdit` is supplied by DataTabManager for any tab config with both
    // `onUpsert` and `schema` (both set below) and opens the `editComponent`
    // tab — the same form a row double-click reaches, which nobody found.
    detailComponent: ({ item, onEdit, onItemSaved }) => (
      <SubmissionDetailPanel
        id={item.id}
        onEdit={onEdit}
        // Same cast as `onUpsert` below: the panel hands back the submission
        // row it re-read from the server, which only has to satisfy the tab's
        // generic here — the list refetch is what the grid renders from.
        onItemSaved={onItemSaved && ((row) => onItemSaved(row as unknown as SubmissionRow & {
          rating: number | null
          notified_at: string | null
          review_count: number
        }))}
      />
    ),
    globalFilterSets: { id: 'submission_id' },
    globalFilterReceives: { contact_id: 'contact_id' },
    exportConfig: exportFor('submissions'),
    toolbarActions: [
      importAction('sessions', 'sessions'),
      {
        // Latest version only (is_current), one folder per submission — the
        // server owns both rules; see routes/importExport.ts.
        id: 'files-zip',
        label: '↓ FILES',
        title: 'Download the current version of every file attached to the checked submissions, as a ZIP',
        disabled: ({ checkedIds }: { checkedIds: string[] }) =>
          checkedIds.length === 0 && 'Check one or more submissions to download their files',
        onClick: async ({ checkedIds }: { checkedIds: string[] }) => {
          try {
            await downloadFilesBundle(checkedIds)
          } catch (err) {
            await appAlert(err instanceof Error ? err.message : 'The download failed.', 'Download files')
          }
        },
      },
    ],
    // F14/ABS-11 + theme-E create-form gap: row double-click opens a real
    // edit form, and "+ New" now opens the *same* form rather than the bare
    // generic RecordForm — the plain `schema` render had no track or status
    // field, so an admin-created submission could never be put on a track or
    // given a starting status other than the server's hardcoded 'pending'
    // (baseline defect: "Submissions created via the admin 'Add new record'
    // form cannot be linked to a speaker/participant afterwards ... no Track
    // field on the create form"). `schema` still has to stay set — DataTabManager
    // gates row-double-click-to-edit on `schema && onUpsert` even when
    // `editComponent` is what actually renders (see its `canEdit` check).
    schema: submissionSchema,
    createComponent: SubmissionEditForm,
    editComponent: SubmissionEditForm,
    onUpsert: async (data, existing) => {
      if (existing) {
        const saved = await updateSubmission(existing.id, data)
        return saved as unknown as SubmissionRow & { rating: number | null; notified_at: string | null; review_count: number }
      }
      // POST /submissions (evaluation.ts) hardcodes a new submission's status
      // to 'pending' and doesn't read a `status` field — SubmissionEditForm's
      // create mode sends one anyway (theme-E: create form should offer a
      // status), so a non-default choice is applied as a second, existing
      // call (the same one the grid's inline status dropdown uses) once the
      // record — and its id — exist.
      const { status: desiredStatus, ...createFields } = data as Record<string, unknown> & { status?: unknown }
      const created = await createSubmission(createFields)
      const createdId = typeof (created as { id?: unknown }).id === 'string' ? (created as { id: string }).id : undefined
      if (createdId && typeof desiredStatus === 'string' && desiredStatus && desiredStatus !== 'pending') {
        await updateSubmissionStatus(createdId, desiredStatus)
        return { ...created, status: desiredStatus } as unknown as SubmissionRow & {
          rating: number | null
          notified_at: string | null
          review_count: number
        }
      }
      // Mirrors the Tasks tab's cast (line ~589): the write response's shape
      // only needs to satisfy TabConfig's generic signature here — the
      // list refetch after save is what the grid actually renders from.
      return created as unknown as SubmissionRow & { rating: number | null; notified_at: string | null; review_count: number }
    },
  }

  // Item 1 (O4 manual-review): "no edit control or due-date change is
  // available anywhere in the Tasks UI, so deadlines cannot be adjusted
  // after creation." PUT /app/api/tasks/:id already accepted title/due_at
  // (see adminApi.ts's pickTaskFields) — nothing in the admin UI ever called
  // it. This is a small inline editor on the assignment detail panel rather
  // than reusing TaskCreateForm: that form's target-picker fields describe
  // *creating* new assignments (a different shape than the definition this
  // edits — see the Tasks TabConfig's own `createComponent` doc comment a few
  // lines down), which would be actively misleading to show mid-edit.
  // Deliberately narrow to title/due date/required: `TaskAssignmentRow` (the
  // grid's row shape) doesn't carry the definition's `description`, and
  // pickTaskFields on the server treats an omitted key as "leave unchanged"
  // but an empty string as "clear it" — pre-filling a description input
  // with nothing and then saving would silently wipe a real description on
  // every edit, so it's left off this form rather than added half-safely.
  const TaskEditPanel = ({
    item,
    onItemSaved,
  }: {
    item: TaskAssignmentRow
    onItemSaved?: (item: TaskAssignmentRow) => void
  }) => {
    const [editing, setEditing] = useState(false)
    const [title, setTitle] = useState(item.task_title)
    const [dueAt, setDueAt] = useState(item.due_at ? item.due_at.slice(0, 10) : '')
    const [required, setRequired] = useState(item.required === 1)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const startEdit = () => {
      setTitle(item.task_title)
      setDueAt(item.due_at ? item.due_at.slice(0, 10) : '')
      setRequired(item.required === 1)
      setError(null)
      setEditing(true)
    }

    const save = async () => {
      const trimmed = title.trim()
      if (!trimmed) {
        setError('Title is required.')
        return
      }
      setSaving(true)
      setError(null)
      try {
        // Writes the *definition* (`tasks`, keyed by `task_id`), not this row's
        // assignment id — see the TabConfig doc comment on `createComponent`
        // for why the grid's `id` is the wrong target.
        await updateTask(item.task_id, {
          title: trimmed,
          due_at: dueAt ? new Date(dueAt).toISOString() : null,
          required,
        })
        onItemSaved?.({
          ...item,
          task_title: trimmed,
          due_at: dueAt ? new Date(dueAt).toISOString() : null,
          required: required ? 1 : 0,
        })
        setEditing(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save the task.')
      } finally {
        setSaving(false)
      }
    }

    if (!editing) {
      return (
        <button type="button" className="record-form-cancel" style={{ marginTop: 8 }} onClick={startEdit}>
          Edit task
        </button>
      )
    }
    return (
      <div className="record-form-fields" style={{ marginTop: 8, maxWidth: 320 }}>
        {error && <div className="record-form-submit-error" role="alert"><span>{error}</span></div>}
        <div className="record-form-field">
          <label htmlFor="task-edit-title">Title</label>
          <input id="task-edit-title" value={title} disabled={saving} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="record-form-field">
          <label htmlFor="task-edit-due">Due date</label>
          <input id="task-edit-due" type="date" value={dueAt} disabled={saving} onChange={(e) => setDueAt(e.target.value)} />
        </div>
        <div className="record-form-field">
          <label htmlFor="task-edit-required" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              id="task-edit-required"
              type="checkbox"
              checked={required}
              disabled={saving}
              onChange={(e) => setRequired(e.target.checked)}
            />
            Required
          </label>
        </div>
        <div className="record-form-actions">
          <span className="record-form-actions-spacer" />
          <button type="button" className="record-form-cancel" disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="button" className="record-form-submit" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    )
  }

  const tasks: TabConfig<TaskAssignmentRow> = {
    displayTitle: 'Tasks',
    dataSource: tasksDataSourceWithStatusFilter(scopedSources.tasks),
    getItemId: (item) => item.id,
    getItemTitle: (item) => item.task_title,
    // Baseline defect: no complete/incomplete status filter existed, only
    // column sorting. `seeds.tasks` (a dashboard deep link, e.g. a specific
    // assignee) folds in alongside the chip's own key rather than replacing
    // this filterConfig outright — same pattern as the Speakers tab's
    // `confirmation` chip above.
    filterConfig: {
      initialFilters: { [TASK_STATE_FILTER_KEY]: '', ...(seeds.tasks ?? {}) },
      defaultFilters: { [TASK_STATE_FILTER_KEY]: '' },
      FilterComponent: TaskStatusFilter,
    },
    columns: [
      { field: 'task_title', header: 'Task', width: '1.6fr', sortable: true },
      {
        field: 'assignee_name',
        header: 'Assignee',
        sortable: true,
        render: (value: string | null, item) => value ?? item.assignee_email,
      },
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
    detailComponent: ({ item, onItemSaved }) => (
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
        {/* Item 1: due dates (and the title/required flag) were frozen at
            creation with no UI anywhere to change them — see TaskEditPanel's
            doc comment above the Tasks TabConfig for why this edits the
            *definition* via `item.task_id`, not this assignment row. */}
        <TaskEditPanel item={item} onItemSaved={onItemSaved} />
        {/* The file the task produced — invisible to organisers before W2-C. */}
        <TaskFilesPanel assignmentId={item.id} actionType={item.action_type} />
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
    dataSource: scopedSources.messages,
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
    // SPK-13: the tab was read-only history — there was no way to write to
    // speakers from the workspace at all. `createComponent` (the Tasks tab's
    // pattern) opens the compose form from '+ New' without also making
    // message_log rows look editable, which needs `schema` as well.
    createComponent: ComposeForm,
    // ComposeForm does its own POST and job polling — it only calls
    // `onSubmit` once the organiser dismisses the result, to close the tab
    // and refetch the list so the new per-recipient rows appear. Nothing is
    // created here, hence the empty stand-in row.
    onUpsert: async () => ({}) as MessageRow,
  }

  // Dashboard deep-link seeds (M5 stretch) and URL-restored q/flt: tabs without
  // their own filter UI still honour seeded local filters; the preset bar in App
  // clears them. Speakers now has its own filterConfig (confirmation chips)
  // declared above, which already folds seeds.speakers into initialFilters —
  // e.g. a `missing_assets` deep-link seed rides alongside the chip filter's
  // `confirmation` key instead of replacing the whole filter UI.
  if (seeds.messages) {
    messages.filterConfig = { initialFilters: seeds.messages, defaultFilters: {}, FilterComponent: NullFilter }
  }

  // Files library (W2-C): one row per version chain, so a count of versions is
  // meaningful and the current file is a single row. It reads its own endpoint
  // rather than the generic query endpoint — the rows are chains, not records.
  const files: TabConfig<FileLibraryRow> = {
    displayTitle: 'Files',
    dataSource: scopedSources.files,
    getItemId: (item) => item.upload_id,
    getItemTitle: (item) => item.filename,
    columns: [
      {
        // Eval defect 1: this column is the grid's resolved `titleField`
        // (DataList falls back to the first non-editable column when a
        // TabConfig doesn't set one — see DataList.tsx's `resolvedTitleField`),
        // which is what makes DataList wrap its rendered content in the
        // "Open details" title-link button (DataList.tsx's `withTitleLink`).
        // That render used to *be* an `<a>` filling the whole cell with its
        // own `onClick={(e) => e.stopPropagation()}` — so every click on the
        // visible filename stopped at the anchor and never reached the
        // wrapping button, and "Open details" was unreachable through its own
        // labelled control (clicking elsewhere in the row still opened it via
        // the row's own click handler, which is why this only looked like a
        // no-op on the specific control named in the defect). Splitting the
        // direct-file-open affordance into its own small icon link — leaving
        // the filename text itself un-wrapped — lets a filename click bubble
        // to "Open details" while the icon keeps the raw-file shortcut.
        field: 'filename',
        header: 'File',
        width: '1.6fr',
        render: (value: string, item) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
            <a
              href={`/files/${item.file_asset_id}`}
              target="_blank"
              rel="noopener"
              title="Open the file directly"
              aria-label={`Open ${value} directly`}
              style={{ flexShrink: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              ↗
            </a>
          </span>
        ),
      },
      {
        field: 'uploaded_by_name',
        header: 'Uploaded by',
        // Prefer the actual uploader (fa.uploaded_by_contact_id); older rows
        // and the self-service portal path never populated a distinct
        // uploaded_by_* (uploader == subject there), so fall back to the
        // chain's contact.
        render: (value: string | null, item) =>
          value ?? item.uploaded_by_email ?? item.uploader_name ?? item.uploader_email ?? '',
      },
      {
        field: 'submission_code',
        header: 'For',
        width: '80px',
        mobileHidden: true,
        // Submission-scoped uploads show the submission code; a headshot (no
        // submission) shows the speaker it's for instead (SPK-10).
        render: (value: string | null, item) => value ?? item.uploader_name ?? item.uploader_email ?? '',
      },
      { field: 'size_bytes', header: 'Size', width: '90px', render: (value: number | null) => formatBytes(value) },
      { field: 'version_count', header: 'Versions', width: '90px' },
      { field: 'uploaded_at', header: 'Uploaded', width: '110px', render: (value: string) => fmtDate(value) },
      eventColumn,
    ],
    detailComponent: ({ item }) => <FileLibraryDetail item={item} />,
    globalFilterReceives: { contact_id: 'contact_id', submission_id: 'submission_id' },
  }

  // Events tab (manual-QA item 1): the org's accessible events, always
  // unscoped by `eventFilterId` (see `eventsDataSource`'s doc comment) — you
  // need to see every event to switch into one. A row click fires
  // `onSelectionChange` below and moves the workspace's event filter (the
  // same "event as a filter dimension" mechanism as the sidebar's
  // `EventFilterSelect`), rather than opening a detail tab.
  const events: TabConfig<EventListRow> = {
    displayTitle: 'Events',
    dataSource: eventsDataSource,
    getItemId: (item) => item.id,
    getItemTitle: (item) => item.name,
    columns: [
      { field: 'name', header: 'Name', width: '2fr', sortable: true },
      {
        field: 'starts_at',
        header: 'Dates',
        width: '1.4fr',
        sortable: true,
        render: (_value: string, item) => `${fmtDate(item.starts_at)} – ${fmtDate(item.ends_at)}`,
      },
      {
        field: 'agenda_published',
        header: 'Agenda',
        width: '100px',
        render: (value: boolean) => (
          <span className={`status-chip status-${value ? 'accepted' : 'pending'}`}>
            {value ? 'Published' : 'Draft'}
          </span>
        ),
      },
      { field: 'speaker_count', header: 'Speakers', width: '90px', mobileHidden: true },
      { field: 'submission_count', header: 'Submissions', width: '100px', mobileHidden: true },
      { field: 'role', header: 'Your role', width: '100px', mobileHidden: true },
    ],
    detailComponent: ({ item }) => (
      <div className="detail-panel">
        <h2>{item.name}</h2>
        <div className="detail-sub">{fmtDate(item.starts_at)} – {fmtDate(item.ends_at)}</div>
        <dl>
          <dt>Agenda</dt><dd>{item.agenda_published ? 'Published' : 'Draft'}</dd>
          <dt>Speakers</dt><dd>{item.speaker_count}</dd>
          <dt>Submissions</dt><dd>{item.submission_count}</dd>
          <dt>Your role</dt><dd>{item.role}</dd>
        </dl>
        <div className="detail-actions">
          <button onClick={() => onSelectEvent(item.id)}>Switch to this event</button>
        </div>
      </div>
    ),
    // A single click on a row already switches the event — see
    // `onSelectionChange` below. The detail tab (and its own button) stays
    // reachable as a fallback for keyboard/assistive navigation that opens a
    // row without firing DataList's click-selection path.
    onSelectionChange: (item) => {
      if (item) onSelectEvent(item.id)
    },
    // "+ New event" opens the existing modal (App.tsx) rather than an inline
    // create tab — CreateEventDialog owns real validation (slug pattern,
    // timezone, date ordering) a second implementation shouldn't duplicate.
    // The create tab DataTabManager opens on click is cancelled immediately.
    createComponent: ({ onCancel }: CreateFormProps) => {
      useEffect(() => {
        onCreateEvent()
        onCancel()
      }, [])
      return null
    },
  }

  return {
    speakers: speakers as TabConfig,
    submissions: submissions as TabConfig,
    tasks: tasks as TabConfig,
    messages: messages as TabConfig,
    files: files as TabConfig,
    events: events as TabConfig,
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

  // SPK-15: the Speakers tab's custom-field definitions, scoped to the
  // current session event (new/edited contacts always write there — same
  // scope adminApiRoutes.post('/contacts') uses). Settings' "Speaker fields"
  // card writes these live; a manual reload picks up a change made there
  // mid-session (no revision-bumped polling for this small a surface).
  const [contactFields, setContactFields] = useState<ContactFieldDef[]>([])
  useEffect(() => {
    if (!me) return
    listContactFields()
      .then((r) => setContactFields(r.items))
      .catch(() => {})
  }, [me?.event.id])

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

  /**
   * `me` is read through a ref so `setFilter` (and everything memoized on it —
   * `onSelectEvent`, and through it the whole `workspaceConfig`) keeps a stable
   * identity. Depending on the `me` *object* meant every `/api/me` re-read
   * rebuilt the config, which hands every mounted DataList a brand-new
   * `dataSource` closure, which DataList answers by wiping and refetching.
   * Switching events does that two or three times within a few hundred ms, and
   * the responses then land against superseded query signatures — which is
   * exactly what tripped the grid's "kept being reloaded before it could
   * finish" breaker on the Speakers roster.
   */
  const meRef = useRef<Me | null>(me)
  meRef.current = me

  const setFilter = useCallback(
    (next: EventFilter) => {
      navigate({ ev: next, rec: null }, { replace: true })
      const current = meRef.current
      if (next !== 'all' && current && next !== current.event.id) void applyEventCookie(next)
    },
    [applyEventCookie],
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
  // Keyed on the *serialised* filters: `parseRoute` allocates a fresh `flt`
  // object on every route change, so keying on its identity rebuilt the seeds
  // (and with them every tab's dataSource closure) whenever an unrelated
  // parameter such as `rec` moved.
  const routeFilterSignature = useMemo(() => stableStringify(route.flt ?? null), [route.flt])
  const routeSeeds = useMemo<Record<string, unknown> | null>(() => {
    const merged = { ...(route.flt ?? {}), ...(route.q ? { q: route.q } : {}) }
    return Object.keys(merged).length > 0 ? merged : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeFilterSignature, route.q])

  const mergedSeeds = useMemo<WorkspaceSeeds>(() => {
    const base = wsPreset?.seeds ?? {}
    if (!routeSeeds) return base
    const out: WorkspaceSeeds = {}
    for (const key of WORKSPACE_TAB_KEYS) {
      out[key] = { ...(base[key] ?? {}), ...routeSeeds }
    }
    return out
  }, [routeSeeds, wsPreset])

  // Manual-QA item 2: memoized independently of `mergedSeeds`/`checklistResetKey`
  // so a dashboard-bubble click or a search keystroke doesn't hand every grid a
  // new `dataSource` identity (see `buildScopedSources`'s doc comment for what
  // that costs — a several-second cross-tab reset/refetch jitter).
  const scopedSources = useMemo(() => buildScopedSources(eventFilterId), [eventFilterId])

  const openCreateEvent = useCallback(() => setCreateEventOpen(true), [])

  // Events tab row click (manual-QA item 1): moves the workspace event filter
  // to the clicked event — the same mechanism as the sidebar's
  // `EventFilterSelect`, so a concrete event also rebinds the session (via
  // `applyEventCookie` inside `setFilter`) the way picking it from the
  // dropdown always has.
  const onSelectEvent = useCallback((eventId: string) => setFilter(eventId), [setFilter])

  // Rebuilding on checklistResetKey both clears checks and refetches lists —
  // exactly what a bulk action needs.
  const workspaceConfig = useMemo(
    () =>
      buildWorkspaceConfig(
        handleChecklist,
        checklistResetKey,
        mergedSeeds,
        me?.event.id ?? '',
        me?.event.name ?? '',
        scopedSources,
        openCreateEvent,
        onSelectEvent,
        contactFields,
        eventFilterId,
      ),
    [
      handleChecklist,
      checklistResetKey,
      mergedSeeds,
      me?.event.id,
      me?.event.name,
      eventFilterId,
      scopedSources,
      openCreateEvent,
      onSelectEvent,
      contactFields,
    ],
  )

  const workspaceTabs = useMemo(
    () => Object.entries(workspaceConfig).map(([key, cfg]) => ({ key, label: cfg.displayTitle ?? key })),
    [workspaceConfig],
  )

  /**
   * Route → tab: re-fire the DataTabManager activate request whenever the URL
   * names a different tab (including a fresh deep link on load).
   *
   * `reportedTab` closes the loop the other way: a tab the workspace itself
   * reported is already active there, so echoing it back as a fresh activate
   * request only feeds the manager stale intermediates. Together with the
   * manager's own guard this is what stopped the dashboard deep-link from
   * oscillating between Speakers and the requested tab (each flip remounted
   * the grid and fired another page request — "Loading…" forever, then
   * net::ERR_INSUFFICIENT_RESOURCES).
   */
  const reportedTab = useRef<string | null>(null)
  useEffect(() => {
    if (view !== 'workspace') {
      // The manager unmounts with the view, taking its "already active" state
      // with it — so does the record of what it last reported.
      reportedTab.current = null
      return
    }
    if (!route.tab) return
    if (reportedTab.current === route.tab) return
    setWsTabRequest((prev) =>
      prev?.configKey === route.tab ? prev : { configKey: route.tab as string, token: (prev?.token ?? 0) + 1 },
    )
    // `view` is a dependency so re-entering the workspace re-asserts the URL's
    // tab: a sidebar sub-tab link clicked from Settings leaves `route.tab`
    // unchanged when it names the tab the URL already carried, and without
    // this the freshly mounted manager would just land on its default tab.
  }, [route.tab, view])

  /**
   * Route → open detail tab. `handledRec` also absorbs selections reported *by*
   * the workspace, so mirroring a click into the URL never bounces back as a
   * re-open. A record that 404s just drops out of the URL.
   */
  const handledRec = useRef<string | null>(null)
  /**
   * The `rec` the URL asked for while its record is still being fetched.
   *
   * Without it the deep link raced the grid: the freshly mounted list reports
   * its own auto-selected first row through `handleWorkspaceSelection`, which
   * rewrites `?rec=` *and* stamps `handledRec` — so by the time the requested
   * record resolved, the URL no longer named it and nothing ever opened its
   * detail tab. That is the "the agent spent dozens of turns before a Detail
   * tab eventually appeared" symptom: it only ever appeared when a reload
   * happened to win the race.
   */
  const pendingRec = useRef<string | null>(null)
  useEffect(() => {
    const { rec, tab } = route
    if (view !== 'workspace' || !rec || !isWorkspaceTabKey(tab)) return
    const key = `${tab}:${rec}`
    if (handledRec.current === key) return
    handledRec.current = key
    if (!REC_RESTORABLE.includes(tab)) return
    let cancelled = false
    pendingRec.current = rec
    const settle = () => {
      if (pendingRec.current === rec) pendingRec.current = null
    }
    void loadWorkspaceRecord(tab, rec, eventFilterId, contactFields)
      .then((item) => {
        if (cancelled) {
          settle()
          return
        }
        if (!item) {
          settle()
          navigate({ rec: null }, { replace: true })
          return
        }
        setDetailRequest((prev) => ({ configKey: tab, item, token: (prev?.token ?? 0) + 1 }))
        settle()
      })
      .catch(() => {
        settle()
        if (!cancelled) navigate({ rec: null }, { replace: true })
      })
    return () => {
      cancelled = true
    }
  }, [route, view, eventFilterId, contactFields])

  /**
   * Workspace → route: active list tab. Detail tabs keep the parent's key. The
   * manager's very first report (landing on the default tab) replaces rather
   * than pushes, so Back doesn't bounce between `?v=workspace` and
   * `?v=workspace&tab=speakers`.
   */
  const handleActiveTabChange = useCallback((tab: { type: string; configKey: string } | null) => {
    if (!tab || tab.type !== 'list') return
    reportedTab.current = tab.configKey
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
      // A deep-linked record still in flight owns the URL until it resolves —
      // see `pendingRec`. The grid's own auto-selection must not overwrite it.
      if (pendingRec.current !== null && pendingRec.current !== id) return
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

  /**
   * CFP-14: send-decisions stopped sending in-request when it moved behind
   * bulk_jobs (sweep item P2-19) — but the note kept quoting the *planned*
   * counts the POST echoes back, so the organiser read "12 decision emails
   * sent" the instant they clicked, before the cron expander had queued a
   * single one (and whatever the provider later did with them). It now polls
   * the job like the dashboard's remind-all does and reports what message_log
   * actually recorded. The skipped counts stay attached throughout: they are
   * decided in-request (rows outside a queue / already notified) and the job
   * knows nothing about them.
   */
  const decisionPollRef = useRef<{ cancel: () => void } | null>(null)
  useEffect(() => () => decisionPollRef.current?.cancel(), [])

  const runBulk = useCallback(
    async (action: 'accept_queue' | 'decline_queue' | 'pending' | 'send_decisions') => {
      if (checkedIds.length === 0) return
      decisionPollRef.current?.cancel()
      setBulkBusy(true)
      let polling = false
      try {
        if (action === 'send_decisions') {
          const r = await sendDecisions(checkedIds)
          const planned = r.accepted + r.declined
          const other = r.skipped - r.skipped_notified
          // r.skipped_no_submitter is a subset of the *queued* (accepted +
          // declined) rows, not of r.skipped — those still get their status
          // flipped by the expander, they just have no address to mail. Call
          // that out explicitly so "queued" copy never implies every queued
          // decision will actually reach an inbox.
          // FR-REV-2: decisions only fire from a queue state (Accept Queue /
          // Decline Queue) by design — a row already Accepted/Declined is
          // refused, not silently resent. That gate is correct, but "not in a
          // queue" alone left the organiser with no idea what to do about it;
          // spell out the remedy (the bulk bar's own "→ Accept/Decline Queue"
          // buttons, right next to this one, re-stage a selection for resend).
          const skippedNote =
            (r.skipped_notified > 0 ? `; ${r.skipped_notified} skipped (already notified)` : '') +
            (other > 0
              ? `; ${other} skipped (already decided — move back to Accept/Decline Queue to resend)`
              : '') +
            ((r.skipped_no_submitter ?? 0) > 0 ? `; ${r.skipped_no_submitter} skipped — no submitter email` : '')
          const plan = `${r.accepted} accepted, ${r.declined} declined`
          if (!r.job_id) {
            // Nothing was in a decision queue, so no job exists to poll.
            setBulkNote(`No decision emails to send${skippedNote}`)
          } else {
            polling = true
            setBulkNote(`Queued decision emails for ${planned} ${planned === 1 ? 'submission' : 'submissions'} (${plan})${skippedNote} — delivery completes within a minute…`)
            decisionPollRef.current = pollDecisionJob(r.job_id, {
              onProgress: (job) =>
                setBulkNote(`Sending decisions… ${job.enqueued}/${job.total ?? planned} processed (${plan})`),
              onSettled: (job) => {
                setBulkNote(`${describeSettledJob(job, 'decision email')} ${plan}${skippedNote}`)
                setBulkBusy(false)
                // The expander flips accept_queue/decline_queue to their final
                // status (and sets notified_at) inside this same job run, so
                // the grid — which last refetched right when the job was
                // *queued*, above — is now showing stale statuses and no
                // Notified checkmarks. Bump the list version again now that
                // the flip has actually landed.
                setChecklistResetKey((k) => k + 1)
              },
              onError: (message) => {
                setBulkNote(message)
                setBulkBusy(false)
              },
              // Belt-and-braces: a job stuck 'running' (a tick that threw
              // partway, or no cron trigger firing at all in a dev/demo
              // deployment) would otherwise leave this toast reading
              // "Sending decisions… 0/2 processed" forever with no way out.
              // Stop polling and hand the organiser back the grid instead of
              // a permanently-stuck spinner; the refresh means any decisions
              // that did land are still visible.
              onTimeout: () => {
                setBulkNote(
                  `Still sending decision emails (${plan})${skippedNote} — this is taking longer than expected. ` +
                    `Refresh the Submissions list in a moment to see what went through.`,
                )
                setBulkBusy(false)
                setChecklistResetKey((k) => k + 1)
              },
            })
          }
        } else {
          const r = await bulkStatus(checkedIds, action)
          setBulkNote(`${r.changed} moved to ${statusLabel(action)}`)
        }
        setCheckedIds([])
        setChecklistResetKey((k) => k + 1)
      } catch (e) {
        polling = false
        setBulkNote(e instanceof Error ? e.message : 'Action failed')
      } finally {
        // The poll owns `bulkBusy` from here when one is running: the bar must
        // stay disabled until the job settles, not just until the POST returns.
        if (!polling) setBulkBusy(false)
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
            {formatEventDateRange(me.event.starts_at, me.event.ends_at, me.event.timezone)}
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
        <AdminErrorBoundary section={NAV_ITEMS.find((i) => i.key === view)?.label ?? view} resetKey={`${view}:${me.event.id}`}>
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
              defaultTabs={['speakers', 'submissions', 'tasks', 'messages', 'files', 'events']}
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
        ) : view === 'embeds' && !isReviewer ? (
          <div className="section-with-event" key={me.event.id}>
            <EventScopeNote scope={scope} />
            <EmbedsSection me={me} />
          </div>
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
        </AdminErrorBoundary>
      </main>
    </div>
    </EventScopeProvider>
  )
}

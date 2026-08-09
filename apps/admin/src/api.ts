// Typed fetch client for the Worker's /app/api endpoints. Same-origin cookie
// auth; a 401 means the session died, so the SPA reloads /app and the Worker
// serves its login page.

import type { DataSourceParams, DataSourceResult } from './components/DataList'

export interface MeEvent {
  id: string
  name: string
  slug: string
  starts_at: string
  ends_at: string
}

export interface Me {
  email: string
  role: string
  event: MeEvent & { timezone: string }
  events: MeEvent[]
}

export interface ContactRow {
  id: string
  event_id: string
  /** present when the workspace queries span events (event-as-filter model) */
  event_name?: string | null
  email: string
  first_name: string | null
  last_name: string | null
  company: string | null
  job_title: string | null
  mobile_phone: string | null
  biography: string | null
  pronouns: string | null
  /** Served via `/files/<id>` — an authenticated admin session has fileAuth
   * access. `c.*` in the contacts resource query already selects this; it
   * was just missing from this interface (W2-E). */
  headshot_asset_id: string | null
  /** organiser-only; never rendered in portal/public surfaces */
  notes: string | null
  /** SPK-15: `{ <contact_field_definitions.key>: value }` json text for this
   * contact's event, or null when it has no custom-field values set. */
  custom_fields_json?: string | null
  /** SPK-04: 'confirmed' (has a confirmed submission_participants row),
   * 'awaiting' (a participant somewhere, none confirmed), or null/absent
   * when the contact is not a submission participant at all. */
  confirmation?: 'confirmed' | 'awaiting' | null
  created_at: string
  updated_at: string
}

export interface SubmissionRow {
  id: string
  event_id: string
  /** present when the workspace queries span events (event-as-filter model) */
  event_name?: string | null
  code: string
  title: string
  description: string | null
  status: string
  format: string | null
  level: string | null
  language: string | null
  track_id: string | null
  track_name: string | null
  submitter_contact_id: string | null
  submitter_name: string | null
  /** organiser-only; never rendered in portal/public surfaces */
  notes: string | null
  /** CNT-12/w3 public-feed visibility gate, independent of `status` — default 1. See 0010 migration. */
  content_approved: number
  created_at: string
  updated_at: string
}

/**
 * `details` carries the parsed error body (F13: duplicate-contact recovery
 * needs `existing_id` off `{ error: 'email_exists', existing_id }`, not just
 * the human-readable message `readableError` renders).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    // Only JSON bodies get the header: a FormData body must keep the
    // browser-generated multipart boundary (the import upload path).
    headers: {
      accept: 'application/json',
      ...(typeof init?.body === 'string' ? { 'content-type': 'application/json' } : {}),
    },
    ...init,
  })
  if (res.status === 401) {
    // Session expired: hand back to the Worker's login page.
    window.location.assign('/app')
    throw new ApiError('Signed out', 401)
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const code = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
    throw new ApiError(readableError(code), res.status, body ?? undefined)
  }
  return body as T
}

const ERROR_MESSAGES: Record<string, string> = {
  email_exists: 'A contact with this email already exists for this event.',
  email_required: 'An email address is required.',
  not_found: 'The record no longer exists.',
  conflict: 'This record changed in another session — reload to pick up the latest version before saving again.',
  invite_notify_required: 'This session has live calendar invites — choose whether to notify speakers before moving it.',
}

function readableError(code: string): string {
  return ERROR_MESSAGES[code] ?? `The server rejected the request (${code}).`
}

export const getMe = () => request<Me>('/app/api/me')

export const switchEvent = (eventId: string) =>
  request<{ ok: boolean }>('/app/api/switch-event', {
    method: 'POST',
    body: JSON.stringify({ event_id: eventId }),
  })

// ---------------------------------------------------------------------------
// Events (FR-EVT-1/2: create; agenda publish flag rides the same PATCH)
// ---------------------------------------------------------------------------

/** A repeatable Rooms/Tracks row from the create-event dialog or the settings
 * editor. Blank rows are dropped server-side, so the client never needs to
 * pre-filter an in-progress "add another" row. */
export interface RoomDraft {
  name: string
  capacity?: number | null
}

export interface TrackDraft {
  name: string
  color?: string | null
}

export interface CreateEventInput {
  name: string
  slug: string
  type?: string
  website_url?: string | null
  location?: string | null
  timezone?: string
  starts_at: string
  ends_at: string
  description?: string | null
  rooms?: RoomDraft[]
  tracks?: TrackDraft[]
}

export const createEvent = (data: CreateEventInput) =>
  request<{ ok: boolean; id: string }>('/app/api/events', { method: 'POST', body: JSON.stringify(data) })

/** A row of the workspace Events tab (W2-E) — GET /app/api/events. */
export interface EventListRow {
  id: string
  name: string
  slug: string
  starts_at: string
  ends_at: string
  agenda_published: boolean
  role: string
  speaker_count: number
  submission_count: number
}

/** The org's accessible events (event-as-filter model), each with cheap counts. */
export const getEvents = () => request<{ items: EventListRow[] }>('/app/api/events')

export const patchEvent = (id: string, patch: { agenda_published?: boolean } & Record<string, unknown>) =>
  request<{ ok: boolean }>(`/app/api/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })

/** Agenda go-live control (FR-AGENDA-9) — thin wrapper over the events PATCH. */
export const setAgendaPublished = (eventId: string, published: boolean) =>
  patchEvent(eventId, { agenda_published: published })

// ---------------------------------------------------------------------------
// Rooms & tracks CRUD (deferred-gap item: create/rename/delete for the event's
// rooms and tracks — the agenda builder's Add Session dialog needs real
// options, not just "No room"/"No track").
// ---------------------------------------------------------------------------

export interface RoomRow {
  id: string
  event_id: string
  name: string
  capacity: number | null
  position: number
  notes: string | null
}

export interface TrackRow {
  id: string
  event_id: string
  name: string
  color: string | null
  position: number
}

export const listRooms = () => request<{ items: RoomRow[] }>('/app/api/rooms')
export const createRoom = (data: { name: string; capacity?: number | null; notes?: string | null }) =>
  request<RoomRow>('/app/api/rooms', { method: 'POST', body: JSON.stringify(data) })
export const updateRoom = (id: string, data: Record<string, unknown>) =>
  request<RoomRow>(`/app/api/rooms/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteRoom = (id: string) =>
  request<{ ok: boolean }>(`/app/api/rooms/${id}`, { method: 'DELETE' })

export const listTracks = () => request<{ items: TrackRow[] }>('/app/api/tracks')
export const createTrack = (data: { name: string; color?: string | null }) =>
  request<TrackRow>('/app/api/tracks', { method: 'POST', body: JSON.stringify(data) })
export const updateTrack = (id: string, data: Record<string, unknown>) =>
  request<TrackRow>(`/app/api/tracks/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteTrack = (id: string) =>
  request<{ ok: boolean }>(`/app/api/tracks/${id}`, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Contact custom fields (SPK-15): per-event field definitions for the
// Speakers tab. `options` travels as a JSON-encoded string[] (only meaningful
// when type is 'select') — same wire shape D1 stores it in.
// ---------------------------------------------------------------------------

export interface ContactFieldDef {
  id: string
  event_id: string
  key: string
  label: string
  type: 'text' | 'select' | 'multiline'
  options: string | null
  position: number
}

export const listContactFields = () => request<{ items: ContactFieldDef[] }>('/app/api/contact-fields')
export const createContactField = (data: { label: string; type: ContactFieldDef['type']; options?: string[] | null }) =>
  request<ContactFieldDef>('/app/api/contact-fields', { method: 'POST', body: JSON.stringify(data) })
export const updateContactField = (id: string, data: Record<string, unknown>) =>
  request<ContactFieldDef>(`/app/api/contact-fields/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteContactField = (id: string) =>
  request<{ ok: boolean }>(`/app/api/contact-fields/${id}`, { method: 'DELETE' })
export const reorderContactFields = (ids: string[]) =>
  request<{ items: ContactFieldDef[] }>('/app/api/contact-fields/reorder', { method: 'POST', body: JSON.stringify({ ids }) })

// ---------------------------------------------------------------------------
// Tasks CRUD (deferred-gap item: tasks were read-only in admin)
// ---------------------------------------------------------------------------

export interface TaskRow {
  id: string
  event_id: string
  title: string
  description: string | null
  target: 'contact' | 'group' | 'submission'
  assignment_mode: 'manual' | 'automatic'
  trigger: 'on_accept' | 'on_schedule' | 'none'
  action_type: 'file_upload' | 'portal_form' | 'acknowledge' | 'external_link'
  due_at: string | null
  required: number
  created_at: string
}

export const createTask = (data: Record<string, unknown>) =>
  request<TaskRow>('/app/api/tasks', { method: 'POST', body: JSON.stringify(data) })

export const updateTask = (id: string, data: Record<string, unknown>) =>
  request<TaskRow>(`/app/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) })

export const deleteTask = (id: string) =>
  request<{ ok: boolean }>(`/app/api/tasks/${id}`, { method: 'DELETE' })

/** Internal notes (organiser-only) — narrow write path for submissions. */
export const updateSubmissionNotes = (id: string, notes: string | null) =>
  request<{ ok: boolean }>(`/app/api/submissions/${id}/notes`, {
    method: 'PUT',
    body: JSON.stringify({ notes }),
  })

// ---------------------------------------------------------------------------
// Bulk jobs (sweep item P2-19): bulk sends return 202 { job_id }
// ---------------------------------------------------------------------------

export interface BulkJobStatus {
  id: string
  kind: string
  status: 'pending' | 'running' | 'done' | 'failed'
  total: number | null
  enqueued: number
  sent: number
  failed: number
  error: string | null
}

export const getBulkJob = (id: string) => request<BulkJobStatus>(`/app/api/bulk-jobs/${id}`)

export interface MessageRow {
  id: string
  template_key: string | null
  to_email: string
  contact_id: string | null
  contact_name: string | null
  subject: string | null
  status: string
  error: string | null
  created_at: string
  sent_at: string | null
}

/** DataList-compatible data source for the generic query endpoint. */
export const queryResource =
  <T>(resource: 'contacts' | 'submissions' | 'messages' | 'tasks') =>
  (params: DataSourceParams): Promise<DataSourceResult<T>> =>
    request<DataSourceResult<T>>(`/app/api/${resource}/query`, {
      method: 'POST',
      body: JSON.stringify(params),
    })

export const createContact = (data: Record<string, unknown>) =>
  request<ContactRow>('/app/api/contacts', { method: 'POST', body: JSON.stringify(data) })

export const updateContact = (id: string, data: Record<string, unknown>) =>
  request<ContactRow>(`/app/api/contacts/${id}`, { method: 'PUT', body: JSON.stringify(data) })

export const deleteContact = (id: string) =>
  request<{ ok: boolean }>(`/app/api/contacts/${id}`, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Form builder (docs/04)
// ---------------------------------------------------------------------------

export interface FormRow {
  id: string
  internal_name: string
  external_title: string | null
  page_heading: string | null
  welcome_message: string | null
  welcome_message_visible: number
  collection_type: 'abstracts' | 'sessions'
  collect_participants: number
  status: 'open' | 'closed'
  close_at: string | null
  submission_limit: number | null
  allow_multiple_drafts: number
  success_message: string | null
  auto_redirect_to_portal: number
  /** parsed json in responses (server normalises); send objects back */
  routing_rules: Record<string, unknown> | null
  participant_roles: Array<{ role: string; min: number; max: number | null }> | null
  confirmation_email_enabled: number
  created_at: string
  updated_at: string
  submission_count?: number
  draft_count?: number
}

export interface FormQuestion {
  id: string
  form_id: string
  section: 'abstract' | 'participant'
  position: number
  required: boolean
  locked: boolean
  label: string
  help_text: string | null
  options: Array<{ value: string; label: string; color?: string }> | null
  max_chars: number | null
  visibility: Record<string, unknown> | null
  field_id: string
  field_key: string
  type: string
}

export interface BuilderMeta {
  fields: Array<{ id: string; key: string; label: string; type: string; scope: string; options: string | null; max_chars: number | null; system: number }>
  tracks: Array<{ id: string; name: string; color: string | null }>
  tags: Array<{ id: string; name: string; color: string | null }>
  plans: Array<{ id: string; name: string; status: string }>
}

export interface FormWithQuestions {
  form: FormRow
  questions: FormQuestion[]
}

export const listForms = () => request<{ items: FormRow[] }>('/app/api/forms')
export const createForm = (data: Record<string, unknown>) =>
  request<FormWithQuestions>('/app/api/forms', { method: 'POST', body: JSON.stringify(data) })
export const getFormDetail = (id: string) => request<FormWithQuestions>(`/app/api/forms/${id}`)
export const updateForm = (id: string, patch: Record<string, unknown>) =>
  request<{ form: FormRow }>(`/app/api/forms/${id}`, { method: 'PUT', body: JSON.stringify(patch) })
export const deleteForm = (id: string) =>
  request<{ ok: boolean }>(`/app/api/forms/${id}`, { method: 'DELETE' })
export const duplicateForm = (id: string) =>
  request<FormWithQuestions>(`/app/api/forms/${id}/duplicate`, { method: 'POST', body: JSON.stringify({}) })
export const addQuestion = (formId: string, body: Record<string, unknown>) =>
  request<{ questions: FormQuestion[] }>(`/app/api/forms/${formId}/questions`, { method: 'POST', body: JSON.stringify(body) })
export const updateQuestion = (formId: string, qid: string, patch: Record<string, unknown>) =>
  request<{ questions: FormQuestion[] }>(`/app/api/forms/${formId}/questions/${qid}`, { method: 'PUT', body: JSON.stringify(patch) })
export const deleteQuestion = (formId: string, qid: string) =>
  request<{ questions: FormQuestion[] }>(`/app/api/forms/${formId}/questions/${qid}`, { method: 'DELETE' })
export const reorderQuestions = (formId: string, section: string, ids: string[]) =>
  request<{ questions: FormQuestion[] }>(`/app/api/forms/${formId}/questions/reorder`, {
    method: 'POST',
    body: JSON.stringify({ section, ids }),
  })
export const getBuilderMeta = () => request<BuilderMeta>('/app/api/builder-meta')

// ---------------------------------------------------------------------------
// Review & scoring (docs/06, M3)
// ---------------------------------------------------------------------------

export interface TaskAssignmentRow {
  id: string
  status: 'not_started' | 'in_progress' | 'complete'
  completed_at: string | null
  submission_id: string | null
  contact_id: string
  task_id: string
  task_title: string
  action_type: string
  due_at: string | null
  required: number
  assignee_name: string | null
  assignee_email: string
  submission_code: string | null
  submission_title: string | null
}

export interface SubmissionDetail {
  submission: Record<string, unknown>
  answers: Array<{ label: string; value_json: string | null }>
  participants: Array<{
    /** submission_participants.id — the target for role changes/removal (F14). */
    participant_id: string
    role: string
    is_primary_contact: number
    /** Set once an organiser confirms this speaker's participation (SPK-04/w2); null = awaiting. */
    confirmed_at: string | null
    contact_id: string
    first_name: string | null
    last_name: string | null
    email: string
    has_bio: number
    has_headshot: number
    headshot_asset_id: string | null
  }>
  reviews: Array<{ reviewer_name: string | null; weighted_total: number | null; comment: string | null; conflict_of_interest: number }>
  tags: string[]
}

/**
 * Role vocabulary for submission_participants (F14/ABS-11) — must track the
 * CHECK constraint in packages/db/migrations/0008_participant_roles.sql and
 * @kms/core's ALL_PARTICIPANT_ROLES. Duplicated here (rather than importing
 * @kms/core into the admin bundle) the same way SUBMISSION_STATUSES-style
 * vocabularies already live client-side in workspace/extras.tsx.
 */
export const PARTICIPANT_ROLES = ['speaker', 'co-speaker', 'moderator', 'panelist', 'co-author', 'co-presenter'] as const

export interface EvaluationOverview {
  plans: Array<{ id: string; name: string; description: string | null; status: string; anonymise_submitters: number; scoring_scale_min: number; scoring_scale_max: number }>
  criteria: Array<{ id: string; plan_id: string; name: string; description: string | null; weight: number; position: number }>
  reviewers: Array<{ id: string; email: string; name: string | null }>
  stats: Array<{ plan_id: string; submissions: number; assignments: number; completed: number }>
}

export interface ReviewQueue {
  assignments: Array<Record<string, unknown>>
  criteria: Record<string, Array<{ id: string; name: string; description: string | null; weight: number }>>
  participants: Record<string, Array<{ name: string | null; role: string }>>
}

export const updateSubmissionStatus = (id: string, status: string) =>
  request<{ ok: boolean }>(`/app/api/submissions/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) })
export const bulkStatus = (ids: string[], status: string) =>
  request<{ ok: boolean; changed: number }>('/app/api/submissions/bulk-status', {
    method: 'POST',
    body: JSON.stringify({ ids, status }),
  })
export const sendDecisions = (ids: string[]) =>
  request<{
    ok: boolean
    accepted: number
    declined: number
    tasks_assigned: number
    skipped: number
    skipped_notified: number
    /** CFP-14: null when nothing was in a decision queue; poll it for real sent/failed counts. */
    job_id: string | null
  }>(
    '/app/api/submissions/send-decisions',
    { method: 'POST', body: JSON.stringify({ ids }) },
  )
export const getSubmissionDetail = (id: string) => request<SubmissionDetail>(`/app/api/submissions/${id}/detail`)

// ---------------------------------------------------------------------------
// Submission edit + participants (F14/ABS-11): the fuller edit surface — the
// admin edit form previously only reached title/description/format via the
// notes/status side-channels; this is the general field PUT plus the
// add/change-role/remove-participant endpoints that let an organiser attach
// a co-speaker (or co-author/co-presenter) retroactively.
// ---------------------------------------------------------------------------

export const createSubmission = (data: Record<string, unknown>) =>
  request<Record<string, unknown>>('/app/api/submissions', { method: 'POST', body: JSON.stringify(data) })

export const updateSubmission = (id: string, data: Record<string, unknown>) =>
  request<Record<string, unknown>>(`/app/api/submissions/${id}`, { method: 'PUT', body: JSON.stringify(data) })

export const addSubmissionParticipant = (
  submissionId: string,
  data: { contact_id: string; role: string; is_primary_contact?: boolean },
) =>
  request<{ ok: boolean; id: string }>(`/app/api/submissions/${submissionId}/participants`, {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const updateSubmissionParticipantRole = (submissionId: string, participantId: string, role: string) =>
  request<{ ok: boolean }>(`/app/api/submissions/${submissionId}/participants/${participantId}`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  })

export const removeSubmissionParticipant = (submissionId: string, participantId: string) =>
  request<{ ok: boolean }>(`/app/api/submissions/${submissionId}/participants/${participantId}`, {
    method: 'DELETE',
  })

/**
 * SPK-04/w2: the dashboard's "Confirmed N / Awaiting confirmation M" stat
 * reads submission_participants.confirmed_at, which used to be set exactly
 * once (automatically, at submit time) with no way for an organiser to
 * change it afterwards. This is the missing control.
 */
export const setSubmissionParticipantConfirmed = (submissionId: string, participantId: string, confirmed: boolean) =>
  request<{ ok: boolean; confirmed: boolean }>(
    `/app/api/submissions/${submissionId}/participants/${participantId}/confirm`,
    { method: 'PUT', body: JSON.stringify({ confirmed }) },
  )

// ---------------------------------------------------------------------------
// Files: version chains and comment threads (lane W2-C)
// ---------------------------------------------------------------------------

export interface FileVersion {
  upload_id: string
  file_request_id: string
  contact_id: string
  submission_id: string | null
  file_asset_id: string
  uploaded_at: string
  version: number
  is_current: number
  filename: string
  content_type: string | null
  size_bytes: number | null
  uploader_name: string | null
  uploader_email: string | null
}

export interface FileComment {
  id: string
  file_request_upload_id: string
  file_asset_id: string
  author_contact_id: string | null
  author_role: string
  author_name: string | null
  body: string
  created_at: string
  version: number
}

export interface FileChain {
  versions: FileVersion[]
  comments: FileComment[]
}

/** One row per chain (current version) for the files library / per-submission tab. */
export interface FileLibraryRow extends FileVersion {
  event_id: string
  request_title: string | null
  submission_code: string | null
  submission_title: string | null
  version_count: number
  comment_count: number
}

const fileQuery = (params: Record<string, string | number | undefined>): string => {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export const getFileLibrary = (params: {
  submission_id?: string
  contact_id?: string
  event_id?: string
  q?: string
  from?: number
  size?: number
} = {}) => request<{ items: FileLibraryRow[]; total: number }>(`/app/api/files/library${fileQuery(params)}`)

export const getFileChain = (uploadId: string) => request<FileChain>(`/app/api/files/chains/${uploadId}`)

export const getTaskAssignmentFiles = (assignmentId: string) =>
  request<FileChain>(`/app/api/files/task-assignments/${assignmentId}`)

export const addFileComment = (uploadId: string, body: string) =>
  request<{ ok: boolean; id: string; comments: FileComment[] }>(`/app/api/files/uploads/${uploadId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })

export const getEvaluationOverview = () => request<EvaluationOverview>('/app/api/evaluation/overview')
export const createPlan = (name: string) =>
  request<{ ok: boolean; id: string }>('/app/api/evaluation/plans', { method: 'POST', body: JSON.stringify({ name }) })
export const updatePlan = (id: string, patch: Record<string, unknown>) =>
  request<{ ok: boolean }>(`/app/api/evaluation/plans/${id}`, { method: 'PUT', body: JSON.stringify(patch) })
export const addCriterion = (planId: string, body: Record<string, unknown>) =>
  request<{ ok: boolean }>(`/app/api/evaluation/plans/${planId}/criteria`, { method: 'POST', body: JSON.stringify(body) })
export const updateCriterion = (id: string, patch: Record<string, unknown>) =>
  request<{ ok: boolean }>(`/app/api/evaluation/criteria/${id}`, { method: 'PUT', body: JSON.stringify(patch) })
export const deleteCriterion = (id: string) =>
  request<{ ok: boolean }>(`/app/api/evaluation/criteria/${id}`, { method: 'DELETE' })
export const assignReviewers = (planId: string, body: Record<string, unknown>) =>
  request<{ ok: boolean; total_assignments: number; submissions: number }>(
    `/app/api/evaluation/plans/${planId}/assign`,
    { method: 'POST', body: JSON.stringify(body) },
  )

// ---------------------------------------------------------------------------
// Agenda & scheduling (docs/07, M4)
// ---------------------------------------------------------------------------

export interface AgendaRoom {
  id: string
  name: string
  capacity: number | null
  position: number
}

export interface AgendaTrack {
  id: string
  name: string
  color: string | null
  position: number
}

export interface AgendaSessionRow {
  id: string
  code: string
  title: string
  description: string | null
  format: string | null
  level: string | null
  capacity: number | null
  track_id: string | null
  room_id: string | null
  starts_at: string | null
  ends_at: string | null
  updated_at: string
  /** 1 when a live METHOD:REQUEST calendar invite exists */
  invited: number
  speakers: Array<{ contact_id: string; name: string }>
}

export interface AgendaConflictRow {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  session_ids: string[]
  contact_id?: string
  signature: string
  ignored: boolean
}

export interface AgendaPayload {
  event: {
    id: string
    name: string
    slug: string
    timezone: string
    starts_at: string
    ends_at: string
    location: string | null
    agenda_published: number
  }
  rooms: AgendaRoom[]
  tracks: AgendaTrack[]
  sessions: AgendaSessionRow[]
  conflicts: AgendaConflictRow[]
}

export interface SchedulePatch {
  starts_at: string | null
  ends_at: string | null
  room_id: string | null
  capacity?: number | null
  notify?: 'confirmed' | 'changed' | 'cancelled'
  /** operator saw the invite prompt and explicitly declined to notify */
  notify_ack?: boolean
}

export const getAgenda = () => request<AgendaPayload>('/app/api/agenda')
export const scheduleSession = (id: string, body: SchedulePatch) =>
  request<AgendaPayload & { ok: boolean; notified: number }>(`/app/api/agenda/sessions/${id}/schedule`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
export const addAgendaSession = (body: Record<string, unknown>) =>
  request<AgendaPayload & { ok: boolean; id: string }>('/app/api/agenda/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  })
export const sendScheduleConfirmations = () =>
  request<AgendaPayload & { ok: boolean; sent_sessions: number; queued: number; job_id?: string }>('/app/api/agenda/send-confirmations', {
    method: 'POST',
    body: JSON.stringify({}),
  })
export const setConflictIgnored = (signature: string, ignored: boolean) =>
  request<AgendaPayload & { ok: boolean }>('/app/api/agenda/conflicts/ignore', {
    method: 'POST',
    body: JSON.stringify({ signature, ignored }),
  })
export const removeSessionSpeaker = (sessionId: string, contactId: string) =>
  request<AgendaPayload & { ok: boolean }>(`/app/api/agenda/sessions/${sessionId}/speakers/${contactId}`, {
    method: 'DELETE',
  })

// ---------------------------------------------------------------------------
// Dashboards (docs/09, M5)
// ---------------------------------------------------------------------------

export interface DashboardNudge {
  key: 'unscheduled' | 'pending' | 'staged' | 'assets' | 'outstanding' | 'overdue' | 'conflicts'
  count: number
  text: string
}

export interface DashboardPayload {
  now: string
  event: { id: string; name: string; slug: string; timezone: string; starts_at: string; ends_at: string }
  kpis: { submissions: number; accepted_speakers: number }
  status_tiles: { accepted: number; pending: number; declined: number; drafts: number; withdrawn: number }
  nudges: DashboardNudge[]
  forms: {
    forms: Array<{ id: string; internal_name: string; status: string; close_at: string | null; submission_count: number; draft_count: number }>
    recent: Array<{ id: string; code: string; title: string; status: string; source: string; created_at: string; track_name: string | null; submitter_name: string | null }>
    pacing: Array<{ day: string; count: number; cumulative: number }>
  }
  participants: {
    by_role: Array<{ role: string; n: number }>
    status_mix: Array<{ kind: string; status: string; n: number }>
  }
  evaluations: {
    reviewers: Array<{ name: string | null; email: string; assigned: number; completed: number }>
    reviews: number
    evaluated_submissions: number
    in_progress: number
    plans: Array<{ name: string; n: number }>
  }
  agenda: {
    scheduled: number
    unscheduled: number
    per_day: Array<{ day: string; count: number }>
    per_room: Array<{ room: string; count: number }>
    conflicts: { error: number; warning: number; info: number }
  }
  tracking: {
    accepted_speakers: number
    outstanding_tasks: number
    confirmation: { confirmed: number; awaiting: number }
    top_speakers: Array<{ contact_id: string; name: string; outstanding: number; overdue: number }>
    overdue: Array<{ assignment_id: string; contact_id: string; name: string; task_title: string; due_at: string; days_overdue: number }>
    assets: Array<{ contact_id: string; name: string; missing_bio: number; missing_headshot: number; missing_slides: number }>
  }
  pipeline: {
    total: number
    pending_review: number
    by_form: Array<{ name: string; count: number }>
    by_track: Array<{ name: string; count: number }>
    funnel: { received: number; reviewed: number; decided: number; accepted: number; scheduled: number }
  }
}

/**
 * ETag-aware poll: pass the previous etag and a 304 comes back as
 * { fresh: false } without a payload (docs/09 §7).
 */
export async function fetchDashboard(
  etag: string | null,
): Promise<{ fresh: true; payload: DashboardPayload; etag: string | null } | { fresh: false }> {
  const res = await fetch('/app/api/dashboard', {
    headers: { accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) },
  })
  if (res.status === 304) return { fresh: false }
  if (res.status === 401) {
    window.location.assign('/app')
    throw new ApiError('Signed out', 401)
  }
  if (!res.ok) throw new ApiError(`The server rejected the request (HTTP ${res.status}).`, res.status)
  return { fresh: true, payload: (await res.json()) as DashboardPayload, etag: res.headers.get('etag') }
}

export const remindTasks = (assignmentIds?: string[]) =>
  request<{ ok: boolean; sent: number; skipped: number; job_id?: string; total?: number }>('/app/api/dashboard/remind', {
    method: 'POST',
    body: JSON.stringify(assignmentIds ? { assignment_ids: assignmentIds } : {}),
  })

// ---------------------------------------------------------------------------
// Settings: API tokens + demo reset (docs/10 §1, M6)
// ---------------------------------------------------------------------------

export interface ApiTokenRow {
  id: string
  name: string
  token_prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export const listTokens = () => request<{ tokens: ApiTokenRow[] }>('/app/api/tokens')
export const createToken = (name: string) =>
  request<{ id: string; name: string; token: string; token_prefix: string }>('/app/api/tokens', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const revokeToken = (id: string) =>
  request<{ ok: boolean }>(`/app/api/tokens/${id}`, { method: 'DELETE' })
export const resetDemoData = () =>
  request<{ ok: boolean; statements: number }>('/app/api/demo/reset', { method: 'POST', body: JSON.stringify({}) })

/**
 * Export URL against the public REST API (session cookie authorises the
 * first-party request). The workspace passes the tab's live merged filters,
 * so the file contains exactly what the grid shows (docs/09 §10 test 7).
 */
export function buildExportUrl(
  eventId: string,
  resource: 'contacts' | 'submissions' | 'tasks' | 'messages',
  format: 'csv' | 'xlsx',
  filters: Record<string, unknown>,
  sort?: { field: string; direction: 'asc' | 'desc' },
): string {
  const params = new URLSearchParams({ format })
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '' || value === false) continue
    params.set(key, String(value))
  }
  if (sort) params.set('sort', sort.direction === 'desc' ? `-${sort.field}` : sort.field)
  return `/api/v1/events/${eventId}/${resource}/export?${params.toString()}`
}

export const getReviewQueue = () => request<ReviewQueue>('/app/api/review/queue')
export const saveReview = (assignmentId: string, body: Record<string, unknown>) =>
  request<{ ok: boolean; weighted_total: number | null; submission_rating: number | null }>(
    `/app/api/review/assignments/${assignmentId}`,
    { method: 'POST', body: JSON.stringify(body) },
  )

// ---------------------------------------------------------------------------
// Import wizard + files bundle (FR-REV-8)
// ---------------------------------------------------------------------------

export type ImportTarget = 'sessions' | 'contacts'
export type ImportRowAction = 'create' | 'update' | 'merge' | 'skip' | 'error'

export interface ImportField {
  key: string
  label: string
  aliases?: string[]
  required?: boolean
  hint?: string
}

export interface ImportPlanRow {
  row: number
  action: ImportRowAction
  message: string | null
  errors: string[]
  label: string
  values: Record<string, string>
  targetId: string | null
  mergeFields: string[] | null
}

export interface ImportPlan {
  target: ImportTarget
  headers: string[]
  mapping: string[]
  rows: ImportPlanRow[]
  summary: Record<ImportRowAction | 'total', number>
  newTracks: string[]
  newRooms: string[]
  unmapped: string[]
  /** the parsed grid, posted back on re-map and commit so nothing re-uploads */
  rows_raw: string[][]
  fields: ImportField[]
  event_id: string
}

/** First pass: upload the file, auto-map its headers and dry-run the result. */
export async function importPreviewFile(
  target: ImportTarget,
  eventId: string,
  file: File,
): Promise<ImportPlan> {
  const form = new FormData()
  form.set('target', target)
  form.set('event_id', eventId)
  form.set('file', file)
  return request<ImportPlan>('/app/api/import/preview', { method: 'POST', body: form })
}

/** Re-run the dry run after the organiser edits the column mapping. */
export const importPreviewMapping = (
  target: ImportTarget,
  eventId: string,
  headers: string[],
  rows: string[][],
  mapping: string[],
) =>
  request<ImportPlan>('/app/api/import/preview', {
    method: 'POST',
    body: JSON.stringify({ target, event_id: eventId, headers, rows, mapping }),
  })

export const importCommit = (
  target: ImportTarget,
  eventId: string,
  headers: string[],
  rows: string[][],
  mapping: string[],
) =>
  request<{ ok: boolean; summary: Record<string, number>; applied: Record<string, number> }>(
    '/app/api/import/commit',
    {
      method: 'POST',
      body: JSON.stringify({ target, event_id: eventId, headers, rows, mapping }),
    },
  )

/**
 * ZIP of the current version of every file attached to the selected
 * submissions. POST (a grid selection is unbounded) with a blob download, so
 * this cannot go through `request`, which expects JSON.
 */
export async function downloadFilesBundle(submissionIds: string[]): Promise<number> {
  const res = await fetch('/app/api/export/files.zip', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ submission_ids: submissionIds }),
  })
  if (res.status === 401) {
    window.location.assign('/app')
    throw new ApiError('Signed out', 401)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(
      body?.error === 'no_files'
        ? 'None of the selected submissions has a file attached.'
        : body?.error === 'bundle_too_large'
          ? 'That selection is too large to bundle — download it in smaller batches.'
          : readableError(body?.error ?? `HTTP ${res.status}`),
      res.status,
    )
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'submission-files.zip'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
  return Number(res.headers.get('x-bundle-entries') ?? 0)
}

// ---------------------------------------------------------------------------
// Messaging (routes/messagingAdmin.ts): organiser-triggered sends — the
// portal invite (SPK-06), the compose flow (SPK-13) and the per-event
// template overrides behind every system email (SPK-14).
// ---------------------------------------------------------------------------

/** SPK-06: mint a portal magic link for a contact and email it to them. */
export const invitePortal = (contactId: string) =>
  request<{ ok: boolean; outcome: 'queued' | 'duplicate' | 'template_disabled' }>(
    '/app/api/messaging/invite-portal',
    { method: 'POST', body: JSON.stringify({ contact_id: contactId }) },
  )

export type ComposeAudience = 'all_contacts' | 'speakers' | 'accepted_speakers' | 'selected'

export interface ComposeAudienceCount {
  audience: Exclude<ComposeAudience, 'selected'>
  count: number
}

export interface MergeField {
  field: string
  description: string
}

export const getComposeAudiences = () =>
  request<{ items: ComposeAudienceCount[]; merge_fields: MergeField[] }>('/app/api/messaging/compose/audiences')

/**
 * SPK-13: hand the server a subject/body and an audience; it snapshots a
 * bulk job and returns its id. Poll `getBulkJob(job_id)` for real sent/failed
 * counts — nothing was sent by the time this resolves.
 */
export const composeMessage = (payload: {
  subject: string
  body: string
  audience: ComposeAudience
  contact_ids?: string[]
}) =>
  request<{ ok: boolean; job_id: string; total: number; audience: ComposeAudience }>('/app/api/messaging/compose', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export interface EmailTemplateRow {
  key: string
  default_subject: string | null
  default_body: string | null
  subject: string | null
  body_richtext: string | null
  enabled: number
  overridden: boolean
  updated_at: string | null
}

export const listEmailTemplates = () =>
  request<{ items: EmailTemplateRow[]; merge_fields: MergeField[] }>('/app/api/messaging/templates')

/** Empty strings clear that half of the override, restoring the code default. */
export const updateEmailTemplate = (
  key: string,
  data: { subject?: string | null; body_richtext?: string | null; enabled?: boolean },
) =>
  request<{ ok: boolean; key: string; overridden: boolean; updated_at: string }>(
    `/app/api/messaging/templates/${key}`,
    { method: 'PUT', body: JSON.stringify(data) },
  )

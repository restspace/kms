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
  /** Contacts-hygiene item 2: `{linkedin, twitter, facebook, website}` json
   * text, same shape and column the portal profile (portal.ts's LINK_FIELDS)
   * already writes — the workspace speaker form just had no control for it.
   * `c.*` in the contacts resource query already selects this. */
  links?: string | null
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
  nothing_to_nudge: 'This speaker has no incomplete tasks to remind them about.',
  no_email: 'This speaker has no email address on file.',
  template_disabled: 'The task-reminder email template is disabled for this event.',
  conflict: 'This record changed in another session — reload to pick up the latest version before saving again.',
  invite_notify_required: 'This session has live calendar invites — choose whether to notify speakers before moving it.',
  already_on_event: 'They are already on this event.',
  other_events_not_accessible:
    'They also belong to events you do not administer, so they can only be removed from this one.',
  empty_body: 'A comment needs some text.',
  review_not_submitted: 'Post your review to join the discussion.',
  not_staged: 'This draft already left the inbox — reload to see its current state.',
  contact_has_no_email: 'This speaker has no email address on file.',
  rung_max: 'This chase is already at the top rung — the next step happens outside the tool.',
  rung_invalid: 'That escalation rung is not recognised.',
  status_invalid: 'That draft status is not recognised.',
  chase_mode_invalid: 'Chase mode must be "auto" or "assisted".',
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
  /** Messages this job wrote that are neither sent nor failed yet (delivery in
   * flight). Optional: older deployments of the worker omit it. */
  queued?: number
  error: string | null
  /** send-decisions only: accepted/declined submissions with no submitter contact to notify. */
  skipped_no_submitter?: number
  /** Recipients the idempotency key caught as already messaged (remind-tasks:
   *  already reminded today). Optional: older workers omit it. */
  skipped_duplicate?: number
  /** remind-tasks only: overdue assignments whose contact has no email on file. */
  skipped_no_email?: number
}

export const getBulkJob = (id: string) => request<BulkJobStatus>(`/app/api/bulk-jobs/${id}`)

export interface MessageRow {
  id: string
  template_key: string | null
  to_email: string
  contact_id: string | null
  contact_name: string | null
  subject: string | null
  /** Rendered per-recipient body (0029). Null on rows queued before body logging. */
  body_html: string | null
  body_text: string | null
  status: string
  error: string | null
  created_at: string
  sent_at: string | null
}

/** Re-queue one failed message (Messages tab detail panel's Retry button). */
export const retryMessage = (id: string) =>
  request<{ ok: boolean; status: string; error: string | null; sent_at: string | null }>(
    `/app/api/messaging/messages/${id}/retry`,
    { method: 'POST' },
  )

/** One reviews-resource row (workplan 13 W1a) — the committee's scores. */
export interface ReviewRow {
  id: string
  event_id: string
  event_name?: string | null
  submission_id: string
  submission_code: string
  submission_title: string
  reviewer_contact_id: string | null
  reviewer_name: string | null
  plan_id: string
  plan_name: string | null
  weighted_total: number | null
  /** Raw `{ criterion_id: score }` JSON text — deliberately not exploded into columns. */
  scores: string | null
  comment: string | null
  conflict_of_interest: number
  created_at: string
}

/** One comments-resource row (workplan 13 W1b) — the discussion threads. */
export interface CommentListRow {
  id: string
  event_id: string
  event_name?: string | null
  submission_id: string
  submission_code: string
  submission_title: string
  plan_id: string | null
  assignment_id: string | null
  author_contact_id: string | null
  author_role: string
  author_name: string | null
  kind: string
  body: string
  created_at: string
}

/** DataList-compatible data source for the generic query endpoint. */
export const queryResource =
  <T>(resource: 'contacts' | 'submissions' | 'messages' | 'tasks' | 'reviews' | 'comments') =>
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

/**
 * CNT-10: the organiser speaker edit form had no photo control — the only
 * way to set a headshot was the speaker's own portal profile page, which is
 * useless for a speaker who hasn't logged in. Mirrors `importPreviewFile`'s
 * FormData shape (a File body must keep its browser-generated multipart
 * boundary, never JSON-stringified) and lands on the same admin-only
 * endpoint adminApi.ts adds alongside the existing headshot-clear-on-delete
 * logic, which itself reuses portal.ts's `saveFile` storage seam.
 */
export const uploadContactHeadshot = (id: string, file: File) => {
  const form = new FormData()
  form.set('headshot', file)
  return request<{ ok: boolean; headshot_asset_id: string }>(`/app/api/contacts/${id}/headshot`, {
    method: 'POST',
    body: form,
  })
}

// ---------------------------------------------------------------------------
// Cross-event contact identity (workplan 5 §4). A contact is one person per
// ORGANISATION since 0015, with a per-event membership row carrying their
// profile — these three endpoints are the surfaces that model makes possible.
// ---------------------------------------------------------------------------

/** A picker row: org-level identity plus the profile the attach will seed. */
export interface OrgContactRow {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  /** From their most recent event in the org, not from this one — they have no
   * row for this one yet, which is the whole point of the search. */
  company: string | null
  job_title: string | null
}

/** People the organisation knows who are NOT already on the current event. */
export const searchOrgContacts = (q: string) =>
  request<{ items: OrgContactRow[] }>(`/app/api/contacts/org-search?q=${encodeURIComponent(q)}`)

/** Put an existing org contact on the current event, seeding their profile
 * from their most recent event in the same org. */
export const attachOrgContact = (id: string) =>
  request<ContactRow>(`/app/api/contacts/${id}/attach`, { method: 'POST' })

export interface ContactHistorySubmission {
  id: string
  event_id: string
  code: string
  title: string
  status: string
  starts_at: string | null
  room_name: string | null
  /** Their participant role, falling back to 'submitter'. */
  role: string | null
}

export interface ContactHistoryEvent {
  event_id: string
  event_name: string
  event_starts_at: string | null
  added_at: string | null
  source: string | null
  company: string | null
  job_title: string | null
  submissions: ContactHistorySubmission[]
}

/** The contact's history across the events this staff session can reach. The
 * server clips it to those — events the caller holds no seat on are absent
 * entirely, not summarised, so nothing here can disclose that they exist. */
export const getContactHistory = (id: string) =>
  request<{ events: ContactHistoryEvent[]; current_event_id: string }>(
    `/app/api/contacts/${id}/history`,
  )

/** Destroy the person org-wide, as distinct from `deleteContact`, which
 * detaches them from the current event. Answers 409 `confirm_required` with
 * the events that go with them until `confirm` is passed. */
export const deleteContactFromOrg = (id: string, confirm = false) =>
  request<{ ok: boolean; events_affected: number }>(
    `/app/api/contacts/${id}/org${confirm ? '?confirm=1' : ''}`,
    { method: 'DELETE' },
  )

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

/**
 * One row of a submission's discussion thread (workplan 7). Append-only —
 * there is no update or delete. kind='rationale' rows are review comments
 * posted at score-save time; kind='discussion' is everything else.
 */
export interface SubmissionComment {
  id: string
  submission_id: string
  plan_id: string | null
  assignment_id: string | null
  author_contact_id: string | null
  author_role: string
  author_name: string | null
  kind: string
  body: string
  created_at: string
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
  reviews: Array<{
    reviewer_name: string | null
    weighted_total: number | null
    conflict_of_interest: number
    plan_id: string
    plan_name: string | null
    created_at: string
  }>
  /** The discussion thread (workplan 7), oldest first — rationale rows included. */
  comments: SubmissionComment[]
  /** Per-round mean, additive alongside `reviews` (evaluation.ts's detail
   *  route) — the same AVG(weighted_total) grouping rating_cache keeps per
   *  plan_id, just also handed to the client so round-level results stay
   *  readable next to the (deliberately pooled) grid rating column. */
  review_plan_means: Array<{ plan_id: string; plan_name: string | null; mean: number; count: number }>
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
  criteria: Array<{ id: string; plan_id: string; name: string; description: string | null; weight: number; position: number; kind?: string; options?: string | null }>
  reviewers: Array<{ id: string; email: string; name: string | null }>
  stats: Array<{ plan_id: string; submissions: number; assignments: number; completed: number }>
}

export interface ReviewQueue {
  assignments: Array<Record<string, unknown>>
  criteria: Record<string, Array<{ id: string; name: string; description: string | null; weight: number; kind?: string; options?: string | null }>>
  participants: Record<string, Array<{ name: string | null; role: string }>>
}

export const updateSubmissionStatus = (id: string, status: string) =>
  request<{ ok: boolean }>(`/app/api/submissions/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) })
export const bulkStatus = (ids: string[], status: string) =>
  request<{ ok: boolean; changed: number }>('/app/api/submissions/bulk-status', {
    method: 'POST',
    body: JSON.stringify({ ids, status }),
  })
export const sendDecisions = (
  ids: string[],
  options?: {
    /** Workplan 10 Wave B: compute counts + speakers_with_pending without creating a job. */
    preflight?: boolean
    /** Workplan 10 Wave B: exclude these speakers' queued rows from a real send. */
    hold_contact_ids?: string[]
    /** Workplan 13 W3: opt-in per send — ask accepted speakers for employer
     * approval and flag their submissions approval_state='pending'. */
    approval_ask?: boolean
  },
) =>
  request<{
    ok: boolean
    accepted: number
    declined: number
    tasks_assigned: number
    skipped: number
    skipped_notified: number
    /** Submissions flipped without an email because no submitter contact/address exists. */
    skipped_no_submitter?: number
    /** Workplan 10 Wave B: echoes back whether this call was preflight-only. */
    preflight?: boolean
    /** Workplan 10 Wave B: count of queued rows excluded via hold_contact_ids. */
    held?: number
    /** Workplan 10 Wave B: speakers in this batch with other undecided submissions. */
    speakers_with_pending?: Array<{
      contact_id: string
      name: string
      pending_count: number
      pending_titles: string[]
    }>
    /** CFP-14: null when nothing was in a decision queue; poll it for real sent/failed counts. */
    job_id: string | null
  }>(
    '/app/api/submissions/send-decisions',
    { method: 'POST', body: JSON.stringify({ ids, ...options }) },
  )
export const getSubmissionDetail = (id: string) => request<SubmissionDetail>(`/app/api/submissions/${id}/detail`)

/** Workplan 13 W3 (D4): the employer-approval flag beside the status editor.
 * State null clears it back to "not asked"; 'refused' never auto-withdraws. */
export const updateSubmissionApproval = (
  id: string,
  body: { approval_state?: string | null; approval_note?: string | null },
) =>
  request<{ ok: boolean; approval_state: string | null; approval_note: string | null }>(
    `/app/api/submissions/${id}/approval`,
    { method: 'PUT', body: JSON.stringify(body) },
  )

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
  /**
   * Who actually performed the upload (file_assets.uploaded_by_contact_id) —
   * `uploader_*` above is the chain's contact (who the file is *for*). Both
   * views show uploaded_by first and fall back to the chain contact, so the
   * library row and the detail page can never disagree about attribution.
   */
  uploaded_by_name?: string | null
  uploaded_by_email?: string | null
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
  /**
   * The actual uploader (fa.uploaded_by_contact_id) — distinct from
   * `uploader_name`/`uploader_email` (FileVersion), which is the chain's
   * `contact_id` and, for headshots set from the admin side, is the subject
   * contact rather than whoever clicked upload (SPK-10).
   */
  uploaded_by_name: string | null
  uploaded_by_email: string | null
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

/**
 * Organiser-side upload (reuses the portal's storage machinery server-side).
 * Pass `upload_id` to append a new version to an existing chain, or
 * `submission_id` to start a new chain on that submission.
 */
export const uploadOrganiserFile = async (
  file: File,
  target: { upload_id?: string; submission_id?: string },
): Promise<{ ok: boolean; upload_id: string; version: number }> => {
  const form = new FormData()
  form.set('file', file)
  if (target.upload_id) form.set('upload_id', target.upload_id)
  if (target.submission_id) form.set('submission_id', target.submission_id)
  const res = await fetch('/app/api/files/uploads', { method: 'POST', body: form, credentials: 'same-origin' })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Upload failed (${res.status})`)
  }
  return res.json() as Promise<{ ok: boolean; upload_id: string; version: number }>
}

/** One pre-edit snapshot per content edit (title/description), newest first. */
export interface ContentRevision {
  id: string
  title: string
  description: string | null
  edited_by: string | null
  edited_by_name: string | null
  source: 'admin' | 'portal'
  edited_at: string
}

export const getSubmissionRevisions = (submissionId: string) =>
  request<{ items: ContentRevision[] }>(`/app/api/submissions/${submissionId}/revisions`)

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
  speakers: Array<{ contact_id: string; name: string; email?: string | null }>
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
    /** Workplan 13 W3: accepted talks awaiting employer approval, sorted by days-until-event ascending. */
    approval_pending: Array<{ submission_id: string; code: string; title: string; approval_note: string | null; contact_id: string | null; name: string; days_until_event: number }>
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
// Green room / run-of-show (workplan 12)
// ---------------------------------------------------------------------------

export interface GreenRoomSpeaker {
  name: string
  email: string
  mobile_phone: string | null
  arrived_at: string | null
  /** false → participant with no event_contacts row: readiness unknown, check-in refused. */
  on_roster: boolean
  missing_bio: number
  missing_headshot: number
  missing_slides: number
  outstanding: number
}

export interface GreenRoomSession {
  id: string
  code: string
  title: string
  format: string | null
  track_name: string | null
  room_id: string
  starts_at: string
  ends_at: string | null
  speaker_ids: string[]
}

export interface GreenRoomPayload {
  now: string
  event: { id: string; name: string; slug: string; timezone: string; starts_at: string; ends_at: string }
  rooms: Array<{ id: string; name: string }>
  sessions: GreenRoomSession[]
  speakers: Record<string, GreenRoomSpeaker>
}

/** ETag-aware poll, same contract as fetchDashboard: 304 → { fresh: false }. */
export async function fetchGreenRoom(
  etag: string | null,
): Promise<{ fresh: true; payload: GreenRoomPayload; etag: string | null } | { fresh: false }> {
  const res = await fetch('/app/api/greenroom', {
    headers: { accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) },
  })
  if (res.status === 304) return { fresh: false }
  if (res.status === 401) {
    window.location.assign('/app')
    throw new ApiError('Signed out', 401)
  }
  if (!res.ok) throw new ApiError(`The server rejected the request (HTTP ${res.status}).`, res.status)
  return { fresh: true, payload: (await res.json()) as GreenRoomPayload, etag: res.headers.get('etag') }
}

/** The write returns the whole refreshed payload plus its new etag. */
export const greenroomCheckin = (contactId: string, arrived: boolean) =>
  request<GreenRoomPayload & { ok: boolean; etag: string }>('/app/api/greenroom/checkin', {
    method: 'POST',
    body: JSON.stringify({ contact_id: contactId, arrived }),
  })

export const greenroomNudge = (contactId: string) =>
  request<{ ok: boolean; sent: number; duplicates: number }>('/app/api/greenroom/nudge', {
    method: 'POST',
    body: JSON.stringify({ contact_id: contactId }),
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
  resource: 'contacts' | 'submissions' | 'tasks' | 'messages' | 'reviews' | 'comments',
  format: 'csv' | 'xlsx',
  filters: Record<string, unknown>,
  sort?: { field: string; direction: 'asc' | 'desc' },
): string {
  return `/api/v1/events/${eventId}/${resource}/export?${exportParams(format, filters, sort)}`
}

/**
 * Export URL against the workspace query endpoint's export twin
 * (GET /app/api/:resource/export). Scoped the way the grids are: pass an
 * `event_id` filter to narrow to one event; omit it and the file spans every
 * accessible event — the "All events" export the REST endpoint cannot do.
 */
export function buildWorkspaceExportUrl(
  resource: 'contacts' | 'submissions' | 'tasks' | 'messages' | 'reviews' | 'comments',
  format: 'csv' | 'xlsx',
  filters: Record<string, unknown>,
  sort?: { field: string; direction: 'asc' | 'desc' },
): string {
  return `/app/api/${resource}/export?${exportParams(format, filters, sort)}`
}

function exportParams(
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
  return params.toString()
}

export const getReviewQueue = () => request<ReviewQueue>('/app/api/review/queue')
export const saveReview = (assignmentId: string, body: Record<string, unknown>) =>
  request<{ ok: boolean; weighted_total: number | null; submission_rating: number | null }>(
    `/app/api/review/assignments/${assignmentId}`,
    { method: 'POST', body: JSON.stringify(body) },
  )

// Submission discussion thread (workplan 7). The organiser posts against the
// submission; the reviewer reads/posts through their assignment, and the
// server answers 403 { error: 'review_not_submitted' } until the D3 gate
// (own review submitted, or round closed) opens.
export const addSubmissionComment = (id: string, body: string) =>
  request<{ ok: boolean; id: string; comments: SubmissionComment[] }>(`/app/api/submissions/${id}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
export const getAssignmentComments = (assignmentId: string) =>
  request<{ comments: SubmissionComment[] }>(`/app/api/review/assignments/${assignmentId}/comments`)
export const addAssignmentComment = (assignmentId: string, body: string) =>
  request<{ ok: boolean; id: string; comments: SubmissionComment[] }>(
    `/app/api/review/assignments/${assignmentId}/comments`,
    { method: 'POST', body: JSON.stringify({ body }) },
  )

// ---------------------------------------------------------------------------
// Import wizard + files bundle (FR-REV-8)
// ---------------------------------------------------------------------------

export type ImportTarget = 'sessions' | 'contacts'
export type ImportRowAction = 'create' | 'update' | 'merge' | 'attach' | 'skip' | 'error'
/** Workplan 11: chooses the source profile (header aliases, value normalisers,
 *  speaker-link semantics) applied inside `planSessions`/`planContacts`.
 *  Omitted on the wire = 'generic'. */
export type ImportSource = 'generic' | 'sessionboard'

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
  /** Workplan 11: top-level, plan-wide notes (e.g. "no Session ID column
   *  mapped — re-running this import will duplicate sessions"), distinct from
   *  the per-row `message`/`errors` already on `ImportPlanRow`. Absent on a
   *  plan with nothing to flag. */
  warnings?: string[]
}

/** First pass: upload the file, auto-map its headers and dry-run the result. */
export async function importPreviewFile(
  target: ImportTarget,
  eventId: string,
  file: File,
  source?: ImportSource,
): Promise<ImportPlan> {
  const form = new FormData()
  form.set('target', target)
  form.set('event_id', eventId)
  form.set('file', file)
  if (source) form.set('source', source)
  return request<ImportPlan>('/app/api/import/preview', { method: 'POST', body: form })
}

/** Re-run the dry run after the organiser edits the column mapping. */
export const importPreviewMapping = (
  target: ImportTarget,
  eventId: string,
  headers: string[],
  rows: string[][],
  mapping: string[],
  source?: ImportSource,
) =>
  request<ImportPlan>('/app/api/import/preview', {
    method: 'POST',
    body: JSON.stringify({ target, event_id: eventId, headers, rows, mapping, source }),
  })

export const importCommit = (
  target: ImportTarget,
  eventId: string,
  headers: string[],
  rows: string[][],
  mapping: string[],
  source?: ImportSource,
  /** Per-row actions from the dry run the user confirmed. The server re-plans
   *  and answers 409 `plan_changed` when the live data no longer produces this
   *  plan, instead of silently applying a different one. */
  expectedActions?: ImportRowAction[],
) =>
  request<{ ok: boolean; summary: Record<string, number>; applied: Record<string, number>; batchId: string }>(
    '/app/api/import/commit',
    {
      method: 'POST',
      body: JSON.stringify({
        target,
        event_id: eventId,
        headers,
        rows,
        mapping,
        source,
        ...(expectedActions ? { expected_actions: expectedActions } : {}),
      }),
    },
  )

/** Workplan 11 (G8): the event's import history for an "undo"/"report" affordance. */
export interface ImportBatch {
  id: string
  target: ImportTarget
  source: ImportSource
  filename: string | null
  created_at: string
  summary: Record<string, number>
  undone_at: string | null
}

export const listImportBatches = (eventId: string) =>
  request<{ batches: ImportBatch[] }>(`/app/api/import/batches?event_id=${encodeURIComponent(eventId)}`)

/** Deletes only the rows this batch *created*; updated/merged rows are left as-is
 *  (the confirm dialog at the call site must say so verbatim). */
export const undoImportBatch = (batchId: string, eventId: string) =>
  request<{ undone: { submissions: number; event_contacts: number; submission_participants: number } }>(
    `/app/api/import/batches/${batchId}/undo`,
    { method: 'POST', body: JSON.stringify({ event_id: eventId }) },
  )

/** CSV download of the batch's per-row action/message; plain link, not `request`
 *  (browser-navigated download, same reasoning as the `/files/<id>` links elsewhere). */
export const importBatchReportUrl = (batchId: string, eventId: string) =>
  `/app/api/import/batches/${batchId}/report.csv?event_id=${encodeURIComponent(eventId)}`

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

/**
 * SPK-06: mint a portal magic link for a contact and email it to them. The
 * server also hands back the minted `link` itself (bound to this contact),
 * so the caller can surface it for the organiser to copy/verify/impersonate
 * with — the same contract `sendReviewerSigninLink` has for reviewers.
 */
export const invitePortal = (contactId: string) =>
  request<{ ok: boolean; outcome: 'queued' | 'duplicate' | 'template_disabled'; link: string }>(
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

// ---------------------------------------------------------------------------
// Assisted chasing (workplan 13 W4): the reminder sweep stages drafts instead
// of sending, per D5/D6/D7 — the ladder is recorded, never automated, and a
// send always carries the acting organiser's address in Reply-To, never From.
// ---------------------------------------------------------------------------

export const CHASE_RUNGS = ['tool_email', 'personal_email', 'cc_chair', 'text', 'call'] as const
export type ChaseRung = (typeof CHASE_RUNGS)[number]
export type ChaseDraftStatus = 'staged' | 'sent' | 'dismissed' | 'resolved'

export interface ChaseDraftRow {
  id: string
  contact_id: string
  contact_email: string | null
  contact_name: string | null
  subject_of: string
  subject_id: string | null
  rung: ChaseRung
  status: ChaseDraftStatus
  subject: string
  body: string
  staged_at: string
  acted_at: string | null
  acted_by: string | null
}

/** Sorted by contact server-side for grouping; `status` defaults to 'staged'. */
export const getChaseDrafts = (params: { status?: ChaseDraftStatus; contact_id?: string } = {}) => {
  const qs = new URLSearchParams()
  if (params.status) qs.set('status', params.status)
  if (params.contact_id) qs.set('contact_id', params.contact_id)
  const s = qs.toString()
  return request<{ items: ChaseDraftRow[] }>(`/app/api/chase/drafts${s ? `?${s}` : ''}`)
}

export const updateChaseDraft = (id: string, data: { subject?: string; body?: string }) =>
  request<{ ok: boolean; item: ChaseDraftRow }>(`/app/api/chase/drafts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })

/** Queues the draft with the organiser's Reply-To (D6); 422 contact_has_no_email. */
export const sendChaseDraft = (id: string) =>
  request<{ ok: boolean; outcome: 'queued' | 'duplicate' }>(`/app/api/chase/drafts/${id}/send`, { method: 'POST' })

export const sendAllChaseDrafts = (contactId?: string) =>
  request<{ ok: boolean; sent: number; skipped: number; total: number }>('/app/api/chase/drafts/send-all', {
    method: 'POST',
    body: JSON.stringify(contactId ? { contact_id: contactId } : {}),
  })

export const dismissChaseDraft = (id: string) =>
  request<{ ok: boolean }>(`/app/api/chase/drafts/${id}/dismiss`, { method: 'POST' })

/** Bumps the rung and records when; sends nothing (D7). Omitted rung advances
 * one step; 409 rung_max at the top of the ladder. */
export const escalateChaseDraft = (id: string, rung?: ChaseRung) =>
  request<{ ok: boolean; rung: ChaseRung; acted_at: string }>(`/app/api/chase/drafts/${id}/escalate`, {
    method: 'POST',
    body: JSON.stringify(rung ? { rung } : {}),
  })

export interface ChaseSettings {
  chase_mode: 'auto' | 'assisted'
}

export const getChaseSettings = () => request<ChaseSettings>('/app/api/chase/settings')

export const updateChaseSettings = (chase_mode: ChaseSettings['chase_mode']) =>
  request<{ ok: boolean; chase_mode: ChaseSettings['chase_mode'] }>('/app/api/chase/settings', {
    method: 'PUT',
    body: JSON.stringify({ chase_mode }),
  })

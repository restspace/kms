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
  /** Org mode (CRM-01): number of event memberships. Absent in event mode. */
  event_count?: number
  /** Org mode: JSON string array of member event names, most recent first. */
  events_json?: string | null
  /** SPK-04: the settable speaker workflow status — a hand-set value on
   * event_contacts.speaker_status, or when unset the server's own
   * confirmed/awaiting_reply derivation (same signal as `confirmation`
   * above, under the new vocabulary's spelling). Null when neither applies. */
  speaker_status?: string | null
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
  /** Schedule (docs/07): a Session is the accepted Submission row itself. */
  starts_at: string | null
  ends_at: string | null
  room_id: string | null
  room_name: string | null
  /** The owning event's timezone — every schedule value renders in it (NFR-12). */
  event_timezone?: string | null
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
  already_merged: 'One of these contacts has already been merged — reload the duplicates list.',
  cannot_merge_self: 'A contact cannot be merged into itself.',
  merge_conflict: 'The merge could not be applied — reload and try again.',
  loser_id_required: 'The merge needs to know which record to fold in.',
  already_enrolled: 'They are already on the pipeline board.',
  invalid_stage: 'That pipeline stage is not recognised.',
  invalid_score: 'The score must be a whole number between 0 and 100.',
  body_required: 'A note needs some text.',
  contact_required: 'Choose a contact to enroll.',
  event_required: 'Choose an event to add them to.',
  no_seat_at_event: 'You do not have a seat on that event.',
  duplicate_criterion_name: 'A criterion with that name already exists on this round — names must be unique within a scorecard.',
  name_exists: 'A tag with that name already exists on this event.',
  name_required: 'A name is required.',
  invalid_tag_id: 'One of those tags no longer exists — reload and try again.',
  tag_ids_required: 'The tag list could not be read.',
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
  /** Workplan 15 W1a: the decision meeting's slot target. NULL = untracked,
   * and it is a target rather than a cap (D1) — nothing refuses a save. */
  target_slots?: number | null
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
  /** IANA event timezone — the Events tab derives its inclusive local-day
   * range from this (via eventDays) instead of reading the UTC instants. */
  timezone: string
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
  /** W1a slot target; null = untracked (no chip in the slot counter). */
  target_slots: number | null
  position: number
}

export const listRooms = () => request<{ items: RoomRow[] }>('/app/api/rooms')
// Mutations go through /app/api/agenda/rooms — the same CRUD as the legacy
// /app/api/rooms routes, plus a settings-history row per change (eval defect:
// room/track edits never appeared in the Settings history panel).
export const createRoom = (data: { name: string; capacity?: number | null; notes?: string | null }) =>
  request<RoomRow>('/app/api/agenda/rooms', { method: 'POST', body: JSON.stringify(data) })
export const updateRoom = (id: string, data: Record<string, unknown>) =>
  request<RoomRow>(`/app/api/agenda/rooms/${id}`, { method: 'PUT', body: JSON.stringify(data) })
/** What deleting this room would touch — feeds the confirm dialog. */
export const getRoomUsage = (id: string) =>
  request<{ session_count: number; scheduled_count: number }>(`/app/api/agenda/rooms/${id}/usage`)
export const deleteRoom = (id: string) =>
  request<{ ok: boolean; room: RoomRow; detached_session_ids: string[] }>(`/app/api/agenda/rooms/${id}`, {
    method: 'DELETE',
  })
/** Undo of deleteRoom: reinstates the room under its original id and re-points
 * the sessions that lost it (sessions re-homed meanwhile are left alone). */
export const restoreRoom = (room: RoomRow, sessionIds: string[]) =>
  request<{ ok: boolean; room: RoomRow; restored_sessions: number }>(`/app/api/agenda/rooms/${room.id}/restore`, {
    method: 'POST',
    body: JSON.stringify({
      name: room.name,
      capacity: room.capacity,
      notes: room.notes,
      position: room.position,
      session_ids: sessionIds,
    }),
  })

export interface FormatRow {
  id: string
  event_id: string
  name: string
  position: number
}

export const listFormats = () => request<{ items: FormatRow[] }>('/app/api/formats')
export const createFormat = (data: { name: string }) =>
  request<FormatRow>('/app/api/formats', { method: 'POST', body: JSON.stringify(data) })
export const updateFormat = (id: string, data: { name: string }) =>
  request<FormatRow>(`/app/api/formats/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteFormat = (id: string) =>
  request<{ ok: boolean }>(`/app/api/formats/${id}`, { method: 'DELETE' })

/**
 * A tag: the event's flat, cross-cutting label vocabulary. No `position` — the
 * server orders by name (tags are scanned alphabetically, unlike rooms/tracks
 * whose order is the running order of the day).
 */
export interface TagRow {
  id: string
  event_id: string
  name: string
  color: string | null
}

export const listTags = () => request<{ items: TagRow[] }>('/app/api/tags')
export const createTag = (data: { name: string; color?: string | null }) =>
  request<TagRow>('/app/api/tags', { method: 'POST', body: JSON.stringify(data) })
export const updateTag = (id: string, data: { name?: string; color?: string | null }) =>
  request<TagRow>(`/app/api/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) })
/** What deleting this tag would unlink — feeds the confirm dialog. */
export const getTagUsage = (id: string) =>
  request<{ submission_count: number; contact_count: number }>(`/app/api/tags/${id}/usage`)
/** The links come back with the row so the Undo below can re-make them. */
export const deleteTag = (id: string) =>
  request<{ ok: boolean; tag: TagRow; submission_ids: string[]; contact_ids: string[] }>(`/app/api/tags/${id}`, {
    method: 'DELETE',
  })
export const restoreTag = (tag: TagRow, submissionIds: string[], contactIds: string[]) =>
  request<{ ok: boolean; tag: TagRow }>(`/app/api/tags/${tag.id}/restore`, {
    method: 'POST',
    body: JSON.stringify({
      name: tag.name,
      color: tag.color,
      submission_ids: submissionIds,
      contact_ids: contactIds,
    }),
  })
/** A tag as it hangs off a record — no event_id, that is the parent's. */
export type SubmissionTag = Pick<TagRow, 'id' | 'name' | 'color'>

/** Replaces the submission's whole tag set; returns what was stored. */
export const setSubmissionTags = (submissionId: string, tagIds: string[]) =>
  request<{ ok: boolean; tags: SubmissionTag[] }>(`/app/api/submissions/${submissionId}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ tag_ids: tagIds }),
  })

export const listTracks = () => request<{ items: TrackRow[] }>('/app/api/tracks')
// Mutations via /app/api/agenda/tracks for the settings-history row, like rooms.
export const createTrack = (data: { name: string; color?: string | null; target_slots?: number | null }) =>
  request<TrackRow>('/app/api/agenda/tracks', { method: 'POST', body: JSON.stringify(data) })
export const updateTrack = (id: string, data: Record<string, unknown>) =>
  request<TrackRow>(`/app/api/agenda/tracks/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteTrack = (id: string) =>
  request<{ ok: boolean }>(`/app/api/agenda/tracks/${id}`, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Saved embeds (EMB-15): named embed configurations. `options` is the
// generator state blob (SavedEmbedOptions) — the API validates only name /
// widget / format and stores the blob opaquely.
// ---------------------------------------------------------------------------

export interface SavedEmbedRow {
  id: string
  event_id: string
  name: string
  widget: 'sessions' | 'speakers' | 'agenda' | 'schedule' | 'gallery'
  format: 'script' | 'iframe' | 'json' | 'xml' | 'ics'
  options: import('./embeds/embedOptions.logic').SavedEmbedOptions
  created_at: string
  updated_at: string
}

export const listSavedEmbeds = () => request<{ items: SavedEmbedRow[] }>('/app/api/embeds')
export const createSavedEmbed = (data: Pick<SavedEmbedRow, 'name' | 'widget' | 'format' | 'options'>) =>
  request<SavedEmbedRow>('/app/api/embeds', { method: 'POST', body: JSON.stringify(data) })
export const updateSavedEmbed = (id: string, data: Partial<Pick<SavedEmbedRow, 'name' | 'widget' | 'format' | 'options'>>) =>
  request<SavedEmbedRow>(`/app/api/embeds/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteSavedEmbed = (id: string) =>
  request<{ ok: boolean }>(`/app/api/embeds/${id}`, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Saved Speaker-roster segments (CRM-09). kind 'dynamic' stores the filter
// object the grid was showing (`filters`); kind 'curated' freezes an explicit
// id list (`member_ids`).
// ---------------------------------------------------------------------------

export interface SegmentRow {
  id: string
  event_id: string
  name: string
  kind: 'dynamic' | 'curated'
  filters: string | null
  member_ids: string | null
  created_at: string
}

export const listContactSegments = () => request<{ items: SegmentRow[] }>('/app/api/contact-segments')
export const createContactSegment = (data: { name: string; kind: 'dynamic' | 'curated'; filters?: Record<string, unknown> | null; member_ids?: string[] | null }) =>
  request<SegmentRow>('/app/api/contact-segments', { method: 'POST', body: JSON.stringify(data) })
export const updateContactSegment = (id: string, data: Record<string, unknown>) =>
  request<SegmentRow>(`/app/api/contact-segments/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteContactSegment = (id: string) =>
  request<{ ok: boolean }>(`/app/api/contact-segments/${id}`, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Speaker-status options (SPK-04): per-event extensions to the built-in
// speaker_status vocabulary (prospect/invited/awaiting_reply/confirmed/
// declined). Same rooms/tracks CRUD shape; `key` is derived server-side from
// `label` on create and immutable thereafter.
// ---------------------------------------------------------------------------

export interface SpeakerStatusOption {
  id: string
  event_id: string
  key: string
  label: string
  position: number
}

export const listSpeakerStatuses = () => request<{ items: SpeakerStatusOption[] }>('/app/api/speaker-statuses')
export const createSpeakerStatus = (data: { label: string }) =>
  request<SpeakerStatusOption>('/app/api/speaker-statuses', { method: 'POST', body: JSON.stringify(data) })
export const updateSpeakerStatus = (id: string, data: { label: string }) =>
  request<SpeakerStatusOption>(`/app/api/speaker-statuses/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteSpeakerStatus = (id: string) =>
  request<{ ok: boolean }>(`/app/api/speaker-statuses/${id}`, { method: 'DELETE' })

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

/** Task audiences (CNT-01) — named assignee sets the create form can target
 * ("all speakers") instead of picking contacts one at a time. Counts are
 * task-flavored (no email requirement), hence not the messaging endpoint. */
export type TaskAudience = 'speakers' | 'accepted_speakers' | 'roster' | 'all_contacts'
export const getTaskAudiences = () =>
  request<{ audiences: Array<{ audience: TaskAudience; count: number }> }>('/app/api/tasks/audiences')

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

/** W6/D10: the intro script, editable from the detail panel as well as the
 *  green room screen (greenroomIntroScript above). */
export const updateSubmissionIntroScript = (id: string, introScript: string | null) =>
  request<{ ok: boolean; intro_script: string | null }>(`/app/api/submissions/${id}/intro-script`, {
    method: 'PUT',
    body: JSON.stringify({ intro_script: introScript }),
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

/**
 * Org-mode variant (CRM-01): same generic query endpoint with `scope: 'org'`
 * folded into the body — one row per contact across the whole organisation,
 * including contacts on no event. `filters.event_id` is ignored server-side
 * in this mode, so a stale event filter can never narrow the directory.
 */
export const queryContactsOrg =
  <T>() =>
  (params: DataSourceParams): Promise<DataSourceResult<T>> =>
    request<DataSourceResult<T>>('/app/api/contacts/query', {
      method: 'POST',
      body: JSON.stringify({ ...params, scope: 'org' }),
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
export const uploadContactHeadshot = (id: string, file: File, eventId?: string | null) => {
  const form = new FormData()
  form.set('headshot', file)
  // F7: the detail panel can be opened from another accessible event's row in
  // the All-events grid — the row's own event_id rides along so the pointer
  // lands on that event's profile, not the session event's (same event-scoping
  // fix the contacts PUT already carries).
  if (eventId) form.set('event_id', eventId)
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

// ---------------------------------------------------------------------------
// Speaker sourcing pipeline (spec-gap CRM-07/08) — org-wide kanban of
// prospects. Writer-only server-side; stages travel with the board payload.
// ---------------------------------------------------------------------------

export interface PipelineCard {
  id: string
  contact_id: string
  stage: string
  score: number | null
  rationale: string | null
  position: number
  created_at: string
  updated_at: string
  first_name: string | null
  last_name: string | null
  email: string
  /** From the contact's most recent membership in the org — same coalesce
   * rule the directory grid uses. */
  company: string | null
  job_title: string | null
}

export interface PipelineActivityRow {
  id: string
  kind: 'enrolled' | 'stage_change' | 'note'
  from_stage: string | null
  to_stage: string | null
  body: string | null
  author_name: string | null
  created_at: string
}

export const fetchPipeline = () =>
  request<{ stages: string[]; cards: PipelineCard[] }>('/app/api/crm/pipeline')

export const enrollPipelineCard = (data: {
  contact_id: string
  stage?: string
  score?: number | null
  rationale?: string | null
}) => request<PipelineCard>('/app/api/crm/pipeline/cards', { method: 'POST', body: JSON.stringify(data) })

/** Workplan 15 W4: route declined-but-highly-rated talks' speakers into the
 * board — one card per person, so the counts split created vs already-there. */
export const enrollSubmissionsInPipeline = (ids: string[]) =>
  request<{ ok: boolean; enrolled: number; created: number; updated: number; skipped_no_speaker: number }>(
    '/app/api/crm/pipeline/enroll-submissions',
    { method: 'POST', body: JSON.stringify({ ids }) },
  )

export const fetchPipelineCard = (id: string) =>
  request<PipelineCard & { activity: PipelineActivityRow[] }>(`/app/api/crm/pipeline/cards/${id}`)

export const updatePipelineCard = (id: string, data: Record<string, unknown>) =>
  request<PipelineCard>(`/app/api/crm/pipeline/cards/${id}`, { method: 'PATCH', body: JSON.stringify(data) })

export const addPipelineNote = (id: string, body: string) =>
  request<PipelineActivityRow>(`/app/api/crm/pipeline/cards/${id}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })

export const deletePipelineCard = (id: string) =>
  request<{ ok: boolean }>(`/app/api/crm/pipeline/cards/${id}`, { method: 'DELETE' })

export const assignPipelineCard = (id: string, eventId: string) =>
  request<{ ok: boolean; event_id: string; contact_id: string }>(`/app/api/crm/pipeline/cards/${id}/assign`, {
    method: 'POST',
    body: JSON.stringify({ event_id: eventId }),
  })

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
export const getContactHistory = (id: string, eventId?: string | null) =>
  request<{ events: ContactHistoryEvent[]; current_event_id: string }>(
    // F7: the roster guard runs against the row's own event when the panel was
    // opened from another accessible event's row (All-events grid) — without
    // it the session-event guard 404s a legitimate read.
    `/app/api/contacts/${id}/history${eventId ? `?event_id=${encodeURIComponent(eventId)}` : ''}`,
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
// Contact merge (workplan 14 Wave B). Candidates come in two tiers per D2:
// same normalized email is a strong signal, same normalized full name is weak
// and needs explicit human confirmation before the merge is offered.
// ---------------------------------------------------------------------------

/** One side of a candidate pair: identity plus the profile from their most
 * recent event in the org — the values the side-by-side picker renders. */
export interface DuplicateContact {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  salutation: string | null
  honorific: string | null
  pronouns: string | null
  gender: string | null
  mobile_phone: string | null
  links: string | null
  created_at: string
  company: string | null
  job_title: string | null
  biography: string | null
  event_count: number
}

export interface DuplicatePair {
  tier: 'strong' | 'weak'
  /** Ordered oldest-first — the suggested winner leads, matching the 0015
   * migration's own survivor election; the organizer can flip it. */
  contacts: [DuplicateContact, DuplicateContact]
}

export const getDuplicateContacts = () =>
  request<{ items: DuplicatePair[] }>('/app/api/contacts/duplicates')

/** Merge `loserId` into `winnerId`. `fields` carries the organizer's per-field
 * picks for conflicting values ('winner' keeps the winner's, 'loser' takes the
 * loser's); unlisted fields keep the winner's, blanks filled from the loser. */
export const mergeContacts = (
  winnerId: string,
  loserId: string,
  fields: Record<string, 'winner' | 'loser'>,
) =>
  request<{ ok: boolean; winner_id: string; loser_id: string; events_affected: number }>(
    `/app/api/contacts/${winnerId}/merge`,
    { method: 'POST', body: JSON.stringify({ loser_id: loserId, fields }) },
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
  /** Full rows, not names: the detail panel's chips are an editor and the
   *  write takes ids (setSubmissionTags). */
  tags: SubmissionTag[]
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

export const updateSubmissionStatus = (id: string, status: string, acceptCondition?: string | null) =>
  request<{ ok: boolean }>(`/app/api/submissions/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status, ...(acceptCondition === undefined ? {} : { accept_condition: acceptCondition }) }),
  })
/** `acceptCondition` is workplan 15 W2's proviso, captured in the accept
 *  action itself rather than in a later edit. */
export const bulkStatus = (ids: string[], status: string, acceptCondition?: string | null) =>
  request<{ ok: boolean; changed: number }>('/app/api/submissions/bulk-status', {
    method: 'POST',
    body: JSON.stringify({ ids, status, ...(acceptCondition ? { accept_condition: acceptCondition } : {}) }),
  })
export const sendDecisions = (
  ids: string[],
  options?: {
    /** Workplan 10 Wave B: compute counts + speakers_with_pending without creating a job. */
    preflight?: boolean
    /** CFP-14: with preflight, also render sample accept/decline emails for the review dialog. */
    preview?: boolean
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
    /** CFP-14: decided-but-never-notified rows included in this send (previously silently skipped). */
    resend?: number
    /** CFP-14 review dialog: sample renders of the decision emails (preflight+preview only).
     * A null side means no rows on that side, or its template is disabled. */
    previews?: {
      accepted: { subject: string; body_html: string; body_text: string; sample_to: string } | null
      declined: { subject: string; body_html: string; body_text: string; sample_to: string } | null
      /** W3: present only when the batch actually contains a revise row. */
      revise?: { subject: string; body_html: string; body_text: string; sample_to: string } | null
      merged_speakers: number
    }
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

/** Workplan 15 W2 (D4): the accept's condition, and marking it met. Neither
 * ever changes status — accepted and owing a co-presenter are independent. */
export const updateSubmissionCondition = (
  id: string,
  body: { accept_condition?: string | null; condition_met?: boolean },
) =>
  request<{ ok: boolean; accept_condition: string | null; condition_met_at: string | null }>(
    `/app/api/submissions/${id}/condition`,
    { method: 'PUT', body: JSON.stringify(body) },
  )

/** Workplan 15 W3 (D5): "revise and resubmit" as a flag on a row that stays
 * declined, so nothing downstream of the decline queue changes. */
export const updateSubmissionDecision = (
  id: string,
  body: { decision_outcome?: string | null; revise_guidance?: string | null },
) =>
  request<{ ok: boolean; decision_outcome: string | null; revise_guidance: string | null }>(
    `/app/api/submissions/${id}/decision`,
    { method: 'PUT', body: JSON.stringify(body) },
  )

/** W3: "Ask to revise" over a selection from the decline queue. */
export const bulkDecision = (ids: string[], reviseGuidance: string | null) =>
  request<{ ok: boolean; changed: number }>('/app/api/submissions/bulk-decision', {
    method: 'POST',
    body: JSON.stringify({ ids, decision_outcome: 'revise', revise_guidance: reviseGuidance }),
  })

/** Workplan 15 W5a (D9): the post-accept materials flag and the deck's
 * reviewer. 'received' is never sent from here — an upload sets it. */
export const updateSubmissionMaterials = (
  id: string,
  body: { materials_state?: string | null; materials_owner_id?: string | null },
) =>
  request<{ ok: boolean; materials_state: string | null; materials_state_at: string | null; materials_owner_id: string | null }>(
    `/app/api/submissions/${id}/materials`,
    { method: 'PUT', body: JSON.stringify(body) },
  )

/** Seats a deck review can be handed to — "share the load" needs a list. */
export const getMaterialsOwners = () =>
  request<{ items: Array<{ id: string; email: string; name: string | null }> }>(
    '/app/api/submissions/materials-owners',
  )

/** W5d: every deck comment on a submission, across chains and versions. */
export const getSubmissionFileComments = (id: string) =>
  request<{ items: SubmissionFileComment[] }>(`/app/api/files/submissions/${id}/comments`)

export interface SubmissionFileComment {
  id: string
  author_role: string
  author_name: string | null
  body: string
  created_at: string
  /** Version ordinal of the upload the comment was left on (0007). */
  version: number
  filename: string
}

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
  /**
   * The session (submission) this upload belongs to (#9) — resolved
   * server-side from `submission_id` when set, falling back to the
   * submission of the task assignment the upload's chain came from when it
   * isn't (a task assigned directly to a contact rather than a submission).
   * `session_code`/`session_title` are the same value as
   * `submission_code`/`submission_title` today; kept as a distinct field so
   * the Files library's Session column has a name independent of the
   * back-compat `submission_*` fields.
   */
  session_id: string | null
  session_code: string | null
  session_title: string | null
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
  /** A single chain by its current upload row's id — `?rec=` deep-link restore. */
  upload_id?: string
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
 * #18 — event-level file-collection defaults: a toggle (pre-fill new tasks'
 * Action type to File upload) plus a default allowed-types list (applied to
 * a file_upload task's file request at creation, adminApi.ts's POST /tasks).
 */
export interface FileCollectionDefaults {
  enabled: boolean
  allowed_types: string[]
}

export const getFileCollectionDefaults = () => request<FileCollectionDefaults>('/app/api/files/settings')

export const updateFileCollectionDefaults = (defaults: FileCollectionDefaults) =>
  request<{ ok: boolean; enabled: boolean; allowed_types: string[] }>('/app/api/files/settings', {
    method: 'PUT',
    body: JSON.stringify(defaults),
  })

/**
 * Airtable mirror settings (deployment-global singleton, routes/airtableAdmin.ts).
 * The API key never round-trips: GET/PUT return only key_set + last 4 chars,
 * and updateAirtableSettings omits api_key entirely to keep the stored one.
 */
export interface AirtableSettings {
  enabled: boolean
  base_id: string
  key_set: boolean
  key_last4: string | null
}

export const getAirtableSettings = () => request<AirtableSettings>('/app/api/airtable/settings')

export const updateAirtableSettings = (body: { enabled: boolean; base_id: string; api_key?: string }) =>
  request<AirtableSettings>('/app/api/airtable/settings', { method: 'PUT', body: JSON.stringify(body) })

/**
 * Probe with the typed-but-unsaved credentials when given, stored/env otherwise.
 * Checks the base's schema where the token allows it, so "tables not created
 * yet" reads differently from "wrong base ID" — both are a bare 404 otherwise.
 */
export const testAirtableConnection = (body: { api_key?: string; base_id?: string } = {}) =>
  request<{ ok: boolean; message?: string; error?: string }>('/app/api/airtable/settings/test', {
    method: 'POST',
    body: JSON.stringify(body),
  })

/** Bases the token can see, for the base picker. Needs schema.bases:read on the PAT. */
export const listAirtableBases = (body: { api_key?: string } = {}) =>
  request<{ ok: boolean; bases: Array<{ id: string; name: string }>; error?: string }>(
    '/app/api/airtable/settings/bases',
    { method: 'POST', body: JSON.stringify(body) },
  )

/** What one setup run changed — additive only, so re-running is always safe. */
export interface AirtableSetupReport {
  createdTables: string[]
  addedFields: string[]
  mismatched: string[]
  unchanged: string[]
}

/** Create the mirror's tables/columns in the selected base. Needs schema.bases:write. */
export const setUpAirtableBase = (body: { api_key?: string; base_id?: string } = {}) =>
  request<{ ok: boolean; report?: AirtableSetupReport; error?: string }>(
    '/app/api/airtable/settings/setup',
    { method: 'POST', body: JSON.stringify(body) },
  )

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

/**
 * One pre-edit snapshot per watched-field edit for a non-submission entity
 * (Wave E: contact profile fields, event settings). `fields` is the full
 * watched set as it stood BEFORE the edit, keyed by the corresponding write
 * surface's own field names, so a restore is literally "send fields back
 * through the normal PUT/PATCH".
 */
export interface EntityRevision {
  id: string
  fields: Record<string, string | null>
  edited_by: string | null
  edited_by_name: string | null
  source: 'admin' | 'portal'
  edited_at: string
}

export const getContactRevisions = (contactId: string, eventId?: string | null) =>
  request<{ items: EntityRevision[] }>(
    `/app/api/contacts/${contactId}/revisions${eventId ? `?event_id=${encodeURIComponent(eventId)}` : ''}`,
  )

export const getEventRevisions = (eventId: string) =>
  request<{ items: EntityRevision[] }>(`/app/api/events/${eventId}/revisions`)

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
  request<{
    ok: boolean
    total_assignments: number
    created: number
    submissions: number
    /** ABS-06: submissions that got fewer reviewers than requested because
     *  the remaining candidates were all at their per-round cap. */
    unassigned: Array<{ submission_id: string; short: number }>
  }>(
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
  /** Set while an auto-scheduled placement is still awaiting confirmation (AIA-08) */
  pencilled_at: string | null
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
/** AIA-08: place every tray session into a free slot, pencilled for review. */
export const autoScheduleSessions = () =>
  request<
    AgendaPayload & {
      ok: boolean
      placed: number
      placements: Array<{ id: string; starts_at: string; ends_at: string; room_id: string }>
      skipped: Array<{ id: string; reason: string }>
    }
  >('/app/api/agenda/auto-schedule', { method: 'POST', body: JSON.stringify({}) })
/** Accept every pencilled placement — they become publishable immediately. */
export const confirmPlacements = () =>
  request<AgendaPayload & { ok: boolean; confirmed: number }>('/app/api/agenda/confirm-placements', {
    method: 'POST',
    body: JSON.stringify({}),
  })
/** Many schedule writes in one call — what undoing a whole auto-place needs. */
export const scheduleBatch = (
  items: Array<{ id: string; starts_at: string | null; ends_at: string | null; room_id: string | null }>,
) =>
  request<AgendaPayload & { ok: boolean; updated: number }>('/app/api/agenda/schedule-batch', {
    method: 'POST',
    body: JSON.stringify({ items }),
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

/** One accepted talk on the Materials panel (W5c). `days_since_request` is
 *  only meaningful for the revision_requested bucket. */
export interface MaterialsRow {
  submission_id: string
  code: string
  title: string
  contact_id: string | null
  name: string
  owner_name: string | null
  days_since_request: number | null
}

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
    /** Workplan 15 W2: accepts carrying a condition nobody has marked met,
     * sorted by days-until-event ascending. A condition nobody chases is a
     * decline discovered late. */
    conditions_outstanding?: Array<{ submission_id: string; code: string; title: string; accept_condition: string; contact_id: string | null; name: string; days_until_event: number }>
    /** Workplan 15 W5c: the two questions the doc asks about decks, plus the
     * line in front of both. Every accepted talk is in exactly one bucket —
     * `settled` is the reviewed/final remainder, counted but not listed. */
    materials?: {
      accepted_total: number
      settled: number
      awaiting_upload: MaterialsRow[]
      not_seen: MaterialsRow[]
      owes_v2: MaterialsRow[]
    }
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

/** One event row on the org dashboard (dashboard.ts's OrgDashboardEventRow). */
export interface OrgDashboardEventRow {
  id: string
  name: string
  slug: string
  /** Event timezone; the date range renders as local days, not UTC dates. */
  timezone: string
  starts_at: string
  ends_at: string
  agenda_published: number
  /** status != 'draft' */
  submissions: number
  accepted: number
  /** accepted AND scheduled into a room/time */
  scheduled: number
}

/** GET /app/api/dashboard/org (CRM-12) — org-wide, all events in the org. */
export interface OrgDashboardPayload {
  now: string
  org: { id: string; name: string }
  kpis: {
    total_contacts: number
    new_contacts_30d: number
    contacts_on_events: number
    contacts_no_event: number
    /** submitter or participant in >= 2 distinct events */
    returning_speakers: number
    events: number
  }
  top_companies: Array<{ company: string; n: number }>
  /** starts_at DESC, then name */
  events: OrgDashboardEventRow[]
}

/** ETag-aware poll for the org board, mirroring fetchDashboard. */
export async function fetchOrgDashboard(
  etag: string | null,
): Promise<{ fresh: true; payload: OrgDashboardPayload; etag: string | null } | { fresh: false }> {
  const res = await fetch('/app/api/dashboard/org', {
    headers: { accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) },
  })
  if (res.status === 304) return { fresh: false }
  if (res.status === 401) {
    window.location.assign('/app')
    throw new ApiError('Signed out', 401)
  }
  if (!res.ok) throw new ApiError(`The server rejected the request (HTTP ${res.status}).`, res.status)
  return { fresh: true, payload: (await res.json()) as OrgDashboardPayload, etag: res.headers.get('etag') }
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
  /** W6/D10: the host's read-out line, editable here as well as the detail panel. */
  intro_script: string | null
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

/** W6/D10: saves the intro script from the day-of screen; same whole-payload
 *  response contract as checkin. */
export const greenroomIntroScript = (submissionId: string, introScript: string | null) =>
  request<GreenRoomPayload & { ok: boolean; etag: string }>('/app/api/greenroom/intro-script', {
    method: 'POST',
    body: JSON.stringify({ submission_id: submissionId, intro_script: introScript }),
  })

/** Show-flow handoff export (W6/D10): plain browser-navigated download, same
 *  reasoning as importBatchReportUrl — the cookie carries the session. */
export const showflowExportUrl = (format: 'csv' | 'xlsx') => `/app/api/greenroom/showflow.${format}`

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
/**
 * Demo-data reset. `redirect_email` (a tester mailbox, or '' to clear) is
 * saved before the seed replays, so every seeded contact comes back as a
 * plus-addressed variant of it — omit the field to keep whatever is stored.
 */
export const resetDemoData = (redirectEmail?: string) =>
  request<{ ok: boolean; statements: number; redirect_email: string | null }>('/app/api/demo/reset', {
    method: 'POST',
    body: JSON.stringify(redirectEmail === undefined ? {} : { redirect_email: redirectEmail }),
  })

export const getDemoSettings = () => request<{ redirect_email: string | null }>('/app/api/demo/settings')

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

/** One row of the lobby queue (workplan 15 W1b): a submission this reviewer
 * personally scored that is not yet accepted, with their own score beside the
 * committee mean they are arguing against. */
export interface LobbyRow {
  id: string
  code: string
  title: string
  status: string
  my_score: number
  submission_rating: number | null
  track_name: string | null
  review_count: number
}

/** "My top-ranked, not yet accepted", ordered by the caller's own score — a
 * purpose-built endpoint because that ordering needs a bind the submissions
 * resource's ORDER BY builder cannot carry (D3). */
export const getReviewLobby = () => request<{ items: LobbyRow[] }>('/app/api/evaluation/lobby')
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
  /** Eval defect #13, contacts only: same-name/different-email candidates
   * among rows that would otherwise create a brand-new contact — advisory,
   * never blocking. Absent when there are none. */
  possibleDuplicates?: ImportPossibleDuplicate[]
}

export interface ImportPossibleDuplicate {
  row: number
  label: string
  email: string
  /** null when the match is another row in this same file, not an existing contact */
  matchContactId: string | null
  matchLabel: string
  matchEmail: string
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

export type ComposeAudience =
  | 'all_contacts'
  | 'roster'
  | 'speakers'
  | 'accepted_speakers'
  | 'declined_speakers'
  | 'selected'

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

/**
 * Workplan-14 F2/D3: render (never send) the subject/body a compose would
 * produce for one recipient, through the server's exact send-time renderer —
 * used by the compose form's "Preview as…" control so the organiser can see
 * merge fields resolved before anything goes out.
 */
export const previewMessage = (payload: { subject: string; body: string; contact_id: string }) =>
  request<{ subject: string; body_text: string; body_html: string }>('/app/api/messaging/preview', {
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

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
  email: string
  first_name: string | null
  last_name: string | null
  company: string | null
  job_title: string | null
  mobile_phone: string | null
  biography: string | null
  pronouns: string | null
  created_at: string
  updated_at: string
}

export interface SubmissionRow {
  id: string
  event_id: string
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
  created_at: string
  updated_at: string
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
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
    throw new ApiError(readableError(code), res.status)
  }
  return body as T
}

const ERROR_MESSAGES: Record<string, string> = {
  email_exists: 'A contact with this email already exists for this event.',
  email_required: 'An email address is required.',
  not_found: 'The record no longer exists.',
  conflict: 'This record changed in another session — reload to pick up the latest version before saving again.',
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

/** DataList-compatible data source for the generic query endpoint. */
export const queryResource =
  <T>(resource: 'contacts' | 'submissions') =>
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

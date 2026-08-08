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

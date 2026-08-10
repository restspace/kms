// Evaluation-lane API calls (lane L3). Kept beside the section rather than in
// the shared src/api.ts so the round editor's new surface — submission
// membership, reviewer provisioning, reminders — lives with the screen that
// owns it. Same contract as the shared client: same-origin cookie auth, a 401
// hands back to the Worker's login page, and a non-2xx becomes a thrown Error
// carrying the server's machine code.

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: {
      accept: 'application/json',
      ...(typeof init?.body === 'string' ? { 'content-type': 'application/json' } : {}),
    },
    ...init,
  })
  if (res.status === 401) {
    window.location.assign('/app')
    throw new Error('Signed out')
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const code = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
    throw new Error(ERRORS[code] ?? `The server rejected the request (${code}).`)
  }
  return body as T
}

const ERRORS: Record<string, string> = {
  not_found: 'That review round no longer exists — reload the section.',
  forbidden: 'You do not have permission to change review rounds.',
  invalid_email: 'Enter a valid email address for the reviewer.',
  selection_required: 'Choose some submissions, or a filter, first.',
  invalid_opens_at: 'The opening date could not be read.',
  invalid_closes_at: 'The closing date could not be read.',
  reviewers_required: 'Tick at least one reviewer before assigning.',
  invalid_reviewer: 'One of those reviewers is no longer seated on this event.',
  invalid_anonymise_submitters: 'The anonymise setting could not be read — reload and try again.',
}

export interface PlanSubmissionRow {
  id: string
  code: string
  title: string
  status: string
  format: string | null
  track_id: string | null
  track_name: string | null
  /** 1 when the submission is in this round */
  member: number
  /** review_assignments already created for it in this round */
  assignments: number
}

export interface PlanSubmissionsPayload {
  items: PlanSubmissionRow[]
  tracks: Array<{ id: string; name: string }>
  formats: string[]
}

export interface MembershipFilter {
  track_id?: string
  format?: string
  status?: string
  q?: string
}

export const getPlanSubmissions = (planId: string) =>
  request<PlanSubmissionsPayload>(`/app/api/evaluation/plans/${planId}/submissions`)

export const changePlanSubmissions = (
  planId: string,
  body: { mode: 'add' | 'remove'; submission_ids?: string[]; filter?: MembershipFilter },
) =>
  request<{ ok: boolean; matched: number; changed: number; total: number }>(
    `/app/api/evaluation/plans/${planId}/submissions`,
    { method: 'POST', body: JSON.stringify(body) },
  )

export const addReviewer = (body: { name?: string; email: string; plan_id?: string }) =>
  request<{ ok: boolean; id: string; email: string; name: string | null; created: boolean }>(
    '/app/api/evaluation/reviewers',
    { method: 'POST', body: JSON.stringify(body) },
  )

/**
 * CFP-11: the response now names the reviewer the link belongs to
 * (`contact_id`/`name`), so the UI can label it with that identity rather than
 * whatever row happened to be clicked — the surfaced link and the name beside
 * it can no longer disagree.
 */
export const sendReviewerSigninLink = (contactId: string) =>
  request<{
    ok: boolean
    contact_id: string
    email: string
    name: string | null
    dev_link: string | null
    emailed?: boolean
  }>(
    `/app/api/evaluation/reviewers/${contactId}/signin-link`,
    { method: 'POST', body: JSON.stringify({}) },
  )

/**
 * The round's reviewer pool (evaluation_plan_reviewers). Ticking/unticking a
 * reviewer used to be local state only — `assign` inserts pool rows and
 * nothing ever deleted one, so a removal came back on the next reload.
 */
export const addPlanReviewer = (planId: string, contactId: string) =>
  request<{ ok: boolean; plan_id: string; contact_id: string }>(
    `/app/api/evaluation/plans/${planId}/reviewers`,
    { method: 'POST', body: JSON.stringify({ contact_id: contactId }) },
  )

export const removePlanReviewer = (planId: string, contactId: string) =>
  request<{ ok: boolean; plan_id: string; contact_id: string; removed_assignments: number }>(
    `/app/api/evaluation/plans/${planId}/reviewers/${contactId}`,
    { method: 'DELETE' },
  )

export const remindReviewers = (planId: string, contactIds?: string[]) =>
  request<{ ok: boolean; sent: number; lagging: Array<{ contact_id: string; outstanding: number }> }>(
    `/app/api/evaluation/plans/${planId}/remind`,
    { method: 'POST', body: JSON.stringify(contactIds ? { contact_ids: contactIds } : {}) },
  )

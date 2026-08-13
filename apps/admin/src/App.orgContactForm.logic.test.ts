/**
 * Replay defect #10: the org directory's contact edit form lacked Company and
 * Job title even though both are directory columns. Pinned as pure logic,
 * same pattern as App.speakerForm.logic.test.ts:
 *
 *  - orgContactEditSchema renders both fields (the event-less CREATE schema
 *    stays identity-only — the server 400s profile fields with no membership).
 *  - buildOrgContactSavePayload sends company/job_title ONLY when the
 *    organiser actually changed them from the seeded row: an untouched save
 *    can neither clear a saved value nor copy the grid's coalesced
 *    most-recent-membership answer onto the sidebar event's row.
 */
import { describe, expect, it } from 'vitest'
import type { ContactRow } from './api'
import { buildOrgContactSavePayload, orgContactEditSchema } from './App'

const existing = {
  id: 'c-priya',
  event_id: null,
  email: 'priya@example.com',
  first_name: 'Priya',
  last_name: 'Raman',
  company: 'Acme',
  job_title: 'CTO',
  mobile_phone: null,
  pronouns: null,
  links: null,
  events_json: JSON.stringify(['DevFlow Conf 2027']),
} as unknown as ContactRow

/** RecordForm submits its whole seeded value object, so the form data carries the row's keys back. */
const seededFormData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...(existing as unknown as Record<string, unknown>),
  ...overrides,
})

describe('orgContactEditSchema', () => {
  it('renders Company and Job title alongside the identity fields', () => {
    const keys = Object.keys(orgContactEditSchema.properties as Record<string, unknown>)
    expect(keys).toContain('company')
    expect(keys).toContain('job_title')
    expect(keys).toContain('email')
    expect(keys).toContain('link_linkedin')
    // Still no membership-only fields the org PUT could misroute.
    expect(keys).not.toContain('biography')
    expect(keys).not.toContain('notes')
    expect(keys).not.toContain('speaker_status')
  })
})

describe('buildOrgContactSavePayload', () => {
  it('omits company/job_title when the organiser did not touch them', () => {
    const payload = buildOrgContactSavePayload(seededFormData(), existing)
    expect('company' in payload).toBe(false)
    expect('job_title' in payload).toBe(false)
    // Identity still travels.
    expect(payload.email).toBe('priya@example.com')
    expect(payload.first_name).toBe('Priya')
  })

  it('sends a changed company (and only that field)', () => {
    const payload = buildOrgContactSavePayload(seededFormData({ company: 'Globex' }), existing)
    expect(payload.company).toBe('Globex')
    expect('job_title' in payload).toBe(false)
  })

  it('sends null when a value is deliberately cleared', () => {
    const payload = buildOrgContactSavePayload(seededFormData({ job_title: '' }), existing)
    expect(payload.job_title).toBeNull()
  })

  it('treats whitespace-only edits as unchanged', () => {
    const payload = buildOrgContactSavePayload(seededFormData({ company: '  Acme  ' }), existing)
    expect('company' in payload).toBe(false)
  })

  it('never attaches profile fields on create (no existing row)', () => {
    const payload = buildOrgContactSavePayload({ email: 'new@example.com', company: 'Acme' })
    expect('company' in payload).toBe(false)
    expect(payload.email).toBe('new@example.com')
  })

  it('strips membership-only stale row keys the same as before', () => {
    const payload = buildOrgContactSavePayload(seededFormData({ biography: 'stale', speaker_status: 'confirmed' }), existing)
    expect('biography' in payload).toBe(false)
    expect('speaker_status' in payload).toBe(false)
  })
})

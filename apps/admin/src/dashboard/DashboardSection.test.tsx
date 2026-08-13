// Speaker Tracking empty states (defect: with zero accepted speakers the
// Asset completeness card asserted "Every accepted speaker has a bio,
// headshot and slides" — vacuous truth rendered as success). With no
// accepted speakers both the assets card and the confirmation donut show a
// neutral "No accepted speakers yet." instead; the green assertion is
// reserved for events that actually have complete speakers. The org board's
// Events table is exercised too: its date range must be the event-local day
// span, not the UTC dates.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/preact'

const { fetchDashboardMock, fetchOrgDashboardMock, getChaseDraftsMock, getChaseSettingsMock } = vi.hoisted(() => ({
  fetchDashboardMock: vi.fn(),
  fetchOrgDashboardMock: vi.fn(),
  getChaseDraftsMock: vi.fn(),
  getChaseSettingsMock: vi.fn(),
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchDashboard: fetchDashboardMock,
    fetchOrgDashboard: fetchOrgDashboardMock,
    getChaseDrafts: getChaseDraftsMock,
    getChaseSettings: getChaseSettingsMock,
  }
})

import type { DashboardPayload, OrgDashboardPayload } from '../api'
import { EventScopeProvider, type EventScopeValue } from '../eventScope'
import { DashboardSection } from './DashboardSection'

const payload = (over: Partial<DashboardPayload['tracking']> = {}): DashboardPayload => ({
  now: new Date().toISOString(),
  event: {
    id: 'ev-1', name: 'DevOps Days', slug: 'devops', timezone: 'America/Los_Angeles',
    starts_at: '2027-05-12T07:00:00.000Z', ends_at: '2027-05-15T06:59:59.999Z',
  },
  kpis: { submissions: 0, accepted_speakers: 0 },
  status_tiles: { accepted: 0, pending: 0, declined: 0, drafts: 0, withdrawn: 0 },
  nudges: [],
  forms: { forms: [], recent: [], pacing: [] },
  participants: { by_role: [], status_mix: [] },
  evaluations: { reviewers: [], reviews: 0, evaluated_submissions: 0, in_progress: 0, plans: [] },
  agenda: { scheduled: 0, unscheduled: 0, per_day: [], per_room: [], conflicts: { error: 0, warning: 0, info: 0 } },
  tracking: {
    accepted_speakers: 0,
    outstanding_tasks: 0,
    confirmation: { confirmed: 0, awaiting: 0 },
    top_speakers: [],
    overdue: [],
    approval_pending: [],
    assets: [],
    ...over,
  },
  pipeline: {
    total: 0, pending_review: 0, by_form: [], by_track: [],
    funnel: { received: 0, reviewed: 0, decided: 0, accepted: 0, scheduled: 0 },
  },
})

beforeEach(() => {
  fetchDashboardMock.mockReset()
  fetchOrgDashboardMock.mockReset()
  getChaseDraftsMock.mockReset()
  getChaseSettingsMock.mockReset()
  getChaseDraftsMock.mockResolvedValue({ items: [] })
  getChaseSettingsMock.mockResolvedValue({ chase_mode: 'assisted' })
  window.localStorage.clear()
})

const openTracking = async () => {
  render(<DashboardSection onNavigate={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: /Speaker Tracking/ }))
}

describe('Speaker Tracking empty states', () => {
  it('shows a neutral empty state, not the green assertion, with zero accepted speakers', async () => {
    fetchDashboardMock.mockResolvedValue({ fresh: true, payload: payload(), etag: null })

    await openTracking()

    // Both the Asset completeness card and the confirmation donut's slot.
    expect(await screen.findAllByText('No accepted speakers yet.')).toHaveLength(2)
    expect(screen.queryByText('Every accepted speaker has a bio, headshot and slides.')).toBeNull()
  })

  it('keeps the green assertion when accepted speakers exist and none are missing assets', async () => {
    fetchDashboardMock.mockResolvedValue({
      fresh: true,
      payload: payload({ accepted_speakers: 3, confirmation: { confirmed: 2, awaiting: 1 }, assets: [] }),
      etag: null,
    })

    await openTracking()

    expect(await screen.findByText('Every accepted speaker has a bio, headshot and slides.')).toBeTruthy()
    expect(screen.queryByText('No accepted speakers yet.')).toBeNull()
  })
})

describe('Organisation board Events table', () => {
  it('renders event dates as the local-day range, not the UTC dates', async () => {
    const org: OrgDashboardPayload = {
      now: new Date().toISOString(),
      org: { id: 'org-1', name: 'Contoso Events' },
      kpis: {
        total_contacts: 0, new_contacts_30d: 0, contacts_on_events: 0,
        contacts_no_event: 0, returning_speakers: 0, events: 1,
      },
      top_companies: [],
      events: [{
        id: 'ev-1', name: 'DevOps Days', slug: 'devops', timezone: 'America/Los_Angeles',
        starts_at: '2027-05-12T07:00:00.000Z', ends_at: '2027-05-15T06:59:59.999Z',
        agenda_published: 1, submissions: 4, accepted: 2, scheduled: 1,
      }],
    }
    fetchOrgDashboardMock.mockResolvedValue({ fresh: true, payload: org, etag: null })
    const scope = { filter: 'all', setFilter: () => {} } as unknown as EventScopeValue

    render(
      <EventScopeProvider value={scope}>
        <DashboardSection onNavigate={() => {}} />
      </EventScopeProvider>,
    )

    // Ends 23:59:59 local on Fri May 14 (= May 15 in UTC): the last local
    // day is what the sidebar and public day tabs show, and the range here
    // must agree with them.
    expect(await screen.findByText('May 12, 2027 – May 14, 2027')).toBeTruthy()
  })
})

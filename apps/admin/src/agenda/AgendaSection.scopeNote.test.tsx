// Eval defect: the sidebar event filter could sit on "All events" while the
// Agenda kept editing one event with nothing naming the divergence. Every
// other per-event surface renders EventScopeNote ("this screen is bound to
// one" caveat); the agenda now renders it too — from inside the section, since
// App.tsx mounts AgendaSection bare.
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/preact'

// jsdom has no matchMedia; same stub as DataTabManager.activate.test.tsx.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as never
  }
})

const { getAgendaMock, listFormatsMock } = vi.hoisted(() => ({
  getAgendaMock: vi.fn(),
  listFormatsMock: vi.fn(),
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return { ...actual, getAgenda: getAgendaMock, listFormats: listFormatsMock }
})

import { AgendaSection } from './AgendaSection'
import { EventScopeProvider, type EventScopeValue } from '../eventScope'

const payload = {
  event: {
    id: 'evt-1',
    name: 'Forward Summit',
    slug: 'forward-summit',
    timezone: 'UTC',
    starts_at: '2026-10-01T08:00:00Z',
    ends_at: '2026-10-01T18:00:00Z',
    location: null,
    agenda_published: 0,
  },
  rooms: [],
  tracks: [],
  sessions: [],
  conflicts: [],
}

const scope = (filter: 'all' | string): EventScopeValue =>
  ({
    me: {} as never,
    filter,
    currentEventId: 'evt-1',
    currentEvent: { id: 'evt-1', name: 'Forward Summit', slug: 'forward-summit', timezone: 'UTC' } as never,
    events: [{ id: 'evt-1', name: 'Forward Summit', slug: 'forward-summit' } as never],
    setFilter: vi.fn(),
    refreshMe: vi.fn(),
    switching: false,
  }) as EventScopeValue

beforeEach(() => {
  getAgendaMock.mockReset()
  listFormatsMock.mockReset()
  getAgendaMock.mockResolvedValue(payload)
  listFormatsMock.mockResolvedValue({ items: [] })
  // EventScopeNote suppresses itself on all+dashboard, and jsdom's default
  // URL parses as v=dashboard — put the router on the agenda screen.
  window.history.replaceState(null, '', '/app?v=agenda')
})

describe('AgendaSection — event scope note', () => {
  it('names its bound event and the all-events caveat when the filter says All events', async () => {
    render(
      <EventScopeProvider value={scope('all')}>
        <AgendaSection initialView="list" />
      </EventScopeProvider>,
    )
    // The note pins the event…
    const note = await screen.findByText('Forward Summit', { selector: 'strong' })
    expect(note).toBeTruthy()
    // …and carries the same caveat wording as the other per-event surfaces.
    expect(
      screen.getByText(/this screen is bound to one, and shows the current one/),
    ).toBeTruthy()
  })

  it('shows the event line without the caveat when the filter matches', async () => {
    render(
      <EventScopeProvider value={scope('evt-1')}>
        <AgendaSection initialView="list" />
      </EventScopeProvider>,
    )
    expect(await screen.findByText('Forward Summit', { selector: 'strong' })).toBeTruthy()
    expect(screen.queryByText(/this screen is bound to one/)).toBeNull()
  })

  it('still renders standalone (tests, storybook) with no provider', async () => {
    render(<AgendaSection initialView="list" />)
    expect(await screen.findByText(/Manage your event agenda/)).toBeTruthy()
    expect(screen.queryByText(/this screen is bound to one/)).toBeNull()
  })
})

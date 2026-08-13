// Settings history panel: renders each snapshot's OWN fields (a rooms/tracks
// revision must not display as nine "(empty)" event fields), and offers
// Restore only when the snapshot carries fields the events PATCH can write.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'

const { getEventRevisionsMock, patchEventMock, appConfirmMock } = vi.hoisted(() => ({
  getEventRevisionsMock: vi.fn(),
  patchEventMock: vi.fn(),
  appConfirmMock: vi.fn(),
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return { ...actual, getEventRevisions: getEventRevisionsMock, patchEvent: patchEventMock }
})

vi.mock('../components/dialogs', async () => {
  const actual = await vi.importActual<typeof import('../components/dialogs')>('../components/dialogs')
  return { ...actual, appConfirm: appConfirmMock }
})

import { SettingsHistory } from './SettingsHistory'

const roomsRevision = {
  id: 'rev-rooms',
  fields: { rooms: 'Main Hall (capacity 120)', tracks: null },
  edited_by: 'c1',
  edited_by_name: 'Ada',
  source: 'admin' as const,
  edited_at: '2026-08-13T10:00:00Z',
}

const settingsRevision = {
  id: 'rev-settings',
  fields: { name: 'Old Name', slug: 'old-slug', type: 'conference', website_url: null, location: null, timezone: 'UTC', description: null, starts_at: '2026-10-01T08:00:00Z', ends_at: '2026-10-02T18:00:00Z' },
  edited_by: 'c1',
  edited_by_name: 'Ada',
  source: 'admin' as const,
  edited_at: '2026-08-12T09:00:00Z',
}

beforeEach(() => {
  getEventRevisionsMock.mockReset()
  patchEventMock.mockReset()
  appConfirmMock.mockReset()
})

describe('SettingsHistory', () => {
  it('keeps the empty-state wording when nothing is recorded', async () => {
    getEventRevisionsMock.mockResolvedValue({ items: [] })
    render(<SettingsHistory eventId="evt-1" />)
    expect(
      await screen.findByText('No settings edits recorded — the event settings are as first configured.'),
    ).toBeTruthy()
  })

  it('shows a rooms/tracks revision with its own fields and no Restore', async () => {
    getEventRevisionsMock.mockResolvedValue({ items: [roomsRevision] })
    render(<SettingsHistory eventId="evt-1" />)

    fireEvent.click(await screen.findByText('Before this edit'))
    expect(screen.getByText('Rooms')).toBeTruthy()
    expect(screen.getByText('Main Hall (capacity 120)')).toBeTruthy()
    // No event fields invented for a snapshot that never carried them.
    expect(screen.queryByText('Slug')).toBeNull()
    expect(screen.queryByText('Restore')).toBeNull()
    expect(screen.getByText('Recorded')).toBeTruthy()
  })

  it('restores an event-fields revision through the events PATCH', async () => {
    getEventRevisionsMock.mockResolvedValue({ items: [settingsRevision] })
    appConfirmMock.mockResolvedValue(true)
    patchEventMock.mockResolvedValue({ ok: true })

    render(<SettingsHistory eventId="evt-1" />)
    fireEvent.click(await screen.findByText('Restore'))

    await waitFor(() => expect(patchEventMock).toHaveBeenCalledWith('evt-1', settingsRevision.fields))
    expect(await screen.findByText('Restored. The replaced content was added to the history.')).toBeTruthy()
  })
})

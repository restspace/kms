// Green room section (workplan 12): lanes derive now/next from the payload,
// check-in flips optimistically and reverts on failure, and the empty states
// point somewhere useful instead of rendering a blank board.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'
import { fireEvent } from '@testing-library/preact'

const fetchGreenRoom = vi.fn()
const greenroomCheckin = vi.fn()
const greenroomNudge = vi.fn()
const greenroomIntroScript = vi.fn()

vi.mock('../api', () => ({
  fetchGreenRoom: (...a: unknown[]) => fetchGreenRoom(...a),
  greenroomCheckin: (...a: unknown[]) => greenroomCheckin(...a),
  greenroomNudge: (...a: unknown[]) => greenroomNudge(...a),
  greenroomIntroScript: (...a: unknown[]) => greenroomIntroScript(...a),
  // W6/D10: plain download links — a static path, not worth a fetch mock.
  showflowExportUrl: (format: string) => `/app/api/greenroom/showflow.${format}`,
}))

import { GreenRoomSection } from './GreenRoomSection'
import type { GreenRoomPayload } from '../api'

// Sessions are placed relative to the real clock so no timer mocking is
// needed: "on now" spans now±30min, "up next" starts in 90min.
const NOW = Date.now()
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString()

const payload = (): GreenRoomPayload => ({
  now: iso(0),
  event: {
    id: 'evt-1', name: 'TestConf', slug: 'testconf', timezone: 'UTC',
    starts_at: iso(-24 * 60), ends_at: iso(24 * 60),
  },
  rooms: [
    { id: 'room-a', name: 'Main Stage' },
    { id: 'room-b', name: 'Workshop Room' },
  ],
  sessions: [
    {
      id: 's-now', code: 'SESS-1', title: 'Live on stage', format: 'Talk', track_name: 'AI',
      room_id: 'room-a', starts_at: iso(-30), ends_at: iso(30), speaker_ids: ['c-1'], intro_script: null,
    },
    {
      id: 's-next', code: 'SESS-2', title: 'Coming right up', format: null, track_name: null,
      room_id: 'room-a', starts_at: iso(90), ends_at: iso(150), speaker_ids: ['c-2'], intro_script: null,
    },
  ],
  speakers: {
    'c-1': {
      name: 'Ada Onstage', email: 'ada@example.com', mobile_phone: '+1 (555)123-4567',
      arrived_at: null, on_roster: true, missing_bio: 0, missing_headshot: 0, missing_slides: 1, outstanding: 1,
    },
    'c-2': {
      name: 'Grace Next', email: 'grace@example.com', mobile_phone: null,
      arrived_at: iso(-120), on_roster: true, missing_bio: 0, missing_headshot: 0, missing_slides: 0, outstanding: 0,
    },
  },
})

beforeEach(() => {
  fetchGreenRoom.mockReset()
  greenroomCheckin.mockReset()
  greenroomNudge.mockReset()
  greenroomIntroScript.mockReset()
})

describe('GreenRoomSection', () => {
  it('renders room lanes with on-now and up-next derived from the payload', async () => {
    fetchGreenRoom.mockResolvedValue({ fresh: true, payload: payload(), etag: '"r1"' })
    render(<GreenRoomSection />)

    await waitFor(() => expect(screen.getByText('Live on stage')).toBeTruthy())
    expect(screen.getByText('Main Stage')).toBeTruthy()
    expect(screen.getByText('On now')).toBeTruthy()
    expect(screen.getByText('Up next')).toBeTruthy()
    expect(screen.getByText('Coming right up')).toBeTruthy()
    // Readiness chip and phone affordance for the on-now speaker.
    expect(screen.getByText('slides missing')).toBeTruthy()
    const call = screen.getByText('Call') as HTMLAnchorElement
    expect(call.getAttribute('href')).toBe('tel:+15551234567')
    // Grace arrived earlier; the empty room folds to a muted line.
    expect(screen.getByText(/^Arrived /)).toBeTruthy()
    expect(screen.getByText('Workshop Room: nothing scheduled')).toBeTruthy()
  })

  it('flips check-in optimistically and adopts the server payload', async () => {
    fetchGreenRoom.mockResolvedValue({ fresh: true, payload: payload(), etag: '"r1"' })
    let resolveCheckin: (v: unknown) => void = () => {}
    greenroomCheckin.mockReturnValue(new Promise((resolve) => { resolveCheckin = resolve }))
    render(<GreenRoomSection />)
    await waitFor(() => expect(screen.getByText('Live on stage')).toBeTruthy())

    fireEvent.click(screen.getByText('Not arrived'))
    // Optimistic: reads as arrived before the POST resolves.
    expect(screen.getAllByText(/^Arrived /).length).toBe(2)
    expect(greenroomCheckin).toHaveBeenCalledWith('c-1', true)

    const server = payload()
    server.speakers['c-1'].arrived_at = iso(0)
    resolveCheckin({ ok: true, etag: '"r2"', ...server })
    await waitFor(() => expect(screen.getAllByText(/^Arrived /).length).toBe(2))
  })

  it('reverts the flip and surfaces the error when check-in fails', async () => {
    fetchGreenRoom.mockResolvedValue({ fresh: true, payload: payload(), etag: '"r1"' })
    greenroomCheckin.mockRejectedValue(new Error('The record no longer exists.'))
    render(<GreenRoomSection />)
    await waitFor(() => expect(screen.getByText('Live on stage')).toBeTruthy())

    fireEvent.click(screen.getByText('Not arrived'))
    await waitFor(() => expect(screen.getByText('The record no longer exists.')).toBeTruthy())
    expect(screen.getByText('Not arrived')).toBeTruthy()
  })

  it('sends a nudge and reports the outcome inline', async () => {
    fetchGreenRoom.mockResolvedValue({ fresh: true, payload: payload(), etag: '"r1"' })
    greenroomNudge.mockResolvedValue({ ok: true, sent: 1, duplicates: 0 })
    render(<GreenRoomSection />)
    await waitFor(() => expect(screen.getByText('Live on stage')).toBeTruthy())

    fireEvent.click(screen.getByText('Nudge'))
    await waitFor(() => expect(screen.getByText('reminder sent')).toBeTruthy())
    expect(greenroomNudge).toHaveBeenCalledWith('c-1')
  })

  it('saves an edited intro script and exposes the show-flow export links', async () => {
    fetchGreenRoom.mockResolvedValue({ fresh: true, payload: payload(), etag: '"r1"' })
    let resolveSave: (v: unknown) => void = () => {}
    greenroomIntroScript.mockReturnValue(new Promise((resolve) => { resolveSave = resolve }))
    render(<GreenRoomSection />)
    await waitFor(() => expect(screen.getByText('Live on stage')).toBeTruthy())

    // W6/D10: the export is a plain link, not a fetch-driven control.
    const csvLink = screen.getByText('Show flow (CSV)') as HTMLAnchorElement
    expect(csvLink.getAttribute('href')).toBe('/app/api/greenroom/showflow.csv')
    expect((screen.getByText('Show flow (XLSX)') as HTMLAnchorElement).getAttribute('href')).toBe(
      '/app/api/greenroom/showflow.xlsx',
    )

    const [introField] = screen.getAllByLabelText('Intro script') as HTMLTextAreaElement[]
    fireEvent.input(introField, { target: { value: 'Please welcome our next speaker.' } })
    const [saveButton] = screen.getAllByText('Save intro') as HTMLButtonElement[]
    expect(saveButton.disabled).toBe(false)
    fireEvent.click(saveButton)
    expect(greenroomIntroScript).toHaveBeenCalledWith('s-now', 'Please welcome our next speaker.')

    const server = payload()
    server.sessions[0]!.intro_script = 'Please welcome our next speaker.'
    resolveSave({ ok: true, etag: '"r2"', ...server })
    await waitFor(() => expect(saveButton.disabled).toBe(true))
  })

  it('points at the agenda when nothing is scheduled', async () => {
    const empty = payload()
    empty.sessions = []
    fetchGreenRoom.mockResolvedValue({ fresh: true, payload: empty, etag: '"r1"' })
    render(<GreenRoomSection />)
    await waitFor(() => expect(screen.getByText(/Nothing is scheduled yet/)).toBeTruthy())
    expect(screen.getByText('Open the agenda')).toBeTruthy()
  })

  it('falls forward to the next day with sessions when today is empty', async () => {
    const future = payload()
    // Move everything to the day after tomorrow.
    future.sessions = future.sessions.map((s) => ({
      ...s,
      starts_at: new Date(NOW + 48 * 3600_000).toISOString(),
      ends_at: new Date(NOW + 49 * 3600_000).toISOString(),
    }))
    fetchGreenRoom.mockResolvedValue({ fresh: true, payload: future, etag: '"r1"' })
    render(<GreenRoomSection />)
    await waitFor(() => expect(screen.getByText(/Nothing scheduled today — showing/)).toBeTruthy())
    expect(screen.getByText('Live on stage')).toBeTruthy()
  })
})

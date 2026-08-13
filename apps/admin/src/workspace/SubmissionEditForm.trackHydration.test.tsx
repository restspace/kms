/**
 * #29 (eval defect): the Edit Submission form's Track select initially shows
 * "— No track —" even though the submission has a real track (e.g. "Platform
 * & Infra") — a race where `fields.track_id` is seeded synchronously from
 * `initialValues.track_id` but the `<select>`'s option list (`tracks`, from
 * `listTracks()`) is still empty on first paint. With no <option> whose value
 * matches, the browser falls back to displaying the first option, "— No
 * track —", even though React's `value` prop was already correct.
 *
 * Fix: extras.tsx's SubmissionEditForm renders a synthetic "Loading…" option
 * for the current track_id until `listTracks()` resolves, so the field never
 * visually reads as "no track" while data is still in flight.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'

const api = vi.hoisted(() => ({
  getSubmissionDetail: vi.fn(),
  updateSubmission: vi.fn(),
  listTracks: vi.fn(),
  listRooms: vi.fn(),
  listFormats: vi.fn(),
}))

vi.mock('../api', () => ({
  PARTICIPANT_ROLES: ['speaker', 'co-speaker', 'moderator', 'panelist', 'co-author', 'co-presenter'],
  getSubmissionDetail: api.getSubmissionDetail,
  updateSubmission: api.updateSubmission,
  updateSubmissionStatus: vi.fn(),
  addSubmissionParticipant: vi.fn(),
  removeSubmissionParticipant: vi.fn(),
  updateSubmissionParticipantRole: vi.fn(),
  setSubmissionParticipantConfirmed: vi.fn(),
  queryResource: () => vi.fn(),
  listTracks: api.listTracks,
  listRooms: api.listRooms,
  listFormats: api.listFormats,
}))

vi.mock('../components/dialogs', () => ({
  appConfirm: async () => true,
  appAlert: async () => undefined,
}))

vi.mock('./FilePanels', () => ({
  SubmissionFilesPanel: () => <div data-testid="files-panel" />,
}))

import { SubmissionEditForm } from './extras'

const EVENT_TRACKS = [
  { id: 'trk-1', name: 'AI Engineering', color: null },
  { id: 'trk-2', name: 'Platform & Infra', color: null },
]

const detailWith = (submission: Record<string, unknown>) => ({
  submission: { id: 'sub-1', room_id: null, ...submission },
  answers: [],
  participants: [],
  reviews: [],
  tags: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  api.listRooms.mockResolvedValue({ items: [] })
  api.listFormats.mockResolvedValue({ items: [] })
})

describe('SubmissionEditForm — Track select hydration race (#29)', () => {
  it('never shows "— No track —" for a submission that has a track, even before listTracks() resolves', async () => {
    let resolveTracks: (v: { items: typeof EVENT_TRACKS }) => void = () => {}
    api.listTracks.mockReturnValue(new Promise((resolve) => { resolveTracks = resolve }))
    api.getSubmissionDetail.mockResolvedValue(detailWith({ track_id: 'trk-2' }))

    render(
      <SubmissionEditForm
        initialValues={{ id: 'sub-1', title: 'A talk', track_id: 'trk-2' }}
        onSubmit={vi.fn(async () => true)}
        onCancel={() => {}}
        title="Edit"
      />,
    )

    // Before listTracks() has resolved, the select's underlying value is
    // still the real track id — never silently falls back to "" ("— No
    // track —"'s value).
    const select = screen.getByLabelText('Track') as HTMLSelectElement
    expect(select.value).toBe('trk-2')
    expect(select.value).not.toBe('')

    resolveTracks({ items: EVENT_TRACKS })
    await waitFor(() => expect(select.value).toBe('trk-2'))
    // Once the real list has loaded, the synthetic placeholder is gone and
    // the actual track name is selectable/visible.
    expect(screen.getByRole('option', { name: 'Platform & Infra' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Loading…' })).toBeNull()
  })

  it('saving before listTracks() resolves does not clobber the stored track', async () => {
    api.listTracks.mockReturnValue(new Promise(() => {})) // never resolves in this test
    api.getSubmissionDetail.mockResolvedValue(detailWith({ track_id: 'trk-2' }))
    const onSubmit = vi.fn(async (_payload: Record<string, unknown>) => true)

    render(
      <SubmissionEditForm
        initialValues={{ id: 'sub-1', title: 'A talk', track_id: 'trk-2' }}
        onSubmit={onSubmit}
        onCancel={() => {}}
        title="Edit"
      />,
    )
    await waitFor(() => expect(api.getSubmissionDetail).toHaveBeenCalled())

    const { userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    // track_id is untouched (equal to what the record loaded with), so it's
    // correctly omitted from the payload rather than sent as null/"".
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('track_id')
  })
})

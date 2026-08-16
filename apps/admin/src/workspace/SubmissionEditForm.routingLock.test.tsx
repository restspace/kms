/**
 * The Track answer is a routing INPUT as well as a routed output: a form's
 * routing rules can key off it, and once the submission is past a decision
 * the API refuses to change it (`routing_locked`, migration 0046). The picker
 * must not offer a choice that comes back a 400 — it disables itself and says
 * why, from `detail.routing.locked_track`.
 *
 * The server check is the guard; this is only the affordance, so the test is
 * about what the organiser sees, not about what gets written.
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

const LOCKED_REASON =
  'This answer decides how the proposal was routed, and can no longer change now that a decision is under way.'

const detailWith = (routing: Record<string, unknown> | undefined) => ({
  submission: { id: 'sub-1', room_id: null, track_id: 'trk-1' },
  answers: [],
  participants: [],
  reviews: [],
  tags: [],
  routing,
})

const renderForm = () =>
  render(
    <SubmissionEditForm
      initialValues={{ id: 'sub-1', title: 'A talk', track_id: 'trk-1' }}
      onSubmit={vi.fn(async () => true)}
      onCancel={() => {}}
      title="Edit"
    />,
  )

beforeEach(() => {
  vi.clearAllMocks()
  api.listTracks.mockResolvedValue({ items: EVENT_TRACKS })
  api.listRooms.mockResolvedValue({ items: [] })
  api.listFormats.mockResolvedValue({ items: [] })
})

describe('SubmissionEditForm — a frozen routing input', () => {
  it('disables the Track picker and explains why', async () => {
    api.getSubmissionDetail.mockResolvedValue(
      detailWith({ applied: [], used_fallback: false, locked_track: true, locked_reason: LOCKED_REASON }),
    )
    renderForm()

    const select = await screen.findByLabelText('Track')
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(true))
    expect(await screen.findByText(new RegExp('decides how the proposal was routed'))).toBeTruthy()
  })

  it('leaves the picker alone while the submission can still be re-routed', async () => {
    api.getSubmissionDetail.mockResolvedValue(
      detailWith({ applied: ['Format is “Talk”'], used_fallback: false, locked_track: false, locked_reason: null }),
    )
    renderForm()

    await waitFor(() => expect(api.getSubmissionDetail).toHaveBeenCalled())
    const select = await screen.findByLabelText('Track')
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false))
  })

  it('leaves the picker alone when the API says nothing about routing at all', async () => {
    api.getSubmissionDetail.mockResolvedValue(detailWith(undefined))
    renderForm()

    await waitFor(() => expect(api.getSubmissionDetail).toHaveBeenCalled())
    const select = await screen.findByLabelText('Track')
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false))
  })
})

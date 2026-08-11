/**
 * CNT eval defect: "Editing/saving a submission silently wipes its Track: the
 * stored value ('Infra & Serving') is absent from the edit form's picklist, so
 * the select defaults to '— No track —' and the save overwrites the stored
 * track to blank."
 *
 * Root cause — the Track picker can only offer the *event's* tracks
 * (GET /app/api/tracks), but a CFP form's Track question carries its own
 * option list. When those disagree (the seeded "Call for Speakers 2026" form
 * offers Agents / Evals / RAG & Retrieval / Infra & Serving / AI in
 * Production while the event's tracks are AI Engineering / Platform & Infra /
 * Developer Experience) the stored value has no option to select, so the
 * control shows "— No track —" through no choice of the organiser's — and the
 * save sent `track_id` unconditionally, overwriting the column with NULL on
 * any unrelated edit.
 *
 * Fix: `track_id` is only sent when it differs from the value the record was
 * loaded with, and PUT /submissions/:id updates per key present in the body,
 * so omitting it leaves the column alone. A deliberate change — including the
 * answer-backfill effect — still writes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'
import { userEvent } from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  getSubmissionDetail: vi.fn(),
  updateSubmission: vi.fn(),
  listTracks: vi.fn(),
  listRooms: vi.fn(),
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
}))

vi.mock('../components/dialogs', () => ({
  appConfirm: async () => true,
  appAlert: async () => undefined,
}))

vi.mock('./FilePanels', () => ({
  SubmissionFilesPanel: () => <div data-testid="files-panel" />,
}))

import { SubmissionEditForm } from './extras'

/** The event's tracks — deliberately disjoint from the form's option list. */
const EVENT_TRACKS = [
  { id: 'trk-1', name: 'AI Engineering', color: null },
  { id: 'trk-2', name: 'Platform & Infra', color: null },
]

const detailWith = (submission: Record<string, unknown>, answers: Array<{ label: string; value_json: string | null }> = []) => ({
  submission: { id: 'sub-1', room_id: null, ...submission },
  answers,
  participants: [],
  reviews: [],
  tags: [],
})

const renderForm = (
  initialValues: Record<string, unknown>,
  onSubmit = vi.fn(async (_data: Record<string, unknown>) => true),
) => {
  render(
    <SubmissionEditForm
      initialValues={{ id: 'sub-1', title: 'A talk', ...initialValues }}
      onSubmit={onSubmit}
      onCancel={() => {}}
      title="Edit"
    />,
  )
  return onSubmit
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listTracks.mockResolvedValue({ items: EVENT_TRACKS })
  api.listRooms.mockResolvedValue({ items: [] })
})

describe('SubmissionEditForm — Track is not wiped by an unrelated save', () => {
  it('omits track_id when the stored track has no option in the picker', async () => {
    api.getSubmissionDetail.mockResolvedValue(
      detailWith({ track_id: 'trk-unlisted' }, [{ label: 'Track', value_json: JSON.stringify('Infra & Serving') }]),
    )
    const onSubmit = renderForm({ track_id: 'trk-unlisted' })

    await waitFor(() => expect(api.getSubmissionDetail).toHaveBeenCalled())
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('track_id')
  })

  it('explains the unmatched submitted answer instead of showing a bare no-track', async () => {
    api.getSubmissionDetail.mockResolvedValue(
      detailWith({ track_id: null }, [{ label: 'Track', value_json: JSON.stringify('Infra & Serving') }]),
    )
    renderForm({ track_id: null })

    expect(await screen.findByText(/Infra & Serving/)).toBeTruthy()
    expect(await screen.findByText(/not one of this event/i)).toBeTruthy()
  })

  it('still writes track_id when the organiser picks a different track', async () => {
    api.getSubmissionDetail.mockResolvedValue(detailWith({ track_id: 'trk-1' }))
    const onSubmit = renderForm({ track_id: 'trk-1' })

    await waitFor(() => expect(api.getSubmissionDetail).toHaveBeenCalled())
    await userEvent.selectOptions(screen.getByLabelText('Track'), 'trk-2')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ track_id: 'trk-2' })
  })

  it('still writes a deliberate clear to no-track', async () => {
    api.getSubmissionDetail.mockResolvedValue(detailWith({ track_id: 'trk-1' }))
    const onSubmit = renderForm({ track_id: 'trk-1' })

    await waitFor(() => expect(api.getSubmissionDetail).toHaveBeenCalled())
    await userEvent.selectOptions(screen.getByLabelText('Track'), '')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ track_id: null })
  })

  it('still backfills track_id from the answer when it does match an event track', async () => {
    api.getSubmissionDetail.mockResolvedValue(
      detailWith({ track_id: null }, [{ label: 'Track', value_json: JSON.stringify('Platform & Infra') }]),
    )
    const onSubmit = renderForm({ track_id: null })

    await waitFor(() => expect(api.getSubmissionDetail).toHaveBeenCalled())
    await waitFor(() => {
      const select = screen.getByLabelText('Track') as HTMLSelectElement
      expect(select.value).toBe('trk-2')
    })
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ track_id: 'trk-2' })
  })
})

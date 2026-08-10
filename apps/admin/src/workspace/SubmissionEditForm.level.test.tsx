/**
 * Manual-review item (O4/item 3): "Level" showed blank in the organiser edit
 * form for a submitted record even though the submitter answered it on the
 * public form. Root cause — `submissions.level` is only populated when the
 * form's question is wired to the canonical `level` field_key
 * (systemColumns() in submit.tsx); a question built via FormBuilder's
 * "Create Field" flow and merely *labeled* "Level" gets its own `custom_*`
 * key, so the answer only ever lands in `submission_answers` — which the
 * read-only detail panel already surfaces (SubmissionDetailPanel reads
 * `detail.answers` by label), but the edit form did not: it only read the
 * `level` column off the grid row.
 *
 * Fix: SubmissionEditForm's detail-load effect now falls back to the
 * matching `detail.answers` entry (matched by label, case-insensitive) when
 * the column itself comes back empty.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'

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

// The files sub-panel does its own fetching and is not under test here (same
// stand-in SubmissionDetailPanel.test.tsx uses).
vi.mock('./FilePanels', () => ({
  SubmissionFilesPanel: () => <div data-testid="files-panel" />,
}))

import { SubmissionEditForm } from './extras'

const baseDetail = (answers: Array<{ label: string; value_json: string | null }>) => ({
  submission: { id: 'sub-1', room_id: null },
  answers,
  participants: [],
  reviews: [],
  tags: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  api.listTracks.mockResolvedValue({ items: [] })
  api.listRooms.mockResolvedValue({ items: [] })
})

describe('SubmissionEditForm — Level field-mapping fallback', () => {
  it('falls back to the answers-list value when submissions.level is empty (custom-keyed question)', async () => {
    api.getSubmissionDetail.mockResolvedValue(
      baseDetail([{ label: 'Level', value_json: JSON.stringify('Advanced') }]),
    )
    render(
      <SubmissionEditForm
        initialValues={{ id: 'sub-1', title: 'A talk', level: undefined }}
        onSubmit={async () => true}
        onCancel={() => {}}
        title="Edit"
      />,
    )

    await waitFor(() => {
      const input = screen.getByLabelText('Level') as HTMLInputElement
      expect(input.value).toBe('Advanced')
    })
  })

  it('leaves the field untouched when submissions.level is already populated', async () => {
    api.getSubmissionDetail.mockResolvedValue(
      baseDetail([{ label: 'Level', value_json: JSON.stringify('Beginner') }]),
    )
    render(
      <SubmissionEditForm
        initialValues={{ id: 'sub-1', title: 'A talk', level: 'Intermediate' }}
        onSubmit={async () => true}
        onCancel={() => {}}
        title="Edit"
      />,
    )

    await screen.findByText('A talk', { exact: false }).catch(() => undefined)
    await waitFor(() => expect(api.getSubmissionDetail).toHaveBeenCalled())
    const input = screen.getByLabelText('Level') as HTMLInputElement
    expect(input.value).toBe('Intermediate')
  })

  it('stays empty when neither the column nor any answer has a level value', async () => {
    api.getSubmissionDetail.mockResolvedValue(baseDetail([]))
    render(
      <SubmissionEditForm
        initialValues={{ id: 'sub-1', title: 'A talk' }}
        onSubmit={async () => true}
        onCancel={() => {}}
        title="Edit"
      />,
    )

    await waitFor(() => expect(api.getSubmissionDetail).toHaveBeenCalled())
    const input = screen.getByLabelText('Level') as HTMLInputElement
    expect(input.value).toBe('')
  })
})

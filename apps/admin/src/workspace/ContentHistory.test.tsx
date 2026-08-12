/**
 * Content history section (eval defect: content_revisions existed server-side
 * with zero UI, so title/abstract edits looked untraceable and irreversible).
 * Pins the two behaviours: the list renders each pre-edit snapshot with
 * author/time/source, and Restore writes the snapshot back through the normal
 * updateSubmission PUT (which snapshots the replaced content itself).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'

const api = vi.hoisted(() => ({
  getSubmissionRevisions: vi.fn(),
  updateSubmission: vi.fn(),
}))

vi.mock('../api', () => ({
  getSubmissionRevisions: api.getSubmissionRevisions,
  updateSubmission: api.updateSubmission,
  // Unused by ContentHistorySection but imported by the module.
  PARTICIPANT_ROLES: [],
  addSubmissionComment: vi.fn(),
  addSubmissionParticipant: vi.fn(),
  getSubmissionDetail: vi.fn(),
  listRooms: async () => ({ items: [] }),
  listTracks: async () => ({ items: [] }),
  queryResource: () => vi.fn(),
  removeSubmissionParticipant: vi.fn(),
  setSubmissionParticipantConfirmed: vi.fn(),
  updateSubmissionApproval: vi.fn(),
  updateSubmissionNotes: vi.fn(),
  updateSubmissionParticipantRole: vi.fn(),
  updateSubmissionStatus: vi.fn(),
}))

vi.mock('./FilePanels', () => ({
  SubmissionFilesPanel: () => null,
}))

vi.mock('../components/dialogs', () => ({
  appConfirm: vi.fn(async () => true),
}))

import { ContentHistorySection } from './extras'

const REVISION = {
  id: 'rev-1',
  title: 'Original title',
  description: 'Original abstract',
  edited_by: 'c-1',
  edited_by_name: 'Priya Raman',
  source: 'portal' as const,
  edited_at: '2026-08-10T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getSubmissionRevisions.mockResolvedValue({ items: [REVISION] })
  api.updateSubmission.mockResolvedValue({})
})

describe('ContentHistorySection', () => {
  it('lists each recorded edit with author and source', async () => {
    render(<ContentHistorySection submissionId="sub-1" />)
    await waitFor(() => expect(api.getSubmissionRevisions).toHaveBeenCalledWith('sub-1'))
    await screen.findByText(/edited by Priya Raman/)
    expect(screen.getByText(/Speaker portal/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
  })

  it('shows the pre-edit snapshot and restores it through updateSubmission', async () => {
    render(<ContentHistorySection submissionId="sub-1" />)
    const showBtn = await screen.findByRole('button', { name: 'Before this edit' })
    showBtn.click()
    await screen.findByText('Original title')

    screen.getByRole('button', { name: 'Restore' }).click()
    await waitFor(() =>
      expect(api.updateSubmission).toHaveBeenCalledWith('sub-1', {
        title: 'Original title',
        description: 'Original abstract',
      }),
    )
    // The list reloads after a restore so the new snapshot row appears.
    expect(api.getSubmissionRevisions).toHaveBeenCalledTimes(2)
  })

  it('says so when no edits are recorded', async () => {
    api.getSubmissionRevisions.mockResolvedValue({ items: [] })
    render(<ContentHistorySection submissionId="sub-2" />)
    await screen.findByText(/No content edits recorded/)
  })
})

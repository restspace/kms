/**
 * Wave E (workplan 14, D8): the contact flavour of the shared history section.
 * Pins that ContactProfileHistory lists a profile snapshot (payload fields,
 * not title/description) and that Restore writes the snapshot back through
 * the normal updateContact PUT with the row's own event_id.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'

const api = vi.hoisted(() => ({
  getContactRevisions: vi.fn(),
  updateContact: vi.fn(),
}))

vi.mock('../api', () => ({
  getContactRevisions: api.getContactRevisions,
  updateContact: api.updateContact,
  getEventRevisions: vi.fn(),
  patchEvent: vi.fn(),
  // Unused by the history components but imported by extras (which
  // entityHistory imports ContentHistorySection from).
  getSubmissionRevisions: vi.fn(),
  updateSubmission: vi.fn(),
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

import { ContactProfileHistory } from './entityHistory'

const REVISION = {
  id: 'rev-1',
  fields: { biography: 'Original bio', company: 'Original Co', job_title: null },
  edited_by: 'c-1',
  edited_by_name: 'Priya Raman',
  source: 'portal' as const,
  edited_at: '2026-08-10T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getContactRevisions.mockResolvedValue({ items: [REVISION] })
  api.updateContact.mockResolvedValue({})
})

describe('ContactProfileHistory', () => {
  it('lists each recorded profile edit with author and source', async () => {
    render(<ContactProfileHistory contactId="con-1" eventId="evt-1" />)
    await waitFor(() => expect(api.getContactRevisions).toHaveBeenCalledWith('con-1', 'evt-1'))
    await screen.findByText(/edited by Priya Raman/)
    expect(screen.getByText(/Speaker portal/)).toBeTruthy()
  })

  it('shows the snapshot fields and restores through updateContact with the row event', async () => {
    render(<ContactProfileHistory contactId="con-1" eventId="evt-1" />)
    const showBtn = await screen.findByRole('button', { name: 'Before this edit' })
    showBtn.click()
    await screen.findByText('Original bio')
    expect(screen.getByText('Original Co')).toBeTruthy()
    // An unset field renders as (empty), not as a missing row.
    expect(screen.getByText('(empty)')).toBeTruthy()

    screen.getByRole('button', { name: 'Restore' }).click()
    await waitFor(() =>
      expect(api.updateContact).toHaveBeenCalledWith('con-1', {
        biography: 'Original bio',
        company: 'Original Co',
        job_title: null,
        event_id: 'evt-1',
      }),
    )
    // The list reloads after a restore so the new snapshot row appears.
    expect(api.getContactRevisions).toHaveBeenCalledTimes(2)
  })

  it('says so when no profile edits are recorded', async () => {
    api.getContactRevisions.mockResolvedValue({ items: [] })
    render(<ContactProfileHistory contactId="con-2" eventId="evt-1" />)
    await screen.findByText(/No profile edits recorded/)
  })
})

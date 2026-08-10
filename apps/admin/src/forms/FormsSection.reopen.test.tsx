// ABS defect (major): "after reopening the closed 'Lightning Talks' form the
// admin Forms panel sometimes showed it Closed again on the next page load,
// requiring repeated attempts." The residual race: the list's Close/Reopen
// button decided its label AND its request body from the raw `status`
// column alone. A form with status='open' but a past close_at (the "status
// duality" case — set via the builder's Close Date field without touching
// Status) is already closed to the public (submit.tsx isFormClosed), but the
// list showed "Open"/"Close" for it, not "Reopen". An admin who wanted to
// reopen it had to click "Close" (no-op for the public, but flips status to
// 'closed') and THEN "Reopen" — two attempts — before the form actually came
// back with a cleared close_at. This drives the real FormsSection (with api.ts
// mocked) to prove a single click on the row now always reopens correctly,
// keyed off *effective* status.

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import type { FormRow } from '../api'

function makeForm(overrides: Partial<FormRow> = {}): FormRow {
  return {
    id: 'form-1',
    internal_name: 'Lightning Talks',
    external_title: 'Lightning Talks',
    page_heading: 'Submit',
    welcome_message: null,
    welcome_message_visible: 0,
    collection_type: 'abstracts',
    collect_participants: 0,
    status: 'open',
    close_at: null,
    submission_limit: null,
    allow_multiple_drafts: 0,
    success_message: null,
    auto_redirect_to_portal: 0,
    routing_rules: null,
    participant_roles: [],
    confirmation_email_enabled: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    submission_count: 0,
    draft_count: 0,
    ...overrides,
  }
}

const { listForms, updateForm, createForm, duplicateForm, deleteForm } = vi.hoisted(() => ({
  listForms: vi.fn(),
  updateForm: vi.fn(async () => ({ form: {} })),
  createForm: vi.fn(),
  duplicateForm: vi.fn(),
  deleteForm: vi.fn(),
}))

vi.mock('../api', () => ({ listForms, updateForm, createForm, duplicateForm, deleteForm }))

import { FormsSection } from './FormsSection'

describe('FormsSection — Reopen keyed off effective status', () => {
  it('a literally-closed form: chip reads "Closed", button reopens in one click, clearing close_at', async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString()
    listForms.mockResolvedValue({ items: [makeForm({ status: 'closed', close_at: past })] })

    render(<FormsSection eventSlug="evt" timezone="UTC" />)
    await screen.findByText('Lightning Talks')
    expect(screen.getByText('Closed')).toBeTruthy()

    fireEvent.click(screen.getByText('Reopen'))
    await waitFor(() => expect(updateForm).toHaveBeenCalledWith('form-1', { status: 'open', close_at: null }))
  })

  it('status duality: status=open but close_at past reads "Closed (by date)" and still offers Reopen, not Close', async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString()
    listForms.mockResolvedValue({ items: [makeForm({ status: 'open', close_at: past })] })

    render(<FormsSection eventSlug="evt" timezone="UTC" />)
    await screen.findByText('Lightning Talks')
    expect(screen.getByText('Closed (by date)')).toBeTruthy()

    // The old bug: raw status is 'open', so the row offered "Close" here —
    // clicking it did nothing for the public form (already closed by date)
    // and required a second Reopen click to actually clear the stale date.
    expect(screen.queryByText('Reopen')).toBeTruthy()
    expect(screen.queryByText('Close')).toBeNull()

    fireEvent.click(screen.getByText('Reopen'))
    // Explicit close_at:null even though raw status was already 'open' — a
    // single click always clears the stale date, regardless of which side of
    // the status/close_at duality caused the closure.
    await waitFor(() => expect(updateForm).toHaveBeenCalledWith('form-1', { status: 'open', close_at: null }))
  })

  it('a genuinely open form (no close_at, or one in the future) offers Close, not Reopen', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    listForms.mockResolvedValue({ items: [makeForm({ status: 'open', close_at: future })] })

    render(<FormsSection eventSlug="evt" timezone="UTC" />)
    await screen.findByText('Lightning Talks')
    expect(screen.getByText('Open')).toBeTruthy()
    expect(screen.getByText('Close')).toBeTruthy()

    fireEvent.click(screen.getByText('Close'))
    await waitFor(() => expect(updateForm).toHaveBeenCalledWith('form-1', { status: 'closed' }))
  })
})

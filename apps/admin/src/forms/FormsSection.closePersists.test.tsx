// CFP defect (major): "closing 'Session Submission Form #2' appears to succeed
// but reverts to Open after reload — reproduced three times."
//
// The write itself was always correct (PUT /app/api/forms/:id stores
// status='closed', verified against the live demo). What went wrong was on the
// list side, and there were two contributing paths:
//
//   1. Every row action ends in reload(), and those list GETs are unordered.
//      Two actions in quick succession start two refetches; if the *older*
//      response lands last it repaints the list with the pre-close status and
//      the closure looks rolled back.
//   2. Close/Reopen is one button whose label and action flip in place, and it
//      stayed live while its own PUT was in flight — so a second click landing
//      on the same element (a double click, or a driver re-using a handle from
//      before the re-render) silently toggled the form straight back open.
//
// Both are fixed here: refetches are sequence-guarded, and the button is
// disabled for the row being written.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import type { FormRow } from '../api'

function makeForm(overrides: Partial<FormRow> = {}): FormRow {
  return {
    id: 'form-2',
    internal_name: 'Session Submission Form #2',
    external_title: 'Session Submission Form #2',
    page_heading: 'Submit',
    welcome_message: null,
    welcome_message_visible: 0,
    collection_type: 'sessions',
    collect_participants: 1,
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
  updateForm: vi.fn(),
  createForm: vi.fn(),
  duplicateForm: vi.fn(),
  deleteForm: vi.fn(),
}))

vi.mock('../api', () => ({ listForms, updateForm, createForm, duplicateForm, deleteForm }))

import { FormsSection } from './FormsSection'

describe('FormsSection — closing a form persists in the list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a stale list response that lands after a newer one does not resurrect "Open"', async () => {
    const open = makeForm({ status: 'open' })
    const closed = makeForm({ status: 'closed', updated_at: '2026-01-02T00:00:00Z' })

    // Refetch #1 (mount) answers immediately with the open row. Refetch #2 — an
    // earlier row action, here a Duplicate — is still in flight and will answer
    // LATE with pre-close data. Refetch #3 (after the close write) answers with
    // the closed row. The sequence guard must let #3 win and drop #2.
    // Boxed rather than a bare `let`: control-flow narrowing decides the
    // variable is still `null` at the call site otherwise (the assignment
    // happens inside a callback the checker cannot order).
    const straggler: { resolve: (() => void) | null } = { resolve: null }
    listForms
      .mockResolvedValueOnce({ items: [open] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            straggler.resolve = () => resolve({ items: [open] })
          }),
      )
      .mockResolvedValue({ items: [closed] })

    updateForm.mockResolvedValue({ form: closed })
    duplicateForm.mockResolvedValue({ form: open })

    render(<FormsSection eventSlug="evt" timezone="UTC" />)
    await screen.findByText('Session Submission Form #2')
    expect(screen.getByText('Open')).toBeTruthy()

    fireEvent.click(screen.getByText('Duplicate'))
    await waitFor(() => expect(listForms).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByText('Close'))
    await waitFor(() => expect(updateForm).toHaveBeenCalledWith('form-2', { status: 'closed' }))
    await waitFor(() => expect(screen.getByText('Closed')).toBeTruthy())

    // The straggler finally answers, with pre-write data.
    straggler.resolve?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByText('Closed')).toBeTruthy()
    expect(screen.queryByText('Open')).toBeNull()
  })

  it('a second click while the status write is in flight cannot toggle the form back open', async () => {
    const open = makeForm({ status: 'open' })
    const closed = makeForm({ status: 'closed', updated_at: '2026-01-02T00:00:00Z' })
    listForms.mockResolvedValue({ items: [open] })

    const write: { settle: (() => void) | null } = { settle: null }
    updateForm.mockImplementation(
      () =>
        new Promise((resolve) => {
          write.settle = () => resolve({ form: closed })
        }),
    )

    render(<FormsSection eventSlug="evt" timezone="UTC" />)
    await screen.findByText('Session Submission Form #2')

    const button = screen.getByText('Close')
    fireEvent.click(button)
    await waitFor(() => expect(updateForm).toHaveBeenCalledTimes(1))

    // Same element, clicked again before the write settles — the label has not
    // flipped yet, so this used to queue a second, contradictory PUT.
    fireEvent.click(button)
    fireEvent.click(button)
    expect(updateForm).toHaveBeenCalledTimes(1)

    write.settle?.()
    await waitFor(() => expect(screen.getByText('Closed')).toBeTruthy())
    expect(updateForm).toHaveBeenCalledTimes(1)
  })
})

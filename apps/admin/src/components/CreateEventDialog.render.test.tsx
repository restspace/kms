// Regression: an eval agent reported the New-event modal's "Create event"
// button could not be activated — "repeated clicks (8s timeouts on fresh
// element references) even after scrolling the modal to the bottom". The
// actual cause turned out to be in dialogs.css: .app-dialog had no
// max-height/overflow, so a tall dialog (this one, with its rooms/tracks
// repeatable fields) could overflow the fixed backdrop with no way to
// scroll to the footer — not a z-index/overlay conflict. This test exercises
// the real rendered dialog end-to-end: fill the required fields, click
// "Create event", and assert the create call fires with the right payload.
// It also covers the Enter-to-submit resilience path from a text field.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'

const { createEvent } = vi.hoisted(() => ({
  createEvent: vi.fn(async () => ({ id: 'evt-new' })),
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return { ...actual, createEvent }
})

import { CreateEventDialog } from './CreateEventDialog'

function fillRequiredFields() {
  fireEvent.input(screen.getByLabelText(/^Name/), { target: { value: 'DevOps Summit' } })
  fireEvent.input(screen.getByLabelText(/^Starts/), { target: { value: '2026-09-01' } })
  fireEvent.input(screen.getByLabelText(/^Ends/), { target: { value: '2026-09-02' } })
}

describe('CreateEventDialog', () => {
  beforeEach(() => {
    createEvent.mockClear()
  })

  it('clicking "Create event" with valid fields fires the create call', async () => {
    const onCreated = vi.fn()
    render(
      <CreateEventDialog open={true} onClose={() => {}} defaultTimezone="UTC" onCreated={onCreated} />,
    )

    fillRequiredFields()

    const submit = screen.getByRole('button', { name: /create event/i })
    expect((submit as HTMLButtonElement).type).toBe('submit')
    // Sanity: the button is enabled and reachable — not disabled, not covered
    // by an ancestor with pointer-events:none.
    expect((submit as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(submit)

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1))
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'DevOps Summit', slug: 'devops-summit' }),
    )
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('evt-new'))
  })

  it('pressing Enter in a text field submits the form (resilience path)', async () => {
    const onCreated = vi.fn()
    render(
      <CreateEventDialog open={true} onClose={() => {}} defaultTimezone="UTC" onCreated={onCreated} />,
    )

    fillRequiredFields()

    const nameField = screen.getByLabelText(/^Name/);
    fireEvent.keyDown(nameField, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('evt-new'))
  })

  it('does not submit when required fields are missing, and surfaces field errors', async () => {
    const onCreated = vi.fn()
    render(
      <CreateEventDialog open={true} onClose={() => {}} defaultTimezone="UTC" onCreated={onCreated} />,
    )

    const submit = screen.getByRole('button', { name: /create event/i })
    fireEvent.click(submit)

    expect(createEvent).not.toHaveBeenCalled()
    expect(await screen.findByText('Name is required.')).toBeTruthy()
  })
})

/**
 * Eval defect #3 (SPK-S1): the inline speaker Status dropdown showed its OLD
 * value while the PUT was in flight (the controlled select only moved once
 * the parent echoed the save back), so a fresh pick looked "reverted to
 * blank" for ~1s and navigating away in that window read as a lost update.
 * Pins the fix: optimistic selection, a visible Saving…/Saved indicator, and
 * revert + error on a failed write.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'

// @testing-library/preact rewrites fireEvent.change to an input event under
// preact/compat, which a <select>'s onChange never sees — dispatch directly
// (same idiom as EvaluationSection.test.tsx).
const pickOption = (select: HTMLSelectElement, value: string) => {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

const { updateContactMock } = vi.hoisted(() => ({
  updateContactMock: vi.fn(),
}))

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return {
    ...actual,
    updateContact: updateContactMock,
  }
})

import { SpeakerStatusControl } from './App'
import type { ContactRow } from './api'

const item = {
  id: 'c-priya',
  event_id: 'evt-1',
  email: 'priya@example.com',
  first_name: 'Priya',
  last_name: 'Raman',
  speaker_status: null,
  created_at: '2026-08-01T00:00:00Z',
} as unknown as ContactRow

beforeEach(() => {
  updateContactMock.mockReset()
})

describe('SpeakerStatusControl', () => {
  it('shows the picked value immediately (optimistic) with a Saving… then Saved indicator', async () => {
    let resolveSave: (v: unknown) => void = () => {}
    updateContactMock.mockImplementation(() => new Promise((resolve) => { resolveSave = resolve }))
    const onUpdated = vi.fn()

    render(<SpeakerStatusControl item={item} options={[]} onUpdated={onUpdated} />)

    const select = screen.getByLabelText(/Status/) as HTMLSelectElement
    expect(select.value).toBe('')
    pickOption(select, 'confirmed')

    // Optimistic: the select reflects the choice before the PUT resolves.
    await waitFor(() => expect(select.value).toBe('confirmed'))
    expect(screen.getByRole('status').textContent).toBe('Saving…')
    expect(onUpdated).not.toHaveBeenCalled()

    resolveSave({})
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved'))
    expect(onUpdated).toHaveBeenCalledWith('confirmed')
    // The write targeted the row's own event membership (F7).
    expect(updateContactMock).toHaveBeenCalledWith('c-priya', {
      speaker_status: 'confirmed',
      event_id: 'evt-1',
    })
    expect(select.value).toBe('confirmed')
  })

  it('reverts the optimistic value and shows the error when the save fails', async () => {
    updateContactMock.mockRejectedValue(new Error('boom'))
    const onUpdated = vi.fn()

    render(<SpeakerStatusControl item={item} options={[]} onUpdated={onUpdated} />)

    const select = screen.getByLabelText(/Status/) as HTMLSelectElement
    pickOption(select, 'declined')

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(select.value).toBe('')
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('lists a custom option once even when it shadows a built-in key', () => {
    render(
      <SpeakerStatusControl
        item={item}
        options={[
          { id: 'sso-1', event_id: 'evt-1', key: 'keynote_hold', label: 'Keynote hold', position: 0 },
          { id: 'sso-2', event_id: 'evt-1', key: 'confirmed', label: 'Confirmed (custom)', position: 1 },
        ]}
        onUpdated={vi.fn()}
      />,
    )
    const select = screen.getByLabelText(/Status/) as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values.filter((v) => v === 'confirmed')).toHaveLength(1)
    expect(values).toContain('keynote_hold')
  })
})

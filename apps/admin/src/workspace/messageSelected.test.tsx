// Eval defect #15: checkbox multi-select on the org directory needs
// somewhere to feed into — this dialog sends through the exact same seam
// SPK-13's compose form uses (`POST /app/api/messaging/compose` with
// `audience: 'selected'`), so a checkbox-driven send is indistinguishable
// server-side from one launched through the compose form's own picker.

import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { MessageSelectedHost, openMessageSelectedDialog } from './messageSelected'

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof api>('../api')
  return {
    ...actual,
    composeMessage: vi.fn(),
    getBulkJob: vi.fn(),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('MessageSelectedHost / openMessageSelectedDialog', () => {
  it('sends the checked contact ids as an explicit "selected" audience and reports the settled counts', async () => {
    vi.mocked(api.composeMessage).mockResolvedValue({ ok: true, job_id: 'job-1', total: 2, audience: 'selected' })
    vi.mocked(api.getBulkJob).mockResolvedValue({
      id: 'job-1', kind: 'compose', status: 'done', total: 2, enqueued: 2, sent: 2, failed: 0, queued: 0,
      error: null, skipped_duplicate: 0,
    } as any)

    render(<MessageSelectedHost />)
    openMessageSelectedDialog({ contactIds: ['con-a', 'con-b'] })

    expect(await screen.findByText('Message 2 selected contacts')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Quick note' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi {{first_name}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to 2' }))

    await waitFor(() =>
      expect(api.composeMessage).toHaveBeenCalledWith({
        subject: 'Quick note',
        body: 'Hi {{first_name}}',
        audience: 'selected',
        contact_ids: ['con-a', 'con-b'],
      }),
    )

    await screen.findByText('2 messages sent.')
  })

  it('requires a subject and a body before sending', async () => {
    render(<MessageSelectedHost />)
    openMessageSelectedDialog({ contactIds: ['con-a'] })
    await screen.findByText('Message 1 selected contact')

    fireEvent.click(screen.getByRole('button', { name: 'Send to 1' }))
    expect((await screen.findByRole('alert')).textContent).toBe('A subject is required.')
    expect(api.composeMessage).not.toHaveBeenCalled()
  })
})

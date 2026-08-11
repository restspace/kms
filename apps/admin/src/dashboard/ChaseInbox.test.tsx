import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'

const {
  getChaseDraftsMock,
  updateChaseDraftMock,
  sendChaseDraftMock,
  sendAllChaseDraftsMock,
  dismissChaseDraftMock,
  escalateChaseDraftMock,
  getChaseSettingsMock,
} = vi.hoisted(() => ({
  getChaseDraftsMock: vi.fn(),
  updateChaseDraftMock: vi.fn(),
  sendChaseDraftMock: vi.fn(),
  sendAllChaseDraftsMock: vi.fn(),
  dismissChaseDraftMock: vi.fn(),
  escalateChaseDraftMock: vi.fn(),
  getChaseSettingsMock: vi.fn(),
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    getChaseDrafts: getChaseDraftsMock,
    updateChaseDraft: updateChaseDraftMock,
    sendChaseDraft: sendChaseDraftMock,
    sendAllChaseDrafts: sendAllChaseDraftsMock,
    dismissChaseDraft: dismissChaseDraftMock,
    escalateChaseDraft: escalateChaseDraftMock,
    getChaseSettings: getChaseSettingsMock,
  }
})

import { ChaseInboxPanel, ChaseModeBanner } from './ChaseInbox'

const draft = (over: Partial<{
  id: string; contact_id: string; contact_name: string; rung: string; subject: string; body: string; staged_at: string
}> = {}) => ({
  id: 'd-1',
  contact_id: 'c-1',
  contact_email: 'speaker@example.com',
  contact_name: 'Ada Speaker',
  subject_of: 'task',
  subject_id: 's-1',
  rung: 'tool_email',
  status: 'staged',
  subject: 'Please upload your slides',
  body: 'Hi Ada, your slides are due.',
  staged_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  acted_at: null,
  acted_by: null,
  ...over,
})

beforeEach(() => {
  getChaseDraftsMock.mockReset()
  updateChaseDraftMock.mockReset()
  sendChaseDraftMock.mockReset()
  sendAllChaseDraftsMock.mockReset()
  dismissChaseDraftMock.mockReset()
  escalateChaseDraftMock.mockReset()
  getChaseSettingsMock.mockReset()
  window.localStorage.clear()
})

describe('ChaseInboxPanel', () => {
  it('renders staged drafts grouped by speaker', async () => {
    getChaseDraftsMock.mockResolvedValue({
      items: [
        draft({ id: 'd-1', contact_id: 'c-1', contact_name: 'Ada Speaker' }),
        draft({ id: 'd-2', contact_id: 'c-2', contact_name: 'Bo Panelist', subject: 'Please confirm your bio' }),
      ],
    })

    render(<ChaseInboxPanel />)

    expect(await screen.findByText('Ada Speaker')).toBeTruthy()
    expect(screen.getByText('Bo Panelist')).toBeTruthy()
    expect(screen.getByDisplayValue('Please upload your slides')).toBeTruthy()
    expect(screen.getByDisplayValue('Please confirm your bio')).toBeTruthy()
    expect(getChaseDraftsMock).toHaveBeenCalledWith({ status: 'staged' })
  })

  it('removes a draft from the list once Send succeeds', async () => {
    getChaseDraftsMock.mockResolvedValue({ items: [draft()] })
    sendChaseDraftMock.mockResolvedValue({ ok: true, outcome: 'queued' })

    render(<ChaseInboxPanel />)

    await screen.findByText('Ada Speaker')
    fireEvent.click(screen.getByText('Send'))

    await waitFor(() => expect(sendChaseDraftMock).toHaveBeenCalledWith('d-1'))
    await waitFor(() => expect(screen.queryByText('Ada Speaker')).toBeNull())
  })

  it('advances the displayed rung on Escalate without ever calling send', async () => {
    getChaseDraftsMock.mockResolvedValue({ items: [draft({ rung: 'tool_email' })] })
    escalateChaseDraftMock.mockResolvedValue({ ok: true, rung: 'personal_email', acted_at: new Date().toISOString() })

    render(<ChaseInboxPanel />)

    expect(await screen.findByText(/Tool email · staged/)).toBeTruthy()
    fireEvent.click(screen.getByText('Escalate'))

    await waitFor(() => expect(escalateChaseDraftMock).toHaveBeenCalledWith('d-1'))
    expect(await screen.findByText(/Personal email · staged/)).toBeTruthy()
    expect(sendChaseDraftMock).not.toHaveBeenCalled()
    expect(sendAllChaseDraftsMock).not.toHaveBeenCalled()
    // The draft stays in the list — escalation is recorded, never a send (D7).
    expect(screen.getByText('Ada Speaker')).toBeTruthy()
  })
})

describe('ChaseModeBanner', () => {
  it('shows for auto mode, not for assisted, and stays dismissed', async () => {
    getChaseSettingsMock.mockResolvedValue({ chase_mode: 'auto' })
    const { unmount } = render(<ChaseModeBanner />)

    expect(await screen.findByText(/Reminders currently send themselves/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText(/Reminders currently send themselves/)).toBeNull()
    unmount()

    // Persisted across remounts (localStorage), even though the event is still 'auto'.
    getChaseSettingsMock.mockResolvedValue({ chase_mode: 'auto' })
    render(<ChaseModeBanner />)
    await waitFor(() => expect(getChaseSettingsMock).toHaveBeenCalled())
    expect(screen.queryByText(/Reminders currently send themselves/)).toBeNull()
  })

  it('does not show for assisted mode', async () => {
    getChaseSettingsMock.mockResolvedValue({ chase_mode: 'assisted' })
    render(<ChaseModeBanner />)

    await waitFor(() => expect(getChaseSettingsMock).toHaveBeenCalled())
    expect(screen.queryByText(/Reminders currently send themselves/)).toBeNull()
  })
})

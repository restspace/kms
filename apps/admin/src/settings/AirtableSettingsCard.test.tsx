import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'

const { getAirtableSettingsMock, updateAirtableSettingsMock, testAirtableConnectionMock } = vi.hoisted(() => ({
  getAirtableSettingsMock: vi.fn(),
  updateAirtableSettingsMock: vi.fn(),
  testAirtableConnectionMock: vi.fn(),
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    getAirtableSettings: getAirtableSettingsMock,
    updateAirtableSettings: updateAirtableSettingsMock,
    testAirtableConnection: testAirtableConnectionMock,
  }
})

import { AirtableSettingsCard } from './AirtableSettingsCard'

const settings = (over: Partial<{ enabled: boolean; base_id: string; key_set: boolean; key_last4: string | null }> = {}) => ({
  enabled: false,
  base_id: '',
  key_set: false,
  key_last4: null,
  ...over,
})

beforeEach(() => {
  getAirtableSettingsMock.mockReset()
  updateAirtableSettingsMock.mockReset()
  testAirtableConnectionMock.mockReset()
})

describe('AirtableSettingsCard', () => {
  it('masks a stored key as a placeholder and never renders the key itself', async () => {
    getAirtableSettingsMock.mockResolvedValue(settings({ enabled: true, base_id: 'appX', key_set: true, key_last4: '1234' }))

    render(<AirtableSettingsCard />)

    const keyInput = (await screen.findByLabelText('Airtable API key')) as HTMLInputElement
    expect(keyInput.type).toBe('password')
    expect(keyInput.value).toBe('') // never hydrated with the secret
    expect(keyInput.placeholder).toBe('••••1234 (set)')
  })

  it('saves without api_key when the key input is untouched, with it when typed', async () => {
    getAirtableSettingsMock.mockResolvedValue(settings({ key_set: true, key_last4: '1234' }))
    updateAirtableSettingsMock.mockResolvedValue(settings({ enabled: true, base_id: 'appNEW', key_set: true, key_last4: '1234' }))

    render(<AirtableSettingsCard />)

    const baseInput = await screen.findByLabelText('Airtable base ID')
    fireEvent.input(baseInput, { target: { value: 'appNEW' } })
    fireEvent.click(screen.getByText('Mirror to Airtable'))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() =>
      expect(updateAirtableSettingsMock).toHaveBeenCalledWith({ enabled: true, base_id: 'appNEW' }),
    )
    expect(await screen.findByText('Saved — the mirror picks this up on the next minutely sweep.')).toBeTruthy()

    // Now type a replacement key: it must travel exactly once, then clear.
    updateAirtableSettingsMock.mockResolvedValue(settings({ enabled: true, base_id: 'appNEW', key_set: true, key_last4: '9999' }))
    const keyInput = screen.getByLabelText('Airtable API key') as HTMLInputElement
    fireEvent.input(keyInput, { target: { value: 'patNEWKEY9999' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() =>
      expect(updateAirtableSettingsMock).toHaveBeenLastCalledWith({
        enabled: true,
        base_id: 'appNEW',
        api_key: 'patNEWKEY9999',
      }),
    )
    await waitFor(() => expect(keyInput.value).toBe(''))
  })

  it('shows the test-connection outcome inline, passing typed credentials through', async () => {
    getAirtableSettingsMock.mockResolvedValue(settings())
    testAirtableConnectionMock.mockResolvedValue({ ok: false, error: 'airtable GET Events: 401 [redacted]' })

    render(<AirtableSettingsCard />)

    const keyInput = await screen.findByLabelText('Airtable API key')
    fireEvent.input(keyInput, { target: { value: 'patTYPED' } })
    fireEvent.input(screen.getByLabelText('Airtable base ID'), { target: { value: 'appTYPED' } })
    fireEvent.click(screen.getByText('Test connection'))

    await waitFor(() =>
      expect(testAirtableConnectionMock).toHaveBeenCalledWith({ api_key: 'patTYPED', base_id: 'appTYPED' }),
    )
    expect(await screen.findByText('airtable GET Events: 401 [redacted]')).toBeTruthy()

    testAirtableConnectionMock.mockResolvedValue({ ok: true })
    fireEvent.click(screen.getByText('Test connection'))
    expect(await screen.findByText('Connected — the base answered.')).toBeTruthy()
  })
})

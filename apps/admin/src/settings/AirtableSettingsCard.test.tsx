import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'

const {
  getAirtableSettingsMock,
  updateAirtableSettingsMock,
  testAirtableConnectionMock,
  listAirtableBasesMock,
  setUpAirtableBaseMock,
} = vi.hoisted(() => ({
  getAirtableSettingsMock: vi.fn(),
  updateAirtableSettingsMock: vi.fn(),
  testAirtableConnectionMock: vi.fn(),
  listAirtableBasesMock: vi.fn(),
  setUpAirtableBaseMock: vi.fn(),
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    getAirtableSettings: getAirtableSettingsMock,
    updateAirtableSettings: updateAirtableSettingsMock,
    testAirtableConnection: testAirtableConnectionMock,
    listAirtableBases: listAirtableBasesMock,
    setUpAirtableBase: setUpAirtableBaseMock,
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
  listAirtableBasesMock.mockReset()
  setUpAirtableBaseMock.mockReset()
})

const emptyReport = { createdTables: [], addedFields: [], mismatched: [], unchanged: [] }

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

  it('lists bases with the typed key and fills the base ID from the picker', async () => {
    getAirtableSettingsMock.mockResolvedValue(settings())
    listAirtableBasesMock.mockResolvedValue({
      ok: true,
      bases: [
        { id: 'appA', name: 'Conference' },
        { id: 'appB', name: 'Scratch' },
      ],
    })

    render(<AirtableSettingsCard />)

    fireEvent.input(await screen.findByLabelText('Airtable API key'), { target: { value: 'patTYPED' } })
    fireEvent.click(screen.getByText('Find my bases'))

    await waitFor(() => expect(listAirtableBasesMock).toHaveBeenCalledWith({ api_key: 'patTYPED' }))
    fireEvent.click(await screen.findByText('Scratch'))

    await waitFor(() =>
      expect((screen.getByLabelText('Airtable base ID') as HTMLInputElement).value).toBe('appB'),
    )
  })

  it('summarises what setup created', async () => {
    getAirtableSettingsMock.mockResolvedValue(settings({ base_id: 'appX', key_set: true, key_last4: '1234' }))
    setUpAirtableBaseMock.mockResolvedValue({
      ok: true,
      report: { ...emptyReport, createdTables: ['Events', 'Contacts'], addedFields: ['Tags.Color'] },
    })

    render(<AirtableSettingsCard />)

    fireEvent.click(await screen.findByText('Create the tables in Airtable'))

    await waitFor(() => expect(setUpAirtableBaseMock).toHaveBeenCalledWith({ base_id: 'appX' }))
    expect(await screen.findByText(/Created 2 table\(s\): Events, Contacts\./)).toBeTruthy()
    expect(screen.getByText(/Added 1 column\(s\): Tags\.Color\./)).toBeTruthy()
  })

  it('says there was nothing to do when the base is already complete', async () => {
    getAirtableSettingsMock.mockResolvedValue(settings({ base_id: 'appX', key_set: true }))
    setUpAirtableBaseMock.mockResolvedValue({ ok: true, report: { ...emptyReport, unchanged: ['Events'] } })

    render(<AirtableSettingsCard />)
    fireEvent.click(await screen.findByText('Create the tables in Airtable'))

    expect(
      await screen.findByText('Nothing to do — the base already has every table and column the mirror needs.'),
    ).toBeTruthy()
  })

  it('surfaces a setup failure as an error, not a summary', async () => {
    getAirtableSettingsMock.mockResolvedValue(settings({ base_id: 'appX', key_set: true }))
    setUpAirtableBaseMock.mockResolvedValue({ ok: false, error: 'Airtable refused: this token cannot…' })

    render(<AirtableSettingsCard />)
    fireEvent.click(await screen.findByText('Create the tables in Airtable'))

    expect(await screen.findByText('Airtable refused: this token cannot…')).toBeTruthy()
  })
})

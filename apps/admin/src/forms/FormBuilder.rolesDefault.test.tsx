// F10 (eval sweep note, CFP agent): @kms/core's DEFAULT_PARTICIPANT_ROLES now
// derives from ALL_PARTICIPANT_ROLES (speaker required, everything else
// optional) instead of a speaker-only literal — but the admin RolesPanel
// used to seed brand-new forms (participant_roles === []) with its own
// hard-coded `[{ role: 'speaker', min: 1, max: null }]`. This pins that a
// fresh form now shows every core role, checked, with the core mins/maxes.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/preact'
import { ALL_PARTICIPANT_ROLES, DEFAULT_PARTICIPANT_ROLES } from '@kms/core'

const FORM_ID = 'form-1'

function makeBaseForm(overrides: Record<string, unknown> = {}) {
  return {
    id: FORM_ID,
    internal_name: 'CFP',
    external_title: 'CFP',
    page_heading: 'Submit',
    welcome_message: null,
    welcome_message_visible: 0,
    collection_type: 'abstracts' as const,
    collect_participants: 0,
    status: 'open' as const,
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
    ...overrides,
  }
}

const { getFormDetail, getBuilderMeta, updateForm, addQuestion, deleteQuestion, reorderQuestions, updateQuestion } =
  vi.hoisted(() => ({
    getFormDetail: vi.fn(),
    getBuilderMeta: vi.fn(),
    updateForm: vi.fn(),
    addQuestion: vi.fn(),
    deleteQuestion: vi.fn(),
    reorderQuestions: vi.fn(),
    updateQuestion: vi.fn(),
  }))

vi.mock('../api', () => ({
  getFormDetail,
  getBuilderMeta,
  updateForm,
  addQuestion,
  deleteQuestion,
  reorderQuestions,
  updateQuestion,
}))

import { FormBuilder } from './FormBuilder'

beforeEach(() => {
  vi.clearAllMocks()
  getBuilderMeta.mockImplementation(async () => ({ fields: [], tracks: [], tags: [], plans: [] }))
  updateForm.mockImplementation(async () => ({ form: makeBaseForm() }))
})

const renderBuilder = () =>
  render(<FormBuilder formId={FORM_ID} eventSlug="evt" timezone="UTC" initialStep="participant" onClose={() => {}} />)

describe('FormBuilder — RolesPanel default seeding (F10)', () => {
  it('seeds a brand-new form (no participant_roles) with every core role, not just speaker', async () => {
    getFormDetail.mockImplementation(async () => ({
      form: makeBaseForm({ participant_roles: [] }),
      questions: [],
    }))
    renderBuilder()
    await screen.findByText('Participant roles')

    for (const role of ALL_PARTICIPANT_ROLES) {
      const row = screen.getByText(role).closest('.roles-row') as HTMLElement
      const checkbox = row.querySelector('input[type=checkbox]') as HTMLInputElement
      const [minInput, maxInput] = row.querySelectorAll('input[type=number]') as unknown as [HTMLInputElement, HTMLInputElement]
      const cfg = DEFAULT_PARTICIPANT_ROLES.find((r) => r.role === role)!

      expect(checkbox.checked).toBe(true)
      expect(Number(minInput.value)).toBe(cfg.min)
      expect(maxInput.value).toBe('')
    }
  })

  it('leaves an explicitly configured (narrower) role set untouched', async () => {
    getFormDetail.mockImplementation(async () => ({
      form: makeBaseForm({ participant_roles: [{ role: 'speaker', min: 1, max: 1 }] }),
      questions: [],
    }))
    renderBuilder()
    await screen.findByText('Participant roles')

    const speakerRow = screen.getByText('speaker').closest('.roles-row') as HTMLElement
    expect((speakerRow.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true)

    const coAuthorRow = screen.getByText('co-author').closest('.roles-row') as HTMLElement
    expect((coAuthorRow.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false)
  })
})

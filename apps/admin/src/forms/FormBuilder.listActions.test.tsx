// Regression (CFP-S1): "the form-builder field list is unreliable — every
// action (Create & Add, Required toggle, Remove) is a full-page-reload submit,
// which produced stale-reference races and duplicated a freshly created
// field", plus "wizard Next needs two clicks" and "no editable CFP close-date
// control".
//
// These drive the real FormBuilder with the api module mocked, and pin the
// three properties the fixes rest on:
//   1. no question-list control is a native submit button (they are all
//      type="button", so a stray <form> ancestor can never reload the page),
//   2. "Create & add" is latched in-flight and cannot double-create,
//   3. Next advances on a single click even with a save already in flight, and
//      the Settings step exposes a labelled, round-tripping close date.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact'

const FORM_ID = 'form-1'

function makeQuestion(id: string, label: string, position: number, locked = false) {
  return {
    id,
    form_id: FORM_ID,
    section: 'abstract' as const,
    position,
    required: false,
    locked,
    label,
    help_text: null,
    options: null,
    max_chars: null,
    visibility: null,
    field_id: `fld-${id}`,
    field_key: label.toLowerCase(),
    type: 'text',
  }
}

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

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  getFormDetail.mockImplementation(async () => ({
    form: makeBaseForm(),
    questions: [makeQuestion('q-title', 'Title', 1, true), makeQuestion('q-format', 'Format', 2)],
  }))
  getBuilderMeta.mockImplementation(async () => ({ fields: [], tracks: [], tags: [], plans: [] }))
  updateForm.mockImplementation(async () => ({ form: makeBaseForm() }))
})

/** The step title in the content pane (the same words also label the rail). */
const paneHeading = () => document.querySelector('.builder-pane h2')?.textContent ?? null

const renderBuilder = (step: string) =>
  render(<FormBuilder formId={FORM_ID} eventSlug="evt" timezone="UTC" initialStep={step} onClose={() => {}} />)

describe('FormBuilder — question-list actions are plain SPA interactions', () => {
  it('renders no <form> and no submit buttons, so no action can reload the page', async () => {
    renderBuilder('abstract')
    await screen.findByText('Format')

    // A <button> with no type attribute defaults to type="submit"; inside any
    // form ancestor that is a native submit → full page reload.
    const untyped = Array.from(document.querySelectorAll('button')).filter((b) => b.type !== 'button')
    expect(untyped.map((b) => b.textContent)).toEqual([])
    expect(document.querySelectorAll('form')).toHaveLength(0)
  })

  it('Required toggle and Remove fire no submit event and update the list in place', async () => {
    const snapshot = deferred<{ questions: ReturnType<typeof makeQuestion>[] }>()
    updateQuestion.mockImplementation(() => snapshot.promise)
    deleteQuestion.mockImplementation(() => new Promise(() => {}))

    const onSubmit = vi.fn()
    window.addEventListener('submit', onSubmit, true)
    try {
      renderBuilder('abstract')
      await screen.findByText('Format')

      const formatRow = screen.getByText('Format').closest('.qrow') as HTMLElement
      const requiredBox = formatRow.querySelector('input[type=checkbox]') as HTMLInputElement
      fireEvent.click(requiredBox)
      // Optimistic, in place: checked immediately, before the response.
      expect(requiredBox.checked).toBe(true)
      expect(updateQuestion).toHaveBeenCalledTimes(1)

      const remove = formatRow.querySelector('.fbtn-link.danger') as HTMLButtonElement
      expect(remove.type).toBe('button')
      fireEvent.click(remove)

      expect(onSubmit).not.toHaveBeenCalled()
      // Still on the builder — nothing navigated or re-mounted.
      expect(paneHeading()).toBe('Abstract Information')
    } finally {
      window.removeEventListener('submit', onSubmit, true)
    }
  })

  it('does not double-create when "Create & add" is clicked twice in a row', async () => {
    addQuestion.mockImplementation(() => new Promise(() => {}))
    renderBuilder('abstract')
    await screen.findByText('Format')

    fireEvent.click(screen.getByText('+ Add Field'))
    fireEvent.click(await screen.findByText('Create Field ›'))
    fireEvent.input(screen.getByLabelText('Label *'), { target: { value: 'Video link' } })

    const createAndAdd = screen.getByText('Create & add') as HTMLButtonElement
    // Two clicks in the same tick: preact has not re-rendered (and so not
    // unmounted the modal) between them — only the in-flight latch stops the
    // second POST.
    act(() => {
      createAndAdd.click()
      createAndAdd.click()
    })

    expect(addQuestion).toHaveBeenCalledTimes(1)
    expect(addQuestion.mock.calls[0]![1]).toMatchObject({
      section: 'abstract',
      new_field: { label: 'Video link', type: 'text' },
    })
  })
})

describe('FormBuilder — Settings close date', () => {
  it('always renders a labelled close-date control that round-trips through Save', async () => {
    renderBuilder('settings')
    const input = (await screen.findByLabelText(/Close Date/i)) as HTMLInputElement
    expect(input.type).toBe('datetime-local')
    // Sits with the Status select, not behind it.
    expect(screen.getByLabelText('Status')).toBeTruthy()
    expect(input.value).toBe('')

    updateForm.mockImplementation(async (_id: string, body: Record<string, unknown>) => ({
      form: makeBaseForm({ close_at: body.close_at, updated_at: '2026-01-02T00:00:00Z' }),
    }))

    fireEvent.input(input, { target: { value: '2026-09-01T17:00' } })
    expect(input.value).toBe('2026-09-01T17:00')

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(updateForm).toHaveBeenCalledTimes(1))
    const sent = updateForm.mock.calls[0]![1] as { close_at: string }
    expect(new Date(sent.close_at).toISOString()).toBe('2026-09-01T17:00:00.000Z')

    // The saved value survives the server round-trip.
    await waitFor(() => expect((screen.getByLabelText(/Close Date/i) as HTMLInputElement).value).toBe('2026-09-01T17:00'))
  })

  it('clears the close date without touching Status', async () => {
    getFormDetail.mockImplementation(async () => ({
      form: makeBaseForm({ close_at: '2026-03-01T12:00:00.000Z' }),
      questions: [],
    }))
    renderBuilder('settings')
    const input = (await screen.findByLabelText(/Close Date/i)) as HTMLInputElement
    expect(input.value).toBe('2026-03-01T12:00')

    fireEvent.click(screen.getByText('Clear close date'))
    await waitFor(() => expect((screen.getByLabelText(/Close Date/i) as HTMLInputElement).value).toBe(''))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(updateForm).toHaveBeenCalledTimes(1))
    const sent = updateForm.mock.calls[0]![1] as { close_at: string | null; status: string }
    expect(sent.close_at).toBeNull()
    expect(sent.status).toBe('open')
  })
})

describe('FormBuilder — wizard navigation', () => {
  it('advances on a single Next click even with a save already in flight', async () => {
    const first = deferred<{ form: ReturnType<typeof makeBaseForm> }>()
    let call = 0
    updateForm.mockImplementation(() => {
      call += 1
      return call === 1 ? first.promise : Promise.resolve({ form: makeBaseForm({ updated_at: '2026-01-03T00:00:00Z' }) })
    })

    renderBuilder('setup')
    await waitFor(() => expect(paneHeading()).toBe('Submission Setup'))

    // Make the form dirty, then start a save and immediately click Next once.
    fireEvent.click(screen.getByText('Sessions'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(updateForm).toHaveBeenCalledTimes(1))
    // The save is genuinely in flight now — one Next click must still advance
    // (it used to be swallowed by the "save already running" bail-out).
    fireEvent.click(screen.getByText('Next'))

    first.resolve({ form: makeBaseForm({ collection_type: 'sessions' }) })

    await waitFor(() => expect(paneHeading()).toBe('Welcome Screen'))
  })

  it('keeps an edit made while a save is in flight instead of stranding it', async () => {
    const first = deferred<{ form: ReturnType<typeof makeBaseForm> }>()
    let call = 0
    updateForm.mockImplementation((_id: string, body: Record<string, unknown>) => {
      call += 1
      return call === 1
        ? first.promise
        : Promise.resolve({
            form: makeBaseForm({ page_heading: body.page_heading, updated_at: '2026-01-03T00:00:00Z' }),
          })
    })

    renderBuilder('welcome')
    const heading = (await screen.findByLabelText(/Page Heading/i)) as HTMLInputElement

    fireEvent.input(heading, { target: { value: 'Apply' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(updateForm).toHaveBeenCalledTimes(1))
    // A keystroke lands while the request is in flight.
    fireEvent.input(heading, { target: { value: 'Apply now' } })
    first.resolve({ form: makeBaseForm({ page_heading: 'Apply', updated_at: '2026-01-02T00:00:00Z' }) })

    // The newer value is re-saved rather than reverted or refused.
    await waitFor(() => expect(updateForm).toHaveBeenCalledTimes(2))
    expect((updateForm.mock.calls[1]![1] as { page_heading: string }).page_heading).toBe('Apply now')
    expect((screen.getByLabelText(/Page Heading/i) as HTMLInputElement).value).toBe('Apply now')
  })
})

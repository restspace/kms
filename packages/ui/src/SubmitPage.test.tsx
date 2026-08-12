import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/preact'
import { axe } from 'vitest-axe'
import { SubmitPage, type SubmitBootstrap } from './SubmitPage'
import type { QuestionDef } from '@kms/core'

function makeQuestion(overrides: Partial<QuestionDef>): QuestionDef {
  return {
    id: overrides.id ?? 'q1',
    section: overrides.section ?? 'abstract',
    field_key: overrides.field_key ?? overrides.id ?? 'q1',
    field_id: overrides.field_id ?? 'f1',
    label: overrides.label ?? 'Question',
    help_text: overrides.help_text ?? null,
    type: overrides.type ?? 'text',
    position: overrides.position ?? 0,
    required: overrides.required ?? false,
    locked: overrides.locked ?? false,
    options: overrides.options ?? null,
    max_chars: overrides.max_chars ?? null,
    visibility: overrides.visibility ?? null,
  }
}

function makeBootstrap(questions: QuestionDef[]): SubmitBootstrap {
  return {
    event: { name: 'Test Con', slug: 'test-con', timezone: 'UTC' },
    form: {
      id: 'form-1',
      external_title: 'Call for Proposals',
      page_heading: 'Submit a session',
      welcome_message: null,
      welcome_message_visible: false,
      collect_participants: true,
      participant_roles: null,
      status: 'open',
      close_at: null,
      submission_limit: null,
      auto_redirect_to_portal: false,
      success_message: null,
    },
    questions,
    viewer: {
      email: 'speaker@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      mobile_phone: null,
      biography: null,
      submission_count: 0,
      draft: null,
    },
    closed: false,
    dev_mode: false,
    base_path: '/submit/test-con/form-1',
  }
}

describe('SubmitPage participant contract', () => {
  it('renders a custom required participant question and blocks Next when it is empty', () => {
    const questions: QuestionDef[] = [
      makeQuestion({ id: 'p-email', section: 'participant', field_key: 'email', type: 'email', label: 'Email', required: true, position: 0 }),
      makeQuestion({
        id: 'p-tshirt',
        section: 'participant',
        field_key: 'tshirt_size',
        type: 'dropdown',
        label: 'T-shirt size',
        required: true,
        position: 1,
        options: [
          { value: 's', label: 'Small' },
          { value: 'm', label: 'Medium' },
        ],
      }),
    ]
    render(<SubmitPage data={makeBootstrap(questions)} />)

    // Jump straight to the participant step (viewer is already signed in).
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // welcome -> account
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // account -> submission
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // submission -> participant

    // The custom required participant question is rendered through QuestionInput.
    expect(screen.getByText('T-shirt size')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // attempt participant -> review

    // Still on the participant step: the required dropdown blocked advancement.
    expect(screen.getByText('T-shirt size')).toBeTruthy()
    expect(screen.getAllByText(/T-shirt size is required/).length).toBeGreaterThan(0)
  })

  it('the step list has no axe violations and marks the active step', async () => {
    const { container } = render(<SubmitPage data={makeBootstrap([])} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()

    const activeStep = container.querySelector('[aria-current="step"]')
    expect(activeStep).toBeTruthy()
    expect(activeStep?.textContent).toContain('Welcome')
  })

  it('item 2: offers co-speaker (not just speaker) when the form has no explicit role config', () => {
    render(<SubmitPage data={makeBootstrap([])} />)

    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // welcome -> account
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // account -> submission
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // submission -> participant

    const select = screen.getByLabelText(/Role for/i) as unknown as HTMLSelectElement
    const optionLabels = Array.from(select.options).map((o) => o.textContent)
    expect(optionLabels).toContain('Co-Speaker')
    const optionValues = Array.from(select.options).map((o) => o.value)
    expect(optionValues).toEqual(expect.arrayContaining(['speaker', 'co-speaker']))
  })

  it('eval defect 3: a form with no participant identity questions still renders name/email inputs per slot', () => {
    // collect_participants is on but the organiser configured no participant
    // questions at all — every slot used to render only the role dropdown and
    // dead-end at submit with participants_invalid.
    render(<SubmitPage data={makeBootstrap([])} />)

    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // welcome -> account
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // account -> submission
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // submission -> participant

    fireEvent.click(screen.getByRole('button', { name: /\+ Add participant/ }))

    expect(screen.getAllByText('First Name').length).toBe(2)
    expect(screen.getAllByText('Last Name').length).toBe(2)
    expect(screen.getAllByText('Email').length).toBe(2)
    // The accidental empty slot is removable.
    expect(screen.getByRole('button', { name: /Remove/ })).toBeTruthy()
  })

  it('eval defect 1: choosing Resume hydrates the saved draft answers into the wizard', () => {
    const questions = [
      makeQuestion({ id: 'q-title', field_key: 'title', label: 'Title', position: 0 }),
      makeQuestion({ id: 'q-desc', field_key: 'description', type: 'textarea', label: 'Description', position: 1 }),
    ]
    const data = makeBootstrap(questions)
    data.viewer!.draft = {
      id: 'draft-1',
      title: 'Streaming Function Calls',
      answers: { 'q-title': 'Streaming Function Calls', 'q-desc': 'Progressive rendering patterns.' },
    }
    render(<SubmitPage data={data} />)

    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // welcome -> account
    fireEvent.click(screen.getByRole('button', { name: /Resume draft/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // account -> submission

    expect((screen.getByLabelText('Title') as unknown as HTMLInputElement).value).toBe('Streaming Function Calls')
    expect((screen.getByLabelText('Description') as unknown as HTMLTextAreaElement).value).toBe(
      'Progressive rendering patterns.',
    )
  })

  it('item 1: the review step shows the Track option label, not the stored track id', () => {
    const questions: QuestionDef[] = [
      makeQuestion({
        id: 'q-track',
        field_key: 'track',
        type: 'dropdown',
        label: 'Track',
        position: 0,
        options: [
          { value: 'trk-uuid-1', label: 'Backend' },
          { value: 'trk-uuid-2', label: 'Frontend' },
        ],
      }),
    ]
    render(<SubmitPage data={makeBootstrap(questions)} />)

    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // welcome -> account
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // account -> submission

    const select = screen.getByLabelText('Track') as unknown as HTMLSelectElement
    // @testing-library/preact rewrites fireEvent.change to an input event
    // under preact/compat, which a <select>'s onChange never sees — dispatch
    // directly (see EvaluationSection.test.tsx for the same workaround).
    select.value = 'trk-uuid-2'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // submission -> participant
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ })) // participant -> review

    expect(screen.getByText('Frontend')).toBeTruthy()
    expect(screen.queryByText('trk-uuid-2')).toBeNull()
  })
})

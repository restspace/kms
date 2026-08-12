/**
 * Regression for eval defect F3: the Evaluation section rendered nothing but
 * "Loading…", forever. The section gated every pixel on `overview !== null`, so
 * a load that resolved with a null body (a non-JSON 200 — the fetch client maps
 * that to `null`) or one that never settled at all left the whole 20-point
 * evaluation area unreachable, with no error and no retry.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'

const getEvaluationOverview = vi.fn()
const createPlan = vi.fn()
const addCriterion = vi.fn()
const assignReviewers = vi.fn()
const updatePlan = vi.fn()

vi.mock('../api', () => ({
  getEvaluationOverview: (...a: unknown[]) => getEvaluationOverview(...a),
  createPlan: (...a: unknown[]) => createPlan(...a),
  updatePlan: (...a: unknown[]) => updatePlan(...a),
  addCriterion: (...a: unknown[]) => addCriterion(...a),
  updateCriterion: vi.fn(),
  deleteCriterion: vi.fn(),
  assignReviewers: (...a: unknown[]) => assignReviewers(...a),
}))

const getPlanSubmissions = vi.fn()
const changePlanSubmissions = vi.fn()
const addReviewer = vi.fn()
const sendReviewerSigninLink = vi.fn()
const remindReviewers = vi.fn()
const addPlanReviewer = vi.fn()
const removePlanReviewer = vi.fn()

vi.mock('./evaluationApi', () => ({
  getPlanSubmissions: (...a: unknown[]) => getPlanSubmissions(...a),
  changePlanSubmissions: (...a: unknown[]) => changePlanSubmissions(...a),
  addReviewer: (...a: unknown[]) => addReviewer(...a),
  sendReviewerSigninLink: (...a: unknown[]) => sendReviewerSigninLink(...a),
  remindReviewers: (...a: unknown[]) => remindReviewers(...a),
  addPlanReviewer: (...a: unknown[]) => addPlanReviewer(...a),
  removePlanReviewer: (...a: unknown[]) => removePlanReviewer(...a),
}))

import { EvaluationSection } from './EvaluationSection'

const full = {
  plans: [{ id: 'p1', name: 'Round 1', description: null, status: 'active', anonymise_submitters: 0, scoring_scale_min: 1, scoring_scale_max: 5, opens_at: null, closes_at: null }],
  criteria: [{ id: 'c1', plan_id: 'p1', name: 'Relevance', description: null, weight: 2, position: 1 }],
  reviewers: [{ id: 'r1', email: 'r@example.com', name: 'Ada Lovelace' }],
  stats: [{ plan_id: 'p1', submissions: 3, assignments: 6, completed: 2 }],
  pool: [{ plan_id: 'p1', contact_id: 'r1' }],
  workload: [{ plan_id: 'p1', contact_id: 'r1', assigned: 3, completed: 1 }],
}

const submissions = {
  items: [
    { id: 's1', code: 'SESS-1', title: 'In the round', status: 'pending', format: 'Talk', track_id: 't1', track_name: 'AI', member: 1, assignments: 2 },
    { id: 's2', code: 'SESS-2', title: 'Not yet', status: 'pending', format: 'Workshop', track_id: null, track_name: null, member: 0, assignments: 0 },
  ],
  tracks: [{ id: 't1', name: 'AI' }],
  formats: ['Talk', 'Workshop'],
}

beforeEach(() => {
  for (const fn of [
    getEvaluationOverview, createPlan, addCriterion, assignReviewers, updatePlan,
    getPlanSubmissions, changePlanSubmissions, addReviewer, sendReviewerSigninLink, remindReviewers,
    addPlanReviewer, removePlanReviewer,
  ]) fn.mockReset()
  addPlanReviewer.mockResolvedValue({ ok: true, plan_id: 'p1', contact_id: 'r1' })
  removePlanReviewer.mockResolvedValue({ ok: true, plan_id: 'p1', contact_id: 'r1', removed_assignments: 1 })
  getPlanSubmissions.mockResolvedValue(submissions)
  changePlanSubmissions.mockResolvedValue({ ok: true, matched: 1, changed: 1, total: 2 })
  addCriterion.mockResolvedValue({ ok: true })
  assignReviewers.mockResolvedValue({ ok: true, total_assignments: 0, created: 0, submissions: 0 })
  addReviewer.mockResolvedValue({ ok: true, id: 'r2', email: 'new@example.com', name: 'New Person', created: true })
  sendReviewerSigninLink.mockResolvedValue({
    ok: true, contact_id: 'r1', email: 'r@example.com', name: 'Ada Lovelace', dev_link: null,
  })
  remindReviewers.mockResolvedValue({ ok: true, sent: 1, lagging: [{ contact_id: 'r1', outstanding: 2 }] })
  updatePlan.mockResolvedValue({ ok: true })
})

describe('EvaluationSection', () => {
  it('renders a configured event', async () => {
    getEvaluationOverview.mockResolvedValue(full)
    render(<EvaluationSection />)

    expect(await screen.findByDisplayValue('Round 1')).toBeTruthy()
    // Criteria render as a "name: weight" summary line until edited.
    expect(screen.getByText(/Relevance: 2/)).toBeTruthy()
    expect(screen.getByText(/3 submissions/)).toBeTruthy()
    expect(screen.getByText('Ada Lovelace')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('renders an empty-but-usable screen for a fresh event with no plan', async () => {
    getEvaluationOverview.mockResolvedValue({ plans: [], criteria: [], reviewers: [], stats: [] })
    render(<EvaluationSection />)

    expect(await screen.findByText('No review rounds yet')).toBeTruthy()
    expect(screen.getByLabelText('New plan name')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('shows an error with Retry instead of hanging when the body is not an object', async () => {
    getEvaluationOverview.mockResolvedValue(null) // non-JSON 200 → request() yields null
    render(<EvaluationSection />)

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('surfaces a rejected load as a visible error', async () => {
    getEvaluationOverview.mockRejectedValue(new Error('Failed to fetch'))
    render(<EvaluationSection />)

    expect(await screen.findByText('Failed to fetch')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('ends the loading state even when the request never settles', async () => {
    vi.useFakeTimers()
    try {
      getEvaluationOverview.mockReturnValue(new Promise(() => {}))
      render(<EvaluationSection />)
      expect(screen.getByText('Loading…')).toBeTruthy()
      await vi.advanceTimersByTimeAsync(16_000)
      expect(screen.queryByText('Loading…')).toBeNull()
      expect(screen.getByRole('alert').textContent).toContain('did not respond in time')
    } finally {
      vi.useRealTimers()
    }
  })

  it('tolerates a partial payload rather than blanking the section', async () => {
    getEvaluationOverview.mockResolvedValue({ plans: full.plans })
    render(<EvaluationSection />)

    expect(await screen.findByDisplayValue('Round 1')).toBeTruthy()
    expect(screen.getByText(/0 submissions/)).toBeTruthy()
  })

  it('creates a plan from the inline field (no window.prompt)', async () => {
    getEvaluationOverview.mockResolvedValue({ plans: [], criteria: [], reviewers: [], stats: [] })
    createPlan.mockResolvedValue({ ok: true, id: 'p9' })
    const promptSpy = vi.spyOn(window, 'prompt')
    render(<EvaluationSection />)

    const input = (await screen.findByLabelText('New plan name')) as HTMLInputElement
    const { fireEvent } = await import('@testing-library/preact')
    fireEvent.input(input, { target: { value: 'Round 2' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Create plan' }))

    await waitFor(() => expect(createPlan).toHaveBeenCalledWith('Round 2'))
    expect(promptSpy).not.toHaveBeenCalled()
  })
})

/**
 * Lane L3: the round editor's missing half. The eval run found that a new
 * round could not be given submissions at all (so Assign reported "0
 * submissions"), had no way to create a reviewer, and no way to nudge one.
 */
describe('EvaluationSection — round editor (lane L3)', () => {
  const openCard = async () => {
    getEvaluationOverview.mockResolvedValue(full)
    render(<EvaluationSection />)
    return screen.findByDisplayValue('Round 1')
  }

  it('lets an organiser pick the round submissions by checkbox', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    fireEvent.click(screen.getByRole('button', { name: 'Choose submissions' }))

    const row = (await screen.findByLabelText('Not yet in this round')) as HTMLInputElement
    expect(row.checked).toBe(false)
    expect((screen.getByLabelText('In the round in this round') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(row)
    await waitFor(() =>
      expect(changePlanSubmissions).toHaveBeenCalledWith('p1', { mode: 'add', submission_ids: ['s2'] }),
    )
  })

  it('adds by filter with "Add matching"', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    fireEvent.click(screen.getByRole('button', { name: 'Choose submissions' }))
    // wait for the loaded payload's options, not just the empty select
    await waitFor(() =>
      expect((screen.getByLabelText('Filter by track') as HTMLSelectElement).options.length).toBe(2),
    )

    const track = screen.getByLabelText('Filter by track') as HTMLSelectElement
    track.value = 't1'
    // @testing-library/preact rewrites fireEvent.change to an input event under
    // preact/compat, which a <select>'s onChange never sees — dispatch directly.
    track.dispatchEvent(new Event('change', { bubbles: true }))
    fireEvent.click(await screen.findByRole('button', { name: /Add matching/ }))

    await waitFor(() =>
      expect(changePlanSubmissions).toHaveBeenCalledWith('p1', { mode: 'add', filter: { track_id: 't1' } }),
    )
  })

  it('explains a zero-submission Assign instead of silently doing nothing', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    // Assign lives in the reviewers editor, behind the ✎ toggle.
    fireEvent.click(screen.getByLabelText('Edit reviewers'))
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }))

    await waitFor(() => expect(assignReviewers).toHaveBeenCalled())
    expect(await screen.findByText(/No submissions in this round yet/)).toBeTruthy()
  })

  it('creates a reviewer from name + email and pools them on the plan', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    fireEvent.click(screen.getByLabelText('Edit reviewers'))
    fireEvent.input(screen.getByLabelText('Reviewer name'), { target: { value: 'New Person' } })
    fireEvent.input(screen.getByLabelText('Reviewer email'), { target: { value: 'new@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Add reviewer' }))

    await waitFor(() =>
      expect(addReviewer).toHaveBeenCalledWith({ name: 'New Person', email: 'new@example.com', plan_id: 'p1' }),
    )
  })

  it('sends a sign-in link and reminds a lagging reviewer', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    fireEvent.click(screen.getByLabelText('Send sign-in link to Ada Lovelace'))
    await waitFor(() => expect(sendReviewerSigninLink).toHaveBeenCalledWith('r1'))

    // workload says 1 of 3 done, so a per-reviewer Remind is offered
    fireEvent.click(screen.getByLabelText('Remind Ada Lovelace'))
    await waitFor(() => expect(remindReviewers).toHaveBeenCalledWith('p1', ['r1']))

    fireEvent.click(screen.getByRole('button', { name: 'Remind all lagging' }))
    await waitFor(() => expect(remindReviewers).toHaveBeenCalledWith('p1'))
  })

  it('persists the review window dates', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    // The window shows as a summary line until its ✎ opens the fields.
    expect(screen.getByText('Always open')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Edit timing'))
    const closes = screen.getByLabelText('Reviews close') as HTMLInputElement
    closes.value = '2026-09-01T17:00'
    // preact/compat maps onBlur to a focusout listener; fireEvent.blur
    // dispatches the non-bubbling native blur, which never reaches it.
    closes.dispatchEvent(new Event('focusout', { bubbles: true }))

    await waitFor(() => expect(updatePlan).toHaveBeenCalled())
    const [planId, patch] = updatePlan.mock.calls[0] as [string, { closes_at: string }]
    expect(planId).toBe('p1')
    expect(new Date(patch.closes_at).getTime()).toBe(new Date('2026-09-01T17:00').getTime())
  })

  // ABS-07: the anonymise checkbox reverted to unchecked on the next refetch.
  it('keeps the anonymise checkbox on what the server stored', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    const box = screen.getByLabelText('Hide submitter identities from reviewers') as HTMLInputElement
    expect(box.checked).toBe(false)

    // The PUT answers with the stored row, and the refetch agrees.
    updatePlan.mockResolvedValue({ ok: true, plan: { ...full.plans[0], anonymise_submitters: 1 } })
    getEvaluationOverview.mockResolvedValue({
      ...full,
      plans: [{ ...full.plans[0], anonymise_submitters: 1 }],
    })
    fireEvent.click(box)

    await waitFor(() => expect(updatePlan).toHaveBeenCalledWith('p1', { anonymise_submitters: true }))
    await waitFor(() =>
      expect((screen.getByLabelText('Hide submitter identities from reviewers') as HTMLInputElement).checked).toBe(true),
    )
  })

  it('puts the anonymise checkbox back when the save fails', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    updatePlan.mockRejectedValue(new Error('Nope'))
    fireEvent.click(screen.getByLabelText('Hide submitter identities from reviewers'))

    expect(await screen.findByText('Nope')).toBeTruthy()
    expect((screen.getByLabelText('Hide submitter identities from reviewers') as HTMLInputElement).checked).toBe(false)
  })

  // The reviewer pool: unticking someone used to be local state only, so the
  // reviewer came back ticked on the next reload.
  it('persists a reviewer removal from the round pool', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    const tick = screen.getByLabelText('Ada Lovelace in this round') as HTMLInputElement
    expect(tick.checked).toBe(true)

    getEvaluationOverview.mockResolvedValue({ ...full, pool: [] })
    fireEvent.click(tick)

    await waitFor(() => expect(removePlanReviewer).toHaveBeenCalledWith('p1', 'r1'))
    await waitFor(() =>
      expect((screen.getByLabelText('Ada Lovelace in this round') as HTMLInputElement).checked).toBe(false),
    )
  })

  it('re-ticks a reviewer whose removal failed', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    removePlanReviewer.mockRejectedValue(new Error('Server said no'))
    fireEvent.click(screen.getByLabelText('Ada Lovelace in this round'))

    expect(await screen.findByText('Server said no')).toBeTruthy()
    expect((screen.getByLabelText('Ada Lovelace in this round') as HTMLInputElement).checked).toBe(true)
  })

  it('ticking a reviewer pools them without waiting for Assign', async () => {
    getEvaluationOverview.mockResolvedValue({ ...full, pool: [] })
    render(<EvaluationSection />)
    await screen.findByDisplayValue('Round 1')
    const { fireEvent } = await import('@testing-library/preact')
    // An empty pool means nobody is checked yet — there is no "everyone by
    // default" fallback (see the regression below for why).
    const tick = screen.getByLabelText('Ada Lovelace in this round') as HTMLInputElement
    expect(tick.checked).toBe(false)
    fireEvent.click(tick) // tick
    await waitFor(() => expect(addPlanReviewer).toHaveBeenCalledWith('p1', 'r1'))
    fireEvent.click(screen.getByLabelText('Ada Lovelace in this round')) // untick
    await waitFor(() => expect(removePlanReviewer).toHaveBeenCalledWith('p1', 'r1'))
  })

  // Regression: unchecking a reviewer showed a success toast, but a page
  // reload (a fresh mount of the section, re-reading the now-correct server
  // pool) put every reviewer's tick back. Root cause was a mount-time default
  // that treated "pool empty" as "never configured" and fell back to
  // checking everyone — which can't be told apart from "deliberately emptied
  // by removing the last one". Also covers the pool's real shape: pool rows
  // are `{plan_id, contact_id}` pairs, so a reviewer pooled in one plan must
  // not read as checked in another.
  it('renders a reviewer unchecked in a plan whose pool does not include them, and keeps it that way across a reload', async () => {
    const twoPlans = {
      ...full,
      plans: [
        full.plans[0],
        { ...full.plans[0], id: 'p2', name: 'Round 2' },
      ],
      // r1 is only pooled in p1.
      pool: [{ plan_id: 'p1', contact_id: 'r1' }],
    }
    getEvaluationOverview.mockResolvedValue(twoPlans)
    const { unmount } = render(<EvaluationSection />)
    await screen.findByDisplayValue('Round 1')

    // r1 has assignments only in p1, so p2's row only appears in its editor.
    const { fireEvent } = await import('@testing-library/preact')
    for (const pencil of screen.getAllByLabelText('Edit reviewers')) fireEvent.click(pencil)

    const ticks = screen.getAllByLabelText('Ada Lovelace in this round') as HTMLInputElement[]
    expect(ticks).toHaveLength(2)
    expect(ticks[0].checked).toBe(true) // p1: pooled
    expect(ticks[1].checked).toBe(false) // p2: not pooled — must not "leak" from p1

    // Uncheck in p1; the server's pool for p1 is now empty.
    getEvaluationOverview.mockResolvedValue({ ...twoPlans, pool: [] })
    fireEvent.click(ticks[0])
    await waitFor(() => expect(removePlanReviewer).toHaveBeenCalledWith('p1', 'r1'))

    // Simulate a page reload: a fresh mount reading the now-empty pool must
    // not fall back to "everyone checked".
    unmount()
    render(<EvaluationSection />)
    await screen.findByDisplayValue('Round 1')
    for (const pencil of screen.getAllByLabelText('Edit reviewers')) fireEvent.click(pencil)
    for (const box of screen.getAllByLabelText('Ada Lovelace in this round') as HTMLInputElement[]) {
      expect(box.checked).toBe(false)
    }
  })

  // CFP-11: the surfaced link must be shown as the target reviewer's.
  it('shows the demo sign-in link labelled with the reviewer it belongs to', async () => {
    await openCard()
    sendReviewerSigninLink.mockResolvedValue({
      ok: true,
      contact_id: 'r1',
      email: 'r@example.com',
      name: 'Ada Lovelace',
      dev_link: 'https://kms.example/auth/callback?t=abc123',
    })
    const { fireEvent } = await import('@testing-library/preact')
    fireEvent.click(screen.getByLabelText('Send sign-in link to Ada Lovelace'))

    const field = (await screen.findByLabelText('Sign-in link for Ada Lovelace')) as HTMLInputElement
    expect(field.value).toBe('https://kms.example/auth/callback?t=abc123')
    expect(screen.getByText(/Sign-in link for Ada Lovelace \(r@example.com\)/)).toBeTruthy()
  })

  // The reported "+ Add criterion occasionally created duplicates": Enter and
  // the button both call the same handler, and clearing the field only takes
  // effect on the next render, so two events in one tick both POSTed.
  it('never double-submits a criterion', async () => {
    await openCard()
    const { fireEvent } = await import('@testing-library/preact')
    fireEvent.click(screen.getByLabelText('Edit criteria'))
    const field = screen.getByLabelText('New criterion name')
    fireEvent.input(field, { target: { value: 'Originality' } })

    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: /Add criterion|Adding/ }))
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(addCriterion).toHaveBeenCalled())
    expect(addCriterion).toHaveBeenCalledTimes(1)
    expect(addCriterion).toHaveBeenCalledWith('p1', { name: 'Originality', weight: 1 })
  })
})

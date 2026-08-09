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

vi.mock('../api', () => ({
  getEvaluationOverview: (...a: unknown[]) => getEvaluationOverview(...a),
  createPlan: (...a: unknown[]) => createPlan(...a),
  updatePlan: vi.fn(),
  addCriterion: vi.fn(),
  updateCriterion: vi.fn(),
  deleteCriterion: vi.fn(),
  assignReviewers: vi.fn(),
}))

import { EvaluationSection } from './EvaluationSection'

const full = {
  plans: [{ id: 'p1', name: 'Round 1', description: null, status: 'active', anonymise_submitters: 0, scoring_scale_min: 1, scoring_scale_max: 5 }],
  criteria: [{ id: 'c1', plan_id: 'p1', name: 'Relevance', description: null, weight: 2, position: 1 }],
  reviewers: [{ id: 'r1', email: 'r@example.com', name: 'Ada Lovelace' }],
  stats: [{ plan_id: 'p1', submissions: 3, assignments: 6, completed: 2 }],
}

beforeEach(() => {
  getEvaluationOverview.mockReset()
  createPlan.mockReset()
})

describe('EvaluationSection', () => {
  it('renders a configured event', async () => {
    getEvaluationOverview.mockResolvedValue(full)
    render(<EvaluationSection />)

    expect(await screen.findByDisplayValue('Round 1')).toBeTruthy()
    expect(screen.getByText('Relevance')).toBeTruthy()
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

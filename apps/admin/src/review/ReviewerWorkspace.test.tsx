/**
 * Reviewer-side discussion thread (workplan 7 §7, gate D3).
 *
 * The gate is server-side: until this reviewer's own review is submitted (and
 * the round is still open), GET /review/assignments/:id/comments answers 403
 * review_not_submitted and the rows never reach the client. These tests pin
 * the two client states — the locked placeholder that must leak nothing, and
 * the open thread with its append-only composer.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'

const setValue = (el: HTMLTextAreaElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

const api = vi.hoisted(() => {
  /** Mirrors the real ApiError so the component's instanceof check holds. */
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly details?: Record<string, unknown>,
    ) {
      super(message)
    }
  }
  return {
    ApiError,
    getReviewQueue: vi.fn(),
    getReviewLobby: vi.fn(),
    saveReview: vi.fn(),
    getAssignmentComments: vi.fn(),
    addAssignmentComment: vi.fn(),
  }
})

vi.mock('../api', () => ({
  ApiError: api.ApiError,
  getReviewQueue: api.getReviewQueue,
  getReviewLobby: api.getReviewLobby,
  saveReview: api.saveReview,
  getAssignmentComments: api.getAssignmentComments,
  addAssignmentComment: api.addAssignmentComment,
}))

import { ReviewerWorkspace } from './ReviewerWorkspace'

const assignment = (overrides: Record<string, unknown> = {}) => ({
  id: 'as-1',
  submission_id: 'sub-1',
  plan_id: 'plan-1',
  plan_name: 'Screening Round',
  code: 'S-001',
  title: 'Designing for Doubt',
  status: 'pending',
  plan_open: 1,
  plan_window_reason: null,
  plan_opens_at: null,
  plan_closes_at: null,
  scoring_scale_min: 1,
  scoring_scale_max: 5,
  my_scores: null,
  my_comment: null,
  my_conflict: 0,
  anonymise_submitters: 0,
  ...overrides,
})

const queue = (overrides: Record<string, unknown> = {}) => ({
  assignments: [assignment(overrides)],
  criteria: {
    'plan-1': [{ id: 'crit-1', name: 'Clarity', description: null, weight: 1 }],
  },
  participants: {},
})

const COMMENTS = [
  {
    id: 'sc-1',
    submission_id: 'sub-1',
    plan_id: 'plan-1',
    assignment_id: 'as-2',
    author_contact_id: 'c-2',
    author_role: 'reviewer',
    author_name: 'Ada Lovelace',
    kind: 'rationale',
    body: 'Strong structure, weak conclusion.',
    created_at: '2026-02-01T10:00:00Z',
  },
  {
    id: 'sc-2',
    submission_id: 'sub-1',
    plan_id: 'plan-1',
    assignment_id: null,
    author_contact_id: 'c-3',
    author_role: 'owner',
    author_name: 'Grace Hopper',
    kind: 'discussion',
    body: 'Agreed — could pair well with the panel slot.',
    created_at: '2026-02-02T11:00:00Z',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  // The W1b lobby panel fetches on mount alongside the queue; these tests are
  // about the discussion thread, so it stays empty and renders nothing.
  api.getReviewLobby.mockResolvedValue({ items: [] })
})

describe('ReviewerWorkspace — discussion thread (workplan 7 §7)', () => {
  it('pre-submit: shows the locked placeholder and leaks no authors or bodies', async () => {
    api.getReviewQueue.mockResolvedValue(queue({ status: 'pending' }))
    api.getAssignmentComments.mockRejectedValue(
      new api.ApiError('Forbidden', 403, { error: 'review_not_submitted' }),
    )

    render(<ReviewerWorkspace />)

    await screen.findByText('Post your review to join the discussion.')
    expect(api.getAssignmentComments).toHaveBeenCalledWith('as-1')

    // Gate D3: the server sent no rows, and the DOM must not invent any —
    // no author names, no bodies, no counts.
    const html = document.body.textContent ?? ''
    expect(html).not.toContain('Ada Lovelace')
    expect(html).not.toContain('Grace Hopper')
    expect(html).not.toContain('Strong structure')
    expect(html).not.toContain('panel slot')
    expect(screen.queryByLabelText('Reply to the discussion')).toBeNull()
  })

  it('post-submit: renders authors and bodies, and posting calls addAssignmentComment', async () => {
    api.getReviewQueue.mockResolvedValue(queue({ status: 'complete' }))
    api.getAssignmentComments.mockResolvedValue({ comments: COMMENTS })

    render(<ReviewerWorkspace />)

    await screen.findByText('Ada Lovelace')
    await screen.findByText('Strong structure, weak conclusion.')
    await screen.findByText('Grace Hopper')
    await screen.findByText('Agreed — could pair well with the panel slot.')
    // Role tags and the rationale marker.
    expect((document.body.textContent ?? '')).toContain('Reviewer')
    expect((document.body.textContent ?? '')).toContain('Organiser')
    expect((document.body.textContent ?? '')).toContain('Review rationale')

    const reply = {
      id: 'sc-3',
      submission_id: 'sub-1',
      plan_id: 'plan-1',
      assignment_id: 'as-1',
      author_contact_id: 'c-1',
      author_role: 'reviewer',
      author_name: 'Me',
      kind: 'discussion',
      body: 'Happy to champion this one.',
      created_at: '2026-02-03T09:00:00Z',
    }
    api.addAssignmentComment.mockResolvedValue({ ok: true, id: 'sc-3', comments: [...COMMENTS, reply] })

    const textarea = screen.getByLabelText('Reply to the discussion') as HTMLTextAreaElement
    setValue(textarea, 'Happy to champion this one.')
    const post = screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement
    await waitFor(() => expect(post.disabled).toBe(false))
    post.click()

    await waitFor(() =>
      expect(api.addAssignmentComment).toHaveBeenCalledWith('as-1', 'Happy to champion this one.'),
    )
    // The thread is replaced from the response and the draft cleared.
    await screen.findByText('Happy to champion this one.')
    await waitFor(() =>
      expect((screen.getByLabelText('Reply to the discussion') as HTMLTextAreaElement).value).toBe(''),
    )
  })
})

/**
 * Workplan 15 W4: the near-miss offer inside the send-decisions review dialog.
 * The archive says the decision batch is exactly where the near-miss cohort is
 * lost, so the pipeline click is offered here — additively: a preflight
 * carrying no near_miss renders the dialog it always did (pinned by
 * App.decisionReview.test.tsx), and enrolling never touches the send.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'

import { DecisionReviewDialog } from './App'

const basePre = {
  ok: true,
  accepted: 1,
  declined: 3,
  resend: 0,
  tasks_assigned: 0,
  skipped: 0,
  skipped_notified: 0,
  skipped_no_submitter: 0,
  preflight: true,
  speakers_with_pending: [] as Array<{
    contact_id: string
    name: string
    pending_count: number
    pending_titles: string[]
  }>,
  previews: { accepted: null, declined: null, merged_speakers: 0 },
  job_id: null,
}

describe('DecisionReviewDialog near-miss offer', () => {
  it('offers the declined near-miss cohort to the pipeline in one click', async () => {
    const user = userEvent.setup()
    const onEnroll = vi.fn()
    const onSend = vi.fn()
    render(
      <DecisionReviewDialog
        pre={{ ...basePre, near_miss: { count: 2, ids: ['s1', 's2'], threshold: 4.5 } }}
        onSend={onSend}
        onCancel={() => {}}
        onEnrollNearMiss={onEnroll}
      />,
    )

    expect(screen.getByText(/2 declined talks rated 4\.5\+/i)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Add to speaker pipeline' }))
    expect(onEnroll).toHaveBeenCalledWith(['s1', 's2'])
    // Enrolling is not deciding: the send is untouched and the click does not
    // re-arm (the button gives way to its confirmation).
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByText(/Added to the speaker pipeline/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add to speaker pipeline' })).toBeNull()
  })

  it('is absent when the preflight carries no near-miss data', () => {
    render(<DecisionReviewDialog pre={basePre} onSend={() => {}} onCancel={() => {}} onEnrollNearMiss={() => {}} />)
    expect(screen.queryByText(/add their speakers to the pipeline/i)).toBeNull()
  })
})

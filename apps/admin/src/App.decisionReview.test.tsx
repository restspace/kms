/**
 * CFP-14: the send-decisions review dialog. Every send now passes through it;
 * these pin the counts line, the rendered email previews, the
 * template-disabled fallback copy, and the hold checkbox feeding
 * hold_contact_ids through onSend. (The server half — eligibility, previews,
 * idempotency — is pinned by apps/api/test/send-decisions-directly-decided.test.ts.)
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'

import { DecisionReviewDialog } from './App'

const basePre = {
  ok: true,
  accepted: 2,
  declined: 1,
  resend: 1,
  tasks_assigned: 0,
  skipped: 1,
  skipped_notified: 1,
  skipped_no_submitter: 0,
  preflight: true,
  speakers_with_pending: [] as Array<{
    contact_id: string
    name: string
    pending_count: number
    pending_titles: string[]
  }>,
  previews: {
    accepted: {
      subject: 'Your talk is accepted',
      body_html: '<p>Hi Ada, your talk <strong>CI at scale</strong> is in.</p>',
      body_text: 'Hi Ada',
      sample_to: 'ada@example.com',
    },
    declined: {
      subject: 'About your submission',
      body_html: '<p>Hi Bo, not this time.</p>',
      body_text: 'Hi Bo',
      sample_to: 'bo@example.com',
    },
    merged_speakers: 0,
  },
  job_id: null,
}

describe('DecisionReviewDialog', () => {
  it('shows counts, resend note and rendered previews, and sends without holds', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<DecisionReviewDialog pre={basePre} onSend={onSend} onCancel={() => {}} />)

    expect(screen.getByText(/2 accept emails and 1 decline email will be sent/i)).toBeTruthy()
    expect(screen.getByText(/1 previously decided but never notified — included/i)).toBeTruthy()
    expect(screen.getByText(/1 skipped \(already notified\)/i)).toBeTruthy()
    // The rendered preview HTML, not merge-field placeholders.
    expect(screen.getByText('Your talk is accepted')).toBeTruthy()
    expect(screen.getByText('CI at scale')).toBeTruthy()
    expect(screen.getByText(/sample recipient ada@example.com/i)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Send 3 emails' }))
    expect(onSend).toHaveBeenCalledWith(null)
  })

  it('warns when a template is disabled instead of showing a preview', () => {
    render(
      <DecisionReviewDialog
        pre={{ ...basePre, previews: { ...basePre.previews, declined: null } }}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText(/switched off in Settings/i)).toBeTruthy()
  })

  it('hold checkbox routes the pending speakers into onSend', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const speakers = [{ contact_id: 'c9', name: 'Priya Raman', pending_count: 1, pending_titles: ['RAG talk'] }]
    render(
      <DecisionReviewDialog pre={{ ...basePre, speakers_with_pending: speakers }} onSend={onSend} onCancel={() => {}} />,
    )

    expect(screen.getByText(/other submissions still under review/i)).toBeTruthy()
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Send 3 emails' }))
    expect(onSend).toHaveBeenCalledWith(['c9'])
  })
})

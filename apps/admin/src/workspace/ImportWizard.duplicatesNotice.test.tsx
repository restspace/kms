// Eval defect #13: dedupe on import was strictly by email, so re-importing
// the same person under a different address silently created a second
// contact with no signal. importer.ts now flags a same-name/different-email
// candidate as `plan.possibleDuplicates`; this pins the notice that surfaces
// it in the import wizard and links to the existing Duplicates/merge panel.

import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { ImportDuplicatesNotice } from './ImportWizard'
import * as contactMerge from './contactMerge'
import type { ImportPlan } from '../api'

const basePlan: ImportPlan = {
  target: 'contacts',
  headers: ['First Name', 'Last Name', 'Email'],
  mapping: ['first_name', 'last_name', 'email'],
  rows: [],
  summary: { create: 1, update: 0, merge: 0, attach: 0, skip: 0, error: 0, total: 1 },
  newTracks: [],
  newRooms: [],
  unmapped: [],
  rows_raw: [['Ada', 'Lovelace', 'ada.l@personal.example.com']],
  fields: [],
  event_id: 'evt-1',
}

describe('ImportDuplicatesNotice', () => {
  it('renders nothing when the plan has no possible duplicates', () => {
    const { container } = render(<ImportDuplicatesNotice plan={basePlan} onMerged={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('names the count and pair, and opens the Duplicates panel on click', () => {
    const openSpy = vi.spyOn(contactMerge, 'openDuplicatesPanel').mockImplementation(() => {})
    const plan: ImportPlan = {
      ...basePlan,
      possibleDuplicates: [
        {
          row: 1,
          label: 'Ada Lovelace',
          email: 'ada.l@personal.example.com',
          matchContactId: 'con-1',
          matchLabel: 'Ada Lovelace',
          matchEmail: 'ada.lovelace@work.example.com',
        },
      ],
    }
    render(<ImportDuplicatesNotice plan={plan} onMerged={() => {}} />)
    expect(screen.getByText('1 possible duplicate by name')).toBeTruthy()
    expect(screen.getByText(/ada\.l@personal\.example\.com/)).toBeTruthy()
    expect(screen.getByText(/ada\.lovelace@work\.example\.com/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Review in the Duplicates panel' }))
    expect(openSpy).toHaveBeenCalledTimes(1)
  })

  it('marks a within-file match (no existing contact) distinctly', () => {
    const plan: ImportPlan = {
      ...basePlan,
      possibleDuplicates: [
        {
          row: 2, label: 'Sam Rivera', email: 'sam.2@example.com',
          matchContactId: null, matchLabel: 'Sam Rivera', matchEmail: 'sam.1@example.com',
        },
      ],
    }
    render(<ImportDuplicatesNotice plan={plan} onMerged={() => {}} />)
    expect(screen.getByText('also in this file', { exact: false })).toBeTruthy()
  })
})

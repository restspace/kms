// Room double-booking guard (eval #22): a passive red ghost used to be the
// only signal that a drop double-booked a room — the write went through
// regardless, and a published agenda could carry the conflict live. These
// pin the pure decision logic AgendaSection.tsx builds on: which patches
// even need checking, which severities block, and the confirm-dialog copy.

import { describe, expect, it } from 'vitest'
import type { Conflict } from '@kms/core'
import {
  blockingConflicts,
  conflictConfirmMessage,
  hasBlockingConflict,
  patchNeedsGuard,
  publishConflictMessage,
} from './scheduleGuard'

const conflict = (over: Partial<Conflict> = {}): Conflict => ({
  code: 'ROOM_DOUBLE_BOOKED',
  severity: 'error',
  message: '"Talk A" and "Talk B" overlap in Room 1.',
  session_ids: ['a', 'b'],
  signature: 'sig-1',
  ...over,
})

describe('patchNeedsGuard', () => {
  it('needs a check when both a time and a room are set', () => {
    expect(patchNeedsGuard({ starts_at: '2027-05-12T09:00:00.000Z', room_id: 'r1' })).toBe(true)
  })

  it('skips the check when the room is being cleared (day-only pencil)', () => {
    expect(patchNeedsGuard({ starts_at: '2027-05-12T09:00:00.000Z', room_id: null })).toBe(false)
  })

  it('skips the check when the time is being cleared (unschedule)', () => {
    expect(patchNeedsGuard({ starts_at: null, room_id: 'r1' })).toBe(false)
  })

  it('skips the check when both are null', () => {
    expect(patchNeedsGuard({ starts_at: null, room_id: null })).toBe(false)
  })
})

describe('blockingConflicts / hasBlockingConflict', () => {
  it('treats only error-severity hits as blocking', () => {
    const hits = [conflict({ severity: 'warning', code: 'SPEAKER_TRAVEL_GAP' }), conflict({ severity: 'error' })]
    expect(blockingConflicts(hits)).toHaveLength(1)
    expect(blockingConflicts(hits)[0]?.severity).toBe('error')
    expect(hasBlockingConflict(hits)).toBe(true)
  })

  it('is false when every hit is a warning (passive, as before)', () => {
    const hits = [conflict({ severity: 'warning', code: 'SPEAKER_TRAVEL_GAP' })]
    expect(hasBlockingConflict(hits)).toBe(false)
  })

  it('is false for an empty hit list', () => {
    expect(hasBlockingConflict([])).toBe(false)
  })
})

describe('conflictConfirmMessage', () => {
  it('names the blocking conflict and asks for an explicit override', () => {
    const msg = conflictConfirmMessage([conflict()])
    expect(msg).toContain('"Talk A" and "Talk B" overlap in Room 1.')
    expect(msg).toContain('Schedule anyway?')
  })

  it('lists every blocking conflict when more than one applies', () => {
    const msg = conflictConfirmMessage([
      conflict({ message: 'first overlap' }),
      conflict({ message: 'second overlap', signature: 'sig-2' }),
    ])
    expect(msg).toContain('first overlap')
    expect(msg).toContain('second overlap')
  })

  it('excludes warnings from the listed reasons', () => {
    const msg = conflictConfirmMessage([
      conflict({ severity: 'warning', code: 'SPEAKER_TRAVEL_GAP', message: 'tight speaker gap' }),
      conflict({ message: 'room double-booked' }),
    ])
    expect(msg).not.toContain('tight speaker gap')
    expect(msg).toContain('room double-booked')
  })
})

describe('publishConflictMessage', () => {
  it('names each unresolved conflict and requires acknowledgement', () => {
    const msg = publishConflictMessage([conflict({ message: 'Room A double-booked at 10am' })])
    expect(msg).toContain('1 unresolved scheduling conflict')
    expect(msg).toContain('Room A double-booked at 10am')
    expect(msg).toContain('Publish anyway?')
  })

  it('pluralizes the count for more than one conflict', () => {
    const msg = publishConflictMessage([
      conflict({ message: 'a', signature: 's1' }),
      conflict({ message: 'b', signature: 's2' }),
    ])
    expect(msg).toContain('2 unresolved scheduling conflicts')
  })

  it('collapses beyond the sixth into a "…and N more" tail rather than an unbounded list', () => {
    const unresolved = Array.from({ length: 9 }, (_, i) => conflict({ message: `conflict ${i}`, signature: `s${i}` }))
    const msg = publishConflictMessage(unresolved)
    for (let i = 0; i < 6; i++) expect(msg).toContain(`conflict ${i}`)
    for (let i = 6; i < 9; i++) expect(msg).not.toContain(`conflict ${i}`)
    expect(msg).toContain('…and 3 more')
  })
})

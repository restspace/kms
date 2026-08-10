import { describe, expect, it } from 'vitest'
import { effectiveFormStatus, isEffectivelyClosed } from './formStatus'

describe('effectiveFormStatus', () => {
  it('open with no close_at is open', () => {
    expect(effectiveFormStatus({ status: 'open', close_at: null })).toBe('open')
  })

  it('open with a future close_at is open', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(effectiveFormStatus({ status: 'open', close_at: future })).toBe('open')
  })

  it('open with a past close_at is closed-by-date (the status duality case)', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    expect(effectiveFormStatus({ status: 'open', close_at: past })).toBe('closed-by-date')
    expect(isEffectivelyClosed({ status: 'open', close_at: past })).toBe(true)
  })

  it('explicit status=closed is closed regardless of close_at', () => {
    expect(effectiveFormStatus({ status: 'closed', close_at: null })).toBe('closed')
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(effectiveFormStatus({ status: 'closed', close_at: future })).toBe('closed')
  })
})

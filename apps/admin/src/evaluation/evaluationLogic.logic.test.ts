import { describe, expect, it } from 'vitest'
import { buildAssignBody, buildScalePatch, parseCapInput, resolveDateInputBlur } from './evaluationLogic'

describe('buildScalePatch (ABS-01)', () => {
  it('returns the changed field as a patch', () => {
    expect(buildScalePatch('scoring_scale_min', '0', 1)).toEqual({ scoring_scale_min: 0 })
    expect(buildScalePatch('scoring_scale_max', '10', 5)).toEqual({ scoring_scale_max: 10 })
  })

  it('returns null when the value is unchanged', () => {
    expect(buildScalePatch('scoring_scale_min', '1', 1)).toBeNull()
  })

  it('returns null for an unparseable value rather than sending NaN', () => {
    expect(buildScalePatch('scoring_scale_max', 'abc', 5)).toBeNull()
  })
})

describe('buildAssignBody (ABS-05)', () => {
  const base = { reviewer_contact_ids: ['r1', 'r2'], strategy: 'all' as const, per_submission: 2 }

  it('carries no submission_ids when not scoped', () => {
    expect(buildAssignBody(base, false, new Set(['s1']))).toEqual(base)
  })

  it('carries no submission_ids when scoped is on but nothing is picked', () => {
    expect(buildAssignBody(base, true, new Set())).toEqual(base)
  })

  it('adds submission_ids when scoped and something is picked', () => {
    expect(buildAssignBody(base, true, new Set(['s1', 's2']))).toEqual({
      ...base,
      submission_ids: ['s1', 's2'],
    })
  })

  it('accepts a plain array too', () => {
    expect(buildAssignBody(base, true, ['s1'])).toEqual({ ...base, submission_ids: ['s1'] })
  })
})

describe('parseCapInput (ABS-06)', () => {
  it('parses a blank field as clearing the cap to null', () => {
    expect(parseCapInput('', 3)).toBeNull()
  })

  it('parses a number', () => {
    expect(parseCapInput('4', null)).toBe(4)
  })

  it('returns undefined (no-op) when the value did not change', () => {
    expect(parseCapInput('4', 4)).toBeUndefined()
    expect(parseCapInput('', null)).toBeUndefined()
  })
})

describe('resolveDateInputBlur (eval defect #24)', () => {
  const parse = (v: string) => (v ? `${v}:00.000Z` : null)

  it('never saves when badInput is set, regardless of the (always empty) value', () => {
    expect(resolveDateInputBlur('', true, '2027-01-01T09:00:00.000Z', parse)).toEqual({ action: 'invalid' });
  });

  it('a genuinely empty value with no badInput is an intentional clear', () => {
    expect(resolveDateInputBlur('', false, '2027-01-01T09:00:00.000Z', parse)).toEqual({
      action: 'save',
      next: null,
    });
  });

  it('saves a complete, changed value', () => {
    expect(resolveDateInputBlur('2027-02-01T10:00', false, null, parse)).toEqual({
      action: 'save',
      next: '2027-02-01T10:00:00.000Z',
    });
  });

  it('is a no-op when the parsed value matches what is already stored', () => {
    expect(resolveDateInputBlur('2027-02-01T10:00', false, '2027-02-01T10:00:00.000Z', parse)).toEqual({
      action: 'noop',
    });
  });
})

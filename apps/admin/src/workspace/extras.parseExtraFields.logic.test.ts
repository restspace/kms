/**
 * Workplan 11 (G7/§5.4): `extra` is a nullable JSON-text column of
 * `{original header: value}` for columns an import left unmapped, surfaced
 * read-only on the submission detail panel as "Imported fields"
 * (SubmissionDetailPanel, workspace/extras.tsx). `parseExtraFields` is the
 * pure seam that decides what shows — cheap to pin without mounting the
 * panel, unlike the rest of that component (DOM-heavy, per
 * SubmissionDetailPanel.test.tsx).
 */
import { describe, expect, it } from 'vitest'
import { parseExtraFields } from './extras'

describe('parseExtraFields', () => {
  it('returns nothing when extra is absent, null, or blank', () => {
    expect(parseExtraFields(undefined)).toEqual([])
    expect(parseExtraFields(null)).toEqual([])
    expect(parseExtraFields('')).toEqual([])
    expect(parseExtraFields('   ')).toEqual([])
  })

  it('returns nothing for malformed JSON rather than throwing', () => {
    expect(parseExtraFields('{not json')).toEqual([])
  })

  it('returns nothing for a non-object JSON value (array, string, number)', () => {
    expect(parseExtraFields('[1,2,3]')).toEqual([])
    expect(parseExtraFields('"hello"')).toEqual([])
    expect(parseExtraFields('42')).toEqual([])
  })

  it('renders header/value pairs from a JSON object, stringifying non-strings', () => {
    expect(parseExtraFields(JSON.stringify({ 'Badge Type': 'VIP', Rank: 3 }))).toEqual([
      ['Badge Type', 'VIP'],
      ['Rank', '3'],
    ])
  })

  it('drops keys whose value is null, undefined, or empty string', () => {
    expect(parseExtraFields(JSON.stringify({ Kept: 'x', Blank: '', Nully: null }))).toEqual([['Kept', 'x']])
  })
})

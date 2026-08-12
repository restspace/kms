// The filename shown in the export toast must be the one the server named in
// Content-Disposition (adminApi.ts `<scope>-<resource>-<date>.<format>`).

import { describe, expect, it } from 'vitest'
import { parseAttachmentFilename } from './exportDownload'

describe('parseAttachmentFilename', () => {
  it('reads the quoted form the workspace export endpoint sends', () => {
    expect(parseAttachmentFilename('attachment; filename="devconf-submissions-2026-08-12.csv"')).toBe(
      'devconf-submissions-2026-08-12.csv',
    )
  })

  it('reads a bare (unquoted) filename', () => {
    expect(parseAttachmentFilename('attachment; filename=export.xlsx')).toBe('export.xlsx')
  })

  it('prefers the RFC 5987 extended form and decodes it', () => {
    expect(
      parseAttachmentFilename(`attachment; filename="fallback.csv"; filename*=UTF-8''caf%C3%A9-export.csv`),
    ).toBe('café-export.csv')
  })

  it('returns null for a missing or filename-less header', () => {
    expect(parseAttachmentFilename(null)).toBeNull()
    expect(parseAttachmentFilename('inline')).toBeNull()
  })
})

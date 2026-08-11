// Sanity checks for the Sessionboard fixtures (workplan 11 §7/§9): the XLSX
// builder must round-trip through the repo's own parseXlsx, and the horrors
// CSV's BOM/CRLF must not swallow or split rows.

import { describe, expect, it } from 'vitest';
import { parseCsv, parseXlsx } from '../src/importer';
import { SB_HORRORS_CSV, buildSbSessionsXlsx } from './fixtures-sessionboard';

describe('sessionboard fixtures', () => {
  it('round-trips buildSbSessionsXlsx through parseXlsx, incl. the raw serial-date cell', () => {
    const rows = parseXlsx(buildSbSessionsXlsx());
    expect(rows[0]).toEqual([
      'Session ID',
      'Session Name',
      'Description',
      'Session Status',
      'Track',
      'Room',
      'Session Start Time',
      'Session End Time',
      'Speakers',
      'Tags',
      'Session Format',
    ]);
    expect(rows).toHaveLength(4); // header + 3 data rows
    expect(rows[1]?.[0]).toBe('SB-1001');
    // The serial-date cell (row 2, "Session Start Time") comes back as the
    // raw number string — no t="" attribute, so parseXlsx can't know it's a
    // date (documented gap, importer.ts:109-114).
    expect(rows[2]?.[6]).toBe('46297.396');
  });

  it('parses the horrors CSV despite a leading BOM and CRLF line endings', () => {
    const rows = parseCsv(SB_HORRORS_CSV);
    // header + 8 adversarial data rows; none is entirely blank, so parseCsv's
    // blank-row filter drops nothing here.
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual([
      'Session ID',
      'Session Name',
      'Description',
      'Session Status',
      'Track',
      'Room',
      'Session Start Time',
      'Session End Time',
      'Speakers',
      'Tags',
      'Session Format',
    ]);
    // BOM must not leak into the first header cell.
    expect(rows[0]?.[0]).toBe('Session ID');
    // Quoted comma survives as one field, not two.
    expect(rows[3]).toContain('Scaling, Fast and Slow');
  });
});

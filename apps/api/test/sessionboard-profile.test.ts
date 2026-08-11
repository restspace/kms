// Unit coverage for apps/api/src/sourceProfiles.ts (workplan 11, §5.1) — pure
// functions, no D1/session fixtures needed, so this runs happily under the
// "workers" vitest project alongside event-date-parsing.test.ts (same
// rationale: sourceProfiles.ts sits under apps/api/src, which the plain
// "unit" project doesn't include).

import { describe, expect, it } from 'vitest';
import {
  isImportSource,
  SESSIONBOARD_STATUS_MAP,
  sessionboardStatus,
  splitMulti,
  sessionboardDateToIso,
  excelSerialToIso,
  parseSpeakerCell,
} from '../src/sourceProfiles';

// Mirrors importer.ts's (unexported) SUBMISSION_STATUSES — the KMS
// submission-status vocabulary every mapped Sessionboard status must land in.
const KMS_SUBMISSION_STATUSES = new Set([
  'draft', 'pending', 'accept_queue', 'accepted', 'decline_queue', 'declined', 'withdrawn',
]);

describe('isImportSource', () => {
  it('accepts the two known sources and rejects everything else', () => {
    expect(isImportSource('generic')).toBe(true);
    expect(isImportSource('sessionboard')).toBe(true);
    expect(isImportSource('other')).toBe(false);
    expect(isImportSource(undefined)).toBe(false);
    expect(isImportSource(null)).toBe(false);
    expect(isImportSource(42)).toBe(false);
  });
});

describe('sessionboardStatus', () => {
  it('maps every entry in SESSIONBOARD_STATUS_MAP onto a real KMS status', () => {
    for (const [sessionboardValue, kmsStatus] of Object.entries(SESSIONBOARD_STATUS_MAP)) {
      expect(KMS_SUBMISSION_STATUSES.has(kmsStatus)).toBe(true);
      // The lookup itself round-trips regardless of case/whitespace.
      expect(sessionboardStatus(sessionboardValue).status).toBe(kmsStatus);
      expect(sessionboardStatus(sessionboardValue).note).toBeNull();
      expect(sessionboardStatus(`  ${sessionboardValue.toUpperCase()}  `).status).toBe(kmsStatus);
    }
  });

  it('covers the documented groupings explicitly', () => {
    expect(sessionboardStatus('Confirmed').status).toBe('accepted');
    expect(sessionboardStatus('Approved').status).toBe('accepted');
    expect(sessionboardStatus('Rejected').status).toBe('declined');
    expect(sessionboardStatus('Cancelled').status).toBe('withdrawn');
    expect(sessionboardStatus('Canceled').status).toBe('withdrawn');
    expect(sessionboardStatus('Under Review').status).toBe('pending');
    expect(sessionboardStatus('Submitted').status).toBe('pending');
    expect(sessionboardStatus('Composition').status).toBe('draft');
    expect(sessionboardStatus('In Progress').status).toBe('draft');
  });

  it('falls back to pending with a note carrying the original value for unknown statuses', () => {
    const result = sessionboardStatus('Waitlisted');
    expect(result.status).toBe('pending');
    expect(result.note).toBe('Sessionboard status "Waitlisted" not recognised — imported as pending');
  });

  it('preserves the original (untrimmed-case) value in the note, trimmed of surrounding whitespace', () => {
    const result = sessionboardStatus('  Custom: Needs Rework  ');
    expect(result.note).toBe('Sessionboard status "Custom: Needs Rework" not recognised — imported as pending');
  });
});

describe('splitMulti', () => {
  it('splits on pipes', () => {
    expect(splitMulti('Track A | Track B | Track C')).toEqual(['Track A', 'Track B', 'Track C']);
  });

  it('splits on semicolons', () => {
    expect(splitMulti('alice@example.com; bob@example.com')).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('drops empty fragments and trims whitespace', () => {
    expect(splitMulti(' A | | B ')).toEqual(['A', 'B']);
  });

  it('returns a single value unchanged when there is no separator', () => {
    expect(splitMulti('Just One Track')).toEqual(['Just One Track']);
  });

  it('splits on commas only when every fragment looks like an email', () => {
    expect(splitMulti('alice@example.com, bob@example.com')).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('protects "Last, First" names — a comma is not treated as a separator when any fragment is not an email', () => {
    expect(splitMulti('Smith, John')).toEqual(['Smith, John']);
    expect(splitMulti('Smith, John | Doe, Jane')).toEqual(['Smith, John', 'Doe, Jane']);
  });

  it('handles a mix: comma-separated emails alongside a semicolon-separated "Last, First" name', () => {
    expect(splitMulti('alice@example.com, bob@example.com; Smith, John')).toEqual([
      'alice@example.com', 'bob@example.com', 'Smith, John',
    ]);
  });
});

describe('sessionboardDateToIso', () => {
  it('parses YYYY-MM-DD HH:mm as wall-clock time in the event timezone (LA, PDT, normal date)', () => {
    expect(sessionboardDateToIso('2026-08-11 09:30', 'America/Los_Angeles')).toBe('2026-08-11T16:30:00.000Z');
  });

  it('parses YYYY-MM-DD HH:mm:ss', () => {
    expect(sessionboardDateToIso('2026-08-11 09:30:15', 'America/Los_Angeles')).toBe('2026-08-11T16:30:15.000Z');
  });

  it('parses a bare YYYY-MM-DD as local midnight', () => {
    expect(sessionboardDateToIso('2026-08-11', 'America/Los_Angeles')).toBe('2026-08-11T07:00:00.000Z');
  });

  it('handles the America/Los_Angeles DST boundary (2026-03-08, spring-forward day)', () => {
    // Clocks in LA jump 02:00 -> 03:00 on 2026-03-08, so 02:30 does not exist.
    // The two-pass wall-clock conversion still converges to a stable instant
    // (deterministically, the pre-transition PST offset) rather than throwing.
    expect(sessionboardDateToIso('2026-03-08 02:30', 'America/Los_Angeles')).toBe('2026-03-08T09:30:00.000Z');
    // Times either side of the gap are unambiguous and land 1 hour apart in
    // UTC despite being 1 hour apart on the clock too — confirms the offset
    // shift is being applied at all.
    expect(sessionboardDateToIso('2026-03-08 01:30', 'America/Los_Angeles')).toBe('2026-03-08T09:30:00.000Z');
    expect(sessionboardDateToIso('2026-03-08 03:30', 'America/Los_Angeles')).toBe('2026-03-08T10:30:00.000Z');
  });

  it('treats UTC as the event timezone with no offset applied', () => {
    expect(sessionboardDateToIso('2026-08-11 09:30', 'UTC')).toBe('2026-08-11T09:30:00.000Z');
  });

  it('passes through a value that already carries an explicit Z/offset unchanged (converted to ISO)', () => {
    expect(sessionboardDateToIso('2026-08-11T09:30:00Z', 'America/Los_Angeles')).toBe('2026-08-11T09:30:00.000Z');
    expect(sessionboardDateToIso('2026-08-11T09:30:00-04:00', 'America/Los_Angeles')).toBe('2026-08-11T13:30:00.000Z');
  });

  it('returns null for unparseable input', () => {
    expect(sessionboardDateToIso('not a date', 'UTC')).toBeNull();
    expect(sessionboardDateToIso('', 'UTC')).toBeNull();
    expect(sessionboardDateToIso('2026/08/11 09:30', 'UTC')).toBeNull();
  });
});

describe('excelSerialToIso', () => {
  it('converts a known Excel serial (2024-01-01 UTC) with no fractional time', () => {
    // Excel serial 45292 is the well-known value for 2024-01-01 under the
    // 1900 date system this profile documents (day 25569 = 1970-01-01).
    expect(excelSerialToIso(45292, 'UTC')).toBe('2024-01-01T00:00:00.000Z');
  });

  it('applies the fractional part as time of day', () => {
    expect(excelSerialToIso(45292.5, 'UTC')).toBe('2024-01-01T12:00:00.000Z');
    expect(excelSerialToIso(45292.25, 'UTC')).toBe('2024-01-01T06:00:00.000Z');
  });

  it('reads the fraction as wall-clock time in a non-UTC event timezone', () => {
    // 45292.5 = 2024-01-01 12:00 wall-clock; LA is UTC-8 in January (PST).
    expect(excelSerialToIso(45292.5, 'America/Los_Angeles')).toBe('2024-01-01T20:00:00.000Z');
  });

  it('guards non-finite and out-of-range serials', () => {
    expect(excelSerialToIso(Number.NaN, 'UTC')).toBeNull();
    expect(excelSerialToIso(Number.POSITIVE_INFINITY, 'UTC')).toBeNull();
    expect(excelSerialToIso(0, 'UTC')).toBeNull();
    expect(excelSerialToIso(-5, 'UTC')).toBeNull();
    expect(excelSerialToIso(200001, 'UTC')).toBeNull();
  });
});

describe('parseSpeakerCell', () => {
  it('classifies a single email', () => {
    expect(parseSpeakerCell('alice@example.com')).toEqual([{ kind: 'email', value: 'alice@example.com' }]);
  });

  it('classifies a single name and collapses internal whitespace', () => {
    expect(parseSpeakerCell('Jane   Doe')).toEqual([{ kind: 'name', value: 'Jane Doe' }]);
  });

  it('lower-cases emails but leaves name casing alone', () => {
    expect(parseSpeakerCell('Alice@Example.COM')).toEqual([{ kind: 'email', value: 'alice@example.com' }]);
    expect(parseSpeakerCell('Jane Doe')).toEqual([{ kind: 'name', value: 'Jane Doe' }]);
  });

  it('handles a mixed cell of emails and names, pipe-separated', () => {
    expect(parseSpeakerCell('alice@example.com | Jane Doe | bob@example.com')).toEqual([
      { kind: 'email', value: 'alice@example.com' },
      { kind: 'name', value: 'Jane Doe' },
      { kind: 'email', value: 'bob@example.com' },
    ]);
  });

  it('protects a "Last, First" name inside a mixed cell', () => {
    expect(parseSpeakerCell('Smith, John | alice@example.com')).toEqual([
      { kind: 'name', value: 'Smith, John' },
      { kind: 'email', value: 'alice@example.com' },
    ]);
  });

  it('returns an empty array for an empty cell', () => {
    expect(parseSpeakerCell('')).toEqual([]);
  });
});

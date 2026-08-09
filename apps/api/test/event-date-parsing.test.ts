// Unit coverage for eventDateToIso (apps/api/src/routes/adminApi.ts): the
// server-side bare-date -> UTC parser fixing the "May 12-14 configured shows
// as May 11-13" off-by-one (CreateEventDialog submits <input type="date">
// values like "2027-05-12"; naive `new Date(...).toISOString()` reads that
// as UTC midnight, which is the *previous* calendar day once rendered back
// in a timezone west of UTC). This file runs under the "workers" vitest
// project (apps/api/vitest.config.ts) rather than "unit" since adminApi.ts
// lives under apps/api/src which that project doesn't include — the function
// itself is pure and needs no D1/session fixtures.

import { describe, expect, it } from 'vitest';
import { eventDateToIso } from '../src/routes/adminApi';

// Mirrors apps/admin/src/agenda/timeUtils.ts utcToLocal's day extraction, so
// the test asserts against the same logic the admin UI uses to render days.
function localDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso));
}

describe('eventDateToIso — bare dates', () => {
  it('round-trips a bare start date to local midnight in a UTC-negative tz (LA)', () => {
    const iso = eventDateToIso('2027-05-12', 'America/Los_Angeles', false);
    expect(iso).not.toBeNull();
    expect(localDay(iso as string, 'America/Los_Angeles')).toBe('2027-05-12');
    // Local midnight in LA in May (PDT, UTC-7) is 07:00 UTC — not the naive
    // UTC-midnight interpretation that caused the bug.
    expect(iso).toBe('2027-05-12T07:00:00.000Z');
  });

  it('round-trips a bare start date to local midnight in a UTC-positive tz (Tokyo)', () => {
    const iso = eventDateToIso('2027-05-12', 'Asia/Tokyo', false);
    expect(iso).not.toBeNull();
    expect(localDay(iso as string, 'Asia/Tokyo')).toBe('2027-05-12');
    expect(iso).toBe('2027-05-11T15:00:00.000Z');
  });

  it('resolves a bare end date to the end of that local day, not its start', () => {
    const iso = eventDateToIso('2027-05-14', 'America/Los_Angeles', true);
    expect(iso).not.toBeNull();
    // Still lands on the configured calendar day...
    expect(localDay(iso as string, 'America/Los_Angeles')).toBe('2027-05-14');
    // ...at (just under) the next local midnight, not at 00:00.
    expect(iso).toBe('2027-05-15T06:59:59.999Z');
  });

  it('a 3-day event (05-12..05-14) covers exactly those three local days in LA', () => {
    const starts = eventDateToIso('2027-05-12', 'America/Los_Angeles', false) as string;
    const ends = eventDateToIso('2027-05-14', 'America/Los_Angeles', true) as string;
    expect(localDay(starts, 'America/Los_Angeles')).toBe('2027-05-12');
    expect(localDay(ends, 'America/Los_Angeles')).toBe('2027-05-14');
    // The old UTC-midnight parse would have put both endpoints one day early.
    expect(localDay(starts, 'America/Los_Angeles')).not.toBe('2027-05-11');
  });

  it('handles a DST-transition span (America/Los_Angeles spring-forward, March 2027)', () => {
    const starts = eventDateToIso('2027-03-13', 'America/Los_Angeles', false) as string;
    const ends = eventDateToIso('2027-03-15', 'America/Los_Angeles', true) as string;
    expect(localDay(starts, 'America/Los_Angeles')).toBe('2027-03-13');
    expect(localDay(ends, 'America/Los_Angeles')).toBe('2027-03-15');
  });
});

describe('eventDateToIso — full ISO instants are unaffected', () => {
  it('passes through a zoned instant unchanged (modulo normalisation)', () => {
    expect(eventDateToIso('2027-05-12T09:00:00Z', 'America/Los_Angeles', false)).toBe('2027-05-12T09:00:00.000Z');
    expect(eventDateToIso('2027-05-12T09:00:00-04:00', 'America/Los_Angeles', false)).toBe('2027-05-12T13:00:00.000Z');
  });

  it('rejects invalid input', () => {
    expect(eventDateToIso('not-a-date', 'UTC', false)).toBeNull();
    expect(eventDateToIso('', 'UTC', false)).toBeNull();
    expect(eventDateToIso(undefined, 'UTC', false)).toBeNull();
    expect(eventDateToIso(null, 'UTC', false)).toBeNull();
  });
});

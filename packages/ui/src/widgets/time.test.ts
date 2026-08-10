// EMB-16: every widget must render a session's time in the EVENT's own
// timezone with a tz label ("10 AM PDT"), not a raw/viewer-local string —
// this is the one shared helper set all of Sessions/Schedule/Agenda/Speaker
// detail import instead of rolling their own `toLocaleTimeString`.

import { describe, expect, it } from 'vitest';
import { eventDays, fmtDayLong, fmtDayShort, fmtMinutes, fmtTimeRange, tzAbbr, utcToLocal } from './time';

describe('utcToLocal / fmtMinutes / tzAbbr', () => {
  it('converts a UTC instant to event-local wall time (America/Los_Angeles, DST)', () => {
    // 2027-05-12T17:00:00Z is PDT (UTC-7) in May -> 10:00 local.
    const local = utcToLocal('2027-05-12T17:00:00.000Z', 'America/Los_Angeles');
    expect(local.day).toBe('2027-05-12');
    expect(local.minutes).toBe(10 * 60);
    expect(fmtMinutes(local.minutes)).toBe('10 AM');
    expect(tzAbbr('America/Los_Angeles', '2027-05-12T17:00:00.000Z')).toBe('PDT');
  });

  it('falls back to UTC for an unknown/blank timezone rather than throwing', () => {
    expect(() => utcToLocal('2027-05-12T17:00:00.000Z', '')).not.toThrow();
  });
});

describe('fmtTimeRange', () => {
  it('renders "10 AM – 10:30 AM PDT", never a raw UTC-looking string', () => {
    const range = fmtTimeRange('2027-05-12T17:00:00.000Z', '2027-05-12T17:30:00.000Z', 'America/Los_Angeles');
    expect(range).toBe('10 AM – 10:30 AM PDT');
  });

  it('clamps an end time that lands on a later local day to end-of-day rather than wrapping', () => {
    // Starts 11:50 PM local, ends 00:20 the next local day.
    const range = fmtTimeRange('2027-05-13T06:50:00.000Z', '2027-05-13T07:20:00.000Z', 'America/Los_Angeles');
    expect(range).toBe('11:50 PM – 12 AM PDT');
  });
});

describe('fmtDayShort / fmtDayLong', () => {
  it('formats a YYYY-MM-DD day key without shifting date under any viewer offset', () => {
    expect(fmtDayShort('2027-05-12')).toBe('Wed, May 12');
    expect(fmtDayLong('2027-05-12')).toBe('Wednesday, May 12');
  });
});

describe('eventDays', () => {
  it('returns the inclusive list of event-local days between two UTC instants', () => {
    const days = eventDays('2027-05-12T17:00:00.000Z', '2027-05-14T02:00:00.000Z', 'America/Los_Angeles');
    expect(days).toEqual(['2027-05-12', '2027-05-13']);
  });

  it('returns a single day for a same-day event', () => {
    const days = eventDays('2027-05-12T17:00:00.000Z', '2027-05-12T23:00:00.000Z', 'America/Los_Angeles');
    expect(days).toEqual(['2027-05-12']);
  });
});

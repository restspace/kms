import { describe, expect, it } from 'vitest';
import { eventLocalDay } from './time';

describe('eventLocalDay', () => {
  it('reads the day off a wall clock in the given zone, not UTC', () => {
    // 2026-08-11T02:00Z is still the 10th in Los Angeles (UTC-7 in August).
    expect(eventLocalDay('2026-08-11T02:00:00Z', 'America/Los_Angeles')).toBe('2026-08-10');
    expect(eventLocalDay('2026-08-11T02:00:00Z', 'UTC')).toBe('2026-08-11');
  });

  it('is stable across the UTC rollover that a US-afternoon press straddles', () => {
    // 17:00 and 18:00 PDT are 00:00 and 01:00 UTC the next day: a UTC-keyed
    // guard would call these different days and let a duplicate through.
    const before = eventLocalDay('2026-08-11T00:00:00Z', 'America/Los_Angeles');
    const after = eventLocalDay('2026-08-11T01:00:00Z', 'America/Los_Angeles');
    expect(before).toBe('2026-08-10');
    expect(after).toBe(before);
  });

  it('handles zones ahead of UTC', () => {
    expect(eventLocalDay('2026-08-10T22:00:00Z', 'Asia/Tokyo')).toBe('2026-08-11');
  });
});

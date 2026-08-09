import { describe, expect, it } from 'vitest';
import { buildIcs } from './ics';

const base = {
  uid: 'session@example.com',
  sequence: 0,
  method: 'REQUEST' as const,
  timezone: 'Asia/Tokyo',
  startsAtLocal: '2026-10-12T09:00:00',
  endsAtLocal: '2026-10-12T10:00:00',
  startsAtUtc: '2026-10-12T00:00:00Z',
  endsAtUtc: '2026-10-12T01:00:00Z',
  summary: 'Session',
  location: 'Room',
  description: 'Description',
  organizerName: 'Event',
  organizerEmail: 'events@example.com',
  attendees: [{ name: 'Speaker', email: 'speaker@example.com' }],
};

describe('buildIcs', () => {
  it('uses the true UTC instant when a VTIMEZONE is not bundled', () => {
    const ics = buildIcs(base);
    expect(ics).toContain('DTSTART:20261012T000000Z');
    expect(ics).toContain('DTEND:20261012T010000Z');
  });

  it('folds every physical content line at 75 UTF-8 octets', () => {
    const ics = buildIcs({ ...base, summary: 'é'.repeat(100) });
    for (const line of ics.split('\r\n')) {
      expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
    }
  });
});

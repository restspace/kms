// End-to-end coverage for the bare-date off-by-one fix: create an event
// through POST /app/api/events with <input type="date">-style bare dates and
// a timezone, then confirm the stored starts_at/ends_at land on the
// configured calendar days once run through the *actual* admin agenda day
// math (apps/admin/src/agenda/timeUtils.ts eventDays), not a re-implementation
// of it. Also covers PATCH re-sending a bare date against the event's
// already-stored timezone.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { eventDays } from '../../admin/src/agenda/timeUtils';
import { jsonReq, seedEvent, seedStaff } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

describe('POST /app/api/events — bare dates + timezone', () => {
  it('a US-timezone event configured for May 12-14 shows May 12-14, not May 11-13', async () => {
    const seedEventId = await seedEvent();
    const admin = await seedStaff(seedEventId, 'admin');

    const slug = `bare-date-${crypto.randomUUID().slice(0, 8)}`;
    const res = await api('/events', admin.cookie, {
      name: 'Bare Date Event',
      slug,
      timezone: 'America/Los_Angeles',
      starts_at: '2027-05-12',
      ends_at: '2027-05-14',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const row = await env.DB.prepare('SELECT starts_at, ends_at, timezone FROM events WHERE id = ?')
      .bind(id).first<{ starts_at: string; ends_at: string; timezone: string }>();
    expect(row).toBeTruthy();

    const days = eventDays(row!.starts_at, row!.ends_at, row!.timezone);
    expect(days).toEqual(['2027-05-12', '2027-05-13', '2027-05-14']);
  });

  it('a Tokyo event configured for May 12-14 also shows May 12-14', async () => {
    const seedEventId = await seedEvent();
    const admin = await seedStaff(seedEventId, 'admin');

    const slug = `bare-date-tokyo-${crypto.randomUUID().slice(0, 8)}`;
    const res = await api('/events', admin.cookie, {
      name: 'Bare Date Event Tokyo',
      slug,
      timezone: 'Asia/Tokyo',
      starts_at: '2027-05-12',
      ends_at: '2027-05-14',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const row = await env.DB.prepare('SELECT starts_at, ends_at, timezone FROM events WHERE id = ?')
      .bind(id).first<{ starts_at: string; ends_at: string; timezone: string }>();
    const days = eventDays(row!.starts_at, row!.ends_at, row!.timezone);
    expect(days).toEqual(['2027-05-12', '2027-05-13', '2027-05-14']);
  });

  it('full ISO starts_at/ends_at still work unchanged alongside a timezone', async () => {
    const seedEventId = await seedEvent();
    const admin = await seedStaff(seedEventId, 'admin');
    const slug = `iso-date-${crypto.randomUUID().slice(0, 8)}`;
    const res = await api('/events', admin.cookie, {
      name: 'ISO Date Event',
      slug,
      timezone: 'America/Los_Angeles',
      starts_at: '2027-05-12T16:00:00Z',
      ends_at: '2027-05-14T20:00:00Z',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await env.DB.prepare('SELECT starts_at, ends_at FROM events WHERE id = ?')
      .bind(id).first<{ starts_at: string; ends_at: string }>();
    expect(row?.starts_at).toBe('2027-05-12T16:00:00.000Z');
    expect(row?.ends_at).toBe('2027-05-14T20:00:00.000Z');
  });
});

describe('PATCH /app/api/events/:id — bare date resolves against the stored timezone', () => {
  it('re-sending a bare starts_at without timezone in the body uses the current stored tz', async () => {
    const seedEventId = await seedEvent();
    const admin = await seedStaff(seedEventId, 'admin');
    const slug = `patch-bare-${crypto.randomUUID().slice(0, 8)}`;
    const created = await api('/events', admin.cookie, {
      name: 'Patch Bare Event',
      slug,
      timezone: 'America/Los_Angeles',
      starts_at: '2027-05-12',
      ends_at: '2027-05-14',
    });
    const { id } = (await created.json()) as { id: string };

    const patched = await api(
      `/events/${id}`,
      admin.cookie,
      { starts_at: '2027-06-01', ends_at: '2027-06-02' },
      'PATCH',
    );
    expect(patched.status).toBe(200);

    const row = await env.DB.prepare('SELECT starts_at, ends_at, timezone FROM events WHERE id = ?')
      .bind(id).first<{ starts_at: string; ends_at: string; timezone: string }>();
    expect(row?.timezone).toBe('America/Los_Angeles');
    const days = eventDays(row!.starts_at, row!.ends_at, row!.timezone);
    expect(days[0]).toBe('2027-06-01');
  });
});

// applyFeedFilter — the one place the ?track= / ?day= embed filters are
// applied (lane W3-A). Every widget pipes its fetched feed through it, so the
// rules live here rather than three times over.

import { describe, expect, it } from 'vitest';
import { applyFeedFilter, isEmptyFilter, trackSlug, type AgendaFeed, type PublicSession } from './publicData';

const session = (over: Partial<PublicSession> & { id: string }): PublicSession => ({
  code: over.id.toUpperCase(),
  title: `Talk ${over.id}`,
  description: null,
  format: null,
  level: null,
  capacity: null,
  track_id: null,
  room_id: null,
  starts_at: '2026-10-01T09:00:00.000Z',
  ends_at: '2026-10-01T10:00:00.000Z',
  day: '2026-10-01',
  speakers: [],
  speaker_details: [],
  ...over,
});

const feed: AgendaFeed = {
  event: { name: 'Test', slug: 'test', timezone: 'UTC' },
  days: ['2026-10-01', '2026-10-02'],
  rooms: [],
  tracks: [
    { id: 'trk-a', name: 'Platform', color: null },
    { id: 'trk-b', name: 'Design', color: null },
  ],
  sessions: [
    session({ id: 'a1', track_id: 'trk-a' }),
    session({ id: 'b1', track_id: 'trk-b' }),
    session({ id: 'a2', track_id: 'trk-a', day: '2026-10-02', starts_at: '2026-10-02T09:00:00.000Z' }),
    session({ id: 'n1', day: '2026-10-02', starts_at: '2026-10-02T11:00:00.000Z' }),
  ],
};

const ids = (f: AgendaFeed | null) => (f?.sessions ?? []).map((s) => s.id);

describe('isEmptyFilter', () => {
  it('treats absent, empty and blank filters as no filter', () => {
    expect(isEmptyFilter(undefined)).toBe(true);
    expect(isEmptyFilter(null)).toBe(true);
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ track: '', day: null })).toBe(true);
    expect(isEmptyFilter({ track: 'trk-a' })).toBe(false);
  });
});

describe('applyFeedFilter', () => {
  it('returns the same feed object when there is nothing to filter', () => {
    expect(applyFeedFilter(feed)).toBe(feed);
    expect(applyFeedFilter(feed, {})).toBe(feed);
  });

  it('passes a null feed (not published) straight through', () => {
    expect(applyFeedFilter(null, { track: 'trk-a' })).toBeNull();
  });

  it('matches a track by id or by name, case-insensitively', () => {
    expect(ids(applyFeedFilter(feed, { track: 'trk-a' }))).toEqual(['a1', 'a2']);
    expect(ids(applyFeedFilter(feed, { track: 'Platform' }))).toEqual(['a1', 'a2']);
    expect(ids(applyFeedFilter(feed, { track: 'platform' }))).toEqual(['a1', 'a2']);
  });

  it('matches a track by its readable slug (what generated embed links carry)', () => {
    const slugFeed: AgendaFeed = {
      ...feed,
      tracks: [{ id: '1e34aaaa-0000-4000-8000-000000000000', name: 'Platform Engineering', color: null }],
      sessions: [session({ id: 'p1', track_id: '1e34aaaa-0000-4000-8000-000000000000' })],
    };
    expect(trackSlug('Platform Engineering')).toBe('platform-engineering');
    expect(ids(applyFeedFilter(slugFeed, { track: 'platform-engineering' }))).toEqual(['p1']);
    // UUID and raw name keep working (back-compat with old links).
    expect(ids(applyFeedFilter(slugFeed, { track: '1e34aaaa-0000-4000-8000-000000000000' }))).toEqual(['p1']);
    expect(ids(applyFeedFilter(slugFeed, { track: 'Platform Engineering' }))).toEqual(['p1']);
  });

  it('filters by day, and combines day with track', () => {
    expect(ids(applyFeedFilter(feed, { day: '2026-10-02' }))).toEqual(['a2', 'n1']);
    expect(ids(applyFeedFilter(feed, { track: 'Platform', day: '2026-10-02' }))).toEqual(['a2']);
  });

  it('drops sessions with no track when a track is asked for', () => {
    expect(ids(applyFeedFilter(feed, { track: 'Design' }))).toEqual(['b1']);
  });

  it('yields an empty session list for an unknown track rather than everything', () => {
    expect(ids(applyFeedFilter(feed, { track: 'no-such-track' }))).toEqual([]);
  });

  it('narrows days and tracks to what survived, so the widget chrome matches', () => {
    const filtered = applyFeedFilter(feed, { track: 'Platform' });
    expect(filtered?.days).toEqual(['2026-10-01', '2026-10-02']);
    expect(filtered?.tracks.map((t) => t.id)).toEqual(['trk-a']);

    const oneDay = applyFeedFilter(feed, { day: '2026-10-01' });
    expect(oneDay?.days).toEqual(['2026-10-01']);
  });

  it('leaves the input feed untouched', () => {
    applyFeedFilter(feed, { track: 'Platform', day: '2026-10-01' });
    expect(feed.sessions).toHaveLength(4);
    expect(feed.days).toHaveLength(2);
  });
});

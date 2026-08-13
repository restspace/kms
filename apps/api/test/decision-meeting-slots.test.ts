// Workplan 15 W1a: track slot targets and the decision-meeting counter.
//
// The counter is not a new endpoint — it is the submissions query endpoint
// under the `decision_accepted` filter (D2: accepted OR accept_queue, because
// the counter runs *during* the meeting where the last ten minutes of accepts
// are still queued and unsent), one call per targeted track, with the same
// filters the grid is showing. These tests pin the arithmetic, the agreement
// between the counter's number and a track_id-filtered grid, and D1 — a
// target that nothing enforces.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';

interface QueryResponse {
  items: Array<Record<string, unknown>>;
  total: number;
}

const query = async (cookie: string, filters: Record<string, unknown>) => {
  const res = await SELF.fetch(
    'https://example.com/app/api/submissions/query',
    jsonReq(cookie, { from: 0, size: 50, filters }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as QueryResponse;
};

async function seedTrack(eventId: string, name: string, target: number | null, position: number): Promise<string> {
  const id = `trk-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    'INSERT INTO tracks (id, event_id, name, target_slots, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, eventId, name, target, position, ts).run();
  return id;
}

const seedDecided = async (eventId: string, trackId: string | null, statuses: string[]) => {
  for (const status of statuses) {
    const id = await seedSubmission(eventId, { status });
    if (trackId) await env.DB.prepare('UPDATE submissions SET track_id = ? WHERE id = ?').bind(trackId, id).run();
  }
};

/**
 * One event mid-decision-meeting: Agents is exactly at its target, Evals is
 * over it (and half of its accepts are still queued), Untracked carries a real
 * target of NULL — the shape the strip has to render correctly.
 */
async function seedMeeting() {
  const eventId = await seedEvent();
  const admin = await seedStaff(eventId, 'admin');
  const agents = await seedTrack(eventId, 'Agents', 3, 0);
  const evals = await seedTrack(eventId, 'Evals', 2, 1);
  const untracked = await seedTrack(eventId, 'RAG', null, 2);

  await seedDecided(eventId, agents, ['accepted', 'accepted', 'accepted']);
  // Over target, and only reachable at all because accept_queue counts (D2).
  await seedDecided(eventId, evals, ['accepted', 'accept_queue', 'accept_queue']);
  await seedDecided(eventId, untracked, ['accepted', 'accepted']);
  // Noise the counter must not pick up: undecided and declined rows, and one
  // accepted row on no track at all.
  await seedDecided(eventId, agents, ['pending', 'declined', 'decline_queue', 'withdrawn']);
  await seedDecided(eventId, null, ['accepted']);

  return { eventId, admin, agents, evals, untracked };
}

describe('slot counter arithmetic (W1a)', () => {
  it('counts accepted + accept_queue per track, and the untracked remainder', async () => {
    const { admin, agents, evals, untracked } = await seedMeeting();

    const all = await query(admin.cookie, { decision_accepted: true });
    const atTarget = await query(admin.cookie, { decision_accepted: true, track_id: agents });
    const overTarget = await query(admin.cookie, { decision_accepted: true, track_id: evals });
    const noTarget = await query(admin.cookie, { decision_accepted: true, track_id: untracked });

    expect(atTarget.total).toBe(3);
    // D2 — two of these three have not been told yet.
    expect(overTarget.total).toBe(3);
    expect(noTarget.total).toBe(2);
    expect(all.total).toBe(9);
    // What the strip's "untracked" chip reads: everything the targeted tracks
    // do not account for (an untargeted track, or no track at all).
    expect(all.total - atTarget.total - overTarget.total).toBe(3);
  });

  it('the counter and a track_id-filtered grid are the same number', async () => {
    const { admin, evals } = await seedMeeting();
    const grid = await query(admin.cookie, { decision_accepted: true, track_id: evals });
    // Counter (total) and list (rows) come from one query, so they cannot
    // disagree — the rule workplan 13 W2 set for the coverage bar.
    expect(grid.items).toHaveLength(grid.total);
    expect(grid.items.every((r) => r.status === 'accepted' || r.status === 'accept_queue')).toBe(true);
    expect(grid.total).toBe(3);
  });

  // D1 is the whole point: the archive shows slots moving between tracks all
  // season, so a cap would be the modal-that-refuses-the-save workplan 13 spent
  // a wave removing.
  it('a track over target refuses nothing — one more accept still saves', async () => {
    const { admin, evals, eventId } = await seedMeeting();
    const extra = await seedSubmission(eventId, { status: 'pending' });
    await env.DB.prepare('UPDATE submissions SET track_id = ? WHERE id = ?').bind(evals, extra).run();

    const res = await SELF.fetch(
      `https://example.com/app/api/submissions/${extra}/status`,
      jsonReq(admin.cookie, { status: 'accepted' }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const after = await query(admin.cookie, { decision_accepted: true, track_id: evals });
    expect(after.total).toBe(4);
  });
});

describe('track slot targets (W1a)', () => {
  it('round-trips through the tracks CRUD, and NULL means untracked', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const created = await SELF.fetch(
      'https://example.com/app/api/tracks',
      jsonReq(admin.cookie, { name: 'Agents', color: '#2563eb', target_slots: 15 }),
    );
    expect(created.status).toBe(201);
    const row = (await created.json()) as { id: string; target_slots: number | null };
    expect(row.target_slots).toBe(15);

    const cleared = await SELF.fetch(
      `https://example.com/app/api/tracks/${row.id}`,
      jsonReq(admin.cookie, { target_slots: null }, 'PUT'),
    );
    expect(((await cleared.json()) as { target_slots: number | null }).target_slots).toBeNull();

    const bad = await SELF.fetch(
      `https://example.com/app/api/tracks/${row.id}`,
      jsonReq(admin.cookie, { target_slots: 'lots' }, 'PUT'),
    );
    expect(bad.status).toBe(400);

    const list = await SELF.fetch('https://example.com/app/api/tracks', { headers: { cookie: admin.cookie } });
    const items = ((await list.json()) as { items: Array<{ target_slots: number | null }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.target_slots).toBeNull();
  });

  // One row shape, two surfaces (RoomsTracksFields.tsx): the create-event
  // dialog's repeatable track rows carry the target too, or a target could
  // only ever be set after the fact.
  it('is set by the create-event dialog’s repeatable track rows', async () => {
    const eventId = await seedEvent();
    const owner = await seedStaff(eventId, 'owner');
    const res = await SELF.fetch(
      'https://example.com/app/api/events',
      jsonReq(owner.cookie, {
        name: 'Next Year',
        slug: `next-${crypto.randomUUID().slice(0, 8)}`,
        starts_at: '2027-05-01',
        ends_at: '2027-05-02',
        tracks: [{ name: 'Agents', color: '#2563eb', target_slots: 15 }, { name: 'RAG' }],
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const { results } = await env.DB.prepare(
      'SELECT name, target_slots FROM tracks WHERE event_id = ? ORDER BY position',
    ).bind(id).all<{ name: string; target_slots: number | null }>();
    expect(results).toEqual([
      { name: 'Agents', target_slots: 15 },
      { name: 'RAG', target_slots: null },
    ]);
  });
});

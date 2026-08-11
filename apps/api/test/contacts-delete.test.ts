// Manual-review bug: deleting a speaker who has the full relation fan-out
// fails. Reproduction first — the whole graph is built here, then the route is
// called exactly as the workspace calls it.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { attachContactToEvent } from './fixtures';
import {
  jsonReq, seedContact, seedEvent, seedEventUser, seedFileAsset, seedStaff,
  seedSubmission, seedTask,
} from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';

/** A contact wired into every table that references contacts(id). */
async function seedFanOut(eventId: string) {
  const speaker = await seedContact(eventId, { email: 'speaker@example.com', first_name: 'Ada' });

  const submission = await seedSubmission(eventId, { submitter_contact_id: speaker, status: 'accepted' });
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
     VALUES (?, ?, ?, 'speaker', 0, 1)`,
  ).bind('sp-1', submission, speaker).run();

  const plan = 'plan-1';
  await env.DB.prepare(
    `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'Plan', 'active', ?)`,
  ).bind(plan, eventId, ts).run();
  await env.DB.prepare(
    `INSERT INTO review_assignments (id, plan_id, submission_id, reviewer_contact_id, status, assigned_at)
     VALUES (?, ?, ?, ?, 'complete', ?)`,
  ).bind('ra-1', plan, submission, speaker, ts).run();
  await env.DB.prepare(
    `INSERT INTO reviews (id, assignment_id, submission_id, reviewer_contact_id, plan_id, weighted_total, created_at)
     VALUES (?, 'ra-1', ?, ?, ?, 4.2, ?)`,
  ).bind('rev-1', submission, speaker, plan, ts).run();

  const task = await seedTask(eventId, { due_at: '2026-01-01T00:00:00Z' });
  await env.DB.prepare(
    `INSERT INTO task_assignments (id, task_id, contact_id, submission_id, status) VALUES (?, ?, ?, ?, 'not_started')`,
  ).bind('ta-1', task, speaker, submission).run();

  // The mutual reference: the contact points at an asset they uploaded.
  const headshot = await seedFileAsset(eventId, speaker, { filename: 'ada.png' });
  const other = await seedFileAsset(eventId, speaker, { filename: 'slides.pdf' });
  await env.DB.prepare('UPDATE event_contacts SET headshot_asset_id = ? WHERE event_id = ? AND contact_id = ?')
    .bind(headshot, eventId, speaker).run();
  // …and the event's branding points at one of their uploads too.
  await env.DB.prepare('UPDATE events SET logo_asset_id = ?, background_asset_id = ? WHERE id = ?')
    .bind(other, headshot, eventId).run();

  await env.DB.prepare(
    `INSERT INTO calendar_invites (id, session_id, contact_id, uid, sequence, method) VALUES (?, ?, ?, 'uid-1', 0, 'REQUEST')`,
  ).bind('ci-1', submission, speaker).run();

  await env.DB.prepare(
    `INSERT INTO message_log (id, event_id, template_key, to_email, contact_id, subject, status, idempotency_key, created_at)
     VALUES (?, ?, 'task_reminder', 'speaker@example.com', ?, 'Reminder', 'sent', ?, ?)`,
  ).bind('ml-1', eventId, speaker, 'idem-1', ts).run();

  await env.DB.prepare(
    `INSERT INTO portal_accounts (id, contact_id, email, created_at) VALUES (?, ?, 'speaker@example.com', ?)`,
  ).bind('pa-1', speaker, ts).run().catch(() => { /* optional table shape */ });

  return { speaker, submission, headshot, other };
}

describe('DELETE /app/api/contacts/:id', () => {
  it('deletes a contact carrying the full relation fan-out', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { speaker, headshot, other } = await seedFanOut(eventId);

    const res = await SELF.fetch(`https://example.com/app/api/contacts/${speaker}`, jsonReq(admin.cookie, undefined, 'DELETE'));
    expect(await res.json().catch(() => null), `status ${res.status}`).toEqual({ ok: true });
    expect(res.status).toBe(200);

    const gone = await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(speaker).first();
    expect(gone).toBeNull();

    // Uploads survive the speaker, with the uploader reference nulled.
    const assets = await env.DB.prepare(
      'SELECT id, uploaded_by_contact_id FROM file_assets WHERE id IN (?, ?) ORDER BY id',
    ).bind(headshot, other).all<{ id: string; uploaded_by_contact_id: string | null }>();
    expect(assets.results).toHaveLength(2);
    for (const row of assets.results) expect(row.uploaded_by_contact_id).toBeNull();

    // The dependent rows went with them; the submission stays, unowned.
    const counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM submission_participants WHERE contact_id = ?1) AS participants,
              (SELECT COUNT(*) FROM review_assignments WHERE reviewer_contact_id = ?1) AS assignments,
              (SELECT COUNT(*) FROM task_assignments WHERE contact_id = ?1) AS tasks,
              (SELECT COUNT(*) FROM calendar_invites WHERE contact_id = ?1) AS invites,
              (SELECT COUNT(*) FROM submissions WHERE submitter_contact_id IS NULL) AS orphan_subs`,
    ).bind(speaker).first<Record<string, number>>();
    expect(counts).toMatchObject({ participants: 0, assignments: 0, tasks: 0, invites: 0, orphan_subs: 1 });
  });

  it('returns 404 on a second delete', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId);

    const first = await SELF.fetch(`https://example.com/app/api/contacts/${contactId}`, jsonReq(admin.cookie, undefined, 'DELETE'));
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`https://example.com/app/api/contacts/${contactId}`, jsonReq(admin.cookie, undefined, 'DELETE'));
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: 'not_found' });
  });

  it('never deletes across events', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    await seedEventUser(eventB, await seedContact(eventB, { email: 'admin@example.com' }), 'admin');
    const victim = await seedContact(eventB, { email: 'other@example.com' });

    const res = await SELF.fetch(`https://example.com/app/api/contacts/${victim}`, jsonReq(admin.cookie, undefined, 'DELETE'));
    expect(res.status).toBe(404);
    expect(await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(victim).first()).not.toBeNull();
  });
  // 0015: the route is a DETACH. The three tests above each have a speaker who
  // belongs to exactly one event, so their detach IS the last membership and
  // the identity row still goes. This is the other half of the contract — one
  // person, two events in the SAME org — which nothing else covers.
  it('detaches from one event only, and deletes the person on the last one', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId });
    const eventB = await seedEvent({ org_id: orgId });
    const adminA = await seedStaff(eventA, 'admin');
    const adminB = await seedStaff(eventB, 'admin');
    const speaker = await seedContact(eventA, { email: 'twice@example.com', first_name: 'Ada' });
    await attachContactToEvent(eventB, speaker, { company: 'B Corp' });

    const first = await SELF.fetch(`https://example.com/app/api/contacts/${speaker}`, jsonReq(adminA.cookie, undefined, 'DELETE'));
    expect(await first.json().catch(() => null), `status ${first.status}`).toEqual({ ok: true });

    // The person survives: only event A's membership row was dropped.
    expect(await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(speaker).first()).not.toBeNull();
    const memberships = await env.DB.prepare('SELECT event_id FROM event_contacts WHERE contact_id = ?')
      .bind(speaker)
      .all<{ event_id: string }>();
    expect(memberships.results.map((r) => r.event_id)).toEqual([eventB]);

    // …and event B still reads them, with event B's own profile untouched.
    const inB = await SELF.fetch('https://example.com/app/api/contacts/query', jsonReq(adminB.cookie, { from: 0, size: 10, filters: { contact_id: speaker } }));
    const bItems = ((await inB.json()) as { items: Array<{ id: string; company: string | null }> }).items;
    expect(bItems).toHaveLength(1);
    expect(bItems[0].company).toBe('B Corp');

    // Event A's roster no longer has them.
    const inA = await SELF.fetch('https://example.com/app/api/contacts/query', jsonReq(adminA.cookie, { from: 0, size: 10, filters: { contact_id: speaker } }));
    expect(((await inA.json()) as { items: unknown[] }).items).toHaveLength(0);

    // Deleting from the last remaining event takes the identity row too.
    const second = await SELF.fetch(`https://example.com/app/api/contacts/${speaker}`, jsonReq(adminB.cookie, undefined, 'DELETE'));
    expect(second.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(speaker).first()).toBeNull();
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM event_contacts WHERE contact_id = ?')
      .bind(speaker)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

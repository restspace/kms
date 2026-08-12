// Speaker sourcing pipeline (spec-gap CRM-07/08): enroll from the org
// directory, move between stages (server-recorded history), notes, and the
// assign-to-event handoff. Org-scoped like the contact directory — another
// organisation's board never shows these cards.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedEventUser, seedStaff } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api/crm${path}`, jsonReq(cookie, body, method));

const getBoard = (cookie: string) =>
  SELF.fetch('https://example.com/app/api/crm/pipeline', { headers: { cookie } });

const getCard = (id: string, cookie: string) =>
  SELF.fetch(`https://example.com/app/api/crm/pipeline/cards/${id}`, { headers: { cookie } });

describe('sourcing pipeline', () => {
  it('enrolls a contact, moves it through stages, and records a timestamped history', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId, {
      first_name: 'Marcus', last_name: 'Okafor', company: 'PlatformCo', job_title: 'Staff Engineer',
    });

    const enrolled = await api('/pipeline/cards', admin.cookie, {
      contact_id: contactId,
      stage: 'identified',
      score: 85,
      rationale: 'Strong platform-engineering track record.',
    });
    expect(enrolled.status).toBe(201);
    const card = (await enrolled.json()) as Record<string, unknown>;
    expect(card).toMatchObject({
      contact_id: contactId,
      stage: 'identified',
      score: 85,
      first_name: 'Marcus',
      company: 'PlatformCo',
      job_title: 'Staff Engineer',
    });

    // Board shows the card with the server's stage vocabulary.
    const board = (await (await getBoard(admin.cookie)).json()) as {
      stages: string[];
      cards: Array<{ id: string; stage: string }>;
    };
    expect(board.stages).toEqual([
      'identified', 'researching', 'contacted', 'interested', 'confirmed', 'declined',
    ]);
    expect(board.cards.find((c) => c.id === card.id)?.stage).toBe('identified');

    // Two moves — the CRM-S2 choreography.
    expect((await api(`/pipeline/cards/${card.id}`, admin.cookie, { stage: 'contacted' }, 'PATCH')).status).toBe(200);
    const second = await api(`/pipeline/cards/${card.id}`, admin.cookie, { stage: 'interested' }, 'PATCH');
    expect(((await second.json()) as { stage: string }).stage).toBe('interested');

    // A fresh board read (the reload) still has it in the new stage.
    const after = (await (await getBoard(admin.cookie)).json()) as { cards: Array<{ id: string; stage: string }> };
    expect(after.cards.find((c) => c.id === card.id)?.stage).toBe('interested');

    // Detail: enrolled + both transitions, newest first, each timestamped
    // and attributed.
    const detail = (await (await getCard(card.id as string, admin.cookie)).json()) as {
      activity: Array<{ kind: string; from_stage: string | null; to_stage: string | null; created_at: string; author_name: string | null }>;
    };
    expect(detail.activity.map((a) => [a.kind, a.from_stage, a.to_stage])).toEqual([
      ['stage_change', 'contacted', 'interested'],
      ['stage_change', 'identified', 'contacted'],
      ['enrolled', null, 'identified'],
    ]);
    for (const entry of detail.activity) {
      expect(entry.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.author_name).toBeTruthy();
    }
  });

  it('one card per contact — re-enrolling answers 409 with the existing id', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId);

    const first = (await (await api('/pipeline/cards', admin.cookie, { contact_id: contactId })).json()) as { id: string };
    const dup = await api('/pipeline/cards', admin.cookie, { contact_id: contactId, stage: 'contacted' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'already_enrolled', existing_id: first.id });
  });

  it('validates stage and score on enroll and move', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId);

    expect((await api('/pipeline/cards', admin.cookie, { contact_id: contactId, stage: 'nope' })).status).toBe(400);
    expect((await api('/pipeline/cards', admin.cookie, { contact_id: contactId, score: 150 })).status).toBe(400);
    expect((await api('/pipeline/cards', admin.cookie, {})).status).toBe(400);

    const card = (await (await api('/pipeline/cards', admin.cookie, { contact_id: contactId })).json()) as { id: string };
    expect((await api(`/pipeline/cards/${card.id}`, admin.cookie, { stage: 'bogus' }, 'PATCH')).status).toBe(400);
    expect((await api(`/pipeline/cards/${card.id}`, admin.cookie, { score: -1 }, 'PATCH')).status).toBe(400);
  });

  it('notes persist on the card and an empty note is refused', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId);
    const card = (await (await api('/pipeline/cards', admin.cookie, { contact_id: contactId })).json()) as { id: string };

    const note = await api(`/pipeline/cards/${card.id}/notes`, admin.cookie, {
      body: 'Left voicemail 2027-01-15; follow up next week.',
    });
    expect(note.status).toBe(201);

    expect((await api(`/pipeline/cards/${card.id}/notes`, admin.cookie, { body: '   ' })).status).toBe(400);

    const detail = (await (await getCard(card.id, admin.cookie)).json()) as {
      activity: Array<{ kind: string; body: string | null }>;
    };
    const saved = detail.activity.find((a) => a.kind === 'note');
    expect(saved?.body).toBe('Left voicemail 2027-01-15; follow up next week.');
  });

  it('is writer-only and org-scoped: reviewers get 403, another org sees nothing', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent(); // fresh org of its own
    const adminA = await seedStaff(eventA, 'admin');
    const adminB = await seedStaff(eventB, 'admin');
    const reviewerA = await seedStaff(eventA, 'reviewer');
    const contactId = await seedContact(eventA);

    expect((await getBoard(reviewerA.cookie)).status).toBe(403);

    const card = (await (await api('/pipeline/cards', adminA.cookie, { contact_id: contactId })).json()) as { id: string };

    const boardB = (await (await getBoard(adminB.cookie)).json()) as { cards: Array<{ id: string }> };
    expect(boardB.cards.find((c) => c.id === card.id)).toBeUndefined();
    expect((await getCard(card.id, adminB.cookie)).status).toBe(404);
    expect((await api(`/pipeline/cards/${card.id}`, adminB.cookie, { stage: 'contacted' }, 'PATCH')).status).toBe(404);
    // Enrolling another org's contact reads as absent too.
    expect((await api('/pipeline/cards', adminB.cookie, { contact_id: contactId })).status).toBe(404);
  });

  it('assigns the prospect to an accessible event, carrying their profile; already-on 409s', async () => {
    const eventA = await seedEvent();
    const org = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(eventA).first<{ org_id: string }>();
    const eventB = await seedEvent({ org_id: org!.org_id });
    const admin = await seedStaff(eventA, 'admin');
    // Same person holds a writer seat at event B — one contact row per org,
    // so the seat is a membership + event_users pair, not a second contact.
    await env.DB.prepare(
      `INSERT INTO event_contacts (event_id, contact_id, added_at, source) VALUES (?, ?, ?, 'admin')`,
    ).bind(eventB, admin.contactId, new Date().toISOString()).run();
    await seedEventUser(eventB, admin.contactId, 'admin');

    const contactId = await seedContact(eventA, { company: 'PlatformCo', biography: 'Bio text' });
    const card = (await (await api('/pipeline/cards', admin.cookie, { contact_id: contactId })).json()) as { id: string };

    const assigned = await api(`/pipeline/cards/${card.id}/assign`, admin.cookie, { event_id: eventB });
    expect(assigned.status).toBe(201);

    const membership = await env.DB.prepare(
      'SELECT company, biography FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(eventB, contactId).first<{ company: string | null; biography: string | null }>();
    expect(membership).toMatchObject({ company: 'PlatformCo', biography: 'Bio text' });

    expect((await api(`/pipeline/cards/${card.id}/assign`, admin.cookie, { event_id: eventB })).status).toBe(409);
    // An event outside the seat set is forbidden.
    const strangerEvent = await seedEvent();
    expect((await api(`/pipeline/cards/${card.id}/assign`, admin.cookie, { event_id: strangerEvent })).status).toBe(403);
  });

  it('delete removes the card and its activity', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId);
    const card = (await (await api('/pipeline/cards', admin.cookie, { contact_id: contactId })).json()) as { id: string };
    await api(`/pipeline/cards/${card.id}/notes`, admin.cookie, { body: 'note' });

    expect((await api(`/pipeline/cards/${card.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(200);
    expect((await getCard(card.id, admin.cookie)).status).toBe(404);
    expect((await api(`/pipeline/cards/${card.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(404);
    const orphans = await env.DB.prepare('SELECT COUNT(*) AS n FROM pipeline_activity WHERE card_id = ?')
      .bind(card.id).first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });
});

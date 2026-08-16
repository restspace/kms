// CNT-12/w3: content_approved (0010 migration) is a public-visibility gate,
// separate from the acceptance `status`. Default-permissive (existing/seeded
// rows stay live), but an organiser can flip it off to pull an accepted,
// scheduled session out of every public feed without rejecting it.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import { createRoom } from './fixtures-submission';

const json = (cookie: string, body: unknown) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

async function adminSession(eventId: string, slug: string) {
  const contactId = await createContact(eventId, { email: `admin-${crypto.randomUUID()}@example.com` });
  await createEventUser(eventId, contactId, 'admin');
  const cookie = await sessionCookieFor({ contactId, eventId, eventSlug: slug, role: 'admin' });
  return { contactId, cookie };
}

/** Every id is namespaced per-call (crypto.randomUUID()) — the workers test
 * pool shares one D1 instance across every `it` in this file, so fixed ids
 * reused across tests would collide on the PRIMARY KEY. Returns the id. */
async function seedAcceptedScheduled(eventId: string, idPrefix: string, code: string): Promise<string> {
  const id = `${idPrefix}-${crypto.randomUUID().slice(0, 8)}`;
  const room = await createRoom(eventId, `Room ${code}-${id}`);
  const ts = '2026-09-01T00:00:00Z';
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, room_id, starts_at, ends_at, source, created_at, updated_at)
     VALUES (?, ?, ?, 'session', ?, 'accepted', ?, '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'manual', ?, ?)`,
  )
    .bind(id, eventId, code, `Talk ${code}`, room, ts, ts)
    .run();
  return id;
}

describe('content_approved defaults', () => {
  it('defaults to 1 (public) for newly inserted submissions', async () => {
    const eventId = await createEvent({ slug: `ca-default-${crypto.randomUUID().slice(0, 8)}` });
    const id = await seedAcceptedScheduled(eventId, 'sub-default', 'SESS-1');
    const row = await env.DB.prepare('SELECT content_approved FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ content_approved: number }>();
    expect(row?.content_approved).toBe(1);
  });
});

describe('public feeds respect content_approved', () => {
  it('agenda.json omits a session with content_approved = 0, even if accepted and scheduled', async () => {
    const slug = `ca-agenda-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug });
    await seedAcceptedScheduled(eventId, 'sub-visible', 'SESS-1');
    const hiddenId = await seedAcceptedScheduled(eventId, 'sub-hidden', 'SESS-2');
    await env.DB.prepare('UPDATE submissions SET content_approved = 0 WHERE id = ?').bind(hiddenId).run();
    await env.DB.prepare('UPDATE events SET agenda_published = 1 WHERE id = ?').bind(eventId).run();

    const res = await SELF.fetch(`https://example.com/e/${slug}/agenda.json`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { sessions: Array<{ code: string }> };
    expect(payload.sessions.map((s) => s.code)).toEqual(['SESS-1']);
  });

  it('speakers.json drops a speaker whose only session is content_approved = 0', async () => {
    const slug = `ca-speakers-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug });
    const subId = await seedAcceptedScheduled(eventId, 'sub-hidden', 'SESS-1');
    await env.DB.prepare('UPDATE submissions SET content_approved = 0 WHERE id = ?').bind(subId).run();
    const speaker = await createContact(eventId, { email: 'hidden-speaker@example.com', first_name: 'Hid', last_name: 'Den' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES (?, ?, ?, 'speaker', 1, 1)`,
    )
      .bind(`sp-${crypto.randomUUID().slice(0, 8)}`, subId, speaker)
      .run();
    await env.DB.prepare('UPDATE events SET agenda_published = 1 WHERE id = ?').bind(eventId).run();

    const res = await SELF.fetch(`https://example.com/e/${slug}/speakers.json`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('hidden-speaker@example.com');
    expect(body).not.toContain('"Hid Den"');
  });

  it('embed agenda.xml also excludes content_approved = 0 sessions', async () => {
    const slug = `ca-xml-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug });
    await seedAcceptedScheduled(eventId, 'sub-visible', 'SESS-1');
    const hiddenId = await seedAcceptedScheduled(eventId, 'sub-hidden', 'SESS-2');
    await env.DB.prepare('UPDATE submissions SET content_approved = 0 WHERE id = ?').bind(hiddenId).run();
    await env.DB.prepare('UPDATE events SET agenda_published = 1 WHERE id = ?').bind(eventId).run();

    const res = await SELF.fetch(`https://example.com/e/${slug}/agenda.xml`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('SESS-1');
    expect(xml).not.toContain('SESS-2');
  });
});

describe('the agenda board sees the gate (AIA-S2)', () => {
  it('carries content_approved on every session so a hidden one can be flagged', async () => {
    const slug = `ca-board-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug });
    const { cookie } = await adminSession(eventId, slug);
    const visible = await seedAcceptedScheduled(eventId, 'sub-board-vis', 'SESS-1');
    const hidden = await seedAcceptedScheduled(eventId, 'sub-board-hid', 'SESS-2');
    await env.DB.prepare('UPDATE submissions SET content_approved = 0 WHERE id = ?').bind(hidden).run();

    const res = await SELF.fetch('https://example.com/app/api/agenda', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ id: string; content_approved: number }> };
    // Without this the board could show a session placed, confirmed and
    // published while every public feed silently skipped it.
    expect(body.sessions.find((s) => s.id === visible)?.content_approved).toBe(1);
    expect(body.sessions.find((s) => s.id === hidden)?.content_approved).toBe(0);
  });
});

describe('PUT /app/api/submissions/:id { content_approved }', () => {
  it('lets an organiser toggle the gate independently of status', async () => {
    const eventId = await createEvent({ slug: `ca-toggle-${crypto.randomUUID().slice(0, 8)}` });
    const { cookie } = await adminSession(eventId, eventId);
    const id = await seedAcceptedScheduled(eventId, 'sub-toggle', 'SESS-1');

    const res = await SELF.fetch(
      `https://example.com/app/api/submissions/${id}`,
      json(cookie, { content_approved: false }),
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT status, content_approved FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ status: string; content_approved: number }>();
    expect(row).toMatchObject({ status: 'accepted', content_approved: 0 });
  });

  it('rejects a non-boolean content_approved', async () => {
    const eventId = await createEvent({ slug: `ca-invalid-${crypto.randomUUID().slice(0, 8)}` });
    const { cookie } = await adminSession(eventId, eventId);
    const id = await seedAcceptedScheduled(eventId, 'sub-bad', 'SESS-1');

    const res = await SELF.fetch(
      `https://example.com/app/api/submissions/${id}`,
      json(cookie, { content_approved: 'yes' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_content_approved' });
  });
});

describe('content revisions (version history)', () => {
  it('snapshots the pre-edit title/description before a title/description PUT, but not for a content_approved-only PUT', async () => {
    const eventId = await createEvent({ slug: `cr-basic-${crypto.randomUUID().slice(0, 8)}` });
    const { cookie } = await adminSession(eventId, eventId);
    const id = await seedAcceptedScheduled(eventId, 'sub-cr', 'SESS-1');
    await env.DB.prepare('UPDATE submissions SET description = ? WHERE id = ?').bind('Original description.', id).run();

    // A content_approved-only PUT touches neither title nor description: no
    // history row, nothing to have "reverted".
    const approvalOnly = await SELF.fetch(
      `https://example.com/app/api/submissions/${id}`,
      json(cookie, { content_approved: false }),
    );
    expect(approvalOnly.status).toBe(200);
    let revisions = await env.DB.prepare('SELECT COUNT(*) AS n FROM content_revisions WHERE submission_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(revisions?.n).toBe(0);

    const editRes = await SELF.fetch(
      `https://example.com/app/api/submissions/${id}`,
      json(cookie, { title: 'Talk SESS-1 (revised)', description: 'New description.' }),
    );
    expect(editRes.status).toBe(200);

    const row = await env.DB.prepare(
      'SELECT title, description, edited_by, source FROM content_revisions WHERE submission_id = ?',
    ).bind(id).first<{ title: string; description: string | null; edited_by: string | null; source: string }>();
    expect(row).toMatchObject({ title: 'Talk SESS-1', description: 'Original description.', source: 'admin' });
    expect(row?.edited_by).toBeTruthy();

    // The submission itself already carries the new values.
    const current = await env.DB.prepare('SELECT title, description FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ title: string; description: string }>();
    expect(current).toMatchObject({ title: 'Talk SESS-1 (revised)', description: 'New description.' });

    // A second edit appends a second snapshot (append-only, oldest values first
    // when read in insertion order) rather than overwriting the first.
    await SELF.fetch(
      `https://example.com/app/api/submissions/${id}`,
      json(cookie, { title: 'Talk SESS-1 (again)' }),
    );
    revisions = await env.DB.prepare('SELECT COUNT(*) AS n FROM content_revisions WHERE submission_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(revisions?.n).toBe(2);

    // GET .../revisions (admin-only) lists them newest first.
    const list = await SELF.fetch(`https://example.com/app/api/submissions/${id}/revisions`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: Array<{ title: string }> };
    expect(listBody.items.map((r) => r.title)).toEqual(['Talk SESS-1 (revised)', 'Talk SESS-1']);
  });

  it('a reviewer session cannot list revisions (admin-only)', async () => {
    const eventId = await createEvent({ slug: `cr-forbidden-${crypto.randomUUID().slice(0, 8)}` });
    const id = await seedAcceptedScheduled(eventId, 'sub-cr2', 'SESS-1');
    const reviewerContactId = await createContact(eventId, { email: `reviewer-${crypto.randomUUID()}@example.com` });
    await createEventUser(eventId, reviewerContactId, 'reviewer');
    const reviewerCookie = await sessionCookieFor({ contactId: reviewerContactId, eventId, eventSlug: eventId, role: 'reviewer' });

    const res = await SELF.fetch(`https://example.com/app/api/submissions/${id}/revisions`, { headers: { cookie: reviewerCookie } });
    expect(res.status).toBe(403);
  });
});

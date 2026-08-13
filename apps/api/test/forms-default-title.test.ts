// Defect #23: a new form with no supplied name/title used to fall back to
// the literal "Untitled form", which then flowed straight through to
// external_title (formsAdmin.ts's create) and rendered as both the
// organiser's forms-list row and the public wizard's H1 (submit.tsx). A
// fresh form now defaults its name to the event's own name, and the public
// page falls back to the event name if a form's stored title is ever empty
// or literally "Untitled form" (old data created before this fix).

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';

async function adminCookie(eventId: string, eventSlug: string): Promise<string> {
  const contactId = await createContact(eventId, { email: 'organiser@example.com' });
  await createEventUser(eventId, contactId, 'owner');
  return sessionCookieFor({ contactId, eventId, eventSlug, role: 'owner' });
}

const postJson = (cookie: string, path: string, body: unknown) =>
  SELF.fetch(`https://example.com/app/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

describe('POST /app/api/forms — default title (defect #23)', () => {
  it('defaults an unnamed form to the event name, not "Untitled form"', async () => {
    const slug = `evt-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug, name: 'AI.Engineer NYC' });
    const cookie = await adminCookie(eventId, slug);

    const res = await postJson(cookie, '/forms', { idempotency_key: crypto.randomUUID() });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { form: { internal_name: string; external_title: string } };
    expect(body.form.internal_name).not.toBe('Untitled form');
    expect(body.form.internal_name).toContain('AI.Engineer NYC');
    expect(body.form.external_title).toContain('AI.Engineer NYC');
  });

  it('an explicit internal_name is still honoured', async () => {
    const slug = `evt-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug, name: 'AI.Engineer NYC' });
    const cookie = await adminCookie(eventId, slug);

    const res = await postJson(cookie, '/forms', { internal_name: 'Workshops CFP', idempotency_key: crypto.randomUUID() });
    const body = (await res.json()) as { form: { internal_name: string } };
    expect(body.form.internal_name).toBe('Workshops CFP');
  });
});

describe('public wizard title fallback (defect #23)', () => {
  it('falls back to the event name when the stored title is the literal "Untitled form"', async () => {
    const slug = `evt-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug, name: 'AI.Engineer NYC' });
    const formId = `form-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO submission_forms (id, event_id, internal_name, external_title, page_heading,
         collection_type, collect_participants, status, participant_roles, created_at, updated_at)
       VALUES (?, ?, 'Untitled form', 'Untitled form', 'Submit', 'abstracts', 1, 'open', '[]', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
    )
      .bind(formId, eventId)
      .run();
    await env.DB.prepare(
      `INSERT INTO field_definitions (id, event_id, key, label, type, scope, system) VALUES (?, ?, 'title', 'Title', 'text', 'submission', 1)`,
    )
      .bind(`fld-${crypto.randomUUID()}`, eventId)
      .run();

    const html = await (await SELF.fetch(`https://example.com/submit/${slug}/${formId}`)).text();
    expect(html).not.toContain('Untitled form');
    expect(html).toContain('AI.Engineer NYC');
  });
});

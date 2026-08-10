// ABS defect (major): "Reopen on a closed submission form is non-functional:
// the admin list flips the form to 'Open' but the public page still reports
// 'This form is closed' based on the past close date." isFormClosed()
// (submit.tsx, shared with portal.ts) treats status='closed' OR a past
// close_at as closed — so flipping status back to 'open' alone did nothing
// while a stale close_at remained in the past. This exercises the fix in
// formsAdmin.ts PUT /:id: an explicit closed -> open transition clears a
// close_at that is still in the past, and the public wizard (and the portal's
// edit-lock, which imports the very same isFormClosed) actually reopen.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createContact, createEventUser, sessionCookieFor } from './fixtures';
import { seedForm, type SeededForm } from './fixtures-submission';

async function adminCookie(form: SeededForm): Promise<string> {
  const contactId = await createContact(form.eventId, { email: 'organiser@example.com' });
  await createEventUser(form.eventId, contactId, 'owner');
  return sessionCookieFor({ contactId, eventId: form.eventId, eventSlug: form.eventSlug, role: 'owner' });
}

const putForm = (cookie: string, formId: string, body: unknown) =>
  SELF.fetch(`https://example.com/app/api/forms/${formId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

const wizardClosed = async (form: SeededForm): Promise<boolean> => {
  const res = await SELF.fetch(`https://example.com${form.basePath}`, { headers: { cookie: form.cookie } });
  const html = await res.text();
  return html.includes('"closed":true');
};

describe('PUT /app/api/forms/:id — reopen clears a stale close date', () => {
  it('closed + past close_at: flipping status to open alone actually reopens the public form', async () => {
    const form = await seedForm();
    await env.DB.prepare(`UPDATE submission_forms SET status = 'closed', close_at = '2020-01-01T00:00:00Z' WHERE id = ?`)
      .bind(form.formId)
      .run();
    expect(await wizardClosed(form)).toBe(true);

    const cookie = await adminCookie(form);
    // The admin list's Reopen button sends exactly this — one field.
    const res = await putForm(cookie, form.formId, { status: 'open' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { form: { status: string; close_at: string | null } };
    expect(body.form.status).toBe('open');
    expect(body.form.close_at).toBeNull();

    expect(await wizardClosed(form)).toBe(false);
  });

  it('leaves close_at untouched when the form is not actually transitioning from closed', async () => {
    const form = await seedForm();
    await env.DB.prepare(`UPDATE submission_forms SET status = 'open', close_at = '2020-01-01T00:00:00Z' WHERE id = ?`)
      .bind(form.formId)
      .run();
    // Already open (and thus already showing closed to the public purely on
    // the elapsed date) — an unrelated save must not silently "reopen" it by
    // clearing the schedule the organiser set.
    const cookie = await adminCookie(form);
    const res = await putForm(cookie, form.formId, { internal_name: 'Renamed' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { form: { close_at: string | null } };
    expect(body.form.close_at).toBe('2020-01-01T00:00:00Z');
    expect(await wizardClosed(form)).toBe(true);
  });

  it('respects a fresh future close_at set in the same reopen request instead of clearing it', async () => {
    const form = await seedForm();
    await env.DB.prepare(`UPDATE submission_forms SET status = 'closed', close_at = '2020-01-01T00:00:00Z' WHERE id = ?`)
      .bind(form.formId)
      .run();
    const cookie = await adminCookie(form);
    const res = await putForm(cookie, form.formId, { status: 'open', close_at: '2099-01-01T00:00:00Z' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { form: { status: string; close_at: string | null } };
    expect(body.form.status).toBe('open');
    expect(body.form.close_at).toBe('2099-01-01T00:00:00.000Z');
    expect(await wizardClosed(form)).toBe(false);
  });

  it('reopening with no close_at at all stays open with no date', async () => {
    const form = await seedForm();
    await env.DB.prepare(`UPDATE submission_forms SET status = 'closed' WHERE id = ?`).bind(form.formId).run();
    const cookie = await adminCookie(form);
    const res = await putForm(cookie, form.formId, { status: 'open' });
    expect(res.status).toBe(200);
    expect(await wizardClosed(form)).toBe(false);
  });

  it('CFP-04/CFP-16 regression: an unrelated form (status open, no reopen) stays enforceable when explicitly closed', async () => {
    const form = await seedForm();
    const cookie = await adminCookie(form);
    // Close it, then close it again (no transition) — must not spuriously clear anything.
    const first = await putForm(cookie, form.formId, { status: 'closed' });
    expect(first.status).toBe(200);
    expect(await wizardClosed(form)).toBe(true);

    const draftRes = await SELF.fetch(`https://example.com${form.basePath}/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: form.cookie },
      body: JSON.stringify({ answers: {} }),
    });
    expect(draftRes.status).toBe(409);
  });
});

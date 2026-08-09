// Public CFP wizard Account step (docs/04 §5 step 2): an unrecognised email
// gets a real submitter account and an in-wizard session immediately — no
// email round trip, which matters on a deployment with no working mail
// provider (the demo-login carve-out's caveat). An already-registered email
// must never be silently signed in.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { verifySessionToken } from '../src/session';
import { countRows, seedForm, type SeededForm } from './fixtures-submission';

const account = (form: SeededForm, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const cookieOf = (res: Response): string | null => res.headers.get('set-cookie');

describe('POST /submit/:slug/:formId/account', () => {
  it('creates a contact and signs the caller in for a brand-new email', async () => {
    const form = await seedForm();
    const res = await account(form, { email: 'new.speaker@example.com' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body).toMatchObject({ ok: true, status: 'created' });

    const cookie = cookieOf(res);
    expect(cookie).toContain('kms_session=');
    const token = cookie!.split('kms_session=')[1]!.split(';')[0]!;
    const session = await verifySessionToken(token, env.SESSION_SECRET);
    expect(session?.email).toBe('new.speaker@example.com');
    expect(session?.eventId).toBe(form.eventId);
    expect(session?.role).toBe('speaker');

    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM contacts WHERE event_id = ? AND email = 'new.speaker@example.com'`,
        form.eventId,
      ),
    ).toBe(1);
  });

  it('queues a best-effort magic-link email for the new contact without blocking the response', async () => {
    const form = await seedForm();
    const res = await account(form, { email: 'return.visit@example.com' });
    expect(res.status).toBe(200);

    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM message_log WHERE event_id = ? AND template_key = 'magic_link' AND to_email = ?`,
        form.eventId,
        'return.visit@example.com',
      ),
    ).toBe(1);
  });

  it('lets the new session immediately submit, attaching the submission to the new contact', async () => {
    const form = await seedForm();
    const res = await account(form, { email: 'fresh@example.com' });
    const cookie = cookieOf(res)!.split(';')[0]!;

    const submitRes = await SELF.fetch(`https://example.com${form.basePath}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        answers: { [form.questions.title!]: 'A fresh talk' },
        participants: [
          { email: 'fresh@example.com', first_name: 'Fresh', last_name: 'Speaker', role: 'speaker' },
        ],
      }),
    });
    expect(submitRes.status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT c.email FROM submissions s JOIN contacts c ON c.id = s.submitter_contact_id
       WHERE s.form_id = ? AND s.title = ?`,
    )
      .bind(form.formId, 'A fresh talk')
      .first<{ email: string }>();
    expect(row?.email).toBe('fresh@example.com');
  });

  it('does not sign in an already-registered email; offers a sign-in link instead', async () => {
    const form = await seedForm();
    // submitter@example.com is the contact seedForm() already creates.
    const res = await account(form, { email: 'submitter@example.com' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; status: string; dev_link?: string | null };
    expect(body).toMatchObject({ ok: true, status: 'existing' });
    expect(body.dev_link).toBeTruthy(); // DEV_MODE=on in the test env

    expect(cookieOf(res)).toBeNull();
    // No duplicate contact row was created for the existing address.
    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM contacts WHERE event_id = ? AND email = 'submitter@example.com'`,
        form.eventId,
      ),
    ).toBe(1);
  });

  it('is case-insensitive when matching an existing email', async () => {
    const form = await seedForm();
    const res = await account(form, { email: 'SUBMITTER@EXAMPLE.COM' });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('existing');
    expect(cookieOf(res)).toBeNull();
  });

  it('rejects a malformed email without touching the database', async () => {
    const form = await seedForm();
    const res = await account(form, { email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(cookieOf(res)).toBeNull();
  });

  it('refuses to create an account once the form is closed', async () => {
    const form = await seedForm();
    await env.DB.prepare(`UPDATE submission_forms SET status = 'closed' WHERE id = ?`).bind(form.formId).run();
    const res = await account(form, { email: 'toolate@example.com' });
    expect(res.status).toBe(409);
    expect(cookieOf(res)).toBeNull();
  });

  it('lets two concurrent requests for the same brand-new email produce only one winner', async () => {
    const form = await seedForm();
    const [a, b] = await Promise.all([
      account(form, { email: 'racer@example.com' }),
      account(form, { email: 'racer@example.com' }),
    ]);
    const bodies = (await Promise.all([a.json(), b.json()])) as Array<{ status: string }>;
    const created = bodies.filter((b) => b.status === 'created');
    const existing = bodies.filter((b) => b.status === 'existing');
    expect(created).toHaveLength(1);
    expect(existing).toHaveLength(1);

    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM contacts WHERE event_id = ? AND email = 'racer@example.com'`,
        form.eventId,
      ),
    ).toBe(1);
  });
});

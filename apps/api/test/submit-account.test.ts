// Public CFP wizard Account step (docs/04 §5 step 2): an unrecognised email
// gets a real submitter account and an in-wizard session immediately — no
// email round trip, which matters on a deployment with no working mail
// provider (the demo-login carve-out's caveat). An already-registered email
// must never be silently signed in.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { verifySessionToken } from '../src/session';
import { createContact, createEvent } from './fixtures';
import { countRows, seedForm, type SeededForm } from './fixtures-submission';

const account = (form: SeededForm, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const cookieOf = (res: Response): string | null => res.headers.get('set-cookie');

// Since 0015 a contact is org-scoped and its membership of THIS event lives on
// event_contacts, so "is this address on the event's roster" is a join, not a
// `contacts.event_id` filter.
const rosterRows = (eventId: string, email: string) =>
  countRows(
    `SELECT COUNT(*) AS n FROM event_contacts ec
       JOIN contacts c ON c.id = ec.contact_id
      WHERE ec.event_id = ? AND c.email = ?`,
    eventId,
    email,
  );

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

    // Exactly one roster row, and it records how they arrived: creating a
    // contact without attaching it would leave a person on no event's roster.
    const membership = await env.DB.prepare(
      `SELECT ec.source FROM event_contacts ec
       JOIN contacts c ON c.id = ec.contact_id
       WHERE ec.event_id = ? AND c.email = 'new.speaker@example.com'`,
    )
      .bind(form.eventId)
      .all<{ source: string }>();
    expect(membership.results).toHaveLength(1);
    expect(membership.results[0]!.source).toBe('cfp');
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
    expect(await rosterRows(form.eventId, 'submitter@example.com')).toBe(1);
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

    expect(await rosterRows(form.eventId, 'racer@example.com')).toBe(1);
  });

  // 0015 widened the dedupe scope from the event to the ORGANISATION, so an
  // address known only from a sibling event now takes the 'existing' branch.
  // That branch deliberately does NOT attach: the caller is unauthenticated, so
  // attaching would let anyone put an org sibling on this event's roster just by
  // typing their address.
  it('treats an org sibling from another event as existing, and does not add them to this roster', async () => {
    const form = await seedForm();
    const orgId = (await env.DB.prepare('SELECT org_id FROM events WHERE id = ?')
      .bind(form.eventId)
      .first<{ org_id: string }>())!.org_id;

    // Same org, different event — the only place this person is known.
    const siblingEventId = await createEvent({ org_id: orgId });
    const siblingContactId = await createContact(siblingEventId, { email: 'sibling@example.com' });

    const res = await account(form, { email: 'sibling@example.com' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; dev_link?: string | null };
    expect(body).toMatchObject({ ok: true, status: 'existing' });
    expect(cookieOf(res)).toBeNull();

    // Still exactly one identity org-wide (no second contact row)...
    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND email = 'sibling@example.com'`,
        orgId,
      ),
    ).toBe(1);
    // ...and it gained no membership of the event whose form was posted to.
    expect(await rosterRows(form.eventId, 'sibling@example.com')).toBe(0);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM event_contacts WHERE contact_id = ?', siblingContactId),
    ).toBe(1);
  });
});

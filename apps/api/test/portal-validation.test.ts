// Sweep item 11: a failed portal POST re-renders its own page with the input
// preserved, a focusable role="alert" summary linking each bad control, and
// per-field aria-invalid / aria-describedby wiring. Success stays PRG.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, sessionCookieFor } from './fixtures';
import { createTaskAssignment } from './fixtures-portal';

const ORIGIN = 'https://kms.test';

let eventId: string;
let slug: string;
let contactId: string;
let cookie: string;

beforeEach(async () => {
  slug = `val-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug });
  contactId = await createContact(eventId, { email: 'speaker@example.com', first_name: 'Ada', last_name: 'Byron' });
  cookie = await sessionCookieFor({ contactId, eventId, eventSlug: slug, role: 'speaker' });
});

const postProfile = (fields: Record<string, string>) =>
  SELF.fetch(`${ORIGIN}/portal/${slug}/profile`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });

describe('POST /portal/:slug/profile validation', () => {
  it('re-renders with the posted values, a linked summary and aria wiring', async () => {
    const res = await postProfile({
      biography: 'A long and carefully written biography.',
      first_name: '',
      last_name: 'Byron',
      company: 'Analytical Engines Ltd',
      link_linkedin: 'not a url',
      link_twitter: '',
      link_facebook: '',
      link_website: '',
    });
    expect(res.status).toBe(400);
    const html = await res.text();

    // (b) summary at the top, linking each failed field
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="#field-first_name"');
    expect(html).toContain('href="#field-link_linkedin"');
    // (d) focusable and focused
    expect(html).toContain('id="error-summary"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("document.getElementById('error-summary').focus()");
    // (c) per-field aria wiring with an adjacent description
    expect(html).toContain('aria-describedby="err-first_name"');
    expect(html).toContain('id="err-first_name"');
    expect(html).toContain('aria-invalid="true"');
    // (a) everything posted comes back
    expect(html).toContain('A long and carefully written biography.');
    expect(html).toContain('Analytical Engines Ltd');
    expect(html).toContain('value="not a url"');
    expect(html).toContain('id="field-first_name"');
  });

  it('does not write anything when validation fails', async () => {
    await postProfile({ first_name: '', last_name: '', company: 'Nope' });
    // The save is two statements since 0015 — identity to contacts, profile to
    // event_contacts — so "nothing was written" has to be read across both.
    const row = await env.DB.prepare(
      `SELECT c.first_name, ec.company
         FROM contacts c
         JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
        WHERE c.id = ?`,
    )
      .bind(eventId, contactId)
      .first<{ first_name: string | null; company: string | null }>();
    expect(row?.first_name).toBe('Ada');
    expect(row?.company).toBeNull();
  });

  it('redirects on success (PRG) and saves', async () => {
    const res = await postProfile({
      first_name: 'Ada',
      last_name: 'Lovelace',
      biography: 'Mathematician.',
      link_website: 'https://example.com/ada',
      link_linkedin: '',
      link_twitter: '',
      link_facebook: '',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/profile?m=');
    const row = await env.DB.prepare('SELECT last_name, links FROM contacts WHERE id = ?')
      .bind(contactId)
      .first<{ last_name: string; links: string | null }>();
    expect(row?.last_name).toBe('Lovelace');
    expect(JSON.parse(row?.links ?? '{}')).toMatchObject({ website: 'https://example.com/ada' });
  });

  it('accepts a bare X/Twitter handle and normalizes it to a full URL', async () => {
    const res = await postProfile({
      first_name: 'Ada',
      last_name: 'Lovelace',
      link_twitter: '@ada_lovelace',
      link_linkedin: '',
      link_facebook: '',
      link_website: '',
    });
    expect(res.status).toBe(302);
    const row = await env.DB.prepare('SELECT links FROM contacts WHERE id = ?')
      .bind(contactId)
      .first<{ links: string | null }>();
    expect(JSON.parse(row?.links ?? '{}')).toMatchObject({ twitter: 'https://x.com/ada_lovelace' });
  });

  it('leaves stored links alone when all four controls are blank and unchanged', async () => {
    await env.DB.prepare('UPDATE contacts SET links = ? WHERE id = ?')
      .bind(JSON.stringify({ linkedin: '', twitter: '', facebook: '', website: '' }), contactId)
      .run();
    const before = await env.DB.prepare('SELECT links FROM contacts WHERE id = ?').bind(contactId).first<{ links: string }>();

    const res = await postProfile({
      first_name: 'Ada',
      last_name: 'Byron',
      link_linkedin: '',
      link_twitter: '',
      link_facebook: '',
      link_website: '',
    });
    expect(res.status).toBe(302);
    const after = await env.DB.prepare('SELECT links FROM contacts WHERE id = ?').bind(contactId).first<{ links: string }>();
    expect(after?.links).toBe(before?.links);
  });

  it('does not clobber links when the form omits the link controls entirely', async () => {
    await env.DB.prepare('UPDATE contacts SET links = ? WHERE id = ?')
      .bind(JSON.stringify({ linkedin: 'https://linkedin.example/ada', twitter: '', facebook: '', website: '' }), contactId)
      .run();

    const res = await postProfile({ first_name: 'Ada', last_name: 'Byron' });
    expect(res.status).toBe(302);
    const row = await env.DB.prepare('SELECT links FROM contacts WHERE id = ?').bind(contactId).first<{ links: string }>();
    expect(JSON.parse(row.links)).toMatchObject({ linkedin: 'https://linkedin.example/ada' });
  });
});

describe('POST /portal/:slug/tasks/:id/complete validation', () => {
  it('re-renders the tasks page instead of redirecting when the tickbox is missing', async () => {
    const assignmentId = await createTaskAssignment(eventId, contactId, { actionType: 'acknowledge' });
    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/tasks/${assignmentId}/complete`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="#field-agree"');
    expect(html).toContain('id="err-agree"');
  });

  it('still redirects on success', async () => {
    const assignmentId = await createTaskAssignment(eventId, contactId, { actionType: 'acknowledge' });
    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/tasks/${assignmentId}/complete`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ agree: '1' }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });
});

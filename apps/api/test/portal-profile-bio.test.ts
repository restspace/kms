// Workplan-17 replay defect #9: the speaker portal's Profile form edits the
// biography in a plain <textarea>, but stored bios can be HTML (the CFP
// participant step's biography field is wysiwyg, and imports carry rich-text
// bios verbatim) — so the speaker was shown raw markup ("<p>…</p>") to edit.
// portal.ts bioForEditing converts HTML to clean text on the way into the
// textarea; saving then stores exactly the plain text the speaker saw, and a
// plain-text bio round-trips completely untouched.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createContact, createEvent, sessionCookieFor } from './fixtures';
import { bioForEditing } from '../src/routes/portal';

const ORIGIN = 'https://kms.test';

async function seedSpeaker(biography: string | null) {
  const slug = `bio-${crypto.randomUUID().slice(0, 8)}`;
  const eventId = await createEvent({ slug });
  const contactId = await createContact(eventId, {
    email: `speaker-${crypto.randomUUID().slice(0, 8)}@example.com`,
    first_name: 'Grace',
    last_name: 'Hopper',
    biography: biography ?? undefined,
  });
  const cookie = await sessionCookieFor({ contactId, eventId, eventSlug: slug, role: 'speaker' });
  return { slug, eventId, contactId, cookie };
}

describe('bioForEditing', () => {
  it('converts an HTML bio to clean text, keeping paragraph breaks', () => {
    expect(bioForEditing('<p>First paragraph.</p><p>Second &amp; last.</p>')).toBe(
      'First paragraph.\n\nSecond & last.',
    );
  });

  it('passes plain text through verbatim (no double conversion on round trips)', () => {
    const plain = 'Line one.\n\nLine two & three.';
    expect(bioForEditing(plain)).toBe(plain);
    expect(bioForEditing(bioForEditing('<p>Once</p>'))).toBe('Once');
  });

  it('never empties a bio that has content', () => {
    expect(bioForEditing('<p><strong>Bold</strong> claim</p>')).toBe('Bold claim');
    expect(bioForEditing(null)).toBe('');
  });
});

describe('GET /portal/:slug/profile — Biography textarea', () => {
  it('shows an HTML bio as clean text, not raw markup', async () => {
    const { slug, cookie } = await seedSpeaker(
      '<p>Grace builds <strong>compilers</strong>.</p><p>She also debugs &amp; teaches.</p>',
    );
    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/profile`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The escaped-into-the-page form of the raw markup is exactly what the
    // speaker used to see inside the textarea.
    expect(html).not.toContain('&lt;p&gt;');
    expect(html).not.toContain('&lt;strong&gt;');
    expect(html).toContain('Grace builds compilers.');
    expect(html).toContain('She also debugs &amp; teaches.');
  });

  it('an HTML bio edited and saved lands as the clean text — not double-escaped, not emptied', async () => {
    const { slug, eventId, contactId, cookie } = await seedSpeaker('<p>Original &amp; rich.</p>');
    // What the speaker's browser posts is the converted textarea content
    // (plus their edit), exactly as the GET rendered it.
    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/profile`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        biography: 'Original & rich.\n\nNow extended.',
        first_name: 'Grace',
        last_name: 'Hopper',
      }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);

    const row = await env.DB.prepare(
      'SELECT biography FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    )
      .bind(eventId, contactId)
      .first<{ biography: string | null }>();
    expect(row?.biography).toBe('Original & rich.\n\nNow extended.');

    // Re-rendering the form shows the same text unchanged: the round trip is
    // stable from here on.
    const again = await (await SELF.fetch(`${ORIGIN}/portal/${slug}/profile`, { headers: { cookie } })).text();
    expect(again).toContain('Original &amp; rich.');
    expect(again).toContain('Now extended.');
    expect(again).not.toContain('&amp;amp;');
  });
});

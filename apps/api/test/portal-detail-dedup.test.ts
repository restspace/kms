// The speaker-facing submission detail page renders the canonical
// `submissions.format`/`track_name` columns as fixed DetailPairs above the
// answers list, but the answers list itself is a frozen-at-submit-time copy
// of what the speaker typed into the form. When a form has its own
// "Title"/"Description"/"Format"/"Track" questions, those frozen answers
// used to render again below — duplicating (and, after an edit, going
// stale relative to) the canonical column value. This pins the fix: the
// canonical columns are the only place Title/Description/Format/Track show,
// and everything else still lists as an answer row.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, sessionCookieFor } from './fixtures';
import { addParticipant, createQuestion, createSubmission, createSubmissionForm, setAnswer } from './fixtures-portal';

const ORIGIN = 'https://kms.test';
const ts = '2026-08-01T00:00:00Z';

let eventId: string;
let slug: string;
let speakerId: string;
let formId: string;
let cookie: string;

beforeEach(async () => {
  slug = `dedup-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug });
  speakerId = await createContact(eventId, { email: 'speaker@example.com', first_name: 'Grace', last_name: 'Hopper' });
  formId = await createSubmissionForm(eventId);
  cookie = await sessionCookieFor({ contactId: speakerId, eventId, eventSlug: slug, role: 'speaker' });
});

describe('portal submission detail — Title/Description/Format/Track dedup', () => {
  it('renders each canonical field once, from the column, not the frozen answer', async () => {
    const titleQ = await createQuestion(eventId, formId, { key: 'title', label: 'Title', position: 0 });
    const descQ = await createQuestion(eventId, formId, { key: 'description', label: 'Description', position: 1 });
    const formatQ = await createQuestion(eventId, formId, { key: 'format', label: 'Format', position: 2 });
    const trackQ = await createQuestion(eventId, formId, { key: 'track', label: 'Track', position: 3 });
    const audienceQ = await createQuestion(eventId, formId, { key: 'audience', label: 'Target audience', position: 4 });

    const id = await createSubmission(eventId, { formId, title: 'Fresh Title' });
    await addParticipant(id, speakerId);
    await env.DB.prepare('UPDATE submissions SET format = ?, description = ? WHERE id = ?')
      .bind('Talk', 'Fresh description', id)
      .run();

    // Stale, frozen-at-submit-time answers — exactly what would linger after
    // an edit only touched the canonical columns.
    await setAnswer(id, titleQ, 'Old Title');
    await setAnswer(id, descQ, 'Old description');
    await setAnswer(id, formatQ, 'Workshop');
    await setAnswer(id, trackQ, 'Old Track');
    await setAnswer(id, audienceQ, 'Beginners');

    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();

    // Canonical values show, once each.
    expect(html).toContain('Fresh Title');
    expect(html).toContain('Fresh description');
    expect(countOccurrences(html, '<dt>Format</dt>')).toBe(1);
    expect(html).toContain('<dd>Talk</dd>');

    // Stale answer text never appears anywhere on the page.
    expect(html).not.toContain('Old Title');
    expect(html).not.toContain('Old description');
    expect(html).not.toContain('Workshop');
    expect(html).not.toContain('Old Track');

    // An unrelated answer still lists normally.
    expect(html).toContain('<dt>Target audience</dt>');
    expect(html).toContain('<dd>Beginners</dd>');
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

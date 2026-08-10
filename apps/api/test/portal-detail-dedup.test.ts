// The speaker-facing submission detail page renders the canonical
// `submissions.format`/`track_name` columns as fixed DetailPairs above the
// answers list, but the answers list itself is a frozen-at-submit-time copy
// of what the speaker typed into the form. When a form has its own
// "Title"/"Description"/"Format"/"Track" questions, those frozen answers
// used to render again below — duplicating (and, after an edit, going
// stale relative to) the canonical column value. This pins the fix: the
// canonical columns are the only place Title/Description/Format/Track show,
// and everything else still lists as an answer row.
//
// Amended for the CFP track defect: suppression applies only while the
// canonical column actually HAS a value. A submission with no track_id renders
// no Track pair, so suppressing the raw answer as well made the track the
// submitter chose vanish from their own submission entirely. Suppress a
// duplicate, never the only copy.

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
    // Canonical track too, so the frozen 'Old Track' answer really is a stale
    // duplicate of a column that has something to show.
    const trackId = `trk-${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO tracks (id, event_id, name, position) VALUES (?, ?, ?, 1)')
      .bind(trackId, eventId, 'Fresh Track')
      .run();
    await env.DB.prepare('UPDATE submissions SET format = ?, description = ?, track_id = ? WHERE id = ?')
      .bind('Talk', 'Fresh description', trackId, id)
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

  it('falls back to the raw Track answer when the submission has no canonical track', async () => {
    const titleQ = await createQuestion(eventId, formId, { key: 'title', label: 'Title', position: 0 });
    const trackQ = await createQuestion(eventId, formId, { key: 'track', label: 'Track', position: 1 });

    const id = await createSubmission(eventId, { formId, title: 'Untracked Talk' });
    await addParticipant(id, speakerId);
    await setAnswer(id, titleQ, 'Untracked Talk');
    await setAnswer(id, trackQ, 'Infra & Serving');

    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();

    // Exactly one Track row, sourced from the answer since the column is null.
    expect(countOccurrences(html, '<dt>Track</dt>')).toBe(1);
    expect(html).toContain('Infra &amp; Serving');
  });

  it('renders an em-dash, not the literal word null, for an unanswered question', async () => {
    const titleQ = await createQuestion(eventId, formId, { key: 'title', label: 'Title', position: 0 });
    const capacityQ = await createQuestion(eventId, formId, { key: 'capacity', label: 'Capacity', position: 1 });

    const id = await createSubmission(eventId, { formId, title: 'Blank number talk' });
    await addParticipant(id, speakerId);
    await setAnswer(id, titleQ, 'Blank number talk');
    await env.DB.prepare(
      'INSERT INTO submission_answers (submission_id, question_id, value_json) VALUES (?, ?, ?)',
    )
      .bind(id, capacityQ, 'null')
      .run();

    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}`, { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('<dt>Capacity</dt>');
    expect(html).not.toContain('<dd>null</dd>');
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

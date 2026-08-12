// Eval defect (2026-08-12, MAJOR): "Speaker 'Edit submission' page fails to
// hydrate the saved Track value (renders 'Select…' while the read-only view
// shows 'Infra & Serving'). Saving without noticing would silently clear a
// required field."
//
// Root causes: stored answers hold the track's display LABEL
// (submit.tsx storableAnswers) while the derived Track options are keyed by
// track id, so the edit control never matched; seeded/imported submissions
// carry the track only as a column with no answer row at all; and an empty
// posted track cleared submissions.track_id outright.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, sessionCookieFor } from './fixtures';
import { addParticipant, createQuestion, createSubmission, createSubmissionForm, setAnswer } from './fixtures-portal';
import { createTrack } from './fixtures-submission';

const ORIGIN = 'https://kms.test';

let eventId: string;
let slug: string;
let speakerId: string;
let formId: string;
let titleQ: string;
let trackQ: string;
let trackId: string;
let cookie: string;

beforeEach(async () => {
  slug = `trk-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug });
  speakerId = await createContact(eventId, { email: 'speaker@example.com', first_name: 'Grace', last_name: 'Hopper' });
  formId = await createSubmissionForm(eventId);
  titleQ = await createQuestion(eventId, formId, { key: 'title', label: 'Title', required: true, position: 0 });
  // The canonical Track question: dropdown, no stored options — loadQuestions
  // derives them from the event's tracks, keyed by track id.
  trackQ = await createQuestion(eventId, formId, { key: 'track', label: 'Track', type: 'dropdown', required: true, position: 1 });
  trackId = await createTrack(eventId, 'Infra & Serving');
  cookie = await sessionCookieFor({ contactId: speakerId, eventId, eventSlug: slug, role: 'speaker' });
});

async function seedSubmission(withAnswerRows: boolean): Promise<string> {
  const id = await createSubmission(eventId, { status: 'pending', submitterContactId: speakerId, formId, title: 'Tracked talk' });
  await addParticipant(id, speakerId);
  await env.DB.prepare('UPDATE submissions SET track_id = ? WHERE id = ?').bind(trackId, id).run();
  if (withAnswerRows) {
    await setAnswer(id, titleQ, 'Tracked talk');
    // What the wizard actually stores: the track's display label, not its id.
    await setAnswer(id, trackQ, 'Infra & Serving');
  }
  return id;
}

const getEdit = (id: string) => SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}/edit`, { headers: { cookie } });

const postEdit = (id: string, fields: Record<string, string>) =>
  SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}/edit`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });

describe('portal edit — track hydration and preservation', () => {
  it('hydrates a label-stored track answer back to the selected option', async () => {
    const id = await seedSubmission(true);
    const html = await (await getEdit(id)).text();
    expect(html).toContain(`<option value="${trackId}" selected>`);
  });

  it('hydrates from system columns when the submission has no answer rows (seeded/imported rows)', async () => {
    const id = await seedSubmission(false);
    const html = await (await getEdit(id)).text();
    expect(html).toContain(`<option value="${trackId}" selected>`);
    // Title synthesized from the column too, not an empty input.
    expect(html).toContain('value="Tracked talk"');
  });

  it('saving with the track posted as its id keeps the track and stores the label answer', async () => {
    const id = await seedSubmission(true);
    const res = await postEdit(id, { [`q_${titleQ}`]: 'Tracked talk v2', [`q_${trackQ}`]: trackId });
    expect(res.status).toBe(302);

    const row = await env.DB.prepare('SELECT title, track_id FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ title: string; track_id: string | null }>();
    expect(row).toMatchObject({ title: 'Tracked talk v2', track_id: trackId });

    const answer = await env.DB.prepare(
      'SELECT value_json FROM submission_answers WHERE submission_id = ? AND question_id = ?',
    )
      .bind(id, trackQ)
      .first<{ value_json: string }>();
    expect(JSON.parse(answer!.value_json)).toBe('Infra & Serving');
  });

  it('an empty/unhydrated track select does not clear the saved track', async () => {
    const id = await seedSubmission(true);
    // Track question exists but posts empty (the pre-fix "Select…" state);
    // make it optional so validation lets the save through.
    await env.DB.prepare('UPDATE form_questions SET required = 0 WHERE id = ?').bind(trackQ).run();

    const res = await postEdit(id, { [`q_${titleQ}`]: 'Tracked talk v3', [`q_${trackQ}`]: '' });
    expect(res.status).toBe(302);

    const row = await env.DB.prepare('SELECT track_id FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ track_id: string | null }>();
    expect(row!.track_id).toBe(trackId);
  });

  it('a stale client that posts the label instead of the id still validates and saves', async () => {
    const id = await seedSubmission(true);
    const res = await postEdit(id, { [`q_${titleQ}`]: 'Tracked talk v4', [`q_${trackQ}`]: 'Infra & Serving' });
    expect(res.status).toBe(302);
    const row = await env.DB.prepare('SELECT track_id FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ track_id: string | null }>();
    expect(row!.track_id).toBe(trackId);
  });
});

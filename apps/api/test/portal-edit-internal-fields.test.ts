// The portal's submission edit page is speaker-facing, so it honours the same
// field-level audience boundary as the CFP wizard (0042): internal fields are
// never rendered, and a portal save must leave their stored answers exactly
// where an organiser or import put them (the save is a delete-and-reinsert of
// answer rows, which used to sweep everything).

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, sessionCookieFor } from './fixtures';
import {
  addParticipant,
  createQuestion,
  createSubmission,
  createSubmissionForm,
  setAnswer,
} from './fixtures-portal';

const ORIGIN = 'https://kms.test';

let eventId: string;
let slug: string;
let speakerId: string;
let formId: string;
let titleQ: string;
let internalQ: string;
let cookie: string;

beforeEach(async () => {
  slug = `edit-int-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug });
  speakerId = await createContact(eventId, { email: 'speaker@example.com' });
  formId = await createSubmissionForm(eventId);
  titleQ = await createQuestion(eventId, formId, { key: 'title', label: 'Title', required: true, position: 0 });
  internalQ = await createQuestion(eventId, formId, {
    key: 'client_session_id',
    label: 'Client Session ID',
    position: 1,
    audience: 'internal',
  });
  cookie = await sessionCookieFor({ contactId: speakerId, eventId, eventSlug: slug, role: 'speaker' });
});

async function seedSubmission(): Promise<string> {
  const id = await createSubmission(eventId, {
    status: 'accepted',
    submitterContactId: speakerId,
    formId,
    title: 'Original title',
  });
  await addParticipant(id, speakerId);
  await setAnswer(id, titleQ, 'Original title');
  await setAnswer(id, internalQ, 'SB-99');
  await env.DB.prepare(`UPDATE submissions SET client_session_id = 'SB-99' WHERE id = ?`).bind(id).run();
  return id;
}

describe('portal edit page — internal-audience fields', () => {
  it('does not render the internal question to the speaker', async () => {
    const id = await seedSubmission();
    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}/edit`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Client Session ID');
    expect(html).not.toContain(internalQ);
    expect(html).toContain('Original title');
  });

  it('a portal save preserves the internal answer row and column untouched', async () => {
    const id = await seedSubmission();
    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}/edit`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ [`q_${titleQ}`]: 'Renamed by speaker' }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);

    const row = await env.DB.prepare('SELECT title, client_session_id FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ title: string; client_session_id: string | null }>();
    expect(row?.title).toBe('Renamed by speaker');
    expect(row?.client_session_id).toBe('SB-99');

    const answer = await env.DB.prepare(
      'SELECT value_json FROM submission_answers WHERE submission_id = ? AND question_id = ?',
    )
      .bind(id, internalQ)
      .first<{ value_json: string }>();
    expect(JSON.parse(answer?.value_json ?? 'null')).toBe('SB-99');
  });
});

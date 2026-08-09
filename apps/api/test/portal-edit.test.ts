// Swyx-2 gap 2: acceptance no longer locks a submission. Any participant may
// edit until the submission is withdrawn or declined, and a post-decision edit
// notifies the organisers configured on the form exactly once per save.

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
let adminId: string;
let strangerId: string;
let formId: string;
let titleQ: string;
let summaryQ: string;
let cookie: string;

async function seedSubmission(status: string): Promise<string> {
  const id = await createSubmission(eventId, { status, submitterContactId: speakerId, formId, title: 'Original title' });
  await addParticipant(id, speakerId);
  await setAnswer(id, titleQ, 'Original title');
  await setAnswer(id, summaryQ, 'Original summary');
  return id;
}

beforeEach(async () => {
  slug = `edit-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug });
  speakerId = await createContact(eventId, { email: 'speaker@example.com', first_name: 'Grace', last_name: 'Hopper' });
  adminId = await createContact(eventId, { email: 'organiser@example.com' });
  strangerId = await createContact(eventId, { email: 'stranger@example.com' });
  formId = await createSubmissionForm(eventId, { notifyAdminsOnUpdate: [adminId, 'ghost-contact-id'] });
  titleQ = await createQuestion(eventId, formId, { key: 'title', label: 'Title', required: true, position: 0 });
  summaryQ = await createQuestion(eventId, formId, {
    key: 'description',
    label: 'Summary',
    type: 'textarea',
    required: true,
    position: 1,
  });
  cookie = await sessionCookieFor({ contactId: speakerId, eventId, eventSlug: slug, role: 'speaker' });
});

const getEdit = (id: string, who = cookie) =>
  SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}/edit`, { headers: { cookie: who } });

const postEdit = (id: string, fields: Record<string, string>, who = cookie) =>
  SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}/edit`, {
    method: 'POST',
    headers: { cookie: who, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });

describe('portal submission editing', () => {
  it('is offered from the detail page while the submission is live', async () => {
    const id = await seedSubmission('accepted');
    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}`, { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain(`/submissions/${id}/edit`);
    expect(html).not.toContain('Contact the organisers — editing reopens');
  });

  it('allows editing an accepted submission', async () => {
    const id = await seedSubmission('accepted');
    expect((await getEdit(id)).status).toBe(200);

    const res = await postEdit(id, { [`q_${titleQ}`]: 'A better title', [`q_${summaryQ}`]: 'A better summary' });
    expect(res.status).toBe(302);

    const row = await env.DB.prepare('SELECT title, description, updated_at FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ title: string; description: string | null; updated_at: string }>();
    expect(row?.title).toBe('A better title');
    expect(row?.description).toBe('A better summary');
    expect(row?.updated_at).not.toBe('2026-08-01T00:00:00Z');

    const answers = await env.DB.prepare('SELECT question_id, value_json FROM submission_answers WHERE submission_id = ?')
      .bind(id)
      .all<{ question_id: string; value_json: string }>();
    expect(answers.results).toHaveLength(2);
    expect(JSON.parse(answers.results.find((a) => a.question_id === titleQ)?.value_json ?? '""')).toBe('A better title');
  });

  it('queues exactly one admin notification per save, to validated event contacts only', async () => {
    const id = await seedSubmission('accepted');
    await postEdit(id, { [`q_${titleQ}`]: 'Renamed', [`q_${summaryQ}`]: 'Summary' });

    // message_log is shared across tests in this file (storage is not reset
    // per test), so scope the assertion to this submission's entity id.
    const { results } = await env.DB.prepare(
      `SELECT to_email, contact_id, idempotency_key FROM message_log
       WHERE template_key = 'submission_updated_admin' AND idempotency_key LIKE ?`,
    )
      .bind(`%:${id}:%`)
      .all<{ to_email: string; contact_id: string; idempotency_key: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]?.contact_id).toBe(adminId);
    expect(results[0]?.to_email).toBe('organiser@example.com');
    // keyed on the new updated_at, so a replay of the same save cannot double-send
    expect(results[0]?.idempotency_key).toContain(id);
  });

  it('sends nothing when the form configures no update recipients', async () => {
    await env.DB.prepare('UPDATE submission_forms SET notify_admins_on_update = NULL WHERE id = ?').bind(formId).run();
    const id = await seedSubmission('accepted');
    await postEdit(id, { [`q_${titleQ}`]: 'Renamed', [`q_${summaryQ}`]: 'Summary' });
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log
       WHERE template_key = 'submission_updated_admin' AND idempotency_key LIKE ?`,
    )
      .bind(`%:${id}:%`)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it.each(['declined', 'withdrawn'])('refuses to edit a %s submission', async (status) => {
    const id = await seedSubmission(status);
    expect((await getEdit(id)).status).toBe(403);

    const res = await postEdit(id, { [`q_${titleQ}`]: 'Sneaky', [`q_${summaryQ}`]: 'Sneaky' });
    expect(res.status).toBe(403);
    const row = await env.DB.prepare('SELECT title FROM submissions WHERE id = ?').bind(id).first<{ title: string }>();
    expect(row?.title).toBe('Original title');
  });

  it('404s for a contact who neither submitted nor participates', async () => {
    const id = await seedSubmission('accepted');
    const strangerCookie = await sessionCookieFor({
      contactId: strangerId,
      eventId,
      eventSlug: slug,
      role: 'speaker',
    });
    expect((await getEdit(id, strangerCookie)).status).toBe(404);
    expect((await postEdit(id, { [`q_${titleQ}`]: 'Hijack' }, strangerCookie)).status).toBe(404);
  });

  it('lets a non-submitting participant edit', async () => {
    const coSpeaker = await createContact(eventId, { email: 'co@example.com' });
    const id = await seedSubmission('accepted');
    await addParticipant(id, coSpeaker, 'co-speaker');
    const coCookie = await sessionCookieFor({ contactId: coSpeaker, eventId, eventSlug: slug, role: 'speaker' });
    expect((await getEdit(id, coCookie)).status).toBe(200);
  });

  it('re-renders with preserved input when a required answer is blank', async () => {
    const id = await seedSubmission('accepted');
    const res = await postEdit(id, { [`q_${titleQ}`]: '', [`q_${summaryQ}`]: 'Kept summary text' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain(`href="#field-${titleQ}"`);
    expect(html).toContain(`id="err-${titleQ}"`);
    expect(html).toContain('Kept summary text');

    const row = await env.DB.prepare('SELECT title FROM submissions WHERE id = ?').bind(id).first<{ title: string }>();
    expect(row?.title).toBe('Original title');
  });
});

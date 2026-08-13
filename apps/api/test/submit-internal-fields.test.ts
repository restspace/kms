// Workplan-17 replay defect #4: the public CFP wizard rendered operational
// fields — Client Session ID (the Sessionboard upsert key), CEU Credits,
// Capacity — to submitters as if they were CFP questions. Fields now carry a
// field_definitions.audience flag (0042): 'internal' fields are skipped on
// every speaker-facing surface (wizard render, autosave, submit, portal
// edit), their answers are discarded server-side, and — critically — a save
// from a wizard that never showed them must not null out the column/answer
// values an import or organiser put there.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createContact, createEventUser, sessionCookieFor } from './fixtures';
import { seedForm, type SeededForm } from './fixtures-submission';

const ORIGIN = 'https://example.com';

/** An internal-audience field + question on a seeded form (0042). */
async function addField(
  form: SeededForm,
  key: string,
  label: string,
  opts: Partial<{ audience: 'public' | 'internal'; type: string; position: number }> = {},
): Promise<{ fieldId: string; questionId: string }> {
  const fieldId = `fld-${crypto.randomUUID()}`;
  const questionId = `q-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO field_definitions (id, event_id, key, label, type, scope, system, audience)
     VALUES (?, ?, ?, ?, ?, 'submission', 0, ?)`,
  )
    .bind(fieldId, form.eventId, key, label, opts.type ?? 'text', opts.audience ?? 'internal')
    .run();
  await env.DB.prepare(
    `INSERT INTO form_questions (id, form_id, section, field_id, label, position, required, locked)
     VALUES (?, ?, 'abstract', ?, ?, ?, 0, 0)`,
  )
    .bind(questionId, form.formId, fieldId, label, opts.position ?? 50)
    .run();
  return { fieldId, questionId };
}

const renderWizard = async (form: SeededForm): Promise<string> => {
  const res = await SELF.fetch(`${ORIGIN}${form.basePath}`, { headers: { cookie: form.cookie } });
  expect(res.status).toBe(200);
  return res.text();
};

const post = (form: SeededForm, path: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}${form.basePath}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

const participants = [
  { email: 'submitter@example.com', first_name: 'Sub', last_name: 'Mitter', role: 'speaker' },
];

describe('public CFP wizard — internal-audience fields (0042)', () => {
  it('never renders an internal field to a submitter; public fields still show', async () => {
    const form = await seedForm();
    const internal = await addField(form, 'client_session_id', 'Client Session ID');
    await addField(form, 'ceu_credits', 'CEU Credits', { type: 'number' });
    await addField(form, 'room_notes', 'Ops Room Notes');

    const html = await renderWizard(form);
    expect(html).not.toContain('Client Session ID');
    expect(html).not.toContain('CEU Credits');
    expect(html).not.toContain('Ops Room Notes');
    expect(html).not.toContain(internal.questionId);
    // The genuine questions are unaffected.
    expect(html).toContain('title');
    expect(html).toContain('description');
  });

  it('a field flipped back to public via PUT /app/api/forms/fields/:id renders again', async () => {
    const form = await seedForm();
    const { fieldId } = await addField(form, 'ceu_credits', 'CEU Credits', { type: 'number' });
    expect(await renderWizard(form)).not.toContain('CEU Credits');

    const adminId = await createContact(form.eventId, { email: 'organiser@example.com' });
    await createEventUser(form.eventId, adminId, 'owner');
    const adminCookie = await sessionCookieFor({
      contactId: adminId, eventId: form.eventId, eventSlug: form.eventSlug, role: 'owner',
    });
    const res = await SELF.fetch(`${ORIGIN}/app/api/forms/fields/${fieldId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ audience: 'public' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { field: { audience: string } };
    expect(body.field.audience).toBe('public');

    expect(await renderWizard(form)).toContain('CEU Credits');

    // Bad vocabulary is refused, and a foreign event's field is not reachable.
    const bad = await SELF.fetch(`${ORIGIN}/app/api/forms/fields/${fieldId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ audience: 'secret' }),
    });
    expect(bad.status).toBe(400);
  });

  it('discards an answer posted at an internal question instead of storing it', async () => {
    const form = await seedForm();
    const internal = await addField(form, 'client_session_id', 'Client Session ID');

    const res = await post(form, '/submit', {
      answers: {
        [form.questions.title!]: 'Honest talk',
        [internal.questionId]: 'SB-INJECTED-42',
      },
      participants,
    });
    expect(res.status).toBe(200);
    const { submission_id } = (await res.json()) as { submission_id: string };

    const row = await env.DB.prepare('SELECT client_session_id FROM submissions WHERE id = ?')
      .bind(submission_id)
      .first<{ client_session_id: string | null }>();
    expect(row?.client_session_id).toBeNull();
    const answer = await env.DB.prepare(
      'SELECT value_json FROM submission_answers WHERE submission_id = ? AND question_id = ?',
    )
      .bind(submission_id, internal.questionId)
      .first();
    expect(answer).toBeNull();
  });

  it('an autosave over a draft carrying internal data preserves the columns and answer rows', async () => {
    const form = await seedForm();
    const internal = await addField(form, 'client_session_id', 'Client Session ID');

    const created = await post(form, '/draft', {
      answers: { [form.questions.title!]: 'Imported draft' },
    });
    expect(created.status).toBe(200);
    const { submission_id } = (await created.json()) as { submission_id: string };

    // What a Sessionboard import / an organiser leaves on the row.
    await env.DB.prepare(
      `UPDATE submissions SET capacity = 120, ceu_credits = 1.5, client_session_id = 'SB-42' WHERE id = ?`,
    )
      .bind(submission_id)
      .run();
    await env.DB.prepare(
      'INSERT INTO submission_answers (submission_id, question_id, value_json) VALUES (?, ?, ?)',
    )
      .bind(submission_id, internal.questionId, JSON.stringify('SB-42'))
      .run();

    // The wizard autosaves without ever having seen the internal fields.
    const saved = await post(form, '/draft', {
      submission_id,
      answers: { [form.questions.title!]: 'Imported draft, renamed' },
    });
    expect(saved.status).toBe(200);

    const row = await env.DB.prepare(
      'SELECT title, capacity, ceu_credits, client_session_id FROM submissions WHERE id = ?',
    )
      .bind(submission_id)
      .first<{ title: string; capacity: number | null; ceu_credits: number | null; client_session_id: string | null }>();
    expect(row?.title).toBe('Imported draft, renamed');
    expect(row?.capacity).toBe(120);
    expect(row?.ceu_credits).toBe(1.5);
    expect(row?.client_session_id).toBe('SB-42');

    const answer = await env.DB.prepare(
      'SELECT value_json FROM submission_answers WHERE submission_id = ? AND question_id = ?',
    )
      .bind(submission_id, internal.questionId)
      .first<{ value_json: string }>();
    expect(JSON.parse(answer?.value_json ?? 'null')).toBe('SB-42');
  });

  it('promoting the draft to a submission keeps the internal data too', async () => {
    const form = await seedForm();
    const internal = await addField(form, 'client_session_id', 'Client Session ID');
    const created = await post(form, '/draft', {
      answers: { [form.questions.title!]: 'Promotable draft' },
    });
    const { submission_id } = (await created.json()) as { submission_id: string };
    await env.DB.prepare(`UPDATE submissions SET capacity = 80, client_session_id = 'SB-7' WHERE id = ?`)
      .bind(submission_id)
      .run();
    await env.DB.prepare(
      'INSERT INTO submission_answers (submission_id, question_id, value_json) VALUES (?, ?, ?)',
    )
      .bind(submission_id, internal.questionId, JSON.stringify('SB-7'))
      .run();

    const res = await post(form, '/submit', {
      submission_id,
      answers: { [form.questions.title!]: 'Promotable draft' },
      participants,
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      'SELECT status, capacity, client_session_id FROM submissions WHERE id = ?',
    )
      .bind(submission_id)
      .first<{ status: string; capacity: number | null; client_session_id: string | null }>();
    expect(row?.status).toBe('pending');
    expect(row?.capacity).toBe(80);
    expect(row?.client_session_id).toBe('SB-7');
    const answer = await env.DB.prepare(
      'SELECT value_json FROM submission_answers WHERE submission_id = ? AND question_id = ?',
    )
      .bind(submission_id, internal.questionId)
      .first<{ value_json: string }>();
    expect(JSON.parse(answer?.value_json ?? 'null')).toBe('SB-7');
  });
});

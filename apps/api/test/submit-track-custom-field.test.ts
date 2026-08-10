// Regression for the MAJOR eval defect: a speaker picks a Track on a form
// whose Track question was added via the builder's "Create Field" flow
// (formsAdmin.ts mints a synthetic `custom_<label>_<id4>` field_key for any
// field created inline), so submit.tsx's systemColumns/trackAnswers lookup —
// which matched field_key === 'track' exactly — silently dropped the answer
// and submissions.track_id stayed null. Same root cause the 'level' system
// column mapping already guards against; this exercises the label-based
// fallback added to trackAnswers() in submit.tsx.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTrack, seedForm, submitBody, type SeededForm } from './fixtures-submission';

const post = (form: SeededForm, path: string, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

/** Add a question backed by a custom-keyed field, exactly as the builder's
 *  "Create Field" flow would (formsAdmin.ts POST /:id/questions with
 *  new_field): field_definitions.key is `custom_<slug>_<id4>`, never 'track'. */
async function addCustomTrackQuestion(form: SeededForm, trackNames: string[]): Promise<string> {
  const fieldId = `fld-${crypto.randomUUID()}`;
  const key = `custom_track_${fieldId.slice(0, 4)}`;
  await env.DB.prepare(
    `INSERT INTO field_definitions (id, event_id, key, label, type, scope, options, system)
     VALUES (?, ?, ?, 'Track', 'dropdown', 'submission', ?, 0)`,
  )
    .bind(fieldId, form.eventId, key, JSON.stringify(trackNames.map((name) => ({ value: name, label: name }))))
    .run();
  const qid = `q-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO form_questions (id, form_id, section, field_id, position, required, locked)
     VALUES (?, ?, 'abstract', ?, 99, 0, 0)`,
  )
    .bind(qid, form.formId, fieldId)
    .run();
  return qid;
}

describe('submit: custom-keyed Track question', () => {
  it('sets submissions.track_id even when the Track question has a custom field_key', async () => {
    const form = await seedForm();
    const platformTrackId = await createTrack(form.eventId, 'Platform');
    const customTrackQuestionId = await addCustomTrackQuestion(form, ['Platform', 'People']);

    const res = await post(form, '/submit', {
      ...submitBody(form, 'Custom-keyed track talk'),
      answers: { [form.questions.title!]: 'Custom-keyed track talk', [customTrackQuestionId]: 'Platform' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submission_id: string };

    const row = await env.DB.prepare('SELECT track_id FROM submissions WHERE id = ?')
      .bind(body.submission_id)
      .first<{ track_id: string | null }>();
    expect(row?.track_id).toBe(platformTrackId);

    const joined = await env.DB.prepare('SELECT track_id FROM submission_tracks WHERE submission_id = ?')
      .bind(body.submission_id)
      .all<{ track_id: string }>();
    expect(joined.results.map((r) => r.track_id)).toContain(platformTrackId);
  });

  it('still prefers the canonical field_key track question when both exist', async () => {
    const form = await seedForm({ trackOptions: ['Platform'] });
    const platformTrackId = await createTrack(form.eventId, 'Platform');
    const peopleTrackId = await createTrack(form.eventId, 'People');
    // A second, custom-keyed "Track" question the canonical one should win over.
    await addCustomTrackQuestion(form, ['People']);

    const res = await post(form, '/submit', {
      ...submitBody(form, 'Canonical wins'),
      answers: { [form.questions.title!]: 'Canonical wins', [form.questions.track!]: ['Platform'] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submission_id: string };

    const row = await env.DB.prepare('SELECT track_id FROM submissions WHERE id = ?')
      .bind(body.submission_id)
      .first<{ track_id: string | null }>();
    expect(row?.track_id).toBe(platformTrackId);
    expect(row?.track_id).not.toBe(peopleTrackId);
  });
});

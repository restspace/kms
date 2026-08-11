// The canonical Track question's options are the event's `tracks` rows, derived
// on every load (formsAdmin.ts's loadQuestions), not a copy stored on the form.
//
// Storing track *names* as options duplicated the tracks table into every form:
// renaming or deleting a track left each form offering a name that resolved to
// nothing, so submissions landed with track_id NULL — and the organiser's edit
// form, which can only offer real tracks, had no option to show for what the
// submitter picked, so an unrelated save then overwrote the column (see
// apps/admin/src/workspace/SubmissionEditForm.track.test.tsx for that half).
//
// These cover the pipeline half: options follow the tracks table, a submitted
// track id resolves by identity, a legacy name still resolves, and the stored
// answer stays human-readable rather than becoming a bare id.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTrack, seedForm, type SeededForm } from './fixtures-submission';

const post = (form: SeededForm, path: string, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

const participants = [
  { email: 'submitter@example.com', first_name: 'Sub', last_name: 'Mitter', role: 'speaker' },
];

const trackOf = (id: string) =>
  env.DB.prepare('SELECT track_id FROM submissions WHERE id = ?').bind(id).first<{ track_id: string | null }>();

const answerOf = (submissionId: string, questionId: string) =>
  env.DB.prepare('SELECT value_json FROM submission_answers WHERE submission_id = ? AND question_id = ?')
    .bind(submissionId, questionId)
    .first<{ value_json: string }>();

/** The public form's rendered HTML, which carries the bootstrap the wizard
 *  renders its controls from — the derived options included. */
const renderForm = async (form: SeededForm): Promise<string> => {
  const res = await SELF.fetch(`https://example.com${form.basePath}`, { headers: { cookie: form.cookie } });
  expect(res.status).toBe(200);
  return res.text();
};

describe('submit: Track options derive from the event tracks', () => {
  it('offers the event tracks, and follows a rename without touching the form', async () => {
    const form = await seedForm();
    const infra = await createTrack(form.eventId, 'Infra Serving');

    expect(await renderForm(form)).toContain('Infra Serving');

    // Only the tracks row changes — the form and its questions are untouched.
    await env.DB.prepare('UPDATE tracks SET name = ? WHERE id = ?').bind('Serving Systems', infra).run();

    const after = await renderForm(form);
    expect(after).toContain('Serving Systems');
    expect(after).not.toContain('Infra Serving');
  });

  it('resolves a submitted track id by identity and stores the answer as the name', async () => {
    const form = await seedForm();
    await createTrack(form.eventId, 'Agents');
    const infra = await createTrack(form.eventId, 'Infra & Serving');

    const res = await post(form, '/submit', {
      answers: { [form.questions.title!]: 'Id-keyed track talk', [form.questions.track!]: [infra] },
      participants,
    });
    expect(res.status).toBe(200);
    const { submission_id } = (await res.json()) as { submission_id: string };

    expect((await trackOf(submission_id))?.track_id).toBe(infra);
    // Stored as the name, not the id: the portal, the organiser detail panel
    // and the exports all read this row straight back out as display text.
    expect(answerOf(submission_id, form.questions.track!).then((r) => r && JSON.parse(r.value_json))).resolves.toEqual([
      'Infra & Serving',
    ]);
  });

  it('still accepts a track submitted by name, as a draft saved before the change would', async () => {
    const form = await seedForm();
    const infra = await createTrack(form.eventId, 'Infra & Serving');

    const res = await post(form, '/submit', {
      answers: { [form.questions.title!]: 'Legacy name talk', [form.questions.track!]: ['Infra & Serving'] },
      participants,
    });
    expect(res.status).toBe(200);
    const { submission_id } = (await res.json()) as { submission_id: string };
    expect((await trackOf(submission_id))?.track_id).toBe(infra);
  });

  it('drops a deleted track from the options instead of offering a dead name', async () => {
    const form = await seedForm();
    const doomed = await createTrack(form.eventId, 'Temporary Track');
    expect(await renderForm(form)).toContain('Temporary Track');

    await env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(doomed).run();
    expect(await renderForm(form)).not.toContain('Temporary Track');
  });
});

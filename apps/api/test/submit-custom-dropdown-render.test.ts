// Regression for the reported MAJOR eval defect: a custom dropdown field
// ("Audience level", options Beginner/Intermediate/Advanced) added via the
// builder's "Create Field" flow (formsAdmin.ts POST /:id/questions with
// new_field, which mints a synthetic `custom_<label>_<id4>` field_key) was
// suspected of never reaching the public submission form — either dropped by
// the track-bound-question detection (submit.tsx's trackBoundQuestion /
// trackAnswers, which special-case field_key === 'track'), or by loadQuestions'
// options COALESCE, or by SubmitPage's per-type renderer.
//
// Live diagnosis against the deployed demo (kms.r-s.workers.dev) found the
// field renders and persists correctly end to end (builder -> SSR bootstrap
// -> SubmitPage -> submit -> submission_answers -> admin detail). This test
// locks in the one layer owned here — the SSR route's bootstrap payload
// (apps/api/src/routes/submit.tsx GET /submit/:slug/:formId) — so a future
// regression in loadQuestions/options serialization for a non-track custom
// dropdown field is caught even though the live repro did not turn one up.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedForm, type SeededForm } from './fixtures-submission';

/** Add a dropdown question backed by a custom-keyed field, exactly as the
 *  builder's "Create Field" flow does (formsAdmin.ts POST /:id/questions
 *  with new_field: field_definitions.key is `custom_<slug>_<id4>`). */
async function addCustomDropdownQuestion(form: SeededForm): Promise<string> {
  const fieldId = `fld-${crypto.randomUUID()}`;
  const key = `custom_audience_level_${fieldId.slice(0, 4)}`;
  const options = JSON.stringify([
    { value: 'Beginner', label: 'Beginner' },
    { value: 'Intermediate', label: 'Intermediate' },
    { value: 'Advanced', label: 'Advanced' },
  ]);
  await env.DB.prepare(
    `INSERT INTO field_definitions (id, event_id, key, label, type, scope, options, system)
     VALUES (?, ?, ?, 'Audience level', 'dropdown', 'submission', ?, 0)`,
  )
    .bind(fieldId, form.eventId, key, options)
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

describe('GET /submit/:slug/:formId: custom-keyed dropdown question', () => {
  it('includes the field with its options in the SSR bootstrap payload', async () => {
    const form = await seedForm();
    const questionId = await addCustomDropdownQuestion(form);

    const res = await SELF.fetch(`https://example.com${form.basePath}`, {
      headers: { cookie: form.cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    const match = html.match(/<script[^>]*id="bootstrap"[^>]*>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const bootstrap = JSON.parse(match![1]!) as { questions: Array<Record<string, unknown>> };

    const question = bootstrap.questions.find((q) => q.id === questionId);
    expect(question).toBeDefined();
    expect(question!.type).toBe('dropdown');
    expect(question!.label).toBe('Audience level');
    expect(question!.section).toBe('abstract');
    expect(question!.options).toEqual([
      { value: 'Beginner', label: 'Beginner' },
      { value: 'Intermediate', label: 'Intermediate' },
      { value: 'Advanced', label: 'Advanced' },
    ]);
  });
});

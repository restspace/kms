// Regression for a live-site defect that survived the label-based fallback in
// trackAnswers (submit-track-custom-field.test.ts): the deployed AI.Engineer
// CFP form's Track question has field_key === 'track' exactly, so the
// fallback was never the problem — but the answer submit.tsx resolves
// against tracks.name is the option's `value`, not its `label`, and
// SubmitPage.tsx's dropdown control submits `value` (SubmitPage.tsx:847-851).
// The form builder's typed-choices flow happens to set value === label, so
// this was invisible on hand-built forms; an option list where they differ
// (an id/slug-style value with a human label) silently dropped the track —
// submissions.track_id stayed null even though the answer itself round-
// tripped fine (which is why the speaker's own view still showed the track
// name: it reads the raw stored answer, not the resolved column).
//
// Also covers the twin failure mode named in the same investigation:
// incidental whitespace on an option value that should still match the
// track's canonical name.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTrack, seedForm, type SeededForm } from './fixtures-submission';

const post = (form: SeededForm, path: string, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

/** Reshape the seeded form's canonical `track` question into a single-value
 *  dropdown with the given options — matching the live CFP form's Track
 *  question shape (field_key 'track', type 'dropdown', {value,label} options)
 *  more closely than the default multiselect-with-no-options fixture. */
async function setTrackDropdownOptions(
  form: SeededForm,
  options: Array<{ value: string; label: string }>,
): Promise<void> {
  await env.DB.prepare(`UPDATE field_definitions SET type = 'dropdown', options = ? WHERE event_id = ? AND key = 'track'`)
    .bind(JSON.stringify(options), form.eventId)
    .run();
}

describe('submit: Track dropdown option value vs label', () => {
  it('resolves the track when the option value is a slug distinct from its label', async () => {
    const form = await seedForm();
    const trackId = await createTrack(form.eventId, 'Infra & Serving');
    await setTrackDropdownOptions(form, [{ value: 'infra-serving', label: 'Infra & Serving' }]);

    const res = await post(form, '/submit', {
      answers: { [form.questions.title!]: 'Slug value track talk', [form.questions.track!]: 'infra-serving' },
      participants: [{ email: 'submitter@example.com', first_name: 'Sub', last_name: 'Mitter', role: 'speaker' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submission_id: string };

    const row = await env.DB.prepare('SELECT track_id FROM submissions WHERE id = ?')
      .bind(body.submission_id)
      .first<{ track_id: string | null }>();
    expect(row?.track_id).toBe(trackId);

    const joined = await env.DB.prepare('SELECT track_id FROM submission_tracks WHERE submission_id = ?')
      .bind(body.submission_id)
      .all<{ track_id: string }>();
    expect(joined.results.map((r) => r.track_id)).toContain(trackId);
  });

  it('resolves the track when the option value carries incidental whitespace', async () => {
    const form = await seedForm();
    const trackId = await createTrack(form.eventId, 'Infra & Serving');
    await setTrackDropdownOptions(form, [{ value: 'Infra & Serving ', label: 'Infra & Serving' }]);

    const res = await post(form, '/submit', {
      answers: { [form.questions.title!]: 'Whitespace track talk', [form.questions.track!]: 'Infra & Serving ' },
      participants: [{ email: 'submitter@example.com', first_name: 'Sub', last_name: 'Mitter', role: 'speaker' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submission_id: string };

    const row = await env.DB.prepare('SELECT track_id FROM submissions WHERE id = ?')
      .bind(body.submission_id)
      .first<{ track_id: string | null }>();
    expect(row?.track_id).toBe(trackId);
  });

  it('draft autosave then a full-answer final submit still resolves the dropdown-shaped track', async () => {
    // Mirrors the wizard exactly: the account/title step autosaves a draft
    // with only some answers filled in, then the final /submit resends the
    // client's complete accumulated `answers` state (SubmitPage.tsx's
    // answersRef.current) including the track — this must not depend on
    // systemColumns() (which never touches track at all) or on any
    // "only changed answers" shortcut.
    const form = await seedForm();
    const trackId = await createTrack(form.eventId, 'Infra & Serving');
    await setTrackDropdownOptions(form, [{ value: 'Infra & Serving', label: 'Infra & Serving' }]);

    const draftRes = await post(form, '/draft', {
      submission_id: null,
      answers: { [form.questions.title!]: 'Draft then promote' },
    });
    expect(draftRes.status).toBe(200);
    const draftBody = (await draftRes.json()) as { submission_id: string };

    const fullAnswers = {
      [form.questions.title!]: 'Draft then promote',
      [form.questions.track!]: 'Infra & Serving',
    };
    await post(form, '/draft', { submission_id: draftBody.submission_id, answers: fullAnswers });

    const res = await post(form, '/submit', {
      submission_id: draftBody.submission_id,
      answers: fullAnswers,
      participants: [{ email: 'submitter@example.com', first_name: 'Sub', last_name: 'Mitter', role: 'speaker' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submission_id: string };

    const row = await env.DB.prepare('SELECT track_id FROM submissions WHERE id = ?')
      .bind(body.submission_id)
      .first<{ track_id: string | null }>();
    expect(row?.track_id).toBe(trackId);
  });
});

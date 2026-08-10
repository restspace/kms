// Regression for the live-reproduced CFP defect: a submitter picked
// "Infra & Serving" on the public form, and the organiser's detail page showed
// "Agents" — the first seeded track — instead.
//
// Root cause was the primary-track precedence in submit.tsx:
//
//   primaryTrackId = routedTrackId ?? existing?.track_id ?? resolvedTrackIds[0]
//
// documented as "primary track is sticky". The wizard autosaves a draft before
// Submit runs, and (without allow_multiple_drafts) that autosave *reuses* the
// submitter's existing open draft rather than creating a new row. The draft
// path never writes track_id, so whatever track the reused row already carried
// won — pinning every submission to that stale track no matter what the
// submitter chose, and making a track edit on an existing submission
// impossible to save.
//
// The answer the submitter actually gave is now the authority; the existing
// column only survives when this request resolved no track at all.

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

describe('submit: the submitted track beats a track already on the row', () => {
  it('a submission whose row already carries a track adopts the newly answered one', async () => {
    const form = await seedForm();
    const agents = await createTrack(form.eventId, 'Agents');
    const infra = await createTrack(form.eventId, 'Infra & Serving');

    // A draft exists and already carries the wrong track — exactly the state
    // the live demo's seeded draft was in when the defect was reproduced.
    const draftRes = await post(form, '/draft', {
      answers: { [form.questions.title!]: 'Sticky track talk' },
    });
    expect(draftRes.status).toBe(200);
    const { submission_id: draftId } = (await draftRes.json()) as { submission_id: string };
    await env.DB.prepare('UPDATE submissions SET track_id = ? WHERE id = ?').bind(agents, draftId).run();

    const res = await post(form, '/submit', {
      submission_id: draftId,
      answers: {
        [form.questions.title!]: 'Sticky track talk',
        [form.questions.track!]: ['Infra & Serving'],
      },
      participants,
    });
    expect(res.status).toBe(200);

    expect((await trackOf(draftId))?.track_id).toBe(infra);
  });

  it('a track already on the row survives a submit that answers no track at all', async () => {
    const form = await seedForm();
    const agents = await createTrack(form.eventId, 'Agents');

    const draftRes = await post(form, '/draft', {
      answers: { [form.questions.title!]: 'No track answer talk' },
    });
    const { submission_id: draftId } = (await draftRes.json()) as { submission_id: string };
    await env.DB.prepare('UPDATE submissions SET track_id = ? WHERE id = ?').bind(agents, draftId).run();

    const res = await post(form, '/submit', {
      submission_id: draftId,
      answers: { [form.questions.title!]: 'No track answer talk' },
      participants,
    });
    expect(res.status).toBe(200);

    expect((await trackOf(draftId))?.track_id).toBe(agents);
  });
});

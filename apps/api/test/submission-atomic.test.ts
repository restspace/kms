// Acceptance for the atomic submission batch (sweep item P0-1). Miniflare's
// D1 serializes writes, so "concurrency" here means the *logical* outcome the
// fix guarantees: exactly one winner, never a partial write, never a duplicate
// code — which is precisely what the single db.batch buys.

import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { countRows, createTrack, seedForm, submitBody, submitBodyV2, type SeededForm } from './fixtures-submission';

const post = (form: SeededForm, path: string, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

const submissionCount = (formId: string) =>
  countRows('SELECT COUNT(*) AS n FROM submissions WHERE form_id = ?', formId);

afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS test_fail_answers').run();
});

describe('POST /submit/:slug/:formId/submit', () => {
  it('collapses an identical double-submit into one row and one queued email', async () => {
    const form = await seedForm();
    const draft = (await (await post(form, '/draft', { answers: {} })).json()) as { submission_id: string };

    const [a, b] = await Promise.all([
      post(form, '/submit', { ...submitBody(form), submission_id: draft.submission_id }),
      post(form, '/submit', { ...submitBody(form), submission_id: draft.submission_id }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const bodies = (await Promise.all([a.json(), b.json()])) as Array<{ code: string; submission_id: string }>;
    expect(bodies[0]!.submission_id).toBe(bodies[1]!.submission_id);
    expect(bodies[0]!.code).toBe(bodies[1]!.code);

    expect(await submissionCount(form.formId)).toBe(1);
    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM message_log WHERE template_key = 'submission_confirmation' AND event_id = ?`,
        form.eventId,
      ),
    ).toBe(1);
  });

  it('treats a retry with no submission_id but identical content as the same submission', async () => {
    const form = await seedForm();
    const first = await post(form, '/submit', submitBody(form, 'Same talk'));
    const retry = await post(form, '/submit', submitBody(form, 'Same talk'));
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);

    const firstBody = (await first.json()) as { submission_id: string };
    const retryBody = (await retry.json()) as { submission_id: string; replayed?: boolean };
    expect(retryBody.submission_id).toBe(firstBody.submission_id);
    expect(retryBody.replayed).toBe(true);
    expect(await submissionCount(form.formId)).toBe(1);
  });

  it('still creates a second row for genuinely different content', async () => {
    const form = await seedForm();
    expect((await post(form, '/submit', submitBody(form, 'Talk one'))).status).toBe(200);
    expect((await post(form, '/submit', submitBody(form, 'Talk two'))).status).toBe(200);

    expect(await submissionCount(form.formId)).toBe(2);
    const { results } = await env.DB.prepare('SELECT title, code FROM submissions WHERE form_id = ? ORDER BY code')
      .bind(form.formId)
      .all<{ title: string; code: string }>();
    expect(results.map((r) => r.title)).toEqual(['Talk one', 'Talk two']);
    expect(new Set(results.map((r) => r.code)).size).toBe(2);
  });

  it('never lets a limit of N yield N+1 rows', async () => {
    const form = await seedForm({ submissionLimit: 1 });
    const responses = await Promise.all([
      post(form, '/submit', submitBody(form, 'One')),
      post(form, '/submit', submitBody(form, 'Two')),
    ]);
    expect(await submissionCount(form.formId)).toBe(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const rejected = responses.find((r) => r.status !== 200)!;
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: 'limit_reached' });
  });

  it('allocates unique sequential codes to parallel creates', async () => {
    const form = await seedForm({ submissionLimit: null });
    const responses = await Promise.all([
      post(form, '/submit', submitBody(form, 'Alpha')),
      post(form, '/submit', submitBody(form, 'Beta')),
      post(form, '/submit', submitBody(form, 'Gamma')),
    ]);
    for (const res of responses) expect(res.status).toBe(200);

    const { results } = await env.DB.prepare('SELECT code FROM submissions WHERE form_id = ? ORDER BY code')
      .bind(form.formId)
      .all<{ code: string }>();
    const codes = results.map((r) => r.code);
    expect(new Set(codes).size).toBe(3);
    expect([...codes].sort()).toEqual(['SESS-1', 'SESS-2', 'SESS-3']);
  });

  it('leaves zero rows behind when a child statement fails (batch rollback)', async () => {
    const form = await seedForm();
    await env.DB.prepare(
      "CREATE TRIGGER test_fail_answers BEFORE INSERT ON submission_answers BEGIN SELECT RAISE(ABORT, 'boom'); END",
    ).run();

    const res = await post(form, '/submit', submitBody(form, 'Doomed'));
    expect(res.status).toBeGreaterThanOrEqual(500);

    expect(await submissionCount(form.formId)).toBe(0);
    expect(await countRows('SELECT COUNT(*) AS n FROM auth_tokens WHERE event_id = ?', form.eventId)).toBe(0);
    expect(await countRows('SELECT COUNT(*) AS n FROM message_log WHERE event_id = ?', form.eventId)).toBe(0);
    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM contacts WHERE event_id = ? AND email = 'submitter@example.com'`,
        form.eventId,
      ),
    ).toBe(1); // the submitter's pre-existing row, nothing new
  });

  it('accepts the frozen participant payload and persists the full answer map', async () => {
    const form = await seedForm();
    const res = await post(form, '/submit', submitBodyV2(form, 'Modern shape'));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT sp.answers_json, sp.role, sp.is_primary_contact FROM submission_participants sp
       JOIN submissions s ON s.id = sp.submission_id WHERE s.form_id = ?`,
    )
      .bind(form.formId)
      .first<{ answers_json: string; role: string; is_primary_contact: number }>();
    expect(row?.role).toBe('speaker');
    expect(row?.is_primary_contact).toBe(1);
    const answers = JSON.parse(row!.answers_json) as Record<string, unknown>;
    expect(answers[form.questions.first_name!]).toBe('Sub');
    expect(answers[form.questions.email!]).toBe('submitter@example.com');
  });

  it('rejects more participants than the overall cap', async () => {
    const form = await seedForm();
    const participants = Array.from({ length: 12 }, (_, i) => ({
      role: 'speaker',
      is_primary_contact: false,
      answers: {
        [form.questions.first_name!]: `First${i}`,
        [form.questions.last_name!]: `Last${i}`,
        [form.questions.email!]: `p${i}@example.com`,
      },
    }));
    const res = await post(form, '/submit', { answers: { [form.questions.title!]: 'Crowded' }, participants });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'participants_invalid' });
    expect(await submissionCount(form.formId)).toBe(0);
  });

  it('writes every selected track to submission_tracks, primary track first', async () => {
    const form = await seedForm({ trackOptions: ['Platform', 'People'] });
    const platform = await createTrack(form.eventId, 'Platform');
    const people = await createTrack(form.eventId, 'People');

    const res = await post(form, '/submit', {
      answers: { [form.questions.title!]: 'Multi', [form.questions.track!]: ['Platform', 'People'] },
      participants: submitBody(form).participants,
    });
    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare(
      `SELECT st.track_id FROM submission_tracks st
       JOIN submissions s ON s.id = st.submission_id WHERE s.form_id = ?`,
    )
      .bind(form.formId)
      .all<{ track_id: string }>();
    expect(new Set(results.map((r) => r.track_id))).toEqual(new Set([platform, people]));

    const primary = await env.DB.prepare('SELECT track_id FROM submissions WHERE form_id = ?')
      .bind(form.formId)
      .first<{ track_id: string }>();
    expect(primary?.track_id).toBe(platform);
  });
});

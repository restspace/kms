// 2026-08-12 eval-sweep defects around the public CFP wizard:
//
//  1. Resuming a seeded/imported draft (system columns only, no
//     submission_answers rows) loaded an entirely empty form, and the next
//     autosave then destroyed the stored draft content. The bootstrap now
//     synthesizes the draft's answers from its columns, and an all-empty
//     autosave over an existing draft is a guarded no-op.
//  4. The advertised submission limit was not enforced consistently: a
//     second, content-identical proposal was answered with the replay
//     success instead of limit_reached. The limit check now runs before the
//     content-replay lookup.
//  3. A never-filled "+ Add participant" slot dead-ended the submission with
//     participants_invalid; and a collect-participants form with no
//     configured name/email participant questions could never identify any
//     added participant. Empty slots are now ignored, and flat identity
//     fields on the modern payload shape are lifted when no configured
//     question carries them.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { countRows, createTrack, seedForm, submitBodyV2, type SeededForm } from './fixtures-submission';

const getWizard = (form: SeededForm) =>
  SELF.fetch(`https://example.com${form.basePath}`, { headers: { cookie: form.cookie } });

const postJson = (form: SeededForm, path: 'draft' | 'submit', body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

/** The SSR'd wizard page's #bootstrap JSON island. */
async function bootstrapOf(form: SeededForm): Promise<Record<string, any>> {
  const html = await (await getWizard(form)).text();
  const match = /<script[^>]*id="bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, any>;
}

async function seedColumnOnlyDraft(form: SeededForm, trackId: string | null = null): Promise<string> {
  const id = `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, form_id, code, kind, title, description, status,
       track_id, submitter_contact_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'SESS-77', 'abstract', 'Streaming Function Calls', '<p>Draft body.</p>', 'draft',
       ?, ?, 'form', '2026-08-07T18:30:00Z', '2026-08-07T18:30:00Z')`,
  )
    .bind(id, form.eventId, form.formId, trackId, form.submitterId)
    .run();
  return id;
}

describe('resume of a seeded draft (defect 1)', () => {
  it('bootstraps the draft answers from system columns when no answer rows exist', async () => {
    const form = await seedForm();
    const trackId = await createTrack(form.eventId, 'Infra & Serving');
    await seedColumnOnlyDraft(form, trackId);

    const bootstrap = await bootstrapOf(form);
    const draft = bootstrap.viewer?.draft;
    expect(draft).toBeTruthy();
    expect(draft.title).toBe('Streaming Function Calls');
    expect(draft.answers[form.questions.title!]).toBe('Streaming Function Calls');
    expect(draft.answers[form.questions.description!]).toBe('<p>Draft body.</p>');
    // The fixtures' track question is a multiselect with derived options
    // (keyed by track id) — the column re-hydrates as [id] so the picker
    // actually selects it.
    expect(draft.answers[form.questions.track!]).toEqual([trackId]);
  });

  it('a draft saved through the wizard hydrates its stored track label back to the option id', async () => {
    const form = await seedForm();
    const trackId = await createTrack(form.eventId, 'Evals');
    const saved = await postJson(form, 'draft', {
      answers: { [form.questions.title!]: 'Judge calibration', [form.questions.track!]: [trackId] },
    });
    expect(saved.status).toBe(200);

    // Stored as the display label…
    const { submission_id } = (await saved.json()) as { submission_id: string };
    const row = await env.DB.prepare(
      'SELECT value_json FROM submission_answers WHERE submission_id = ? AND question_id = ?',
    )
      .bind(submission_id, form.questions.track!)
      .first<{ value_json: string }>();
    expect(JSON.parse(row!.value_json)).toEqual(['Evals']);

    // …but bootstrapped back as the option value the picker needs.
    const bootstrap = await bootstrapOf(form);
    expect(bootstrap.viewer.draft.answers[form.questions.track!]).toEqual([trackId]);
  });

  it('an all-empty autosave never clobbers a non-empty stored draft', async () => {
    const form = await seedForm();
    const draftId = await seedColumnOnlyDraft(form);

    // The pre-hydration failure mode: autosave fires with the empty form
    // state (no submission_id — the client had not adopted the draft yet, so
    // the endpoint's reuse-latest-draft lookup resolves to the seeded row).
    const res = await postJson(form, 'draft', { answers: {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { submission_id: string }).submission_id).toBe(draftId);

    const row = await env.DB.prepare('SELECT title, description FROM submissions WHERE id = ?')
      .bind(draftId)
      .first<{ title: string; description: string | null }>();
    expect(row!.title).toBe('Streaming Function Calls');
    expect(row!.description).toBe('<p>Draft body.</p>');

    // A save that actually says something still writes.
    const real = await postJson(form, 'draft', {
      submission_id: draftId,
      answers: { [form.questions.title!]: 'Streaming Function Calls v2' },
    });
    expect(real.status).toBe(200);
    expect((await env.DB.prepare('SELECT title FROM submissions WHERE id = ?').bind(draftId).first<{ title: string }>())!.title).toBe(
      'Streaming Function Calls v2',
    );
  });
});

describe('submission limit at submit time (defect 4)', () => {
  it('a second, content-identical proposal is refused with limit_reached, not replayed as a success', async () => {
    const form = await seedForm({ submissionLimit: 1 });

    const first = await postJson(form, 'submit', submitBodyV2(form, 'LLMs on the Edge'));
    expect(first.status).toBe(200);

    const second = await postJson(form, 'submit', submitBodyV2(form, 'LLMs on the Edge'));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe('limit_reached');

    expect(await countRows(`SELECT COUNT(*) AS n FROM submissions WHERE form_id = ? AND status != 'withdrawn'`, form.formId)).toBe(1);
  });

  it('a retried draft promotion (same submission_id) still replays instead of erroring', async () => {
    const form = await seedForm({ submissionLimit: 1 });
    const draft = await postJson(form, 'draft', { answers: { [form.questions.title!]: 'Promoted talk' } });
    const draftId = ((await draft.json()) as { submission_id: string }).submission_id;

    const body = { ...submitBodyV2(form, 'Promoted talk'), submission_id: draftId };
    const first = await postJson(form, 'submit', body);
    expect(first.status).toBe(200);

    const retry = await postJson(form, 'submit', body);
    expect(retry.status).toBe(200);
    const parsed = (await retry.json()) as { replayed?: boolean; submission_id: string };
    expect(parsed.replayed).toBe(true);
    expect(parsed.submission_id).toBe(draftId);
  });

  it('under the limit, content-identical retries without an id still replay', async () => {
    const form = await seedForm({ submissionLimit: 5 });
    const first = await postJson(form, 'submit', submitBodyV2(form, 'Same talk'));
    expect(first.status).toBe(200);
    const firstId = ((await first.json()) as { submission_id: string }).submission_id;

    const retry = await postJson(form, 'submit', submitBodyV2(form, 'Same talk'));
    expect(retry.status).toBe(200);
    const parsed = (await retry.json()) as { replayed?: boolean; submission_id: string };
    expect(parsed.replayed).toBe(true);
    expect(parsed.submission_id).toBe(firstId);
  });
});

describe('participant slots (defects 3 and 6)', () => {
  it('a never-filled extra participant slot is ignored, not a participants_invalid dead end', async () => {
    const form = await seedForm();
    const body = submitBodyV2(form, 'Co-authored talk') as { participants: unknown[] };
    body.participants.push({ role: 'speaker', is_primary_contact: false, answers: {} });

    const res = await postJson(form, 'submit', body as unknown);
    expect(res.status).toBe(200);
    const { submission_id } = (await res.json()) as { submission_id: string };
    expect(await countRows('SELECT COUNT(*) AS n FROM submission_participants WHERE submission_id = ?', submission_id)).toBe(1);
  });

  it('flat identity fields on the modern shape are lifted when the form has no matching participant question', async () => {
    const form = await seedForm();
    // A collect-participants form whose participant section was emptied out,
    // with no explicit role config — the widened default vocabulary
    // (defect 6) must let a co-author be labelled as one end to end.
    await env.DB.prepare(`DELETE FROM form_questions WHERE form_id = ? AND section = 'participant'`).bind(form.formId).run();
    await env.DB.prepare(`UPDATE submission_forms SET participant_roles = NULL WHERE id = ?`).bind(form.formId).run();

    const res = await postJson(form, 'submit', {
      answers: { [form.questions.title!]: 'Talk with co-author' },
      participants: [
        { role: 'speaker', is_primary_contact: true, answers: {}, email: 'submitter@example.com', first_name: 'Sub', last_name: 'Mitter' },
        { role: 'co-author', is_primary_contact: false, answers: {}, email: 'coauthor@example.com', first_name: 'Co', last_name: 'Author' },
      ],
    });
    expect(res.status).toBe(200);
    const { submission_id } = (await res.json()) as { submission_id: string };

    const { results } = await env.DB.prepare(
      `SELECT sp.role, c.email FROM submission_participants sp
       JOIN contacts c ON c.id = sp.contact_id
       WHERE sp.submission_id = ? ORDER BY sp.position`,
    )
      .bind(submission_id)
      .all<{ role: string; email: string }>();
    expect(results.map((r) => [r.role, r.email])).toEqual([
      ['speaker', 'submitter@example.com'],
      ['co-author', 'coauthor@example.com'],
    ]);
  });
});

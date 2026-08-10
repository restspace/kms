// ABS defect (major, data loss): "Starting a new public CFP submission
// silently resumed and overwrote an existing unrelated draft under the same
// code ... with no warning." The GET wizard bootstrap used to hand the
// client the submitter's most-recently-updated draft (id + answers), and
// SubmitPage seeded `answers`/`submissionId` from it unconditionally — so the
// very next autosave tick wrote over that draft regardless of what the
// submitter actually meant to do.
//
// The fix keeps the server the single source of truth for "does a resumable
// draft exist" (bootstrap draft, now with a title so the client can show it)
// but requires an explicit `force_new` on POST .../draft to create a second,
// independent draft — the reuse-most-recent-draft lookup is skipped only
// when the caller asks for that. This exercises the server half directly.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { countRows, seedForm, type SeededForm } from './fixtures-submission';

const getWizard = (form: SeededForm) => SELF.fetch(`https://example.com${form.basePath}`, { headers: { cookie: form.cookie } });

const postDraft = (form: SeededForm, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

async function draftTitle(submissionId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT title FROM submissions WHERE id = ?').bind(submissionId).first<{ title: string | null }>();
  return row?.title ?? null;
}

describe('POST /submit/:slug/:formId/draft — start new vs. resume', () => {
  it('the bootstrap draft carries a title so the client can offer "Resume draft <title>"', async () => {
    const form = await seedForm();
    const first = await postDraft(form, { answers: { [form.questions.title!]: 'Streaming Function Calls' } });
    expect(first.status).toBe(200);

    const html = await (await getWizard(form)).text();
    expect(html).toContain('Streaming Function Calls');
  });

  it('without force_new, autosave reuses the existing draft (baseline: single-draft forms never accumulate rows)', async () => {
    const form = await seedForm(); // allow_multiple_drafts defaults to off
    const first = await postDraft(form, { answers: { [form.questions.title!]: 'First draft' } });
    const firstId = ((await first.json()) as { submission_id: string }).submission_id;

    const second = await postDraft(form, { answers: { [form.questions.title!]: 'First draft, edited' } });
    const secondId = ((await second.json()) as { submission_id: string }).submission_id;

    expect(secondId).toBe(firstId);
    expect(await countRows('SELECT COUNT(*) AS n FROM submissions WHERE form_id = ?', form.formId)).toBe(1);
  });

  it('force_new creates a genuinely separate draft, leaving the original untouched', async () => {
    const form = await seedForm();
    const original = await postDraft(form, { answers: { [form.questions.title!]: 'Streaming Function Calls' } });
    const originalId = ((await original.json()) as { submission_id: string }).submission_id;

    const started = await postDraft(form, { answers: {}, force_new: true });
    expect(started.status).toBe(200);
    const newId = ((await started.json()) as { submission_id: string }).submission_id;

    expect(newId).not.toBe(originalId);
    expect(await countRows('SELECT COUNT(*) AS n FROM submissions WHERE form_id = ?', form.formId)).toBe(2);
    // The original draft's title survives untouched — this is the exact
    // "SESS-10, previously 'Streaming Function Calls...'" scenario from the
    // eval report.
    expect(await draftTitle(originalId)).toBe('Streaming Function Calls');

    // Autosaving the new draft (still without submission_id — the client
    // only learns the new id from THIS response) must not fall back onto
    // reusing the original draft again.
    const editNew = await postDraft(form, { submission_id: newId, answers: { [form.questions.title!]: 'A brand new talk' } });
    expect(((await editNew.json()) as { submission_id: string }).submission_id).toBe(newId);
    expect(await draftTitle(originalId)).toBe('Streaming Function Calls');
    expect(await draftTitle(newId)).toBe('A brand new talk');
  });

  it('force_new still respects the submission limit, with a clear error', async () => {
    const form = await seedForm({ submissionLimit: 1 });
    const original = await postDraft(form, { answers: { [form.questions.title!]: 'Only slot' } });
    expect(original.status).toBe(200);

    const res = await postDraft(form, { answers: {}, force_new: true });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('limit_reached');

    // No second row was created.
    expect(await countRows('SELECT COUNT(*) AS n FROM submissions WHERE form_id = ?', form.formId)).toBe(1);
  });

  it('force_new on a form that allows multiple drafts behaves the same as the normal create path', async () => {
    const form = await seedForm({ collectParticipants: false });
    await env.DB.prepare(`UPDATE submission_forms SET allow_multiple_drafts = 1 WHERE id = ?`).bind(form.formId).run();

    const a = await postDraft(form, { answers: { [form.questions.title!]: 'Talk A' } });
    const b = await postDraft(form, { answers: { [form.questions.title!]: 'Talk B' }, force_new: true });
    const idA = ((await a.json()) as { submission_id: string }).submission_id;
    const idB = ((await b.json()) as { submission_id: string }).submission_id;
    expect(idA).not.toBe(idB);
    expect(await countRows('SELECT COUNT(*) AS n FROM submissions WHERE form_id = ?', form.formId)).toBe(2);
  });
});

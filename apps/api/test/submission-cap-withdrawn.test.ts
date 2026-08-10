// ABS defect (minor): "the per-user submission cap counts drafts and
// withdrawn submissions ... blocked from starting a new proposal at 3 even
// though it had withdrawn two." docs/02-domain-model.md §"Submissions per
// submitter per form <= submission_limit. Checked on create, including
// drafts" — drafts DO count (spec is explicit), but nothing says withdrawn
// should. submit.tsx's countForLimit() already filters `status != 'withdrawn'`
// on every call site (draft autosave, submit, force_new) — this locks that
// behaviour in with a test that mirrors the eval's exact scenario, and checks
// the limit_reached body now explains what counts.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedForm, submitBodyV2, type SeededForm } from './fixtures-submission';

const postDraft = (form: SeededForm, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

const postSubmit = (form: SeededForm, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

async function withdraw(formId: string, submissionId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE submissions SET status = 'withdrawn', updated_at = ? WHERE id = ? AND form_id = ?`,
  )
    .bind(new Date().toISOString(), submissionId, formId)
    .run();
}

describe('submission cap excludes withdrawn submissions', () => {
  it('withdrawing frees up a slot: 3 submitted, 2 withdrawn, a new draft is allowed', async () => {
    const form = await seedForm({ submissionLimit: 3 });

    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await postSubmit(form, submitBodyV2(form, `Talk ${i}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { submission_id: string };
      ids.push(body.submission_id);
    }

    // At the cap: a 4th would be rejected.
    const blocked = await postDraft(form, { answers: {}, force_new: true });
    expect(blocked.status).toBe(409);

    // Withdraw two of the three.
    await withdraw(form.formId, ids[0]!);
    await withdraw(form.formId, ids[1]!);

    // Now only 1 active submission counts toward the limit of 3 — starting a
    // new draft must succeed, exactly the case the eval hit.
    const started = await postDraft(form, { answers: {}, force_new: true });
    expect(started.status).toBe(200);
  });

  it('drafts still count toward the limit (docs/02: "Checked on create, including drafts")', async () => {
    const form = await seedForm({ submissionLimit: 1 });
    const first = await postDraft(form, { answers: { [form.questions.title!]: 'Only slot' } });
    expect(first.status).toBe(200);

    const second = await postDraft(form, { answers: {}, force_new: true });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string; message?: string };
    expect(body.error).toBe('limit_reached');
    // The message should explain what counts toward the limit.
    expect(body.message).toMatch(/draft/i);
    expect(body.message).toMatch(/withdrawn/i);
  });
});

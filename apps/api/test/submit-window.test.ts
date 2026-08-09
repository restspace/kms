// Submission-window enforcement (eval CFP-04/CFP-16): the dashboard already
// labels a form "closed · closes Jul 31, 2026", but that label was never
// backed by a server-side check across every write path. This exercises the
// close-date/status gate directly — for the SSR wizard, the account, draft
// and atomic submit endpoints, plus a close_at that has not yet elapsed
// staying fully open.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedForm, submitBody, type SeededForm } from './fixtures-submission';

const getWizard = (form: SeededForm) => SELF.fetch(`https://example.com${form.basePath}`, { headers: { cookie: form.cookie } });

const postJson = (form: SeededForm, path: string, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

async function close(form: SeededForm, mode: 'status' | 'past_close_at' | 'future_close_at' = 'status') {
  if (mode === 'status') {
    await env.DB.prepare(`UPDATE submission_forms SET status = 'closed' WHERE id = ?`).bind(form.formId).run();
  } else if (mode === 'past_close_at') {
    await env.DB.prepare(`UPDATE submission_forms SET close_at = '2020-01-01T00:00:00Z' WHERE id = ?`)
      .bind(form.formId)
      .run();
  } else {
    await env.DB.prepare(`UPDATE submission_forms SET close_at = '2099-01-01T00:00:00Z' WHERE id = ?`)
      .bind(form.formId)
      .run();
  }
}

describe('submission window enforcement', () => {
  it('GET wizard renders a closed state (not the live wizard) once status=closed', async () => {
    const form = await seedForm();
    await close(form, 'status');
    const res = await getWizard(form);
    expect(res.status).toBe(200); // the closed notice is a 200 SSR page, not a 404/redirect
    const html = await res.text();
    expect(html).toContain('"closed":true');
  });

  it('GET wizard renders a closed state once close_at has elapsed', async () => {
    const form = await seedForm();
    await close(form, 'past_close_at');
    const html = await (await getWizard(form)).text();
    expect(html).toContain('"closed":true');
  });

  it('GET wizard stays open while close_at is in the future', async () => {
    const form = await seedForm();
    await close(form, 'future_close_at');
    const html = await (await getWizard(form)).text();
    expect(html).toContain('"closed":false');
  });

  it.each(['status', 'past_close_at'] as const)('rejects a new draft once closed (%s)', async (mode) => {
    const form = await seedForm();
    await close(form, mode);
    const res = await postJson(form, '/draft', { answers: {} });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('form_closed');
  });

  it.each(['status', 'past_close_at'] as const)('rejects the atomic submit endpoint once closed (%s)', async (mode) => {
    const form = await seedForm();
    await close(form, mode);
    const res = await postJson(form, '/submit', submitBody(form));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('form_closed');

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE form_id = ?')
      .bind(form.formId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it.each(['status', 'past_close_at'] as const)('rejects the account endpoint once closed (%s)', async (mode) => {
    const form = await seedForm();
    await close(form, mode);
    const res = await SELF.fetch(`https://example.com${form.basePath}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'toolate@example.com' }),
    });
    expect(res.status).toBe(409);
  });

  it('still accepts a new submission while close_at is in the future', async () => {
    const form = await seedForm();
    await close(form, 'future_close_at');
    const res = await postJson(form, '/submit', submitBody(form, 'Still in the window'));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE form_id = ? AND title = ?')
      .bind(form.formId, 'Still in the window')
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('accepts a new submission on an open form with no close_at set at all', async () => {
    const form = await seedForm();
    const res = await postJson(form, '/submit', submitBody(form, 'Wide open'));
    expect(res.status).toBe(200);
  });
});

// The canonical Format question's options are the event's `formats` rows,
// derived on every load (formsAdmin.ts FORMAT_FIELD_KEY) — the same rule
// migration 0013 established for Track, applied by 0032 to Format.
//
// One deliberate difference from track derivation: there is no format_id
// column to resolve into. submissions.format stores the display name and
// every read surface (portal, embeds, exports, REST) consumes that string, so
// derived options are keyed by name (`value === label`) and the submitted
// value lands verbatim in the column.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createFormat, seedForm, type SeededForm } from './fixtures-submission';

const post = (form: SeededForm, path: string, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

const participants = [
  { email: 'submitter@example.com', first_name: 'Sub', last_name: 'Mitter', role: 'speaker' },
];

const renderForm = async (form: SeededForm): Promise<string> => {
  const res = await SELF.fetch(`https://example.com${form.basePath}`, { headers: { cookie: form.cookie } });
  expect(res.status).toBe(200);
  return res.text();
};

describe('submit: Format options derive from the event formats', () => {
  it('offers the event formats, and follows a rename without touching the form', async () => {
    const form = await seedForm();
    const talk = await createFormat(form.eventId, 'Talk (30 min)');

    expect(await renderForm(form)).toContain('Talk (30 min)');

    await env.DB.prepare('UPDATE formats SET name = ? WHERE id = ?').bind('Session (30 min)', talk).run();

    const after = await renderForm(form);
    expect(after).toContain('Session (30 min)');
    expect(after).not.toContain('Talk (30 min)');
  });

  it('a submitted format lands verbatim in submissions.format', async () => {
    const form = await seedForm();
    await createFormat(form.eventId, 'Talk (30 min)', 0);
    await createFormat(form.eventId, 'Workshop (120 min)', 1);

    const res = await post(form, '/submit', {
      answers: {
        [form.questions.title!]: 'Name-keyed format talk',
        [form.questions.format!]: 'Workshop (120 min)',
      },
      participants,
    });
    expect(res.status).toBe(200);
    const { submission_id } = (await res.json()) as { submission_id: string };

    const row = await env.DB.prepare('SELECT format FROM submissions WHERE id = ?')
      .bind(submission_id)
      .first<{ format: string | null }>();
    expect(row?.format).toBe('Workshop (120 min)');
  });

  it('a form with authored format options keeps them (derivation only fills empty)', async () => {
    const form = await seedForm();
    await createFormat(form.eventId, 'Talk (30 min)');
    // Author options directly on the question — the COALESCE(q.options,
    // f.options) path must win over derivation.
    await env.DB.prepare('UPDATE form_questions SET options = ? WHERE id = ?')
      .bind(JSON.stringify([{ value: 'Custom Format', label: 'Custom Format' }]), form.questions.format!)
      .run();

    const html = await renderForm(form);
    expect(html).toContain('Custom Format');
    expect(html).not.toContain('Talk (30 min)');
  });

  it('drops a deleted format from the options instead of offering a dead name', async () => {
    const form = await seedForm();
    const doomed = await createFormat(form.eventId, 'Temporary Format');
    expect(await renderForm(form)).toContain('Temporary Format');

    await env.DB.prepare('DELETE FROM formats WHERE id = ?').bind(doomed).run();
    expect(await renderForm(form)).not.toContain('Temporary Format');
  });
});

// Item 3 (O4 lane) probe: does a public-form answer to a `level` question
// actually land in submissions.level, and does the admin submissions list
// (which SubmissionEditForm reads its initialValues from) come back with it?
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedForm, submitBodyV2 } from './fixtures-submission';

async function addLevelQuestion(formId: string, eventId: string): Promise<string> {
  const fieldId = `fld-level-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO field_definitions (id, event_id, key, label, type, scope, options, system)
     VALUES (?, ?, 'level', 'Level', 'dropdown', 'submission',
       '[{"value":"Beginner","label":"Beginner"},{"value":"Advanced","label":"Advanced"}]', 0)`,
  )
    .bind(fieldId, eventId)
    .run();
  const qid = `q-level-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO form_questions (id, form_id, section, field_id, position, required, locked)
     VALUES (?, ?, 'abstract', ?, 99, 0, 0)`,
  )
    .bind(qid, formId, fieldId)
    .run();
  return qid;
}

describe('submit -> submissions.level mapping', () => {
  it('a level answer on the public form ends up in submissions.level, not just answers', async () => {
    const form = await seedForm();
    const levelQid = await addLevelQuestion(form.formId, form.eventId);

    const body = submitBodyV2(form, 'Level mapping test talk');
    (body.answers as Record<string, unknown>)[levelQid] = 'Advanced';

    const res = await SELF.fetch(`https://kms.test${form.basePath}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: form.cookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT level FROM submissions WHERE form_id = ? AND title = 'Level mapping test talk'`,
    )
      .bind(form.formId)
      .first<{ level: string | null }>();
    expect(row?.level).toBe('Advanced');
  });
});

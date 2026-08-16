// Routing's `add_tag_ids` on the SUBMIT path, which nothing covered: the
// existing routing tests exercise the rule engine (packages/core) and the
// re-route path, but not the one hop between them — a rule firing at first
// submit and its tag actually reaching submission_tags.
//
// Mirrors the shape the demo event uses in production: a canonical Format
// question whose options derive from the event's `formats` rows, and a rule
// keyed on `equals "Workshop"`.

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

async function createTag(eventId: string, name: string): Promise<string> {
  const id = `tag-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO tags (id, event_id, name) VALUES (?, ?, ?)').bind(id, eventId, name).run();
  return id;
}

async function tagsOf(submissionId: string): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT tag_id FROM submission_tags WHERE submission_id = ?')
    .bind(submissionId)
    .all<{ tag_id: string }>();
  return results.map((r) => r.tag_id);
}

async function seedWorkshopRouting(): Promise<{ form: SeededForm; tagId: string }> {
  const form = await seedForm();
  await createFormat(form.eventId, 'Talk', 0);
  await createFormat(form.eventId, 'Workshop', 1);
  const tagId = await createTag(form.eventId, 'Production');
  await env.DB.prepare('UPDATE submission_forms SET routing_rules = ? WHERE id = ?')
    .bind(
      JSON.stringify({
        rules: [
          {
            id: 'r-workshops',
            when: { question_id: form.questions.format, op: 'equals', value: 'Workshop' },
            then: { add_tag_ids: [tagId] },
          },
        ],
      }),
      form.formId,
    )
    .run();
  return { form, tagId };
}

describe('submit: routing tags', () => {
  it('attaches the tag a matching rule asks for', async () => {
    const { form, tagId } = await seedWorkshopRouting();

    const res = await post(form, '/submit', {
      answers: { [form.questions.title!]: 'A workshop', [form.questions.format!]: 'Workshop' },
      participants,
    });
    expect(res.status).toBe(200);
    const { submission_id } = (await res.json()) as { submission_id: string };

    expect(await tagsOf(submission_id)).toEqual([tagId]);
  });

  it('attaches nothing when no rule matches', async () => {
    const { form } = await seedWorkshopRouting();

    const res = await post(form, '/submit', {
      answers: { [form.questions.title!]: 'A talk', [form.questions.format!]: 'Talk' },
      participants,
    });
    const { submission_id } = (await res.json()) as { submission_id: string };

    expect(await tagsOf(submission_id)).toEqual([]);
  });

  it('records the tag as routing-owned, so a later re-route can move it', async () => {
    const { form, tagId } = await seedWorkshopRouting();

    const res = await post(form, '/submit', {
      answers: { [form.questions.title!]: 'A workshop', [form.questions.format!]: 'Workshop' },
      participants,
    });
    const { submission_id } = (await res.json()) as { submission_id: string };

    const row = await env.DB.prepare('SELECT routing_state FROM submissions WHERE id = ?')
      .bind(submission_id)
      .first<{ routing_state: string | null }>();
    expect(row!.routing_state).not.toBeNull();
    const state = JSON.parse(row!.routing_state!) as { applied_rule_ids: string[]; set: { tag_ids: string[] } };
    expect(state.applied_rule_ids).toEqual(['r-workshops']);
    expect(state.set.tag_ids).toEqual([tagId]);
  });

  it('also attaches a routing tag when the submission is promoted from a draft', async () => {
    const { form, tagId } = await seedWorkshopRouting();

    const draft = await post(form, '/draft', {
      answers: { [form.questions.title!]: 'A workshop', [form.questions.format!]: 'Workshop' },
      participants,
    });
    expect(draft.status).toBe(200);

    const res = await post(form, '/submit', {
      answers: { [form.questions.title!]: 'A workshop', [form.questions.format!]: 'Workshop' },
      participants,
    });
    expect(res.status).toBe(200);
    const { submission_id } = (await res.json()) as { submission_id: string };

    expect(await tagsOf(submission_id)).toEqual([tagId]);
  });
});

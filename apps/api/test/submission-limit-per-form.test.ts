// Live-eval defect: "the public form showed 'Submission limit: 1 per user' yet
// a speaker with 3 existing submissions created a 4th successfully." docs/04
// §5 step 1 ("Submission Limit: 3 submissions per user") and §6 acceptance
// test 6 ("A form with a submission limit of 1 blocks the second submission")
// both describe the cap as applying to ONE form (docs/02 §9: "Submissions
// per submitter per form <= submission_limit"), and docs/04 §2.5's "Event
// max: 3" chip is explicitly a per-form fallback ("Applies when no form-level
// limit is set"), not a pooled event-wide cap.
//
// This locks in two things: (1) the literal "3 existing -> 4th attempt" replay
// via the authoritative /submit endpoint (not just /draft) is blocked on the
// SAME form, and (2) a submitter who is already at a DIFFERENT form's limit
// is correctly still allowed their first submission to a second form — the
// eval's "created a 4th successfully" was a speaker at their form-1 cap
// submitting to an independent form-2, which the stated per-form rule says
// should succeed, not a missed 409.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedForm, submitBodyV2, type SeededForm } from './fixtures-submission';

const postSubmit = (form: SeededForm, body: unknown) =>
  SELF.fetch(`https://example.com${form.basePath}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: form.cookie },
    body: JSON.stringify(body),
  });

/** A second form on the same event, sharing the first form's submitter/cookie
 *  identity — the fixture helper only seeds one form per call, so the second
 *  form's rows are added directly against the same event_id. */
async function seedSecondForm(base: SeededForm, submissionLimit: number | null): Promise<SeededForm> {
  const ts = '2026-08-01T00:00:00Z';
  const formId = `form-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submission_forms (id, event_id, internal_name, external_title, page_heading,
       collection_type, collect_participants, status, submission_limit, participant_roles,
       confirmation_email_enabled, created_at, updated_at)
     VALUES (?, ?, 'CFP 2', 'CFP 2', 'Submit', 'abstracts', 1, 'open', ?, ?, 1, ?, ?)`,
  )
    .bind(formId, base.eventId, submissionLimit, JSON.stringify([{ role: 'speaker', min: 1, max: null }]), ts, ts)
    .run();

  // field_definitions is unique on (event_id, key) — seedForm(base) already
  // created one row per key for this event, so form B's questions reuse those
  // same field rows rather than colliding with a fresh insert.
  const questions: Record<string, string> = {};
  const sections: Array<{ key: string; section: 'abstract' | 'participant'; required?: boolean }> = [
    { key: 'title', section: 'abstract', required: true },
    { key: 'first_name', section: 'participant', required: true },
    { key: 'last_name', section: 'participant', required: true },
    { key: 'email', section: 'participant', required: true },
  ];
  let position = 0;
  for (const spec of sections) {
    const field = await env.DB.prepare('SELECT id FROM field_definitions WHERE event_id = ? AND key = ?')
      .bind(base.eventId, spec.key)
      .first<{ id: string }>();
    if (!field) throw new Error(`fixture bug: field ${spec.key} missing on base form`);
    const qid = `q-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO form_questions (id, form_id, section, field_id, position, required, locked)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
      .bind(qid, formId, spec.section, field.id, (position += 1), spec.required ? 1 : 0)
      .run();
    questions[spec.key] = qid;
  }

  return {
    ...base,
    formId,
    questions,
    basePath: `/submit/${base.eventSlug}/${formId}`,
  };
}

describe('submission limit is per-form (docs/02 §9, docs/04 §2.5/§5)', () => {
  it('reproduces the live scenario: 3 existing submissions on a form, a 4th full /submit is blocked', async () => {
    const form = await seedForm({ submissionLimit: 3 });

    for (let i = 0; i < 3; i += 1) {
      const res = await postSubmit(form, submitBodyV2(form, `Talk ${i}`));
      expect(res.status).toBe(200);
    }

    // The 4th, via the same authoritative /submit endpoint the eval used
    // (not just the /draft autosave path) must be rejected.
    const fourth = await postSubmit(form, submitBodyV2(form, 'Talk 4'));
    expect(fourth.status).toBe(409);
    const body = (await fourth.json()) as { error: string };
    expect(body.error).toBe('limit_reached');
  });

  it('a submitter at form A\'s cap can still submit their first proposal to form B (per-form, not per-event)', async () => {
    const formA = await seedForm({ submissionLimit: 1 });
    const first = await postSubmit(formA, submitBodyV2(formA, 'Form A talk'));
    expect(first.status).toBe(200);

    // Same account, same event, at the cap for form A.
    const blockedOnA = await postSubmit(formA, submitBodyV2(formA, 'Form A talk 2'));
    expect(blockedOnA.status).toBe(409);

    // Form B on the same event, same submitter — independent quota, must
    // succeed as this submitter's FIRST submission to form B.
    const formB = await seedSecondForm(formA, 1);
    const onB = await postSubmit(formB, submitBodyV2(formB, 'Form B talk'));
    expect(onB.status).toBe(200);

    // Now form B is at its own cap of 1 too.
    const blockedOnB = await postSubmit(formB, submitBodyV2(formB, 'Form B talk 2'));
    expect(blockedOnB.status).toBe(409);
  });

  it('the displayed limit and the enforced limit come from the same field (ctx.limit)', async () => {
    // Form-level override wins over the event default.
    const form = await seedForm({ submissionLimit: 2 });
    const page = await SELF.fetch(`https://example.com${form.basePath}`, { headers: { cookie: form.cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    // The SSR bootstrap embeds the same ctx.limit the /submit guard checks —
    // assert the numeral the banner will render from is the form's override
    // (2), not the event's unrelated default (99, per seedForm's createEvent
    // call), so display and enforcement can never disagree about which
    // number is authoritative.
    expect(html).toContain('"submission_limit":2');
    expect(html).not.toContain('"submission_limit":99');
  });
});

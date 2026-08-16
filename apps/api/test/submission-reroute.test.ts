// Routing used to run once, at submit, and never again — so the answer a rule
// keyed off could change afterwards (speaker portal edit, organiser track
// change) and the routed track/plan/tags would keep pointing where the FIRST
// version of the answers sent them.
//
// These cover both halves of the fix (migration 0046, ../src/submissionRouting):
// re-routing while the submission is still in play, and freezing the routing
// inputs once it is not — plus the provenance rules that stop a re-route from
// undoing an organiser's manual decision.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import { addParticipant, createQuestion, createSubmission, createSubmissionForm, setAnswer } from './fixtures-portal';
import { createTrack } from './fixtures-submission';

const ORIGIN = 'https://kms.test';

let eventId: string;
let slug: string;
let speakerId: string;
let adminCookie: string;
let speakerCookie: string;
let formId: string;
let titleQ: string;
let trackQ: string;
let formatQ: string;
let workshopTrack: string;
let talkTrack: string;
let workshopPlan: string;
let talkPlan: string;
let workshopTag: string;
let talkTag: string;

async function createPlan(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, eventId, name, 'active', new Date().toISOString())
    .run();
  return id;
}

async function createTag(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO tags (id, event_id, name) VALUES (?, ?, ?)').bind(id, eventId, name).run();
  return id;
}

/** Two rules on the Format answer: Workshop → workshop plan/tag/track,
 *  Talk → talk plan/tag/track. Nothing keys off Track unless a test says so. */
async function setRoutingRules(rules: unknown): Promise<void> {
  await env.DB.prepare('UPDATE submission_forms SET routing_rules = ? WHERE id = ?')
    .bind(JSON.stringify(rules), formId)
    .run();
}

const formatRules = () => ({
  rules: [
    {
      id: 'r-workshop',
      when: { question_id: formatQ, op: 'equals', value: 'Workshop' },
      then: {
        assign_evaluation_plan_id: workshopPlan,
        add_tag_ids: [workshopTag],
        set_track_id: workshopTrack,
      },
    },
    {
      id: 'r-talk',
      when: { question_id: formatQ, op: 'equals', value: 'Talk' },
      then: { assign_evaluation_plan_id: talkPlan, add_tag_ids: [talkTag], set_track_id: talkTrack },
    },
  ],
});

beforeEach(async () => {
  slug = `rr-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug });
  speakerId = await createContact(eventId, { email: 'speaker@example.com', first_name: 'Grace', last_name: 'Hopper' });
  const adminId = await createContact(eventId, { email: 'admin@example.com', first_name: 'Ada', last_name: 'Lovelace' });
  await createEventUser(eventId, adminId, 'admin');
  speakerCookie = await sessionCookieFor({ contactId: speakerId, eventId, eventSlug: slug, role: 'speaker' });
  adminCookie = await sessionCookieFor({ contactId: adminId, eventId, eventSlug: slug, role: 'admin' });

  formId = await createSubmissionForm(eventId);
  titleQ = await createQuestion(eventId, formId, { key: 'title', label: 'Title', required: true, position: 0 });
  trackQ = await createQuestion(eventId, formId, {
    key: 'track',
    label: 'Track',
    type: 'dropdown',
    required: false,
    position: 1,
  });
  formatQ = await createQuestion(eventId, formId, {
    key: 'format',
    label: 'Format',
    type: 'dropdown',
    required: false,
    position: 2,
    options: [
      { value: 'Talk', label: 'Talk' },
      { value: 'Workshop', label: 'Workshop' },
    ],
  });

  workshopTrack = await createTrack(eventId, 'Workshops');
  talkTrack = await createTrack(eventId, 'Main stage');
  workshopPlan = await createPlan('Workshop review');
  talkPlan = await createPlan('Talk review');
  workshopTag = await createTag('workshop');
  talkTag = await createTag('talk');
  await setRoutingRules(formatRules());
});

/**
 * A submission as the submit path would have left it: routed by the Talk rule,
 * with the provenance row that records routing as the owner of those values.
 */
async function seedRoutedSubmission(status = 'pending'): Promise<string> {
  const id = await createSubmission(eventId, {
    status,
    submitterContactId: speakerId,
    formId,
    title: 'Routed talk',
  });
  await addParticipant(id, speakerId);
  await setAnswer(id, titleQ, 'Routed talk');
  await setAnswer(id, formatQ, 'Talk');
  await setAnswer(id, trackQ, 'Main stage');
  await env.DB.prepare('UPDATE submissions SET track_id = ?, evaluation_plan_id = ?, routing_state = ? WHERE id = ?')
    .bind(
      talkTrack,
      talkPlan,
      JSON.stringify({
        applied_rule_ids: ['r-talk'],
        used_fallback: false,
        at: new Date().toISOString(),
        set: {
          track_id: talkTrack,
          track_ids: [talkTrack],
          evaluation_plan_id: talkPlan,
          tag_ids: [talkTag],
          status: 'pending',
        },
      }),
      id,
    )
    .run();
  await env.DB.prepare('INSERT INTO submission_tags (submission_id, tag_id) VALUES (?, ?)').bind(id, talkTag).run();
  await env.DB.prepare('INSERT INTO submission_tracks (submission_id, track_id) VALUES (?, ?)')
    .bind(id, talkTrack)
    .run();
  return id;
}

const postPortalEdit = (id: string, fields: Record<string, string>) =>
  SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}/edit`, {
    method: 'POST',
    headers: { cookie: speakerCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });

const putAdminSubmission = (id: string, body: Record<string, unknown>) =>
  SELF.fetch(`${ORIGIN}/app/api/submissions/${id}`, {
    method: 'PUT',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const rowOf = (id: string) =>
  env.DB.prepare('SELECT status, track_id, evaluation_plan_id, routing_state FROM submissions WHERE id = ?')
    .bind(id)
    .first<{ status: string; track_id: string | null; evaluation_plan_id: string | null; routing_state: string | null }>();

async function tagsOf(id: string): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT tag_id FROM submission_tags WHERE submission_id = ? ORDER BY tag_id')
    .bind(id)
    .all<{ tag_id: string }>();
  return results.map((r) => r.tag_id);
}

async function tracksOf(id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT track_id FROM submission_tracks WHERE submission_id = ? ORDER BY track_id',
  )
    .bind(id)
    .all<{ track_id: string }>();
  return results.map((r) => r.track_id);
}

describe('re-routing on a speaker portal edit', () => {
  it('moves the plan, tags and track when the answer a rule keys off changes', async () => {
    const id = await seedRoutedSubmission();
    const res = await postPortalEdit(id, {
      [`q_${titleQ}`]: 'Routed talk',
      [`q_${formatQ}`]: 'Workshop',
      [`q_${trackQ}`]: talkTrack,
    });
    expect(res.status).toBe(302);

    const row = await rowOf(id);
    expect(row!.evaluation_plan_id).toBe(workshopPlan);
    expect(row!.track_id).toBe(workshopTrack);
    expect(await tagsOf(id)).toEqual([workshopTag]);
    expect(await tracksOf(id)).toEqual([workshopTrack]);
  });

  it('records the rules that fired, so the routing is traceable afterwards', async () => {
    const id = await seedRoutedSubmission();
    await postPortalEdit(id, { [`q_${titleQ}`]: 'Routed talk', [`q_${formatQ}`]: 'Workshop' });
    const state = JSON.parse((await rowOf(id))!.routing_state!) as { applied_rule_ids: string[] };
    expect(state.applied_rule_ids).toEqual(['r-workshop']);
  });

  it('never changes the status, even when a rule says set_status', async () => {
    const id = await seedRoutedSubmission();
    await setRoutingRules({
      rules: [
        {
          id: 'r-queue',
          when: { question_id: formatQ, op: 'equals', value: 'Workshop' },
          then: { set_status: 'accept_queue', assign_evaluation_plan_id: workshopPlan },
        },
      ],
    });
    await postPortalEdit(id, { [`q_${titleQ}`]: 'Routed talk', [`q_${formatQ}`]: 'Workshop' });

    const row = await rowOf(id);
    expect(row!.status).toBe('pending');
    expect(row!.evaluation_plan_id).toBe(workshopPlan);
  });

  it('leaves an organiser-overridden evaluation plan alone', async () => {
    const id = await seedRoutedSubmission();
    // The organiser moved it out of the routed plan by hand.
    const manualPlan = await createPlan('Chair shortlist');
    await env.DB.prepare('UPDATE submissions SET evaluation_plan_id = ? WHERE id = ?').bind(manualPlan, id).run();

    await postPortalEdit(id, { [`q_${titleQ}`]: 'Routed talk', [`q_${formatQ}`]: 'Workshop' });
    expect((await rowOf(id))!.evaluation_plan_id).toBe(manualPlan);
  });

  it('leaves the plan alone when membership was set explicitly, even if the column still matches', async () => {
    const id = await seedRoutedSubmission();
    await env.DB.prepare(
      'INSERT INTO evaluation_plan_submissions (plan_id, submission_id, added_at) VALUES (?, ?, ?)',
    )
      .bind(talkPlan, id, new Date().toISOString())
      .run();

    await postPortalEdit(id, { [`q_${titleQ}`]: 'Routed talk', [`q_${formatQ}`]: 'Workshop' });
    expect((await rowOf(id))!.evaluation_plan_id).toBe(talkPlan);
  });

  it('keeps a tag an organiser attached, and drops only the one routing added', async () => {
    const id = await seedRoutedSubmission();
    const manualTag = await createTag('keynote-candidate');
    await env.DB.prepare('INSERT INTO submission_tags (submission_id, tag_id) VALUES (?, ?)').bind(id, manualTag).run();

    await postPortalEdit(id, { [`q_${titleQ}`]: 'Routed talk', [`q_${formatQ}`]: 'Workshop' });

    const tags = await tagsOf(id);
    expect(tags).toContain(manualTag);
    expect(tags).toContain(workshopTag);
    expect(tags).not.toContain(talkTag);
  });

  it('keeps routing a rule keyed on an organiser-only answer the speaker never sees', async () => {
    // Internal-audience questions (0042) are not rendered on the portal edit
    // page and survive its delete-and-reinsert untouched — so routing has to
    // be handed them explicitly, or an unrelated save would evaluate the rule
    // against a missing answer and un-route the submission.
    const internalQ = await createQuestion(eventId, formId, {
      key: 'committee_stream',
      label: 'Committee stream',
      type: 'dropdown',
      audience: 'internal',
      position: 3,
      options: [{ value: 'Deep dive', label: 'Deep dive' }],
    });
    const id = await seedRoutedSubmission();
    await setAnswer(id, internalQ, 'Deep dive');
    await setRoutingRules({
      rules: [
        {
          id: 'r-internal',
          when: { question_id: internalQ, op: 'equals', value: 'Deep dive' },
          then: { assign_evaluation_plan_id: workshopPlan, add_tag_ids: [workshopTag] },
        },
      ],
    });
    // Re-route once so the internal rule owns the plan and tag.
    await postPortalEdit(id, { [`q_${titleQ}`]: 'Routed talk', [`q_${formatQ}`]: 'Talk' });
    expect((await rowOf(id))!.evaluation_plan_id).toBe(workshopPlan);
    expect(await tagsOf(id)).toContain(workshopTag);

    // A later edit that touches nothing the rule reads must not undo it.
    const res = await postPortalEdit(id, { [`q_${titleQ}`]: 'Retitled', [`q_${formatQ}`]: 'Talk' });
    expect(res.status).toBe(302);
    expect((await rowOf(id))!.evaluation_plan_id).toBe(workshopPlan);
    expect(await tagsOf(id)).toContain(workshopTag);
  });

  it('only adds to a submission with no provenance — it never re-points its track or plan', async () => {
    const id = await seedRoutedSubmission();
    // A pre-0046 row: routed values present, but nothing recording that
    // routing is what put them there.
    await env.DB.prepare('UPDATE submissions SET routing_state = NULL WHERE id = ?').bind(id).run();

    await postPortalEdit(id, { [`q_${titleQ}`]: 'Routed talk', [`q_${formatQ}`]: 'Workshop' });

    const row = await rowOf(id);
    expect(row!.evaluation_plan_id).toBe(talkPlan);
    expect(row!.track_id).toBe(talkTrack);
    // The new tag still applies; the old one is not routing's to remove.
    const tags = await tagsOf(id);
    expect(tags).toContain(workshopTag);
    expect(tags).toContain(talkTag);
  });
});

describe('freezing the routing inputs after a decision', () => {
  it('renders a frozen routing answer as disabled on the portal edit page', async () => {
    const id = await seedRoutedSubmission('accept_queue');
    const html = await (
      await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}/edit`, { headers: { cookie: speakerCookie } })
    ).text();
    expect(html).toContain('<fieldset disabled');
    expect(html).toContain('decides how the proposal was routed');
  });

  it('refuses a posted change to a frozen routing answer and writes nothing', async () => {
    const id = await seedRoutedSubmission('accept_queue');
    const res = await postPortalEdit(id, {
      [`q_${titleQ}`]: 'Renamed while accepted',
      [`q_${formatQ}`]: 'Workshop',
    });
    expect(res.status).toBe(400);

    const row = await rowOf(id);
    expect(row!.evaluation_plan_id).toBe(talkPlan);
    const answer = await env.DB.prepare(
      'SELECT value_json FROM submission_answers WHERE submission_id = ? AND question_id = ?',
    )
      .bind(id, formatQ)
      .first<{ value_json: string }>();
    expect(JSON.parse(answer!.value_json)).toBe('Talk');
  });

  it('still allows editing the rest of the proposal after a decision', async () => {
    const id = await seedRoutedSubmission('accepted');
    const res = await postPortalEdit(id, { [`q_${titleQ}`]: 'A better title', [`q_${formatQ}`]: 'Talk' });
    expect(res.status).toBe(302);
    const row = await env.DB.prepare('SELECT title FROM submissions WHERE id = ?').bind(id).first<{ title: string }>();
    expect(row!.title).toBe('A better title');
  });
});

describe('the organiser changing the track from the Workspace', () => {
  it('carries the Track answer and submission_tracks with it, and re-routes', async () => {
    const id = await seedRoutedSubmission();
    // Route off the TRACK answer for this one, so the organiser's change is a
    // routing input and must move the plan too.
    await setRoutingRules({
      rules: [
        {
          id: 'r-track-workshops',
          when: { question_id: trackQ, op: 'equals', value: 'Workshops' },
          then: { assign_evaluation_plan_id: workshopPlan, add_tag_ids: [workshopTag] },
        },
      ],
    });

    const res = await putAdminSubmission(id, { track_id: workshopTrack });
    expect(res.status).toBe(200);

    const row = await rowOf(id);
    expect(row!.track_id).toBe(workshopTrack);
    expect(row!.evaluation_plan_id).toBe(workshopPlan);
    expect(await tracksOf(id)).toEqual([workshopTrack]);

    const answer = await env.DB.prepare(
      'SELECT value_json FROM submission_answers WHERE submission_id = ? AND question_id = ?',
    )
      .bind(id, trackQ)
      .first<{ value_json: string }>();
    expect(JSON.parse(answer!.value_json)).toBe('Workshops');
    expect(await tagsOf(id)).toContain(workshopTag);
  });

  it('refuses the change once the track answer is a frozen routing input', async () => {
    const id = await seedRoutedSubmission('accepted');
    await setRoutingRules({
      rules: [
        {
          id: 'r-track-workshops',
          when: { question_id: trackQ, op: 'equals', value: 'Workshops' },
          then: { assign_evaluation_plan_id: workshopPlan },
        },
      ],
    });

    const res = await putAdminSubmission(id, { track_id: workshopTrack });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'routing_locked' });
    expect((await rowOf(id))!.track_id).toBe(talkTrack);
  });

  it('still allows the change after a decision when no rule keys off the track', async () => {
    const id = await seedRoutedSubmission('accepted');
    const res = await putAdminSubmission(id, { track_id: workshopTrack });
    expect(res.status).toBe(200);
    const row = await rowOf(id);
    expect(row!.track_id).toBe(workshopTrack);
    // Frozen, so no re-route: the plan stays where the organiser workflow left it.
    expect(row!.evaluation_plan_id).toBe(talkPlan);
  });

  it('reports why a submission was routed where it was', async () => {
    const id = await seedRoutedSubmission();
    const res = await SELF.fetch(`${ORIGIN}/app/api/submissions/${id}/detail`, { headers: { cookie: adminCookie } });
    const body = (await res.json()) as { routing: { applied: string[]; locked_track: boolean } };
    expect(body.routing.applied).toEqual(['Format is “Talk”']);
    expect(body.routing.locked_track).toBe(false);
  });
});

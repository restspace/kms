// The post-accept editorial loop (workplan 15 W5, decision D9). Four claims:
//
//  1. W5a — a current upload against a submission flips materials_state
//     NULL → 'received' with no human involved, and never overwrites a state
//     a human has since set: a v2 landing on a 'revision_requested' row must
//     not silently regress it.
//  2. W5b — 'revision_requested' re-arms the *existing* chase detector: one
//     staged draft per offset, idempotent across re-runs, and nothing more
//     once the next upload lands.
//  3. W5c — the tracking board's three questions partition the accepted set.
//  4. W5d — a v1 deck comment stays visible, and labelled v1, after v2 lands.
//
// Time is not faked (chase.test.ts's rule): materials_state_at is moved
// backwards to walk the offset windows, since the sweep only ever sees
// (now - requested).

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepReminders } from '../src/jobs/reminders';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';
import { fileFrom, pdfBytes } from './fixtures-portal';

const ORIGIN = 'https://kms.test';
const DAY_MS = 86_400_000;
const agoMs = (ms: number) => new Date(Date.now() - ms).toISOString();

/** The organiser-side upload, i.e. the same seam the portal's upload uses. */
async function upload(
  cookie: string,
  fields: Record<string, string>,
  filename = 'slides.pdf',
): Promise<{ upload_id: string; version: number }> {
  const form = new FormData();
  form.set('file', fileFrom(pdfBytes(), filename, 'application/pdf'));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await SELF.fetch(`${ORIGIN}/app/api/files/uploads`, {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { upload_id: string; version: number };
}

const materialsOf = (submissionId: string) =>
  env.DB.prepare(
    'SELECT materials_state, materials_state_at, materials_owner_id FROM submissions WHERE id = ?',
  )
    .bind(submissionId)
    .first<{ materials_state: string | null; materials_state_at: string | null; materials_owner_id: string | null }>();

const setMaterials = (submissionId: string, state: string, at: string) =>
  env.DB.prepare('UPDATE submissions SET materials_state = ?, materials_state_at = ? WHERE id = ?')
    .bind(state, at, submissionId)
    .run();

const draftsFor = (eventId: string) =>
  env.DB.prepare('SELECT subject_of, status, idem_key FROM chase_drafts WHERE event_id = ? ORDER BY idem_key')
    .bind(eventId)
    .all<{ subject_of: string; status: string; idem_key: string }>();

describe('W5a — the materials state', () => {
  it('an upload flips NULL → received without a human', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'deck-a@example.com' });
    const submissionId = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speaker });
    expect((await materialsOf(submissionId))?.materials_state).toBeNull();

    await upload(admin.cookie, { submission_id: submissionId });

    const after = await materialsOf(submissionId);
    expect(after?.materials_state).toBe('received');
    expect(after?.materials_state_at).not.toBeNull();
  });

  it('does not overwrite a later state: a v2 against revision_requested stays revision_requested', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'deck-b@example.com' });
    const submissionId = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speaker });

    const first = await upload(admin.cookie, { submission_id: submissionId });
    const requestedAt = agoMs(2 * DAY_MS);
    await setMaterials(submissionId, 'revision_requested', requestedAt);

    const second = await upload(admin.cookie, { upload_id: first.upload_id }, 'slides-v2.pdf');
    expect(second.version).toBe(2);

    // The flag is a human's, so the machine leaves it alone; the second chase
    // resolves off the upload's timestamp instead (see W5b below).
    const after = await materialsOf(submissionId);
    expect(after?.materials_state).toBe('revision_requested');
    expect(after?.materials_state_at).toBe(requestedAt);
  });

  it('PUT /submissions/:id/materials sets the human states and the deck owner, and refuses anything else', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const submissionId = await seedSubmission(eventId, { status: 'accepted' });

    const ok = await SELF.fetch(
      `${ORIGIN}/app/api/submissions/${submissionId}/materials`,
      jsonReq(admin.cookie, { materials_state: 'revision_requested', materials_owner_id: reviewer.contactId }, 'PUT'),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { materials_state: string; materials_owner_id: string };
    expect(body.materials_state).toBe('revision_requested');
    expect(body.materials_owner_id).toBe(reviewer.contactId);

    const bad = await SELF.fetch(
      `${ORIGIN}/app/api/submissions/${submissionId}/materials`,
      jsonReq(admin.cookie, { materials_state: 'shipped' }, 'PUT'),
    );
    expect(bad.status).toBe(400);

    // Reassigning the owner must not restart the chase clock.
    const stamped = (await materialsOf(submissionId))?.materials_state_at;
    const reassign = await SELF.fetch(
      `${ORIGIN}/app/api/submissions/${submissionId}/materials`,
      jsonReq(admin.cookie, { materials_owner_id: admin.contactId }, 'PUT'),
    );
    expect(reassign.status).toBe(200);
    expect((await materialsOf(submissionId))?.materials_state_at).toBe(stamped);

    // Reviewers never write it (the second lock behind the shared guard).
    const denied = await SELF.fetch(
      `${ORIGIN}/app/api/submissions/${submissionId}/materials`,
      jsonReq(reviewer.cookie, { materials_state: 'final' }, 'PUT'),
    );
    expect(denied.status).toBe(403);
  });
});

describe('W5b — the second chase is the same chase (D9)', () => {
  it('stages exactly one draft per offset, and none once the next upload lands', async () => {
    const eventId = await seedEvent();
    await env.DB.prepare(`UPDATE events SET chase_mode = 'assisted' WHERE id = ?`).bind(eventId).run();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'deck-chase@example.com', first_name: 'Rosa' });
    const submissionId = await seedSubmission(eventId, {
      status: 'accepted',
      submitter_contact_id: speaker,
      title: 'Agentic evals in anger',
    });

    // Nothing owing yet: a fresh request is inside every window.
    await setMaterials(submissionId, 'revision_requested', agoMs(1 * DAY_MS));
    await sweepReminders(env);
    expect((await draftsFor(eventId)).results).toHaveLength(0);

    // T+4d → the 3-day offset, once however often the sweep runs.
    await setMaterials(submissionId, 'revision_requested', agoMs(4 * DAY_MS));
    await sweepReminders(env);
    await sweepReminders(env);
    let drafts = (await draftsFor(eventId)).results;
    expect(drafts.map((d) => d.idem_key)).toEqual([`materials_revision:${speaker}:${submissionId}:v3d`]);
    expect(drafts[0]!.subject_of).toBe('materials');
    expect(drafts[0]!.status).toBe('staged'); // assisted: nothing left without a click

    // T+8d and T+20d add their own offsets and no more.
    await setMaterials(submissionId, 'revision_requested', agoMs(8 * DAY_MS));
    await sweepReminders(env);
    await setMaterials(submissionId, 'revision_requested', agoMs(20 * DAY_MS));
    await sweepReminders(env);
    drafts = (await draftsFor(eventId)).results;
    expect(drafts.map((d) => d.idem_key).sort()).toEqual(
      [
        `materials_revision:${speaker}:${submissionId}:v14d`,
        `materials_revision:${speaker}:${submissionId}:v3d`,
        `materials_revision:${speaker}:${submissionId}:v7d`,
      ].sort(),
    );

    // The v2 lands: the chase resolves the way the first chase does — when a
    // file arrives — even though the flag itself is still a human's to clear.
    await upload(admin.cookie, { submission_id: submissionId });
    await sweepReminders(env);
    expect((await draftsFor(eventId)).results).toHaveLength(3);
  });

  it('auto mode sends it through the one existing pipeline', async () => {
    const eventId = await seedEvent({ name: 'DeckCon' }); // chase_mode stays 'auto'
    const speaker = await seedContact(eventId, { email: 'deck-auto@example.com', first_name: 'Rosa' });
    const submissionId = await seedSubmission(eventId, {
      status: 'accepted',
      submitter_contact_id: speaker,
      title: 'Agentic evals in anger',
    });
    await setMaterials(submissionId, 'revision_requested', agoMs(4 * DAY_MS));

    await sweepReminders(env);

    const logs = await env.DB.prepare('SELECT idempotency_key, status FROM message_log WHERE event_id = ?')
      .bind(eventId)
      .all<{ idempotency_key: string; status: string }>();
    expect(logs.results.map((l) => l.idempotency_key)).toEqual([
      `materials_revision:${speaker}:${submissionId}:v3d`,
    ]);
    const drafts = (await draftsFor(eventId)).results;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe('sent');

    const draft = await env.DB.prepare('SELECT subject, body FROM chase_drafts WHERE event_id = ?')
      .bind(eventId)
      .first<{ subject: string; body: string }>();
    expect(draft!.subject).toContain('DeckCon');
    expect(draft!.body).toContain('Hi Rosa,');
    expect(draft!.body).toContain('Agentic evals in anger');
    expect(draft!.body).not.toContain('{{');
  });

  it('never chases a talk that is not accepted', async () => {
    const eventId = await seedEvent();
    const speaker = await seedContact(eventId, { email: 'deck-pending@example.com' });
    const submissionId = await seedSubmission(eventId, { status: 'pending', submitter_contact_id: speaker });
    await setMaterials(submissionId, 'revision_requested', agoMs(20 * DAY_MS));

    await sweepReminders(env);
    expect((await draftsFor(eventId)).results).toHaveLength(0);
  });
});

describe('W5c — the tracking board answers the two questions', () => {
  it('partitions the accepted set across not-seen, owes-a-v2, nothing-at-all and settled', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'deck-board@example.com' });

    const nothing = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speaker, title: 'No deck' });
    const received = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speaker, title: 'Unread deck' });
    const older = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speaker, title: 'Owes a v2, long ago' });
    const newer = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speaker, title: 'Owes a v2, recently' });
    const done = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speaker, title: 'Signed off' });
    // A decided-but-not-accepted row must not enter the arithmetic at all.
    await seedSubmission(eventId, { status: 'declined', submitter_contact_id: speaker, title: 'Not in the set' });

    await setMaterials(received, 'received', agoMs(DAY_MS));
    await setMaterials(older, 'revision_requested', agoMs(10 * DAY_MS));
    await setMaterials(newer, 'revision_requested', agoMs(2 * DAY_MS));
    await setMaterials(done, 'final', agoMs(DAY_MS));

    const res = await SELF.fetch(`${ORIGIN}/app/api/dashboard`, {
      headers: { cookie: admin.cookie, accept: 'application/json' },
    });
    const body = (await res.json()) as {
      tracking: {
        materials: {
          accepted_total: number;
          settled: number;
          awaiting_upload: Array<{ submission_id: string }>;
          not_seen: Array<{ submission_id: string }>;
          owes_v2: Array<{ submission_id: string; days_since_request: number | null }>;
        };
      };
    };
    const m = body.tracking.materials;

    expect(m.accepted_total).toBe(5);
    expect(m.awaiting_upload.map((r) => r.submission_id)).toEqual([nothing]);
    expect(m.not_seen.map((r) => r.submission_id)).toEqual([received]);
    // "Who owes me a v2", longest-owing first.
    expect(m.owes_v2.map((r) => r.submission_id)).toEqual([older, newer]);
    expect(m.owes_v2[0]!.days_since_request).toBe(10);
    expect(m.settled).toBe(1);

    // The claim the panel makes: nothing accepted falls between the buckets.
    expect(m.awaiting_upload.length + m.not_seen.length + m.owes_v2.length + m.settled).toBe(m.accepted_total);
  });
});

describe('W5d — one thread, not two', () => {
  it('keeps a v1 deck comment visible and labelled v1 after v2 lands', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'deck-thread@example.com' });
    const submissionId = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speaker });

    const first = await upload(admin.cookie, { submission_id: submissionId });
    const comment = await SELF.fetch(
      `${ORIGIN}/app/api/files/uploads/${first.upload_id}/comments`,
      jsonReq(admin.cookie, { body: 'Slide 12 is unreadable.' }),
    );
    expect(comment.status).toBe(200);

    await upload(admin.cookie, { upload_id: first.upload_id }, 'slides-v2.pdf');

    const res = await SELF.fetch(`${ORIGIN}/app/api/files/submissions/${submissionId}/comments`, {
      headers: { cookie: admin.cookie, accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: Array<{ body: string; version: number; author_role: string; author_name: string | null }>;
    };
    expect(items).toHaveLength(1);
    expect(items[0]!.body).toBe('Slide 12 is unreadable.');
    // Version-anchored (0007), so the label still points at the deck it described.
    expect(items[0]!.version).toBe(1);
    expect(items[0]!.author_role).toBe('admin');
  });
});
